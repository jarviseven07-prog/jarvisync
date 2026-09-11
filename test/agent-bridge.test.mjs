import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { startServer } from '../server/index.mjs';
import { createClient, digest, loadConnection } from '../integrations/runtime/client.mjs';
import { createToolHandler } from '../integrations/runtime/mcp.mjs';

async function fixture(t, scope = 'work') {
  const directory = await mkdtemp(join(tmpdir(), 'jarvisync-bridge-'));
  const app = await startServer({ port: 0, dataDir: directory });
  t.after(async () => { await app.close(); if (dirname(directory) === tmpdir() && basename(directory).startsWith('jarvisync-bridge-')) await rm(directory, { recursive: true, force: true }); });
  const before = await readFile(join(directory, 'board.json'), 'utf8');
  const body = { host: 'mcp', scope, ...(scope === 'project' ? { projectId: (await app.store.read()).projects[0].id } : {}) };
  const prepared = await fetch(`${app.url}/api/onboarding/prepare`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: app.url, 'X-JarviSync-UI': '1' }, body: JSON.stringify(body) });
  assert.equal(prepared.status, 200, await prepared.clone().text());
  const profile = await prepared.json();
  assert.equal(profile.connectionToken, undefined);
  assert.equal(await readFile(join(directory, 'board.json'), 'utf8'), before);
  const config = await loadConnection(profile.configPath);
  config.autoStart = false;
  const client = createClient(config);
  const session = { host: 'mcp', profileId: profile.id, sessionId: 'real-host-session-A' };
  return { app, directory, profile, config, client, session, execute: createToolHandler(config, client) };
}

