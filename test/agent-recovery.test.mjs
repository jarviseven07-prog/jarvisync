import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicJson, createClient } from '../integrations/runtime/client.mjs';
import { computeBuildIdentity } from '../integrations/runtime/build-identity.mjs';
import { writeSessionState } from '../integrations/runtime/hook.mjs';

const session = { host: 'codex', profileId: 'profile-1', sessionId: 'recovery-thread' };

async function isolated(run) {
  const stateDir = await mkdtemp(join(tmpdir(), 'jarvisync-agent-recovery-'));
  try { await run(stateDir); }
  finally { await rm(stateDir, { recursive: true, force: true }); }
}

async function serve(handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

function reply(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

function config(url, stateDir) {
  return { url, boardInstanceId: 'board-recovery', stateDir, host: session.host, profileId: session.profileId, connectionToken: 'token' };
}

async function runtimeFixture(stateDir, { reportedBuildId = null } = {}) {
  const sourceRoot = join(stateDir, 'runtime-source');
  const distDir = join(sourceRoot, 'dist');
  await Promise.all(['server', 'shared', 'integrations', 'dist'].map(name => mkdir(join(sourceRoot, name), { recursive: true })));
  const marker = join(stateDir, 'untrusted-source-ran');
  await writeFile(join(sourceRoot, 'server', 'build-identity.mjs'), `import { writeFile } from 'node:fs/promises'; await writeFile(${JSON.stringify(marker)}, 'ran');`, 'utf8');
  await writeFile(join(sourceRoot, 'shared', 'runtime.mjs'), 'export const runtime = true;\n', 'utf8');
  await writeFile(join(sourceRoot, 'integrations', 'runtime.mjs'), 'export const integration = true;\n', 'utf8');
  await writeFile(join(distDir, 'index.html'), '<main>fixture</main>\n', 'utf8');
  const server = [
    "import { createServer } from 'node:http';",
    "import { writeFile } from 'node:fs/promises';",
    "import { join } from 'node:path';",
    "const dataDir = process.env.NODEBOARD_DATA_DIR;",
    `const responseBuildId = ${JSON.stringify(reportedBuildId)};`,
    "const server = createServer((req, res) => { res.writeHead(200, {'Content-Type': 'application/json'}); res.end(JSON.stringify({ boardInstanceId: 'board-recovery', buildId: responseBuildId })); });",
    "server.listen(Number(process.env.PORT || 0), '127.0.0.1', async () => { const port = server.address().port; await writeFile(join(dataDir, 'agent-endpoint.json'), JSON.stringify({ boardInstanceId: 'board-recovery', url: `http://127.0.0.1:${port}` })); });",
  ].join('\n');
  await writeFile(join(sourceRoot, 'server', 'index.mjs'), server, 'utf8');
  return { sourceRoot, distDir, marker, runtimeBuild: await computeBuildIdentity({ root: sourceRoot, distDir }) };
}

test('离线自动启动只接受安装时保存的运行身份，且不会导入待核验源码', async () => isolated(async stateDir => {
  const fixture = await runtimeFixture(stateDir);
  await atomicJson(join(stateDir, 'instance.json'), { boardInstanceId: 'board-recovery' });
  await atomicJson(join(stateDir, 'board.json'), { revision: 1 });
  await writeFile(join(fixture.sourceRoot, 'shared', 'runtime.mjs'), 'export const runtime = false;\n', 'utf8');
  const client = createClient({ ...config('http://127.0.0.1:1', stateDir), autoStart: true, dataDir: stateDir, nodeExecutable: process.execPath,
    serverEntry: join(fixture.sourceRoot, 'server', 'index.mjs'), runtimeBuild: { ...fixture.runtimeBuild, sourceRoot: fixture.sourceRoot, distDir: fixture.distDir } });
  await assert.rejects(client.ensure(), error => error.status === 409 && /运行文件已变更/.test(error.message));
  await assert.rejects(stat(fixture.marker));
}));

test('离线自动启动等待的新服务必须回报安装时的构建标识', async () => isolated(async stateDir => {
  const fixture = await runtimeFixture(stateDir, { reportedBuildId: 'wrong-build-id' });
  await atomicJson(join(stateDir, 'instance.json'), { boardInstanceId: 'board-recovery' });
  await atomicJson(join(stateDir, 'board.json'), { revision: 1 });
  const client = createClient({ ...config('http://127.0.0.1:1', stateDir), autoStart: true, dataDir: stateDir, nodeExecutable: process.execPath,
    serverEntry: join(fixture.sourceRoot, 'server', 'index.mjs'), runtimeBuild: { ...fixture.runtimeBuild, sourceRoot: fixture.sourceRoot, distDir: fixture.distDir } });
  await assert.rejects(client.ensure(), error => error.status === 409 && /构建标识/.test(error.message));
}));

test('写入前授权预检遇 403 不创建 pending，也不调用变更接口', async () => isolated(async stateDir => {
  const actions = [];
  const app = await serve((req, res) => {
    if (req.url === '/api/health') return reply(res, 200, { boardInstanceId: 'board-recovery' });
    actions.push(req.url);
    if (req.url === '/api/agent/status') return reply(res, 403, { error: '此 Agent 的自动记录已停用。' });
    return reply(res, 500, { error: '不应调用' });
  });
  try {
    const client = createClient(config(app.url, stateDir));
    await assert.rejects(client.change({ session, clientOperationId: 'disabled-write', expectedRevision: 0, change: { type: 'node.update' } }), error => error.status === 403);
    assert.deepEqual(actions, ['/api/agent/status']);
    assert.deepEqual(await readdir(join(stateDir, 'pending')).catch(() => []), []);
  } finally { await app.close(); }
}));

test('会话或操作 ID 不完整时在授权预检前拒绝且不写 pending', async () => isolated(async stateDir => {
  const actions = [];
  const app = await serve((req, res) => {
    if (req.url === '/api/health') return reply(res, 200, { boardInstanceId: 'board-recovery' });
    actions.push(req.url);
    return reply(res, 200, { enabled: true });
  });
  try {
    const client = createClient(config(app.url, stateDir));
    await assert.rejects(client.change({ session: { host: session.host, profileId: session.profileId }, clientOperationId: 'bad-session' }), error => error.status === 400);
    await assert.rejects(client.change({ session, clientOperationId: '   ' }), error => error.status === 400);
    assert.deepEqual(actions, []);
    assert.deepEqual(await readdir(join(stateDir, 'pending')).catch(() => []), []);
  } finally { await app.close(); }
}));

test('授权预检后若写入竞态返回 403，移除本次新建 pending', async () => isolated(async stateDir => {
  const actions = [];
  const app = await serve((req, res) => {
    if (req.url === '/api/health') return reply(res, 200, { boardInstanceId: 'board-recovery' });
    actions.push(req.url);
    if (req.url === '/api/agent/status') return reply(res, 200, { enabled: true });
    if (req.url === '/api/agent/change') return reply(res, 403, { error: '此 Agent 的自动记录已停用。' });
    return reply(res, 500, { error: 'unexpected' });
  });
  try {
    const client = createClient(config(app.url, stateDir));
    await assert.rejects(client.change({ session, clientOperationId: 'disabled-race', expectedRevision: 0, change: { type: 'node.update' } }), error => error.status === 403);
    assert.deepEqual(actions, ['/api/agent/status', '/api/agent/change']);
    assert.deepEqual(await readdir(join(stateDir, 'pending')), []);
  } finally { await app.close(); }
}));

test('授权预检网络不可达时保留原请求供以后核对', async () => isolated(async stateDir => {
  const app = await serve((_req, res) => reply(res, 200, {}));
  const url = app.url;
  await app.close();
  const client = createClient(config(url, stateDir));
  const body = { session, clientOperationId: 'offline-write', expectedRevision: 3, change: { type: 'node.update', id: 'n-1', patch: { next: '待同步' } } };
  await assert.rejects(client.change(body), error => error.status === 0);
  const names = await readdir(join(stateDir, 'pending'));
  assert.equal(names.length, 1);
  const pending = JSON.parse(await readFile(join(stateDir, 'pending', names[0]), 'utf8'));
  assert.equal(pending.action, 'change');
  assert.deepEqual(pending.body, body);
  assert.equal(pending.state, 'pending');
}));

test('服务离线时本地停用或中断状态阻止新 mutate 落入 pending', async () => isolated(async stateDir => {
  const app = await serve((_req, res) => reply(res, 200, {}));
  const url = app.url;
  await app.close();
  const cfg = config(url, stateDir);
  const client = createClient(cfg);
  const body = state => ({ session: { ...session, sessionId: `local-${state}` }, clientOperationId: `offline-${state}`, expectedRevision: 3, change: { type: 'node.update', id: 'n-1', patch: { next: '不应保存' } } });

  const disabledBody = body('disabled');
  await writeSessionState(cfg, disabledBody.session, { recordingDisabled: true, interrupted: false });
  await assert.rejects(client.change(disabledBody), error => error.status === 403 && error.details?.code === 'recording-disabled');

  const interruptedBody = body('interrupted');
  await writeSessionState(cfg, interruptedBody.session, { recordingDisabled: false, interrupted: true });
  await assert.rejects(client.change(interruptedBody), error => error.status === 409 && error.details?.code === 'session-interrupted');
  assert.deepEqual(await readdir(join(stateDir, 'pending')).catch(() => []), []);
}));

test('显式 on 只放行 recording 恢复请求，不放开离线业务写入', async () => isolated(async stateDir => {
  const app = await serve((_req, res) => reply(res, 200, {}));
  const url = app.url;
  await app.close();
  const cfg = config(url, stateDir);
  const client = createClient(cfg);
  const selectedSession = { ...session, sessionId: 'explicit-recording-on' };
  await writeSessionState(cfg, selectedSession, { recordingDisabled: true, explicitRecordingOverride: true, interrupted: false });

  await assert.rejects(client.change({
    session: selectedSession, clientOperationId: 'ordinary-write-stays-blocked', expectedRevision: 3,
    change: { type: 'node.update', id: 'n-1', patch: { next: '不应保存' } },
  }), error => error.status === 403 && error.details?.code === 'recording-disabled');
  assert.deepEqual(await readdir(join(stateDir, 'pending')).catch(() => []), []);

  const mixedEnable = { session: selectedSession, clientOperationId: 'mixed-enable', expectedRevision: 3, projectId: 'p-1', recording: true };
  await assert.rejects(client.attach(mixedEnable), error => error.status === 403 && error.details?.code === 'recording-disabled');
  assert.deepEqual(await readdir(join(stateDir, 'pending')).catch(() => []), []);

  const enable = { session: selectedSession, clientOperationId: 'explicit-enable', expectedRevision: 3, recording: true };
  await assert.rejects(client.attach(enable), error => error.status === 0);
  const names = await readdir(join(stateDir, 'pending'));
  assert.equal(names.length, 1);
  const pending = JSON.parse(await readFile(join(stateDir, 'pending', names[0]), 'utf8'));
  assert.equal(pending.action, 'attach');
  assert.deepEqual(pending.body, enable);
}));

test('显式 on 可穿过旧的远端停用状态提交恢复，但普通写入仍被拒绝', async () => isolated(async stateDir => {
  const actions = [];
  const app = await serve((req, res) => {
    if (req.url === '/api/health') return reply(res, 200, { boardInstanceId: 'board-recovery' });
    actions.push(req.url);
    if (req.url === '/api/agent/status') return reply(res, 200, { enabled: false });
    if (req.url === '/api/agent/attach') return reply(res, 200, { revision: 4, binding: { projectId: 'p-1', recording: true } });
    return reply(res, 500, { error: 'unexpected' });
  });
  try {
    const cfg = config(app.url, stateDir);
    const client = createClient(cfg);
    const selectedSession = { ...session, sessionId: 'explicit-recording-online' };
    await writeSessionState(cfg, selectedSession, { recordingDisabled: true, explicitRecordingOverride: true, interrupted: false });

    await assert.rejects(client.change({
      session: selectedSession, clientOperationId: 'online-ordinary-stays-blocked', expectedRevision: 3,
      change: { type: 'node.update', id: 'n-1', patch: { next: '不应保存' } },
    }), error => error.status === 403);
    await assert.rejects(client.attach({ session: selectedSession, clientOperationId: 'online-mixed-enable', expectedRevision: 3, projectId: 'p-1', recording: true }), error => error.status === 403 && error.details?.code === 'recording-disabled');
    const enabled = await client.attach({ session: selectedSession, clientOperationId: 'online-enable', expectedRevision: 3, recording: true });
    assert.equal(enabled.binding.recording, true);
    assert.deepEqual(actions, ['/api/agent/status', '/api/agent/attach']);
    assert.deepEqual(await readdir(join(stateDir, 'pending')).catch(() => []), []);
  } finally { await app.close(); }
}));

test('本地显式 off 在线时也先拦截普通写入和混合 attach，只放行纯停用请求', async () => isolated(async stateDir => {
  const actions = [];
  const app = await serve((req, res) => {
    if (req.url === '/api/health') return reply(res, 200, { boardInstanceId: 'board-recovery' });
    actions.push(req.url);
    if (req.url === '/api/agent/status') return reply(res, 200, { enabled: true });
    if (req.url === '/api/agent/attach') return reply(res, 200, { revision: 4, binding: { recording: false } });
    return reply(res, 500, { error: 'unexpected' });
  });
  try {
    const cfg = config(app.url, stateDir);
    const client = createClient(cfg);
    const selectedSession = { ...session, sessionId: 'explicit-recording-off-online' };
    await writeSessionState(cfg, selectedSession, { recordingDisabled: false, explicitRecordingOverride: false, interrupted: false });

    await assert.rejects(client.change({
      session: selectedSession, clientOperationId: 'off-change-blocked', expectedRevision: 3,
      change: { type: 'node.update', id: 'n-1', patch: { next: '不应保存' } },
    }), error => error.status === 403 && error.details?.code === 'recording-disabled');
    await assert.rejects(client.attach({
      session: selectedSession, clientOperationId: 'off-create-blocked', expectedRevision: 3,
      create: { title: '不应创建', nodes: [] }, recording: false,
    }), error => error.status === 403 && error.details?.code === 'recording-disabled');
    assert.deepEqual(actions, []);
    assert.deepEqual(await readdir(join(stateDir, 'pending')).catch(() => []), []);

    const disabled = await client.attach({ session: selectedSession, clientOperationId: 'off-toggle', expectedRevision: 3, recording: false });
    assert.equal(disabled.binding.recording, false);
    assert.deepEqual(actions, ['/api/agent/status', '/api/agent/attach']);
  } finally { await app.close(); }
}));

test('sticky 中断阻止 flush；下一用户请求清除后才允许重放', async () => isolated(async stateDir => {
  const actions = [];
  const app = await serve((req, res) => {
    if (req.url === '/api/health') return reply(res, 200, { boardInstanceId: 'board-recovery' });
    actions.push(req.url);
    if (req.url === '/api/agent/operation') return reply(res, 200, { outcome: null });
    if (req.url === '/api/agent/discover') return reply(res, 200, { revision: 4, binding: { projectId: 'p-1', nodeId: 'n-1', runId: 'run-1' } });
    if (req.url === '/api/agent/change') return reply(res, 200, { revision: 5, saved: { id: 'n-1' } });
    return reply(res, 500, { error: 'unexpected' });
  });
  try {
    const cfg = config(app.url, stateDir);
    const client = createClient(cfg);
    const body = { session, clientOperationId: 'sticky-replay', expectedRevision: 4, change: { type: 'node.run.update', id: 'n-1', runId: 'run-1', patch: { progress: '恢复写入' } } };
    await atomicJson(join(stateDir, 'pending', 'a'.repeat(64) + '.json'), { action: 'change', body, state: 'pending', queuedAt: '2026-09-10T00:00:00.000Z' });
    await writeSessionState(cfg, session, { interrupted: true });
    await assert.rejects(client.flush(session), error => error.status === 409 && error.details?.code === 'session-interrupted');
    assert.deepEqual(actions, []);
    assert.equal((await readdir(join(stateDir, 'pending'))).length, 1);

    await writeSessionState(cfg, session, { interrupted: false });
    const recovered = await client.flush(session);
    assert.equal(recovered.results[0].state, 'recovered');
    assert.deepEqual(actions, ['/api/agent/operation', '/api/agent/discover', '/api/agent/change']);
    assert.deepEqual(await readdir(join(stateDir, 'pending')), []);
  } finally { await app.close(); }
}));

test('takeover 走同一授权预检和 pending 可靠写入包装', async () => isolated(async stateDir => {
  const actions = [];
  const app = await serve((req, res) => {
    if (req.url === '/api/health') return reply(res, 200, { boardInstanceId: 'board-recovery' });
    actions.push(req.url);
    if (req.url === '/api/agent/status') return reply(res, 200, { enabled: true });
    if (req.url === '/api/agent/takeover') return reply(res, 200, { revision: 8, runId: 'run-new' });
    return reply(res, 500, { error: 'unexpected' });
  });
  try {
    const client = createClient(config(app.url, stateDir));
    const result = await client.takeover({ session, clientOperationId: 'takeover-write', expectedRevision: 7, nodeId: 'n-1', previousRunId: 'run-old' });
    assert.equal(result.runId, 'run-new');
    assert.deepEqual(actions, ['/api/agent/status', '/api/agent/takeover']);
    assert.deepEqual(await readdir(join(stateDir, 'pending')), []);
  } finally { await app.close(); }
}));

test('atomicJson 重写后只留下已同步且可解析的目标文件', async () => isolated(async stateDir => {
  const path = join(stateDir, 'nested', 'state.json');
  await atomicJson(path, { revision: 1 });
  await atomicJson(path, { revision: 2, value: '完成' });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { revision: 2, value: '完成' });
  assert.deepEqual(await readdir(join(stateDir, 'nested')), ['state.json']);
}));

test('回执窗口外的未知结果不能当成已提交，也不能删掉或重放待同步请求', async () => isolated(async stateDir => {
  const actions = [];
  const app = await serve((req, res) => {
    if (req.url === '/api/health') return reply(res, 200, { boardInstanceId: 'board-recovery' });
    actions.push(req.url);
    if (req.url === '/api/agent/operation') return reply(res, 200, { outcome: { state: 'unknown', replayFloorRevision: 300 } });
    return reply(res, 500, { error: '过期请求不应继续访问业务接口' });
  });
  try {
    const client = createClient(config(app.url, stateDir));
    const path = join(stateDir, 'pending', 'b'.repeat(64) + '.json');
    await atomicJson(path, { action: 'attach', body: { session, expectedRevision: 5, clientOperationId: 'expired-creation', create: { title: '原任务', nodes: [] } }, state: 'pending' });
    const result = await client.flush(session);
    assert.equal(result.results[0].state, 'needs-review');
    assert.match(result.results[0].error, /保留窗口/);
    assert.deepEqual(actions, ['/api/agent/operation']);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).body.clientOperationId, 'expired-creation');
  } finally { await app.close(); }
}));

