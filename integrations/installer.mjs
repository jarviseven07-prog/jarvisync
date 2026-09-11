import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve, delimiter } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { atomicJson } from './runtime/client.mjs';
import { computeBuildIdentity } from '../server/build-identity.mjs';

const exec = promisify(execFile);
const exists = async path => Boolean(await stat(path).catch(() => null));
const names = { codex: 'Codex', 'claude-code': 'Claude Code', hermes: 'Hermes', mcp: '其他 Agent' };
// Electron can read individual files inside ASAR, but its cp wrapper cannot
// extract a whole archived directory. Copy our packaged templates file by file.
async function copyTemplate(source, target) {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isDirectory()) await copyTemplate(join(source, entry.name), join(target, entry.name));
    else if (entry.isFile()) await copyFile(join(source, entry.name), join(target, entry.name));
    else throw new Error('接入模板包含不支持的文件类型。');
  }
}
export function hookCommand({ nodeExecutable, hookScript, configPath, host, runtimeEnv = {}, windows = process.platform === 'win32' }) {
  const entries = Object.entries(runtimeEnv);
  if (entries.some(([key,value]) => !/^[A-Z_][A-Z0-9_]*$/.test(key) || typeof value !== 'string')) throw new Error('接入运行时环境无效。');
  if (windows) {
    const quote = value => `'${String(value).replaceAll("'", "''")}'`;
    const script = `[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; ${entries.map(([key,value]) => `$env:${key} = ${quote(value)}; `).join('')}& ${quote(nodeExecutable)} ${quote(hookScript)} --connection ${quote(configPath)} --host ${quote(host)} | Out-String -Stream; exit $LASTEXITCODE`;
    const powershell = join(process.env.SystemRoot || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe').replaceAll('\\', '/');
    const command = /[\s"';&|$`<>]/.test(powershell) ? 'powershell.exe' : powershell;
    return `${command} -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
  }
  const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
  return `${entries.map(([key,value]) => `${key}=${quote(value)} `).join('')}${quote(nodeExecutable)} ${quote(hookScript)} --connection ${quote(configPath)} --host ${quote(host)}`;
}
export function hookExecCommand({ nodeExecutable, hookScript, configPath, host, runtimeEnv = {} }) {
  const entries = Object.entries(runtimeEnv);
  if (entries.some(([key,value]) => !/^[A-Z_][A-Z0-9_]*$/.test(key) || typeof value !== 'string')) throw new Error('接入运行时环境无效。');
  if (entries.length) throw new Error('Windows Hook 需要可直接执行的 Node，不能在命令中包装运行时环境。');
  return { command: nodeExecutable, args: [hookScript, '--connection', configPath, '--host', host] };
}
export async function findDirectNodeExecutable({ environment = process.env, candidates = [] } = {}) {
  const extension = process.platform === 'win32' ? '.exe' : '';
  const locations = [
    ...candidates,
    ...(process.platform === 'win32' ? [
      environment.ProgramFiles && join(environment.ProgramFiles, 'nodejs', 'node.exe'),
      environment.ProgramW6432 && join(environment.ProgramW6432, 'nodejs', 'node.exe'),
      environment.LOCALAPPDATA && join(environment.LOCALAPPDATA, 'Programs', 'nodejs', 'node.exe'),
    ] : []),
    ...(environment.PATH || '').split(delimiter).filter(Boolean).map(path => join(path, `node${extension}`)),
  ];
  for (const candidate of [...new Set(locations.filter(Boolean))]) {
    if (!await exists(candidate)) continue;
    try {
      const { stdout } = await exec(candidate, ['--version'], { windowsHide: true, timeout: 2_000, maxBuffer: 1024 });
      if (/^v\d+\.\d+\.\d+\s*$/.test(stdout)) return candidate;
    } catch { /* Try the next installed Node location. */ }
  }
  return null;
}
export async function findHost(host, { homeDir = homedir(), hostExecutables = {}, hostEnv = {} } = {}) {
  if (hostExecutables[host]) return hostExecutables[host];
  const environment = { ...process.env, ...hostEnv };
  const candidates = [];
  if (host === 'hermes') candidates.push(join(environment.HERMES_HOME || join(homeDir, '.hermes'), 'bin', process.platform === 'win32' ? 'hermes.exe' : 'hermes'));
  if (host === 'claude-code' && process.platform === 'win32') {
    const base = join(environment.APPDATA || join(homeDir, 'AppData', 'Roaming'), 'Claude', 'claude-code');
    const entries = await readdir(base).catch(() => []);
    const versions = entries.filter(entry => /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(entry));
    versions.sort((a, b) => {
      const left = a.split(/[.+-]/).slice(0, 3).map(Number), right = b.split(/[.+-]/).slice(0, 3).map(Number);
      return right[0] - left[0] || right[1] - left[1] || right[2] - left[2];
    });
    candidates.push(...versions.map(version => join(base, version, 'claude.exe')));
  }
  if (host === 'codex' && process.platform === 'win32') {
    const base = join(environment.LOCALAPPDATA || join(homeDir, 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
    const entries = await readdir(base).catch(() => []);
    const present = await Promise.all(entries.map(async entry => ({ path: join(base, entry, 'codex.exe'), modified: (await stat(join(base, entry)).catch(() => null))?.mtimeMs || 0 })));
    candidates.push(...present.sort((a,b) => b.modified-a.modified).map(item => item.path));
  }
  const command = host === 'claude-code' ? 'claude' : host;
  candidates.push(join(homeDir, '.local', 'bin', `${command}${process.platform === 'win32' ? '.exe' : ''}`));
  for (const dir of (environment.PATH || '').split(delimiter).filter(Boolean)) candidates.push(join(dir, `${command}${process.platform === 'win32' ? '.exe' : ''}`));
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  return null;
}
export async function detectHosts(options) {
  return Promise.all(Object.keys(names).map(async host => ({ host, name: names[host], available: host === 'mcp' || Boolean(await findHost(host, options)) })));
}
export async function prepareIntegration({ root, dataDir, url, boardInstanceId, profile, servicePort = 0, nodeExecutable = process.execPath, runtimeEnv = process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {} }) {
  let runtimeNodeExecutable = nodeExecutable;
  let runtimeEnvironment = runtimeEnv;
  // Claude's `command` + `args` form directly starts an executable and cannot
  // apply ELECTRON_RUN_AS_NODE. Prefer a confirmed installed Node for it. A
  // packaged desktop without one keeps the established Electron wrapper.
  if (process.platform === 'win32' && profile.host === 'claude-code' && Object.keys(runtimeEnv).length) {
    const externalNode = await findDirectNodeExecutable();
    if (externalNode) {
      runtimeNodeExecutable = externalNode;
      runtimeEnvironment = {};
    }
  }
  const sourceRoot = resolve(root);
  const distDir = join(sourceRoot, 'dist');
  const runtimeBuild = await computeBuildIdentity({ root: sourceRoot, distDir });
  const base = join(dataDir, 'agent-integrations', 'profiles', profile.id);
  const pluginName = profile.host === 'hermes' ? 'jarvisync-hermes' : 'jarvisync';
  const pluginRoot = join(base, 'plugins', pluginName);
  const runtime = join(pluginRoot, 'runtime');
  const template = join(root, 'integrations', profile.host, profile.host === 'hermes' ? 'plugin' : 'jarvisync');
  if (profile.host !== 'mcp') await copyTemplate(template, pluginRoot);
  await mkdir(runtime, { recursive: true });
  await copyTemplate(join(root, 'integrations', 'runtime'), runtime);
  const configPath = join(runtime, 'connection.json');
  const config = { version: 1, url, boardInstanceId, dataDir: resolve(dataDir), host: profile.host, profileId: profile.id,
    connectionToken: profile.connectionToken, scope: profile.scope, projectId: profile.projectId,
    stateDir: join(base, 'state'), nodeExecutable: runtimeNodeExecutable, runtimeEnv: runtimeEnvironment, servicePort, serverEntry: join(sourceRoot, 'server', 'index.mjs'),
    runtimeBuild: { version: runtimeBuild.version, buildId: runtimeBuild.buildId, sourceRoot, distDir }, autoStart: true };
  await atomicJson(configPath, config);
  const mcp = { mcpServers: { jarvisync: { command: runtimeNodeExecutable, args: [join(runtime, 'mcp.mjs')], env: { ...runtimeEnvironment, JARVISYNC_CONNECTION: configPath } } } };
  await atomicJson(join(pluginRoot, '.mcp.json'), mcp);
  const hookConfig = join(pluginRoot, 'hooks', 'hooks.json');
  if (await exists(hookConfig)) {
    const value = JSON.parse(await readFile(hookConfig, 'utf8'));
    const commandArgs = { nodeExecutable: runtimeNodeExecutable, hookScript: join(runtime, 'hook.mjs'), configPath, host: profile.host, runtimeEnv: runtimeEnvironment };
    const replace = item => {
      if (Array.isArray(item)) return item.map(replace);
      if (item && typeof item === 'object') {
        if (item.type === 'command') {
          if (process.platform === 'win32' && profile.host === 'claude-code' && !Object.keys(runtimeEnvironment).length) return { ...item, ...hookExecCommand(commandArgs) };
          return { ...item, command: hookCommand(commandArgs),
            ...(profile.host === 'codex' ? { commandWindows: hookCommand({ ...commandArgs, windows: true }) } : {}) };
        }
        return Object.fromEntries(Object.entries(item).map(([key,val]) => [key, replace(val)]));
      }
      return item;
    };
    await atomicJson(hookConfig, replace(value));
  }
  let marketplacePath = null, viewUrl = null;
  const marketplaceName = `jarvisync-${profile.id.slice(0, 8)}`;
  if (profile.host === 'codex') {
    marketplacePath = join(base, '.agents', 'plugins', 'marketplace.json');
    await atomicJson(marketplacePath, { name: marketplaceName, interface: { displayName: 'JarviSync 本机接入' }, plugins: [{ name: pluginName, source: { source: 'local', path: `./plugins/${pluginName}` }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }] });
    viewUrl = `codex://plugins/${pluginName}?marketplacePath=${encodeURIComponent(marketplacePath)}`;
  }
  if (profile.host === 'claude-code') {
    marketplacePath = join(base, '.claude-plugin', 'marketplace.json');
    await atomicJson(marketplacePath, { name: marketplaceName, owner: { name: 'JarviSync' }, plugins: [{ name: pluginName, source: `./plugins/${pluginName}`, description: '在本地看板接续工作与成果' }] });
  }
  await writeFile(join(base, '接入说明.txt'), `${names[profile.host]} 接入 ${boardInstanceId}\n安装后请重新打开会话，并完成宿主要求的工具与 Hook 信任确认。\n验证提示：请完成 JarviSync 连接验证，在独立验证区读取、写入并读回。\n停用：看板 > 接入我的 Agent > 停用。项目记录不会删除。\n`, 'utf8');
  return { pluginRoot, pluginName, marketplaceRoot: base, marketplaceName, marketplacePath, viewUrl, configPath, mcpConfigPath: join(pluginRoot, '.mcp.json') };
}
export async function installIntegration(profile, options = {}) {
  if (profile.host === 'mcp') return { installation: 'manual', message: '接入配置已准备。请使用宿主的 MCP 导入入口；仅基础工具连接，无自动会话检查。' };
  const executable = await findHost(profile.host, options);
  if (!executable) throw new Error(`未找到 ${names[profile.host]} 本机命令行，请先安装该宿主，再回到这里安装接入。`);
  const run = args => (options.runHostCommand || exec)(executable, args, { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024, env: { ...process.env, ...(options.hostEnv || {}) } });
  if (profile.host === 'codex') {
    await run(['plugin', 'marketplace', 'add', profile.marketplaceRoot]);
    // Codex's local-plugin update contract is a changed manifest version plus
    // plugin add again. There is no `plugin update` command or need to remove.
    await run(['plugin', 'add', `${profile.pluginName}@${profile.marketplaceName}`]);
  } else if (profile.host === 'claude-code') {
    const marketplaces = JSON.parse((await run(['plugin', 'marketplace', 'list', '--json'])).stdout);
    if (!Array.isArray(marketplaces)) throw new Error('Claude Code 返回了无法识别的市场列表，未修改接入。');
    const marketplace = marketplaces.find(item => item.name === profile.marketplaceName);
    if (marketplace) {
      if (marketplace.source !== 'directory' || typeof marketplace.path !== 'string' || resolve(marketplace.path) !== resolve(profile.marketplaceRoot)) {
        throw new Error('Claude Code 中同名市场指向其他来源，未覆盖；请核对现有接入。');
      }
    } else await run(['plugin', 'marketplace', 'add', profile.marketplaceRoot]);
    const plugins = JSON.parse((await run(['plugin', 'list', '--json'])).stdout);
    if (!Array.isArray(plugins)) throw new Error('Claude Code 返回了无法识别的插件列表，未安装或更新插件。');
    const selector = `${profile.pluginName}@${profile.marketplaceName}`;
    const installed = plugins.some(item => item.id === selector && item.scope === 'user');
    // install skips existing plugins; update refreshes their versioned cache
    // while preserving enablement and installations belonging to other scopes.
    await run(['plugin', installed ? 'update' : 'install', selector, '--scope', 'user']);
  } else {
    // Hermes native plugin installation is finalized against the installed host API.
    const { installHermes } = await import('./hermes/install.mjs');
    await installHermes({ profile, executable, run, ...options });
  }
  return { installation: 'awaiting-host', installedAt: new Date().toISOString(), message: profile.host === 'codex' ? '已安装。请在 Codex 的 /hooks 中核对并信任 JarviSync，然后重新打开对话。' : '已安装。请重新打开对话，完成宿主的工具与插件确认，再进行验证。' };
}
