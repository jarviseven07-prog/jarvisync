import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { startServer } from '../server/index.mjs';
import { createClient, loadConnection } from '../integrations/runtime/client.mjs';
import { createToolHandler } from '../integrations/runtime/mcp.mjs';
import { getProgressCheckpoint, PROGRESS_REMINDER_MS } from '../server/progress-checkpoint.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'jarvisync-progress-'));
  const app = await startServer({ port: 0, dataDir: directory });
  t.after(async () => {
    await app.close();
    if (dirname(directory) === tmpdir() && basename(directory).startsWith('jarvisync-progress-')) await rm(directory, { recursive: true, force: true });
  });
  const profile = await app.onboarding.prepare({ host: 'mcp', scope: 'work' });
  const config = await loadConnection(profile.configPath);
  const client = createClient({ ...config, autoStart: false });
  const session = { host: 'mcp', profileId: profile.id, sessionId: 'progress-session' };
  const execute = createToolHandler(config, client);
  const attach = await execute('jarvisync_attach', {
    sessionId: session.sessionId, clientOperationId: 'attach', expectedRevision: (await app.store.read()).revision,
    create: { title: '进展演练', nodes: [{ key: 'work', title: '工作', dependsOn: [], independentReason: '独立演练入口' }] }, nodeKey: 'work',
  });
  const nodeId = attach.binding.nodeId;
  const start = await execute('jarvisync_start', { sessionId: session.sessionId, clientOperationId: 'start', expectedRevision: attach.revision, nodeId, owner: 'test' });
  const status = () => client.request('status', { session });
  return { app, client, session, execute, nodeId, runId: start.runId, status, start, profile, config };
}

test('真实 HTTP/MCP 进展检查点不被布局、重复正文或旧回执刷新', async t => {
  const f = await fixture(t);
  assert.equal((await f.status()).progressCheckpoint.reminderDue, false);
  const old = new Date(Date.now() - PROGRESS_REMINDER_MS - 60_000).toISOString();
  await f.app.store.transact(board => {
    const binding = board.agentBindings.find(item => item.sessionId === f.session.sessionId);
    binding.progressCheckpoint.at = old;
    board.revision++;
    return { next: board, result: null };
  });
  const before = await f.app.store.read();
  const moved = await f.client.change({ session: f.session, clientOperationId: 'move', expectedRevision: before.revision,
    change: { type: 'node.update', id: f.nodeId, patch: { position: { x: 321, y: 123 } } } });
  assert.equal((await f.status()).progressCheckpoint.lastProgressAt, old);
  assert.equal((await f.client.discover(f.session)).progressCheckpoint.reminderDue, true);
  assert.equal((await f.client.context({ session: f.session })).progressCheckpoint.reminderDue, true);
  const progress = { sessionId: f.session.sessionId, clientOperationId: 'progress', expectedRevision: moved.revision,
    nodeId: f.nodeId, runId: f.runId, progress: '已定位原因，进入修复', next: '实施后验证' };
  const saved = await f.execute('jarvisync_progress', progress);
  const checkpoint = (await f.status()).progressCheckpoint;
  assert.notEqual(checkpoint.lastProgressAt, old);
  assert.equal(checkpoint.reminderDue, false);
  await f.execute('jarvisync_progress', { ...progress, clientOperationId: 'same-content', expectedRevision: saved.revision });
  assert.equal((await f.status()).progressCheckpoint.lastProgressAt, checkpoint.lastProgressAt);
  await f.execute('jarvisync_progress', progress);
  assert.equal((await f.status()).progressCheckpoint.lastProgressAt, checkpoint.lastProgressAt);
});

test('提醒在中断、停止与停用时清空，正常请求恢复后仍只反映真实执行', async t => {
  const f = await fixture(t);
  await f.client.request('event', { session: f.session, event: 'Interrupt' });
  assert.equal((await f.status()).progressCheckpoint, null);
  assert.equal((await f.client.discover(f.session)).progressCheckpoint, null);
  assert.equal((await f.client.context({ session: f.session })).progressCheckpoint, null);
  await f.client.request('event', { session: f.session, event: 'UserPromptSubmit', turnId: 'resumed-turn' });
  assert.equal((await f.status()).progressCheckpoint.runId, f.runId);
  let revision = (await f.app.store.read()).revision;
  const disabled = await f.client.attach({ session: f.session, clientOperationId: 'disable', expectedRevision: revision, recording: false });
  assert.equal((await f.status()).progressCheckpoint, null);
  const enabled = await f.client.attach({ session: f.session, clientOperationId: 'enable', expectedRevision: disabled.revision, recording: true });
  await f.client.change({ session: f.session, clientOperationId: 'stop', expectedRevision: enabled.revision,
    change: { type: 'node.stop', id: f.nodeId, runId: f.runId, reason: '测试执行已实际停止' } });
  assert.equal((await f.status()).progressCheckpoint, null);
  assert.equal((await f.client.context({ session: f.session })).progressCheckpoint, null);
});

test('无执行、旧绑定、人工结束与未来时钟都不会错误催写', () => {
  const at = '2026-01-01T00:00:00.000Z';
  const binding = { host: 'mcp', profileId: 'profile', sessionId: 'session', projectId: 'p', nodeId: 'n', runId: 'run', recording: true };
  const board = { projects: [{ id: 'p' }], nodes: [{ id: 'n', projectId: 'p', executions: [{ id: 'run', startedAt: at }] }] };
  assert.equal(getProgressCheckpoint(board, binding, { now: Date.parse(at) - 1000 }).reminderDue, false);
  assert.equal(getProgressCheckpoint(board, { ...binding, runId: 'old' }), null);
  assert.equal(getProgressCheckpoint(board, { ...binding, runId: undefined }), null);
  assert.equal(getProgressCheckpoint(board, binding, { interrupted: true }), null);
  board.humanEndedSessions = [{ host: 'mcp', profileId: 'profile', sessionId: 'session' }];
  assert.equal(getProgressCheckpoint(board, binding), null);
});

test('更新现有通用 MCP 接入刷新代码并保留绑定、凭据和会话记录', async t => {
  const f = await fixture(t);
  const before = await f.app.store.read();
  const oldConfig = JSON.parse(await readFile(f.profile.configPath, 'utf8'));
  const runtime = join(f.profile.pluginRoot, 'runtime/mcp.mjs');
  await writeFile(runtime, '// old integration\n');
  const result = await f.app.onboarding.install({ profileId: f.profile.id });
  assert.equal(result.id, f.profile.id);
  assert.equal(result.installation, 'manual');
  assert.match(await readFile(runtime, 'utf8'), /independentReason/);
  const config = JSON.parse(await readFile(f.profile.configPath, 'utf8'));
  for (const key of ['boardInstanceId', 'connectionToken', 'profileId', 'host', 'stateDir']) assert.equal(config[key], oldConfig[key]);
  assert.deepEqual(await f.app.store.read(), before);
  assert.equal((await f.status()).progressCheckpoint.runId, f.runId);
});