test('本机入口隔离验证区真实读写读回，网页不能伪造Agent验收或跨站安装', async t => {
  const f = await fixture(t);
  const before = await f.app.store.read();
  const read = await f.execute('jarvisync_verify', { sessionId: f.session.sessionId, phase: 'read' });
  const write = await f.execute('jarvisync_verify', { sessionId: f.session.sessionId, phase: 'write', challenge: read.challenge });
  const back = await f.execute('jarvisync_verify', { sessionId: f.session.sessionId, phase: 'readback', challenge: read.challenge, receipt: write.receipt });
  assert.equal(back.verified, true);
  assert.deepEqual(await f.app.store.read(), before);
  const status = await (await fetch(`${f.app.url}/api/onboarding`)).json();
  assert.equal(status.profiles[0].verification.readback, true);
  assert.equal(status.profiles[0].hooksObserved, false);
  const attack = await fetch(`${f.app.url}/api/onboarding/enable`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.org', 'X-JarviSync-UI': '1' }, body: JSON.stringify({ profileId: f.profile.id, enabled: false }) });
  assert.equal(attack.status, 403);
  const fake = await fetch(`${f.app.url}/api/agent/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: f.app.url }, body: JSON.stringify({}) });
  assert.equal(fake.status, 403);
  await f.app.onboarding.enable({ profileId: f.profile.id, enabled: false });
  await assert.rejects(f.client.discover(f.session), error => error.status === 403);
  assert.deepEqual(await f.app.store.read(), before);
});

test('MCP工具从创建到交付使用真实服务，缺失模型诚实保存，同目录新会话只读发现', async t => {
  const f = await fixture(t);
  const initial = await f.execute('jarvisync_discover', { sessionId: f.session.sessionId });
  const attached = await f.execute('jarvisync_attach', { sessionId: f.session.sessionId, clientOperationId: 'task-create', expectedRevision: initial.revision, create: { title: '桥接验证项目', nodes: [{ key: 'result', dependsOn: [], independentReason: '独立测试任务，无需上游成果', title: '制作成果' }] } });
  const nodeId = attached.nodeIdsByKey.result;
  const started = await f.execute('jarvisync_start', { sessionId: f.session.sessionId, clientOperationId: 'task-start', expectedRevision: attached.revision, nodeId, owner: 'MCP host' });
  const startedNode = (await f.app.store.read()).nodes.find(node => node.id === nodeId);
  assert.equal(startedNode.executions[0].model, null);
  assert.equal(startedNode.executions[0].modelSource, 'host-unavailable');
  const delivered = await f.execute('jarvisync_deliver', { sessionId: f.session.sessionId, clientOperationId: 'task-deliver', expectedRevision: started.revision, nodeId, runId: started.runId, summary: '独立成果完成', links: ['C:/outputs/result.md'] });
  assert.equal(delivered.saved.status, 'done');
  assert.match((await f.execute('jarvisync_context', { sessionId: f.session.sessionId })).markdown, /独立成果完成/);
  const revision = (await f.app.store.read()).revision;
  const next = await f.client.discover({ ...f.session, sessionId: 'new-conversation', cwd: 'C:/same-directory' });
  assert.equal(next.binding, null);
  assert.ok(next.candidates.some(item => item.projectId === attached.binding.projectId));
  assert.equal((await f.app.store.read()).revision, revision);
});

test('写入已成功但响应丢失时，恢复查原结果，不重复创建或交付', async t => {
  const f = await fixture(t);
  const body = { session: f.session, clientOperationId: 'lost-create', expectedRevision: (await f.app.store.read()).revision, create: { title: '响应丢失演练', nodes: [{ key: 'a', dependsOn: [], independentReason: '独立测试任务，无需上游成果', title: '唯一节点' }] } };
  const originalFetch = globalThis.fetch;
  let dropped = false;
  globalThis.fetch = async (url, options) => {
    const response = await originalFetch(url, options);
    if (String(url).endsWith('/api/agent/attach') && !dropped) { dropped = true; await response.text(); throw new TypeError('simulated response loss after server commit'); }
    return response;
  };
  try { await assert.rejects(f.client.attach(body), error => error.status === 0); }
  finally { globalThis.fetch = originalFetch; }
  const saved = await f.app.store.read();
  assert.equal(saved.projects.filter(p => p.title === '响应丢失演练').length, 1);
  const recovered = await f.client.flush(f.session);
  assert.equal(recovered.results[0].state, 'recovered');
  assert.equal((await readdir(join(f.config.stateDir, 'pending'))).length, 0);
  assert.deepEqual(await f.app.store.read(), saved);
});

test('同一操作 ID 的不同请求冲突后，flush 保留第二份内容供核对', async t => {
  const f = await fixture(t);
  const attached = await f.client.attach({
    session: f.session,
    clientOperationId: 'conflict-project',
    expectedRevision: (await f.app.store.read()).revision,
    create: { title: '冲突回执项目', nodes: [{ key: 'work', dependsOn: [], independentReason: '独立测试任务，无需上游成果', title: '待更新节点' }] },
    nodeKey: 'work',
  });
  const operationId = 'same-id-different-body';
  const first = {
    session: f.session,
    clientOperationId: operationId,
    expectedRevision: attached.revision,
    change: { type: 'node.update', id: attached.binding.nodeId, patch: { progress: '第一份已提交内容' } },
  };
  await f.client.change(first);
  const second = {
    ...first,
    expectedRevision: (await f.app.store.read()).revision,
    change: { type: 'node.update', id: attached.binding.nodeId, patch: { progress: '第二份冲突内容，必须保留待核对' } },
  };
  await assert.rejects(f.client.change(second), error => error.status === 409 && error.details?.code === 'idempotency-conflict');

  const pendingPath = join(f.config.stateDir, 'pending', `${digest(operationId)}.json`);
  const pending = JSON.parse(await readFile(pendingPath, 'utf8'));
  assert.equal(pending.state, 'needs-review');
  assert.equal(pending.errorCode, 'idempotency-conflict');
  assert.equal(pending.body.change.patch.progress, '第二份冲突内容，必须保留待核对');

  const flushed = await f.client.flush(f.session);
  assert.equal(flushed.results[0].state, 'needs-review');
  assert.equal(flushed.results[0].errorCode, 'idempotency-conflict');
  assert.equal(JSON.parse(await readFile(pendingPath, 'utf8')).body.change.patch.progress, '第二份冲突内容，必须保留待核对');
  assert.equal((await f.app.store.read()).nodes.find(node => node.id === attached.binding.nodeId).progress, '第一份已提交内容');
});

test('待同步请求遇到新版本保留待核对，不将旧内容盲目重放', async t => {
  const f = await fixture(t);
  const attached = await f.client.attach({ session: f.session, clientOperationId: 'create-before-offline', expectedRevision: (await f.app.store.read()).revision, create: { title: '断线演练', nodes: [{ key: 'a', dependsOn: [], independentReason: '独立测试任务，无需上游成果', title: '工作' }] } });
  const nodeId = attached.nodeIdsByKey.a;
  const started = await f.execute('jarvisync_start', { sessionId: f.session.sessionId, clientOperationId: 'start-offline', expectedRevision: attached.revision, nodeId, owner: 'MCP host' });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => { if (String(url).endsWith('/api/agent/change')) throw new TypeError('offline before write'); return originalFetch(url, options); };
  try { await assert.rejects(f.client.change({ session: f.session, clientOperationId: 'offline-progress', expectedRevision: started.revision, change: { type: 'node.run.update', id: nodeId, runId: started.binding.runId, patch: { progress: '离线旧内容' } } })); }
  finally { globalThis.fetch = originalFetch; }
  await f.app.store.change(started.revision, { type: 'node.run.update', id: nodeId, runId: started.binding.runId, patch: { progress: '已经更新的内容' } });
  const sync = await f.client.flush(f.session);
  assert.equal(sync.results[0].state, 'needs-review');
  assert.equal((await f.app.store.read()).nodes.find(n => n.id === nodeId).progress, '已经更新的内容');
});

test('用户中断后拒绝迟到写回，新用户请求前不恢复，已提交结果仍可查询', async t => {
  const f = await fixture(t);
  const attached = await f.client.attach({ session: f.session, clientOperationId: 'interrupt-create', expectedRevision: (await f.app.store.read()).revision, create: { title: '中断演练', nodes: [{ key: 'a', dependsOn: [], independentReason: '独立测试任务，无需上游成果', title: '工作' }] } });
  await f.client.request('event', { session: f.session, event: 'UserPromptSubmit', turnId: 'turn-1' });
  const started = await f.execute('jarvisync_start', { sessionId: f.session.sessionId, clientOperationId: 'interrupt-start', expectedRevision: attached.revision, nodeId: attached.nodeIdsByKey.a, owner: 'MCP host' });
  await f.client.request('event', { session: f.session, event: 'Interrupt' });
  const before = await f.app.store.read();
  const request = { session: f.session, clientOperationId: 'late-progress', expectedRevision: started.revision, change: { type: 'node.run.update', id: attached.nodeIdsByKey.a, runId: started.binding.runId, patch: { progress: '迟到内容' } } };
  await assert.rejects(f.client.change(request), error => error.details?.code === 'session-interrupted');
  assert.deepEqual(await f.app.store.read(), before);
  assert.ok((await f.client.operation('interrupt-start', f.session)).outcome);
  await f.client.request('event', { session: f.session, event: 'UserPromptSubmit', turnId: 'turn-2' });
  const pending = await f.client.flush(f.session);
  assert.equal(pending.results[0].state, 'needs-review');
  assert.deepEqual(await f.app.store.read(), before);
});

test('限定项目删除后显示失效并可修改范围，同会话能重新关联新项目', async t => {
  const f = await fixture(t, 'project');
  const oldProject = (await f.app.store.read()).projects[0];
  await f.client.attach({ session: f.session, clientOperationId: 'bind-limited', expectedRevision: (await f.app.store.read()).revision });
  const { prepareHumanChange } = await import('../server/model.mjs');
  await f.app.store.change((await f.app.store.read()).revision, prepareHumanChange({ type: 'project.remove', id: oldProject.id }));
  assert.equal((await f.app.onboarding.status()).profiles[0].scopeInvalid, true);
  const tombstone = (await f.client.operation('bind-limited', f.session)).outcome;
  assert.equal(tombstone.deleted, true);
  assert.equal(tombstone.binding, undefined);
  await assert.rejects(f.client.attach({ session: f.session, clientOperationId: 'deleted-scope', expectedRevision: (await f.app.store.read()).revision }), error => error.details?.code === 'connection-scope-missing');
  await f.app.onboarding.configure({ profileId: f.profile.id, scope: 'work' });
  const created = await f.client.attach({ session: f.session, clientOperationId: 'new-scope-create', expectedRevision: (await f.app.store.read()).revision, create: { title: '改范围后的新项目', nodes: [] } });
  assert.notEqual(created.binding.projectId, oldProject.id);
  assert.equal((await f.app.onboarding.status()).profiles[0].scopeInvalid, false);
});

test('新会话接管须有原宿主中断证据，Stop不算，接管后原会话不能写新执行', async t => {
  const f = await fixture(t);
  const attached = await f.client.attach({ session: f.session, clientOperationId: 'take-create', expectedRevision: (await f.app.store.read()).revision, create: { title: '真实接续', nodes: [{ key: 'a', dependsOn: [], independentReason: '独立测试任务，无需上游成果', title: '未完成节点' }] } });
  const nodeId = attached.nodeIdsByKey.a;
  const started = await f.execute('jarvisync_start', { sessionId: f.session.sessionId, clientOperationId: 'take-start', expectedRevision: attached.revision, nodeId, owner: 'old host' });
  const nextSession = { ...f.session, sessionId: 'new-host-conversation' };
  const rebound = await f.client.attach({ session: nextSession, clientOperationId: 'take-attach', projectId: attached.binding.projectId, nodeId, expectedRevision: started.revision });
  const request = { sessionId: nextSession.sessionId, clientOperationId: 'take-over', nodeId, expectedRevision: rebound.revision, previousRunId: started.binding.runId, reason: '原宿主已中断，继续已交办工作', confirmation: 'host-observed', owner: 'new host' };
  await f.client.request('event', { session: f.session, event: 'Stop' });
  await assert.rejects(f.execute('jarvisync_takeover', request), error => error.details?.code === 'takeover-stop-unconfirmed');
  await f.client.request('event', { session: f.session, event: 'Interrupt' });
  const taken = await f.execute('jarvisync_takeover', request);
  assert.notEqual(taken.runId, started.binding.runId);
  const takenNode = (await f.app.store.read()).nodes.find(node => node.id === nodeId);
  assert.equal(takenNode.executions[0].stopConfirmation, 'host-observed');
  assert.equal(takenNode.executions[0].stoppedByRunId, taken.runId);
  assert.deepEqual((await f.client.operation('take-over', nextSession)).outcome, taken);
  await f.client.request('event', { session: f.session, event: 'UserPromptSubmit', turnId: 'late-resume' });
  await assert.rejects(f.execute('jarvisync_progress', { sessionId: f.session.sessionId, clientOperationId: 'late-after-takeover', nodeId, runId: started.binding.runId, expectedRevision: taken.revision, progress: '旧会话迟到结果' }), error => error.details?.code === 'stale-run');
});

test('stdio MCP遵循初始化和工具协议，插件路径含中文空格仍能读写验证', async t => {
  const f = await fixture(t);
  const child = spawn(process.execPath, [join(f.profile.pluginRoot, 'runtime', 'mcp.mjs')], { env: { ...process.env, JARVISYNC_CONNECTION: f.profile.configPath }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let sequence = 0;
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => { const result = JSON.parse(line); const waiter = pending.get(result.id); if (waiter) { pending.delete(result.id); waiter(result); } });
  const rpc = (method, params) => new Promise((ok, fail) => { const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); fail(new Error('MCP timeout')); }, 12000); pending.set(id, result => { clearTimeout(timer); ok(result); }); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const initialized = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'isolated-test', version: '1.0' } });
  assert.equal(initialized.result.serverInfo.name, 'jarvisync');
  const tools = (await rpc('tools/list')).result.tools;
  assert.equal(tools.length, 11);
  assert.ok(tools.some(tool => tool.name === 'jarvisync_resolve'));
  const read = await rpc('tools/call', { name: 'jarvisync_verify', arguments: { sessionId: 'stdio-session', phase: 'read' } });
  assert.equal(read.result.isError, undefined);
  assert.ok(JSON.parse(read.result.content[0].text).challenge);
  child.stdin.end();
  await new Promise(ok => child.once('exit', ok));
});

test('原服务关闭后按固定实例后台启动，未绑定的数据目录绝不生成第三份看板', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jarvisync-bridge-headless-'));
  let app = await startServer({ port: 0, dataDir: directory });
  let childPid;
  try {
    const profile = await app.onboarding.prepare({ host: 'mcp', scope: 'work' });
    const config = await loadConnection(profile.configPath);
    const original = await readFile(join(directory, 'board.json'), 'utf8');
    const identity = JSON.parse(await readFile(join(directory, 'instance.json'), 'utf8'));
    await app.close(); app = null;
    const result = await createClient(config).discover({ host: config.host, profileId: profile.id, sessionId: 'headless-session' });
    assert.equal(result.boardInstanceId, identity.boardInstanceId);
    const endpoint = JSON.parse(await readFile(join(directory, 'agent-endpoint.json'), 'utf8'));
    assert.equal(endpoint.boardInstanceId, identity.boardInstanceId);
    assert.notEqual(endpoint.pid, process.pid);
    childPid = endpoint.pid;
    assert.equal(await readFile(join(directory, 'board.json'), 'utf8'), original);
    const missing = { ...config, url: 'http://127.0.0.1:1', dataDir: join(directory, 'missing-original') };
    await assert.rejects(createClient(missing).discover({ host: config.host, profileId: profile.id, sessionId: 'missing-session' }), error => error.status === 409);
    await assert.rejects(readFile(join(missing.dataDir, 'board.json')), error => error.code === 'ENOENT');
  } finally {
    if (app) await app.close();
    if (childPid) {
      process.kill(childPid, 'SIGTERM');
      for (let i = 0; i < 40; i++) { try { process.kill(childPid, 0); } catch { break; } await new Promise(ok => setTimeout(ok, 50)); }
    }
    if (dirname(directory) === tmpdir() && basename(directory).startsWith('jarvisync-bridge-headless-')) await rm(directory, { recursive: true, force: true });
  }
});
