import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { installIntegration, prepareIntegration } from '../integrations/installer.mjs';

const profile = { host: 'claude-code', pluginName: 'jarvisync', marketplaceName: 'jarvisync-test', marketplaceRoot: join(tmpdir(), 'jarvisync-test-marketplace') };
const selector = 'jarvisync@jarvisync-test';
function hostOptions({ marketplaces = [], plugins = [], fail } = {}) {
  const calls = [];
  return { calls, options: {
    hostExecutables: { 'claude-code': process.execPath, codex: process.execPath },
    async runHostCommand(executable, args, options) {
      assert.equal(executable, process.execPath);
      assert.equal(options.windowsHide, true);
      calls.push(args);
      if (fail?.(args)) throw new Error('host update failed');
      if (args.join(' ') === 'plugin marketplace list --json') return { stdout: JSON.stringify(marketplaces) };
      if (args.join(' ') === 'plugin list --json') return { stdout: JSON.stringify(plugins) };
      return { stdout: '' };
    },
  } };
}

test('new Claude connection adds only its marketplace and installs user scope', async () => {
  const host = hostOptions();
  const result = await installIntegration(profile, host.options);
  assert.equal(result.installation, 'awaiting-host');
  assert.deepEqual(host.calls, [
    ['plugin', 'marketplace', 'list', '--json'],
    ['plugin', 'marketplace', 'add', profile.marketplaceRoot],
    ['plugin', 'list', '--json'],
    ['plugin', 'install', selector, '--scope', 'user'],
  ]);
});

test('existing disabled Claude connection updates exact user plugin without reinstall or enable', async () => {
  const host = hostOptions({
    marketplaces: [{ name: profile.marketplaceName, source: 'directory', path: profile.marketplaceRoot }],
    plugins: [{ id: selector, version: '0.1.0', scope: 'user', enabled: false }, { id: 'other@elsewhere', scope: 'user' }],
  });
  await installIntegration(profile, host.options);
  assert.deepEqual(host.calls, [
    ['plugin', 'marketplace', 'list', '--json'],
    ['plugin', 'list', '--json'],
    ['plugin', 'update', selector, '--scope', 'user'],
  ]);
});

test('Claude does not update another marketplace or project installation', async () => {
  const host = hostOptions({ plugins: [{ id: selector, scope: 'project' }, { id: 'jarvisync@other', scope: 'user' }] });
  await installIntegration(profile, host.options);
  assert.deepEqual(host.calls.at(-1), ['plugin', 'install', selector, '--scope', 'user']);
});

test('conflicting Claude marketplace fails before any mutation', async () => {
  const host = hostOptions({ marketplaces: [{ name: profile.marketplaceName, source: 'directory', path: join(tmpdir(), 'unrelated') }] });
  await assert.rejects(installIntegration(profile, host.options), /同名市场指向其他来源/);
  assert.equal(host.calls.length, 1);
});

test('failed Claude update propagates without uninstall fallback', async () => {
  const host = hostOptions({ plugins: [{ id: selector, scope: 'user' }], fail: args => args[1] === 'update' });
  await assert.rejects(installIntegration(profile, host.options), /host update failed/);
  assert.equal(host.calls.some(args => ['uninstall', 'remove', 'enable'].includes(args[1])), false);
});

test('Codex refresh uses supported add again without removing existing plugin', async () => {
  const host = hostOptions();
  await installIntegration({ ...profile, host: 'codex' }, host.options);
  assert.deepEqual(host.calls, [
    ['plugin', 'marketplace', 'add', profile.marketplaceRoot],
    ['plugin', 'add', selector],
  ]);
});

test('refresh replaces stale runtime and manifest while retaining connection identity and state', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jarvisync-upgrade-'));
  try {
    const saved = { id: 'existing-profile', host: 'claude-code', scope: 'work', projectId: null, connectionToken: 'preserved-token' };
    const options = { root: process.cwd(), dataDir, url: 'http://127.0.0.1:4317', boardInstanceId: 'same-board', profile: saved, runtimeEnv: {} };
    const first = await prepareIntegration(options);
    const stateDir = JSON.parse(await readFile(first.configPath, 'utf8')).stateDir;
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, 'session.json'), '{"recording":false,"projectId":"existing-project"}');
    await writeFile(join(first.pluginRoot, 'runtime', 'hook.mjs'), '// stale runtime');
    await writeFile(join(first.pluginRoot, '.claude-plugin', 'plugin.json'), '{"name":"jarvisync","version":"0.1.0"}');
    const refreshed = await prepareIntegration(options);
    assert.equal(refreshed.pluginRoot, first.pluginRoot);
    assert.equal(await readFile(join(refreshed.pluginRoot, 'runtime', 'hook.mjs'), 'utf8'), await readFile('integrations/runtime/hook.mjs', 'utf8'));
    assert.equal(await readFile(join(refreshed.pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8'), await readFile('integrations/claude-code/jarvisync/.claude-plugin/plugin.json', 'utf8'));
    const connection = JSON.parse(await readFile(refreshed.configPath, 'utf8'));
    assert.equal(connection.connectionToken, saved.connectionToken);
    assert.equal(connection.profileId, saved.id);
    assert.equal(connection.stateDir, stateDir);
    assert.deepEqual(JSON.parse(await readFile(join(stateDir, 'session.json'), 'utf8')), { recording: false, projectId: 'existing-project' });
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