test('紧凑已提交回执足以收敛响应丢失，无需完整业务正文', async () => isolated(async stateDir => {
  const actions = [];
  const receipt = { committed: true, revision: 9, clientOperationId: 'compact-result', binding: { projectId: 'p-1', nodeId: 'n-1', runId: 'run-1' }, saved: { type: 'node', id: 'n-1', status: 'done' } };
  const app = await serve((req, res) => {
    if (req.url === '/api/health') return reply(res, 200, { boardInstanceId: 'board-recovery' });
    actions.push(req.url);
    if (req.url === '/api/agent/operation') return reply(res, 200, { outcome: receipt });
    return reply(res, 500, { error: '已提交无需重复请求' });
  });
  try {
    const client = createClient(config(app.url, stateDir));
    await atomicJson(join(stateDir, 'pending', 'c'.repeat(64) + '.json'), { action: 'change', body: { session, expectedRevision: 8, clientOperationId: 'compact-result', change: { type: 'node.deliver', id: 'n-1', runId: 'run-1', summary: '原结果' } }, state: 'pending' });
    const result = await client.flush(session);
    assert.equal(result.results[0].state, 'recovered');
    assert.deepEqual(result.results[0].outcome, receipt);
    assert.deepEqual(actions, ['/api/agent/operation']);
    assert.deepEqual(await readdir(join(stateDir, 'pending')), []);
  } finally { await app.close(); }
}));
