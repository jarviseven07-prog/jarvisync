import assert from 'node:assert/strict';
import test from 'node:test';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installHermes } from '../integrations/hermes/install.mjs';

const pluginRoot = fileURLToPath(new URL('../integrations/hermes/plugin/', import.meta.url));
const read = (name) => readFile(join(pluginRoot, name), 'utf8');

test('Hermes adapter uses the native prompt section and observer hooks', async () => {
  const [manifest, plugin] = await Promise.all([read('plugin.yaml'), read('__init__.py')]);
  assert.match(manifest, /^name: jarvisync-hermes$/m);
  for (const hook of ['on_session_start', 'pre_llm_call', 'on_session_end', 'subagent_start', 'subagent_stop']) {
    assert.match(manifest, new RegExp(`- ${hook}`));
    assert.match(plugin, new RegExp(`register_hook\\("${hook}"`));
  }
  assert.match(plugin, /register_system_prompt_section\("jarvisync\.onboarding"/);
  assert.match(plugin, /ctx\.register_system_prompt_section/);
  assert.match(plugin, /JarviSync sessionId for this turn is/);
  assert.match(plugin, /use Hermes tool search to locate the/);
  assert.match(plugin, /discovery and\nattach\/context\/start in that order/);
  assert.match(plugin, /--config", str\(_CONNECTION\)/);
  assert.match(plugin, /profile_id, node_executable, runtime_env = _connection\(\)/);
  assert.match(plugin, /\[node_executable, str\(_HOOK\), "--config", str\(_CONNECTION\)/);
  assert.match(plugin, /"env": \{\*\*os\.environ, \*\*runtime_env\}/);
  assert.match(plugin, /subprocess\.run\(command, input=payload, timeout=15/);
  assert.doesNotMatch(plugin, /subprocess\.Popen/);
  assert.doesNotMatch(plugin, /on_session_finalize",/);
});

test('Hermes lifecycle mapping preserves host stop and interruption semantics', async () => {
  const plugin = await read('__init__.py');
  for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop', 'Interrupt', 'SubagentStart']) {
    assert.match(plugin, new RegExp(`_emit\\("${event}"`));
  }
  assert.match(plugin, /if interrupted:/);
  assert.match(plugin, /never proof of business completion/);
  assert.match(plugin, /child_goal.*intentionally not forwarded/);
  assert.match(plugin, /if _text\(turn_id\) is not None:/);
  assert.match(plugin, /Only a supplied host turn/);
  assert.match(plugin, /JarviSync protocol for an explicit user work request/);
  assert.match(plugin, /jarvisync_discover; if it reports no binding, call jarvisync_attach/);
  assert.match(plugin, /jarvisync_context and jarvisync_start/);
  assert.match(plugin, /After the real output exists, call jarvisync_deliver/);
  assert.match(plugin, /Do not stop after discovery/);
  assert.match(plugin, /\("model", _text\(model\)\)/);
  assert.match(plugin, /child_session_id=child/);
  assert.match(plugin, /parent_session_id=_text\(parent_session_id\)/);
  assert.match(plugin, /agent_id=_text\(child_subagent_id\), agent_type=_text\(child_role\)/);
});

test('Hermes MCP template is a fixed-root stdio connection contract', async () => {
  const template = JSON.parse(await read('mcp-server.template.json'));
  assert.equal(template.name, 'jarvisync');
  assert.equal(template.config.command, 'node');
  assert.deepEqual(template.config.args, ['<absolute-plugin-root>/runtime/mcp.mjs']);
  assert.equal(template.config.enabled, true);
  assert.equal(template.config.tools.resources, false);
  assert.equal(template.config.tools.prompts, false);
});

test('Hermes installer copies into an isolated home and only sets its MCP leaf', async () => {
  const home = await mkdtemp(join(tmpdir(), 'jarvisync-hermes-home-'));
  const calls = [];
  const source = fileURLToPath(new URL('../integrations/hermes/plugin/', import.meta.url));
  const prepared = join(home, 'prepared-plugin');
  await cp(source, prepared, { recursive: true });
  await mkdir(join(prepared, 'runtime'), { recursive: true });
  await writeFile(join(prepared, 'runtime', 'connection.json'), JSON.stringify({ host: 'hermes', profileId: 'profile-a' }), 'utf8');
  const profile = {
    id: 'profile-a',
    host: 'hermes',
    pluginRoot: prepared,
    mcpConfigPath: join(prepared, 'mcp-server.template.json'),
  };
  // The prepared installer writes a concrete .mcp.json. Adapt the template
  // without touching a real Hermes profile for this contract test.
  const concrete = join(prepared, '.mcp.json');
  await writeFile(concrete, JSON.stringify({ mcpServers: {
    jarvisync: { command: process.execPath, args: [join(prepared, 'runtime', 'mcp.mjs')], env: { JARVISYNC_CONNECTION: join(prepared, 'runtime', 'connection.json') } },
  } }), 'utf8');
  profile.mcpConfigPath = concrete;
  let configured = null;
  const run = async args => {
    calls.push(args);
    if (args.slice(0, 3).join(' ') === 'config get mcp_servers.jarvisync') {
      if (configured) return { stdout: JSON.stringify(configured), stderr: '' };
      const error = new Error('Config key not set: mcp_servers.jarvisync');
      error.stderr = 'Config key not set: mcp_servers.jarvisync';
      throw error;
    }
    if (args.slice(0, 3).join(' ') === 'config set mcp_servers.jarvisync') configured = JSON.parse(args[3]);
    return { stdout: '', stderr: '' };
  };
  try {
    const installed = await installHermes({ profile, executable: join(home, 'bin', 'hermes.exe'), run, hostEnv: { HERMES_HOME: home } });
    assert.equal(installed.pluginRoot, join(home, 'plugins', 'jarvisync-hermes'));
    assert.deepEqual(calls[1], ['plugins', 'enable', 'jarvisync-hermes', '--no-allow-tool-override']);
    assert.equal(calls[2][0], 'config');
    assert.equal(calls[2][1], 'set');
    assert.equal(calls[2][2], 'mcp_servers.jarvisync');
    const entry = JSON.parse(calls[2][3]);
    assert.equal(entry.enabled, true);
    assert.equal(entry.tools.resources, false);
    assert.equal(entry.env.JARVISYNC_CONNECTION, join(prepared, 'runtime', 'connection.json'));
    const retry = await installHermes({ profile, executable: join(home, 'bin', 'hermes.exe'), run, hostEnv: { HERMES_HOME: home } });
    assert.equal(retry.reused, true);
    assert.equal(calls.filter(args => args.slice(0, 3).join(' ') === 'config set mcp_servers.jarvisync').length, 1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('Hermes installer refuses an existing plugin from a different prepared profile', async () => {
  const home = await mkdtemp(join(tmpdir(), 'jarvisync-hermes-foreign-'));
  const source = fileURLToPath(new URL('../integrations/hermes/plugin/', import.meta.url));
  const prepared = join(home, 'prepared-plugin');
  const foreign = join(home, 'plugins', 'jarvisync-hermes');
  await cp(source, prepared, { recursive: true });
  await mkdir(join(prepared, 'runtime'), { recursive: true });
  await writeFile(join(prepared, 'runtime', 'connection.json'), JSON.stringify({ host: 'hermes', profileId: 'profile-a' }), 'utf8');
  await mkdir(join(foreign, 'runtime'), { recursive: true });
  await writeFile(join(foreign, 'runtime', 'connection.json'), JSON.stringify({ host: 'hermes', profileId: 'profile-b' }), 'utf8');
  const concrete = join(prepared, '.mcp.json');
  await writeFile(concrete, JSON.stringify({ mcpServers: { jarvisync: { command: process.execPath, args: [join(prepared, 'runtime', 'mcp.mjs')] } } }), 'utf8');
  try {
    await assert.rejects(
      installHermes({ profile: { id: 'profile-a', host: 'hermes', pluginRoot: prepared, mcpConfigPath: concrete }, executable: join(home, 'bin', 'hermes.exe'), hostEnv: { HERMES_HOME: home }, run: async args => {
        if (args.slice(0, 3).join(' ') === 'config get mcp_servers.jarvisync') {
          const error = new Error('Config key not set: mcp_servers.jarvisync'); error.stderr = error.message; throw error;
        }
        return { stdout: '', stderr: '' };
      } }),
      /不属于当前接入/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('Hermes installer derives a Windows bin home when no explicit isolated home is supplied', async () => {
  const home = await mkdtemp(join(tmpdir(), 'jarvisync-hermes-bin-home-'));
  const source = fileURLToPath(new URL('../integrations/hermes/plugin/', import.meta.url));
  const prepared = join(home, 'prepared-plugin');
  await cp(source, prepared, { recursive: true });
  await mkdir(join(prepared, 'runtime'), { recursive: true });
  await writeFile(join(prepared, 'runtime', 'connection.json'), JSON.stringify({ host: 'hermes', profileId: 'profile-bin' }), 'utf8');
  const concrete = join(prepared, '.mcp.json');
  await writeFile(concrete, JSON.stringify({ mcpServers: { jarvisync: { command: process.execPath, args: [join(prepared, 'runtime', 'mcp.mjs')] } } }), 'utf8');
  let configured = null;
  const run = async args => {
    if (args.slice(0, 3).join(' ') === 'config get mcp_servers.jarvisync') {
      if (configured) return { stdout: JSON.stringify(configured), stderr: '' };
      const error = new Error('Config key not set: mcp_servers.jarvisync'); error.stderr = error.message; throw error;
    }
    if (args.slice(0, 3).join(' ') === 'config set mcp_servers.jarvisync') configured = JSON.parse(args[3]);
    return { stdout: '', stderr: '' };
  };
  try {
    const installed = await installHermes({ profile: { id: 'profile-bin', host: 'hermes', pluginRoot: prepared, mcpConfigPath: concrete }, executable: join(home, 'bin', 'hermes.exe'), run, hostEnv: { HERMES_HOME: '' } });
    assert.equal(installed.home, home);
    assert.equal(installed.pluginRoot, join(home, 'plugins', 'jarvisync-hermes'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
