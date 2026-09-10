import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { startServer } from '../server/index.mjs';
import { loadConnection } from '../integrations/runtime/client.mjs';
import { createToolHandler, toolDefinitions } from '../integrations/runtime/mcp.mjs';

test('工具预检明确拒绝缺失验证值和不完整节点参数，不发送业务请求', async () => {
  let calls = 0;
  const execute = createToolHandler({ host: 'mcp', profileId: 'isolated' }, { request: async () => { calls++; }, change: async () => { calls++; } });
  for (const args of [{ phase: 'write' }, { phase: 'readback', receipt: 'r' }, { phase: 'readback', challenge: 'c' }]) {
    await assert.rejects(execute('jarvisync_verify', { sessionId: 'test-session', ...args }), /必填参数/);
  }
  const common = { sessionId: 'test-session', clientOperationId: 'create', expectedRevision: 1 };
  await assert.rejects(execute('jarvisync_change', { ...common, change: { type: 'node.create', title: '后续成果' } }), /对应字段/);
  await assert.rejects(execute('jarvisync_change', { ...common, change: { type: 'node.create', projectId: 'p', title: '后续成果', goal: '此字段应在 patch 中' } }), /对应字段/);
  await assert.rejects(execute('jarvisync_change', { ...common, expectedRevision: '1', change: { type: 'edge.remove', id: 'e' } }), /integer/);
  await assert.rejects(execute('jarvisync_progress', { ...common, nodeId: 'n', runId: 'r' }), /缺少所需字段/);
  await assert.rejects(execute('jarvisync_context', { sessionId: common.sessionId, nodeId: 'n', projectId: 'p' }), /互斥参数/);
  await assert.rejects(execute('jarvisync_attach', { ...common, projectId: 'p', create: { title: 'p', nodes: [] } }), /互斥参数/);
  await assert.rejects(execute('jarvisync_attach', { ...common, nodeKey: 'n' }), /缺少所需字段/);
  assert.equal(calls, 0);
  const definition = toolDefinitions.find(tool => tool.name === 'jarvisync_change').inputSchema.properties.change;
  const create = definition.oneOf.find(item => item.properties.type.const === 'node.create');
  assert.deepEqual(create.required, ['type', 'projectId', 'title']);
  assert.equal(create.additionalProperties, false);
  assert.deepEqual(toolDefinitions.find(tool => tool.name === 'jarvisync_verify').inputSchema.oneOf[2].required, ['challenge', 'receipt']);
});

test('resolve 工具传递真实会话及原失败请求身份，不接受替换正文', async () => {
  let received;
  const execute = createToolHandler({ host: 'hermes', profileId: 'p' }, { resolvePending: async args => { received = args; return { state: 'discarded' }; } });
  const args = { sessionId: 'real-session', clientOperationId: 'failed-original', expectedRevision: 12, resolution: 'discard' };
  assert.equal((await execute('jarvisync_resolve', args)).state, 'discarded');
  assert.deepEqual(received, { session: { host: 'hermes', profileId: 'p', sessionId: 'real-session' }, clientOperationId: 'failed-original', expectedRevision: 12, resolution: 'discard' });
  await assert.rejects(execute('jarvisync_resolve', { ...args, change: {} }), /不支持/);
});

test('真实工具可验证、在执行期间建立并补充后续节点、交付后切换同项目节点', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jarvisync-contract-'));
  const app = await startServer({ port: 0, dataDir: directory });
  t.after(async () => { await app.close(); if (dirname(directory) === tmpdir() && basename(directory).startsWith('jarvisync-contract-')) await rm(directory, { recursive: true, force: true }); });
  const response = await fetch(`${app.url}/api/onboarding/prepare`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: app.url, 'X-JarviSync-UI': '1' }, body: JSON.stringify({ host: 'mcp', scope: 'work' }) });
  assert.equal(response.status, 200);
  const profile = await response.json();
  const config = await loadConnection(profile.configPath);
  config.autoStart = false;
  const execute = createToolHandler(config);
  const sessionId = 'isolated-coordinator';
  const initial = await execute('jarvisync_discover', { sessionId });
  const challenge = (await execute('jarvisync_verify', { sessionId, phase: 'read' })).challenge;
  const receipt = (await execute('jarvisync_verify', { sessionId, phase: 'write', challenge })).receipt;
  assert.equal((await execute('jarvisync_verify', { sessionId, phase: 'readback', challenge, receipt })).verified, true);
  const attached = await execute('jarvisync_attach', { sessionId, expectedRevision: initial.revision, clientOperationId: 'attach', create: { title: '顺序成果', nodes: [{ key: 'first', title: '第一项' }] }, nodeKey: 'first' });
  const first = attached.binding.nodeId;
  const started = await execute('jarvisync_start', { sessionId, expectedRevision: attached.revision, clientOperationId: 'start', nodeId: first, owner: '真实测试宿主' });
  const second = await execute('jarvisync_change', { sessionId, expectedRevision: started.revision, clientOperationId: 'second', change: { type: 'node.create', projectId: attached.binding.projectId, title: '新增独立成果' } });
  assert.equal(second.binding.nodeId, first);
  assert.equal(second.binding.runId, started.runId);
  const planned = await execute('jarvisync_change', { sessionId, expectedRevision: second.revision, clientOperationId: 'plan-second', change: { type: 'node.update', id: second.saved.id, patch: { goal: '新增要求', next: '完成第二项', owner: 'Codex', model: '计划模型' } } });
  const linked = await execute('jarvisync_change', { sessionId, expectedRevision: planned.revision, clientOperationId: 'link', change: { type: 'edge.create', projectId: attached.binding.projectId, source: first, target: second.saved.id } });
  const delivered = await execute('jarvisync_deliver', { sessionId, expectedRevision: linked.revision, clientOperationId: 'deliver', nodeId: first, runId: started.runId, summary: '第一项完成' });
  const next = await execute('jarvisync_attach', { sessionId, expectedRevision: delivered.revision, clientOperationId: 'next', nodeId: second.saved.id });
  assert.equal(next.binding.nodeId, second.saved.id);
  assert.equal(next.binding.projectId, attached.binding.projectId);
  assert.equal(next.binding.runId, undefined);
  const board = await app.store.read();
  const node = board.nodes.find(item => item.id === second.saved.id);
  assert.equal(node.goal, '新增要求');
  assert.equal(node.executions?.length || 0, 0);
});
