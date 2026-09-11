import { cp, lstat, mkdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';

const exists = async path => Boolean(await stat(path).catch(() => null));

function requiredText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Hermes 接入缺少 ${label}。请回到看板重新准备接入。`);
  return value;
}

function pluginHome({ executable, homeDir, hostEnv = {} }) {
  const effectiveEnv = { ...process.env, ...hostEnv };
  if (effectiveEnv.HERMES_HOME) return resolve(effectiveEnv.HERMES_HOME);
  if (homeDir) return resolve(homeDir, '.hermes');
  const binary = resolve(requiredText(executable, 'Hermes 可执行文件'));
  if (/^hermes(?:\.exe)?$/i.test(basename(binary)) && basename(dirname(binary)).toLowerCase() === 'bin') {
    return dirname(dirname(binary));
  }
  return resolve(homedir(), '.hermes');
}

function inside(root, target) {
  const path = relative(root, target);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function isMissingConfig(error) {
  const text = [error?.message, error?.stdout, error?.stderr].filter(Boolean).join('\n');
  return /Config key not set:\s*mcp_servers\.jarvisync/i.test(text);
}

async function currentMcp(run) {
  try {
    const result = await run(['config', 'get', 'mcp_servers.jarvisync', '--json']);
    try {
      const value = JSON.parse(result.stdout);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
      return value;
    } catch {
      throw new Error('Hermes 的 jarvisync MCP 配置不是结构化对象，已取消安装以免覆盖。');
    }
  } catch (error) {
    if (isMissingConfig(error)) return null;
    throw error;
  }
}

function matchingMcp(existing, expected) {
  return existing?.command === expected.command
    && Array.isArray(existing.args) && existing.args.length === expected.args.length
    && existing.args.every((value, index) => value === expected.args[index])
    && existing.enabled === expected.enabled
    && existing.connect_timeout === expected.connect_timeout
    && existing.tools?.resources === expected.tools.resources
    && existing.tools?.prompts === expected.tools.prompts
    && Object.entries(expected.env).every(([key, value]) => existing.env?.[key] === value);
}

async function targetBelongsToProfile(target, profile) {
  try {
    const connection = JSON.parse(await readFile(join(target, 'runtime', 'connection.json'), 'utf8'));
    return connection?.host === 'hermes' && connection?.profileId === profile.id;
  } catch {
    return false;
  }
}

async function loadMcpConfig(path) {
  let value;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`无法读取准备好的 Hermes MCP 配置：${error.message}`);
  }
  const entry = value?.mcpServers?.jarvisync;
  if (!entry || typeof entry !== 'object') throw new Error('准备好的 Hermes MCP 配置缺少 jarvisync。');
  if (typeof entry.command !== 'string' || !entry.command || !Array.isArray(entry.args) || !entry.args.every(arg => typeof arg === 'string')) {
    throw new Error('准备好的 Hermes MCP 命令格式无效。');
  }
  if (entry.env !== undefined && (!entry.env || typeof entry.env !== 'object' || Array.isArray(entry.env)
    || !Object.entries(entry.env).every(([key, value]) => typeof key === 'string' && typeof value === 'string'))) {
    throw new Error('准备好的 Hermes MCP 环境变量格式无效。');
  }
  return {
    command: entry.command,
    args: entry.args,
    env: entry.env || {},
    enabled: true,
    connect_timeout: 15,
    tools: { resources: false, prompts: false },
  };
}

/**
 * Install the prepared native package into exactly one Hermes home.
 *
 * Hermes's `mcp add` requires an interactive stdin choice after discovery.
 * The app's hidden `run` callback has no stdin transport, so this uses Hermes's
 * own structured `config set` command for the one validated leaf rather than
 * editing config.yaml. All preflight checks occur before the first write.
 */
export async function installHermes({ profile, executable, run, homeDir, hostEnv = {} }) {
  if (profile?.host !== 'hermes') throw new Error('Hermes 安装器只能处理 Hermes 接入配置。');
  if (typeof run !== 'function') throw new Error('Hermes 安装器没有可用的宿主命令执行器。');
  const source = resolve(requiredText(profile.pluginRoot, '插件包路径'));
  const mcpConfigPath = resolve(requiredText(profile.mcpConfigPath, 'MCP 配置路径'));
  if (!await exists(source) || !await exists(join(source, 'plugin.yaml')) || !await exists(join(source, 'runtime', 'connection.json'))) {
    throw new Error('Hermes 接入包尚未准备完整。请回到看板重新关联后再安装。');
  }
  const mcp = await loadMcpConfig(mcpConfigPath);
  const home = pluginHome({ executable, homeDir, hostEnv });
  const pluginsRoot = resolve(home, 'plugins');
  const target = resolve(pluginsRoot, 'jarvisync-hermes');
  if (!inside(pluginsRoot, target)) throw new Error('Hermes 插件目录不安全，已取消安装。');
  const targetExists = await exists(target);
  if (targetExists && (await lstat(target)).isSymbolicLink()) throw new Error('Hermes 插件目录不能是符号链接，已取消安装。');
  if (inside(target, source) || inside(source, target)) throw new Error('Hermes 插件源与安装目录不能重叠，已取消安装。');
  const existingMcp = await currentMcp(run);
  if (targetExists && !await targetBelongsToProfile(target, profile)) {
    throw new Error('Hermes 已有不属于当前接入的 JarviSync 插件目录。为避免覆盖，已取消安装。');
  }
  if (existingMcp && (!targetExists || !matchingMcp(existingMcp, mcp))) {
    throw new Error('Hermes 已有不属于当前接入的 jarvisync MCP 配置。为避免覆盖，已取消安装。');
  }

  let swapped = false;
  let backedUp = false;
  let mcpWritten = false;
  const suffix = randomUUID();
  const staging = resolve(pluginsRoot, `.jarvisync-stage-${suffix}`);
  const backup = resolve(pluginsRoot, `.jarvisync-backup-${suffix}`);
  let canonicalRoot;
  // Every rename/delete stays at a checked direct child of this Hermes home.
  const checkPath = async path => {
    if (![target, staging, backup].includes(path) || dirname(path) !== pluginsRoot || !inside(pluginsRoot, path)
      || await realpath(pluginsRoot) !== canonicalRoot) throw new Error('Hermes 安装目录在操作期间发生变化，已停止。');
    const entry = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (entry?.isSymbolicLink() || (entry && dirname(await realpath(path)) !== canonicalRoot)) throw new Error('Hermes 安装路径超出确认范围，已停止。');
  };
  const safeRemove = async path => { await checkPath(path); await rm(path, { recursive: true, force: true }); };
  const safeRename = async (from, to) => { await checkPath(from); await checkPath(to); await rename(from, to); };
  const copyOptions = { recursive: true, filter: async path => {
    if (basename(path) === '__pycache__' || /\.py[co]$/i.test(path)) return false;
    if ((await lstat(path)).isSymbolicLink()) throw new Error('Hermes 插件包含符号链接，已取消安装。');
    return true;
  } };
  try {
    await mkdir(pluginsRoot, { recursive: true });
    canonicalRoot = await realpath(pluginsRoot);
    await checkPath(staging);
    await checkPath(backup);
    // Retain local state/extra files, then overlay only the newly prepared package.
    if (targetExists) await cp(target, staging, copyOptions);
    await cp(source, staging, copyOptions);
    if (targetExists) {
      await safeRename(target, backup);
      backedUp = true;
    }
    await safeRename(staging, target);
    swapped = true;
    await run(['plugins', 'enable', 'jarvisync-hermes', '--no-allow-tool-override']);
    if (!existingMcp) {
      await run(['config', 'set', 'mcp_servers.jarvisync', JSON.stringify(mcp)]);
      mcpWritten = true;
    }
  } catch (error) {
    const rollbackErrors = [];
    if (mcpWritten) await run(['config', 'unset', 'mcp_servers.jarvisync']).catch(reason => rollbackErrors.push(String(reason)));
    if (swapped && !targetExists) await run(['plugins', 'disable', 'jarvisync-hermes']).catch(reason => rollbackErrors.push(String(reason)));
    if (swapped) await safeRemove(target).catch(reason => rollbackErrors.push(String(reason)));
    if (backedUp) await safeRename(backup, target).catch(reason => rollbackErrors.push(String(reason)));
    if (canonicalRoot) await safeRemove(staging).catch(reason => rollbackErrors.push(String(reason)));
    if (rollbackErrors.length) error.message += ` 安装回滚未完全完成：${rollbackErrors.join('；')}`;
    throw error;
  }

  // Cleanup follows the committed host operation; never roll back to a backup
  // whose cleanup may already have partially succeeded.
  if (backedUp) await safeRemove(backup);

  return { home, pluginRoot: target, mcpName: 'jarvisync', reused: targetExists };
}
