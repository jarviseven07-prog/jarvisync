import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { hookExecCommand, prepareIntegration } from '../integrations/installer.mjs';
import { createClient } from '../integrations/runtime/client.mjs';
import { readSessionState, updateSessionState, writeSessionState } from '../integrations/runtime/hook.mjs';
import { recordingCommand } from '../integrations/runtime/recording-command.mjs';
import { startServer } from '../server/index.mjs';

const configFor = stateDir => ({ url: 'http://127.0.0.1:1', boardInstanceId: 'board', stateDir, host: 'claude-code', profileId: 'profile', connectionToken: 'token' });
const sessionId = 'claude-session';

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

test('Claude Windows Hook exec form directly starts Node with Chinese and space paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'JarviSync 中文 路径 '));
  const hook = join(directory, '钩子 文件.mjs');
  const connection = join(directory, '连接 文件.json');
  try {
    await writeFile(hook, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n', 'utf8');
    const command = hookExecCommand({ nodeExecutable: process.execPath, hookScript: hook, configPath: connection, host: 'claude-code' });
    assert.equal(command.command, process.execPath);
    assert.deepEqual(command.args, [hook, '--connection', connection, '--host', 'claude-code']);
    const result = await run(command.command, command.args);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ['--connection', connection, '--host', 'claude-code']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Claude preparation uses a confirmed external Node for all generated hook commands', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jarvisync-claude-prepare-'));
  try {
    const profile = { id: 'claude-profile', host: 'claude-code', scope: 'work', projectId: null, connectionToken: 'token' };
    const prepared = await prepareIntegration({
      root: process.cwd(), dataDir, url: 'http://127.0.0.1:4317', boardInstanceId: 'board', profile,
      nodeExecutable: 'C:\\not-an-external-node.exe', runtimeEnv: { ELECTRON_RUN_AS_NODE: '1' },
    });
    const connection = JSON.parse(await readFile(prepared.configPath, 'utf8'));
    const hooks = JSON.parse(await readFile(join(prepared.pluginRoot, 'hooks', 'hooks.json'), 'utf8'));
    const handlers = Object.values(hooks.hooks).flatMap(groups => groups.flatMap(group => group.hooks));
    assert.match(connection.nodeExecutable, /node\.exe$/i);
    assert.deepEqual(connection.runtimeEnv, {});
    for (const handler of handlers) {
      assert.equal(handler.command, connection.nodeExecutable);
      assert.deepEqual(handler.args, [join(prepared.pluginRoot, 'runtime', 'hook.mjs'), '--connection', prepared.configPath, '--host', 'claude-code']);
      assert.doesNotMatch(handler.command, /powershell/i);
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('off keeps the session facts and only updates an existing binding', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'jarvisync-recording-command-'));
  const config = configFor(stateDir);
  const session = { host: config.host, profileId: config.profileId, sessionId };
  const calls = [];
  const client = {
    async discover() { return { revision: 7, binding: { projectId: 'project-1', recording: true } }; },
    async attach(body) { calls.push(body); return { revision: 8, binding: { projectId: 'project-1', recording: false } }; },
  };
  try {
    await writeSessionState(config, session, { lastEvent: 'SessionStart' });
    const result = await recordingCommand({ action: 'off', config, sessionId, client });
    const state = await readSessionState(config, session);
    assert.equal(result.localIntent, 'off');
    assert.equal(result.remote.state, 'updated');
    assert.equal(state.explicitRecordingOverride, false);
    assert.equal(state.lastEvent, 'SessionStart');
    assert.equal(calls.length, 1);
    assert.deepEqual(Object.keys(calls[0]).sort(), ['clientOperationId', 'expectedRevision', 'recording', 'session']);
    assert.equal(calls[0].recording, false);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('recording command merges its choice into the newest session state', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'jarvisync-recording-command-'));
  const config = configFor(stateDir);
  const session = { host: config.host, profileId: config.profileId, sessionId };
  let release;
  let locked;
  const hasLock = new Promise(resolve => { locked = resolve; });
  const mayFinish = new Promise(resolve => { release = resolve; });
  try {
    await writeSessionState(config, session, { lastEvent: 'SessionStart', interrupted: false });
    const concurrent = updateSessionState(config, session, async current => {
      locked();
      await mayFinish;
      return { ...current, lastEvent: 'Interrupt', interrupted: true, observedBinding: 'new-binding' };
    });
    await hasLock;

    const command = recordingCommand({
      action: 'off',
      config,
      sessionId,
      client: { async discover() { return { revision: 7, binding: null }; } },
    });
    release();
    await concurrent;
    const result = await command;
    const state = await readSessionState(config, session);
    assert.equal(result.localIntent, 'off');
    assert.equal(state.explicitRecordingOverride, false);
    assert.equal(state.interrupted, true);
    assert.equal(state.lastEvent, 'Interrupt');
    assert.equal(state.observedBinding, 'new-binding');
  } finally {
    release?.();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('on for an unbound session records only a local recovery intent', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'jarvisync-recording-command-'));
  const config = configFor(stateDir);
  const client = { async discover() { return { revision: 4, binding: null }; }, async attach() { throw new Error('不应关联'); } };
  try {
    const result = await recordingCommand({ action: 'on', config, sessionId, client });
    const state = await readSessionState(config, { host: config.host, profileId: config.profileId, sessionId });
    assert.equal(result.localIntent, 'on');
    assert.deepEqual(result.remote, { state: 'unbound', revision: 4 });
    assert.equal(state.explicitRecordingOverride, true);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('off and on update only an existing live binding', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'jarvisync-recording-live-'));
  const app = await startServer({ port: 0, dataDir });
  try {
    await app.onboarding.prepare({ host: 'claude-code', scope: 'work' });
    const profile = (await app.onboarding.read()).profiles.find(item => item.host === 'claude-code');
    const config = JSON.parse(await readFile(profile.configPath, 'utf8'));
    const client = createClient(config);
    const session = { host: config.host, profileId: config.profileId, sessionId };
    const initial = await client.discover(session);
    await client.attach({ session, clientOperationId: 'create-live-binding', expectedRevision: initial.revision, create: { title: '隔离记录命令', nodes: [] } });

    const off = await recordingCommand({ action: 'off', config, sessionId });
    assert.equal(off.remote.state, 'updated');
    assert.equal((await client.discover(session)).binding.recording, false);
    assert.equal((await readSessionState(config, session)).recordingDisabled, true);

    const on = await recordingCommand({ action: 'on', config, sessionId });
    assert.equal(on.remote.state, 'updated');
    assert.equal((await client.discover(session)).binding.recording, true);
    assert.equal((await readSessionState(config, session)).recordingDisabled, false);
    const current = await client.discover(session);
    const written = await client.change({
      session,
      clientOperationId: 'write-after-recording-on',
      expectedRevision: current.revision,
      change: { type: 'node.create', projectId: current.binding.projectId, title: '恢复后正常写入' },
    });
    assert.equal(written.committed, true);
    assert.equal((await app.store.read()).nodes.find(node => node.id === written.saved.id).title, '恢复后正常写入');

    await updateSessionState(config, session, state => ({ ...state, interrupted: true }));
    const onWhileInterrupted = await recordingCommand({ action: 'on', config, sessionId });
    assert.equal(onWhileInterrupted.remote.state, 'updated');
    assert.equal((await readSessionState(config, session)).interrupted, true);
    const interruptedRevision = (await client.discover(session)).revision;
    await assert.rejects(client.change({
      session,
      clientOperationId: 'write-after-on-while-interrupted',
      expectedRevision: interruptedRevision,
      change: { type: 'node.create', projectId: current.binding.projectId, title: '中断时不应写入' },
    }), error => error.status === 409 && error.details?.code === 'session-interrupted');
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
