// Launches a packaged desktop build the way a user would and checks what unit tests cannot reach:
// that the bundled board service starts, that onboarding lists the expected hosts, that an MCP
// integration prepared by the build completes its handshake with the build's own runtime, and that
// a hook run as a process entry gets its session event to the board.
//
// Usage: node scripts/smoke-desktop-package.mjs <packager output directory> [expected version]
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const [output, expectedVersion] = process.argv.slice(2);
const step = (label, detail = '') => console.log(`ok  ${label}${detail ? `  ${detail}` : ''}`);
const until = async (label, probe, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise(ok => setTimeout(ok, 250));
  }
};

async function main() {
  if (!output) throw new Error('usage: smoke-desktop-package.mjs <packaged directory> [expected version]');
  const packaged = resolve(output);
  const executable = process.platform === 'win32' ? join(packaged, 'JarviSync.exe')
    : process.platform === 'darwin' ? join(packaged, 'JarviSync.app', 'Contents', 'MacOS', 'JarviSync')
    : join(packaged, 'JarviSync');
  if (!existsSync(executable)) throw new Error(`no packaged executable at ${executable}`);

  const dataDir = await mkdtemp(join(tmpdir(), 'jarvisync-smoke-'));
  const app = spawn(executable, [], { env: { ...process.env, NODEBOARD_DESKTOP_DATA_DIR: dataDir }, stdio: 'ignore' });
  app.unref();
  try {
    // The shell writes its service address beside its data once the service is up. A cold Windows
    // runner scans a freshly extracted executable before it runs, so the first start can be slow.
    const { url } = await until('the board service', async () => JSON.parse(await readFile(join(dataDir, 'connection.json'), 'utf8')), 120_000);
    step('board service', url);

    const hosts = (await (await fetch(`${url}/api/onboarding`)).json()).hosts.map(host => host.host).join(',');
    if (hosts !== 'codex,claude-code,mcp') throw new Error(`unexpected onboarding hosts: ${hosts}`);
    step('onboarding hosts', hosts);
    if (!(await (await fetch(url)).text()).includes('<title>JarviSync')) throw new Error('the board page did not load');
    step('board page');

    const prepare = async host => {
      const response = await fetch(`${url}/api/onboarding/prepare`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url, 'X-JarviSync-UI': '1' },
        body: JSON.stringify({ host, scope: 'work' }),
      });
      if (!response.ok) throw new Error(`preparing ${host} failed: ${response.status} ${await response.text()}`);
      return response.json();
    };

    // Start the MCP server exactly as the prepared .mcp.json tells a host to start it.
    const server = JSON.parse(await readFile((await prepare('mcp')).mcpConfigPath, 'utf8')).mcpServers.jarvisync;
    const mcp = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ['pipe', 'pipe', 'inherit'] });
    const replies = new Map();
    createInterface({ input: mcp.stdout }).on('line', line => {
      try { const value = JSON.parse(line); replies.get(value.id)?.(value); } catch { /* not a reply */ }
    });
    const rpc = (id, method, params) => new Promise((ok, fail) => {
      const timer = setTimeout(() => fail(new Error(`MCP ${method} timed out`)), 60_000);
      replies.set(id, value => { clearTimeout(timer); ok(value); });
      mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
    try {
      const version = (await rpc(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } })).result?.serverInfo?.version;
      if (expectedVersion && version !== expectedVersion) throw new Error(`MCP reports ${version}, expected ${expectedVersion}`);
      const tools = (await rpc(2, 'tools/list')).result?.tools ?? [];
      if (tools.length !== 11) throw new Error(`MCP lists ${tools.length} tools, expected 11`);
      step('MCP handshake', `version ${version}, ${tools.length} tools`);
    } finally { mcp.stdin.end(); mcp.kill(); }

    // Hosts run the hook as a process entry. Before 0.1.3 that deadlocked on the hook's own import,
    // so no attempt ever got its event through. A cold machine can also miss the hook's 2 s network
    // budget once, after which the hook stays quiet for its offline cooldown by design. A missed
    // first attempt is therefore retried warm with the cooldown cleared, and reported rather than
    // hidden; only a warm miss fails the check.
    const profile = await prepare('claude-code');
    const connection = JSON.parse(await readFile(profile.configPath, 'utf8'));
    const cooldown = join(connection.stateDir, 'hook-runtime.json');
    const runHook = async sessionId => {
      const hook = spawn(connection.nodeExecutable, [join(profile.pluginRoot, 'runtime', 'hook.mjs'), '--connection', profile.configPath, '--host', 'claude-code'], {
        env: { ...process.env, ...connection.runtimeEnv }, stdio: ['pipe', 'ignore', 'ignore'],
      });
      const started = Date.now();
      hook.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', session_id: sessionId, source: 'startup' }));
      await new Promise(ok => hook.once('close', ok));
      const elapsed = Date.now() - started;
      const reason = JSON.parse(await readFile(cooldown, 'utf8').catch(() => '{}')).reason || 'no reason recorded';
      const profiles = (await (await fetch(`${url}/api/onboarding`)).json()).profiles;
      return { elapsed, reason, observed: profiles.find(item => item.id === profile.id)?.hooksObserved === true };
    };
    const cold = await runHook('smoke-session');
    if (cold.observed) {
      step('hook as process entry', `${cold.elapsed} ms, event reached the board`);
    } else {
      await rm(cooldown, { force: true });
      const warm = await runHook('smoke-session-warm');
      if (!warm.observed) throw new Error(`the SessionStart hook never got its event to the board (cold: ${cold.elapsed} ms, ${cold.reason}; warm: ${warm.elapsed} ms, ${warm.reason})`);
      step('hook as process entry', `cold attempt missed (${cold.elapsed} ms, ${cold.reason}); warm ${warm.elapsed} ms, event reached the board`);
    }
  } finally {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
    else app.kill();
    await new Promise(ok => setTimeout(ok, 1500));
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().then(() => process.exit(0), error => { console.error(`FAIL  ${error.message}`); process.exit(1); });
