import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { startServer } from '../server/index.mjs';
import { atomicJson, createClient, digest, loadConnection } from '../integrations/runtime/client.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'nodeboard-conflict-resolution-'));
  const app = await startServer({ port: 0, dataDir: directory });
  t.after(async () => {
    await app.close();
    if (dirname(directory) === tmpdir() && basename(directory).startsWith('nodeboard-conflict-resolution-')) await rm(directory, { recursive: true, force: true });
  });
  const profile = await app.onboarding.prepare({ host: 'mcp', scope: 'work' });
  const config = await loadConnection(profile.configPath);
  config.autoStart = false;
  const session = { host: 'mcp', profileId: profile.id, sessionId: 'resolution-session-A' };
  return { app, config, client: createClient(config), session };
}

const pendingPath = (f, id) => join(f.config.stateDir, 'pending', `${digest(id)}.json`);
const resolutionPath = (f, id) => join(f.config.stateDir, 'resolved', `${digest(id)}.json`);
const resolutionClaimPath = (f, id) => join(f.config.stateDir, 'resolution-claims', `${digest(id)}.json`);

if (process.platform === 'win32') {
  // A fresh windows-latest VM pays a one-time Defender real-time scan plus .NET
  // Framework cold initialization on the first powershell.exe spawn, and that
  // first spawn occasionally exceeded the old 15s readiness deadline (CI run
  // 35310475639 timed out at exactly 15048ms with empty stderr while the next
  // test's helper spawned in well under a second on the same VM). Pay that cold
  // start here, before any per-test timer runs, so the lock helpers below
  // always spawn into a warm binary cache.
  before(async () => {
    await new Promise(resolve => {
      const warmup = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { stdio: 'ignore', windowsHide: true });
      warmup.once('close', resolve);
      warmup.once('error', resolve);
    });
  });
}

async function lockWithoutDeleteSharing(path) {
  // The helper holds the destination open without FILE_SHARE_DELETE, which is
  // exactly the condition atomicJson has to outlast. Readiness is decided by
  // observing that condition on the file system — renaming the destination
  // must fail — instead of trusting a stdout deadline, so PowerShell startup
  // jitter can no longer fail the test: it proceeds exactly once the lock is
  // verifiably in force. The open loop tolerates the destination being renamed
  // away for a few milliseconds by the readiness probe below.
  const script = [
    '$stream = $null',
    '$deadline = [DateTime]::UtcNow.AddSeconds(60)',
    'while ($null -eq $stream) {',
    "  try { $stream = [System.IO.File]::Open($env:JARVISYNC_TEST_LOCK_PATH, 'Open', 'Read', 'ReadWrite') }",
    '  catch [System.IO.IOException] { if ([DateTime]::UtcNow -ge $deadline) { throw } Start-Sleep -Milliseconds 25 }',
    '}',
    "[Console]::Out.WriteLine('LOCKED')",
    '[Console]::Out.Flush()',
    '[Console]::In.ReadLine() | Out-Null',
    '$stream.Dispose()',
  ].join('\n');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, JARVISYNC_TEST_LOCK_PATH: path },
    windowsHide: true,
  });
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve([code, signal])));
  let output = '';
  let errorOutput = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errorOutput += chunk; });
  await new Promise((resolve, reject) => {
    const probe = `${path}.lockprobe`;
    // Ceiling for genuinely broken helpers (spawn failure, early exit, never
    // locking) only; startup jitter never reaches it because readiness is
    // effect-based and the binary was warmed up before the test timer started.
    const timer = setTimeout(() => {
      finish();
      reject(new Error(`lock helper did not make the destination rename-proof within 18s (stdout: ${output}, stderr: ${errorOutput})`));
    }, 18000);
    const onError = error => { finish(); reject(error); };
    const onExit = code => { finish(); reject(new Error(`lock helper exited with ${code} before locking (stderr: ${errorOutput})`)); };
    child.once('error', onError);
    child.once('exit', onExit);
    function finish() {
      clearTimeout(timer);
      child.off('error', onError);
      child.off('exit', onExit);
    }
    (async () => {
      try {
        // Confirm the lock by its effect, twice in a row, so a transient hold
        // by scanner software cannot be mistaken for the helper's handle.
        // Every successful probe rename is undone immediately; the helper's
        // open loop above simply retries while the path is briefly absent.
        let consecutive = 0;
        for (;;) {
          try { await rename(path, probe); }
          catch (error) {
            if (['EACCES', 'EBUSY', 'EPERM'].includes(error.code)) {
              if (++consecutive >= 2) { finish(); resolve(); return; }
              await new Promise(wait => setTimeout(wait, 50));
              continue;
            }
            throw error;
          }
          consecutive = 0;
          await rename(probe, path);
          await new Promise(wait => setTimeout(wait, 10));
        }
      } catch (error) { finish(); reject(error); }
    })();
  }).catch(async error => {
    child.kill();
    await closed;
    throw error;
  });
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    const alreadyExited = child.exitCode !== null || child.signalCode !== null;
    const timer = setTimeout(() => child.kill(), 3000);
    let result;
    try {
      if (!alreadyExited) child.stdin.end('\n');
      result = await closed;
    } finally { clearTimeout(timer); }
    const [code, signal] = result;
    if (code !== 0 || signal) throw new Error(`lock helper exited with ${code ?? signal}: ${errorOutput}`);
  };
}

test('atomicJson 在 Windows 临时占用解除后完成原子替换并清理临时文件', { skip: process.platform !== 'win32', timeout: 25000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nodeboard-atomic-json-'));
  const path = join(directory, 'pending.json');
  await atomicJson(path, { state: 'before' });
  let release;
  t.after(async () => {
    try { await release?.(); }
    finally {
      if (dirname(directory) === tmpdir() && basename(directory).startsWith('nodeboard-atomic-json-')) await rm(directory, { recursive: true, force: true });
    }
  });
  release = await lockWithoutDeleteSharing(path);

  let outcome = 'pending';
  let writeError;
  const write = atomicJson(path, { state: 'after' }).then(
    () => { outcome = 'fulfilled'; },
    error => { outcome = 'rejected'; writeError = error; return error; },
  );
  let temporaryObserved = false;
  for (let attempt = 0; attempt < 100 && outcome === 'pending'; attempt++) {
    temporaryObserved = (await readdir(directory)).some(name => name.startsWith('pending.json.') && name.endsWith('.tmp'));
    if (temporaryObserved) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  if (temporaryObserved) await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(outcome, 'pending', writeError?.message);
  assert.equal(temporaryObserved, true);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { state: 'before' });
  assert.equal((await readdir(directory)).some(name => name.startsWith('pending.json.') && name.endsWith('.tmp')), true);
  await release();
  // Slow runners can take a moment to observe the unlock and finish the
  // pending rename; poll instead of assuming the write resolves immediately.
  for (let attempt = 0; attempt < 200 && outcome === 'pending'; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(outcome, 'fulfilled', writeError?.message);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { state: 'after' });
  assert.deepEqual((await readdir(directory)).filter(name => name.endsWith('.tmp')), []);
});

test('atomicJson 对 Windows 持续占用有界失败并清理临时文件', { skip: process.platform !== 'win32', timeout: 25000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nodeboard-atomic-json-'));
  const path = join(directory, 'pending.json');
  await atomicJson(path, { state: 'before' });
  let release;
  t.after(async () => {
    try { await release?.(); }
    finally {
      if (dirname(directory) === tmpdir() && basename(directory).startsWith('nodeboard-atomic-json-')) await rm(directory, { recursive: true, force: true });
    }
  });
  release = await lockWithoutDeleteSharing(path);

  await assert.rejects(atomicJson(path, { state: 'after' }), error => ['EACCES', 'EBUSY', 'EPERM'].includes(error.code));
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { state: 'before' });
  assert.deepEqual((await readdir(directory)).filter(name => name.endsWith('.tmp')), []);
  await release();
});

async function createBoundNode(f, prefix = 'work') {
  return f.client.attach({
    session: f.session,
    clientOperationId: `${prefix}-attach`,
    expectedRevision: (await f.app.store.read()).revision,
    create: { title: `${prefix} project`, nodes: [{ key: 'node', dependsOn: [], independentReason: '独立测试任务，无需上游成果', title: `${prefix} node` }] },
    nodeKey: 'node',
  });
}

async function queueRevisionConflict(f, prefix) {
  const attached = await createBoundNode(f, prefix);
  const id = `${prefix}-revision-conflict`;
  const expectedRevision = attached.revision;
  await f.app.store.change(expectedRevision, { type: 'node.update', id: attached.nodeIdsByKey.node, patch: { progress: `${prefix} external update` } });
  await assert.rejects(f.client.change({
    session: f.session, clientOperationId: id, expectedRevision,
    change: { type: 'node.update', id: attached.nodeIdsByKey.node, patch: { progress: `${prefix} retried body` } },
  }), error => error.status === 409 && error.details?.code === 'revision-conflict');
  return { attached, id, reviewedRevision: (await f.app.store.read()).revision };
}

test('跨项目 409 经确认重新关联后只用替代 ID 重试一次，原 pending 不能复用', async t => {
  const f = await fixture(t);
  await createBoundNode(f, 'first');
  let board = await f.app.store.read();
  await f.app.store.change(board.revision, { type: 'project.create', title: 'other project' });
  board = await f.app.store.read();
  const otherProject = board.projects.at(-1);
  await f.app.store.change(board.revision, { type: 'node.create', projectId: otherProject.id, title: 'other node' });
  const otherNode = (await f.app.store.read()).nodes.at(-1);
  const failedId = 'cross-project-progress';
  const failed = {
    session: f.session,
    clientOperationId: failedId,
    expectedRevision: (await f.app.store.read()).revision,
    change: { type: 'node.update', id: otherNode.id, patch: { progress: 'reviewed, then written once' } },
  };
  await assert.rejects(f.client.change(failed), error => error.status === 409 && error.details?.code === 'binding-scope-conflict');
  assert.equal(JSON.parse(await readFile(pendingPath(f, failedId), 'utf8')).state, 'needs-review');

  const rebound = await f.client.attach({
    session: f.session,
    clientOperationId: 'confirm-cross-project',
    expectedRevision: (await f.app.store.read()).revision,
    projectId: otherProject.id,
    confirmRebind: true,
  });
  const retried = await f.client.resolvePending({ session: f.session, clientOperationId: failedId, resolution: 'retry', expectedRevision: rebound.revision });
  assert.equal(retried.state, 'retried');
  assert.notEqual(retried.replacementOperationId, failedId);
  assert.equal((await f.app.store.read()).nodes.find(node => node.id === otherNode.id).progress, 'reviewed, then written once');
  assert.deepEqual(await readdir(join(f.config.stateDir, 'pending')), []);
  assert.equal((await readdir(join(f.config.stateDir, 'resolved'))).length, 1);
  await assert.rejects(f.client.change({ ...failed, expectedRevision: retried.outcome.revision }), error => error.status === 409 && error.details?.code === 'operation-resolved');
});

test('当前节点正文正确时，另一项目的合法写入推进全局版本后可在读上下文后 retry 一次', async t => {
  const f = await fixture(t);
  const attached = await createBoundNode(f, 'revision');
  let board = await f.app.store.read();
  await f.app.store.change(board.revision, { type: 'project.create', title: 'independent project' });
  board = await f.app.store.read();
  const otherProject = board.projects.at(-1);
  await f.app.store.change(board.revision, { type: 'node.create', projectId: otherProject.id, title: 'independent node' });
  const otherNode = (await f.app.store.read()).nodes.at(-1);
  const id = 'global-revision-conflict';
  const expectedRevision = (await f.app.store.read()).revision;
  await f.app.store.change(expectedRevision, { type: 'node.update', id: otherNode.id, patch: { progress: 'a legitimate update from another project' } });
  await assert.rejects(f.client.change({
    session: f.session, clientOperationId: id, expectedRevision,
    change: { type: 'node.update', id: attached.nodeIdsByKey.node, patch: { progress: 'the original correct node body' } },
  }), error => error.status === 409 && error.details?.code === 'revision-conflict');
  const context = await f.client.context({ session: f.session });
  const retried = await f.client.resolvePending({ session: f.session, clientOperationId: id, resolution: 'retry', expectedRevision: context.revision });
  assert.equal(retried.state, 'retried');
  const saved = await f.app.store.read();
  assert.equal(saved.nodes.find(node => node.id === attached.nodeIdsByKey.node).progress, 'the original correct node body');
  assert.equal(saved.nodes.find(node => node.id === otherNode.id).progress, 'a legitimate update from another project');
  assert.equal(saved.revision, context.revision + 1);
});

test('两 client 在同一待核对请求上竞争不同决议时，只会保存其中一个决定', async t => {
  const f = await fixture(t);
  const pending = await queueRevisionConflict(f, 'different-decision');
  const before = await f.app.store.read();
  const left = createClient(f.config);
  const right = createClient(f.config);
  const originalFetch = globalThis.fetch;
  let discoverCount = 0;
  let releaseDiscover;
  const discoverGate = new Promise(resolve => { releaseDiscover = resolve; });
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/api/agent/discover')) {
      discoverCount++;
      if (discoverCount === 2) releaseDiscover();
      await discoverGate;
    }
    return originalFetch(url, options);
  };
  let results;
  try {
    results = await Promise.allSettled([
      left.resolvePending({ session: f.session, clientOperationId: pending.id, resolution: 'retry', expectedRevision: pending.reviewedRevision }),
      right.resolvePending({ session: f.session, clientOperationId: pending.id, resolution: 'discard', expectedRevision: pending.reviewedRevision }),
    ]);
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(discoverCount, 2);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const winner = results.find(result => result.status === 'fulfilled').value;
  const loser = results.find(result => result.status === 'rejected').reason;
  assert.equal(loser.details?.code, 'resolution-selected');
  const after = await f.app.store.read();
  if (winner.state === 'discarded') {
    assert.deepEqual(after, before);
    const retryAfterDiscard = await createClient(f.config).resolvePending({ session: f.session, clientOperationId: pending.id, resolution: 'retry', expectedRevision: before.revision });
    assert.equal(retryAfterDiscard.state, 'discarded');
    assert.deepEqual(await f.app.store.read(), before);
  } else {
    assert.equal(winner.state, 'retried');
    assert.equal(after.revision, before.revision + 1);
    assert.equal(after.nodes.find(node => node.id === pending.attached.nodeIdsByKey.node).progress, 'different-decision retried body');
  }
});

test('同一 retry 并发共享替代请求 ID，业务变更只提交一次', async t => {
  const f = await fixture(t);
  const pending = await queueRevisionConflict(f, 'same-retry');
  const before = await f.app.store.read();
  const first = createClient(f.config);
  const second = createClient(f.config);
  const originalFetch = globalThis.fetch;
  let discoverCount = 0;
  let releaseDiscover;
  const discoverGate = new Promise(resolve => { releaseDiscover = resolve; });
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/api/agent/discover')) {
      discoverCount++;
      if (discoverCount === 2) releaseDiscover();
      await discoverGate;
    }
    return originalFetch(url, options);
  };
  let results;
  try {
    results = await Promise.allSettled([
      first.resolvePending({ session: f.session, clientOperationId: pending.id, resolution: 'retry', expectedRevision: pending.reviewedRevision }),
      second.resolvePending({ session: f.session, clientOperationId: pending.id, resolution: 'retry', expectedRevision: pending.reviewedRevision }),
    ]);
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(discoverCount, 2);
  const rejections = results.filter(result => result.status === 'rejected').map(result => ({
    message: result.reason?.message,
    code: result.reason?.details?.code,
    details: result.reason?.details,
  }));
  assert.deepEqual(rejections, []);
  const receipts = results.map(result => result.value);
  assert.ok(receipts.every(receipt => receipt.replacementOperationId === receipts[0].replacementOperationId));
  const after = await f.app.store.read();
  assert.equal(after.revision, before.revision + 1);
  assert.equal(after.nodes.find(node => node.id === pending.attached.nodeIdsByKey.node).progress, 'same-retry retried body');
  assert.deepEqual(await readdir(join(f.config.stateDir, 'pending')), []);
  assert.equal((await readdir(join(f.config.stateDir, 'resolved'))).length, 1);
});

test('崩溃在 claim 保存后、映射保存前时，新 client 沿用原 claim 的版本和替代 ID', async t => {
  const f = await fixture(t);
  const pending = await queueRevisionConflict(f, 'claim-crash');
  const claimRevision = pending.reviewedRevision;
  const originalId = pending.id;
  const expectedReplacementId = `resolved-${digest(`${f.session.host}\0${f.session.profileId}\0${f.session.sessionId}\0${originalId}\0${claimRevision}`)}`;
  await atomicJson(resolutionClaimPath(f, originalId), { session: f.session, clientOperationId: originalId, resolution: 'retry', expectedRevision: claimRevision });
  await f.app.store.change(claimRevision, { type: 'node.update', id: pending.attached.nodeIdsByKey.node, patch: { progress: 'new revision after crash' } });
  const rereadRevision = (await f.app.store.read()).revision;
  await assert.rejects(createClient(f.config).resolvePending({ session: f.session, clientOperationId: originalId, resolution: 'retry', expectedRevision: rereadRevision }), error => error.details?.recovery?.clientOperationId === expectedReplacementId);
  const settled = JSON.parse(await readFile(resolutionPath(f, originalId), 'utf8'));
  assert.equal(settled.state, 'replaced');
  assert.equal(settled.replacementOperationId, expectedReplacementId);
  const replacement = JSON.parse(await readFile(pendingPath(f, expectedReplacementId), 'utf8'));
  assert.equal(replacement.body.expectedRevision, claimRevision);
  assert.equal(replacement.body.clientOperationId, expectedReplacementId);
});

test('服务已提交而响应丢失时 resolve 取回原回执，不重复写入', async t => {
  const f = await fixture(t);
  const attached = await createBoundNode(f, 'loss');
  const id = 'response-loss-progress';
  const request = {
    session: f.session, clientOperationId: id, expectedRevision: attached.revision,
    change: { type: 'node.update', id: attached.nodeIdsByKey.node, patch: { progress: 'committed before response loss' } },
  };
  const originalFetch = globalThis.fetch;
  let dropped = false;
  globalThis.fetch = async (url, options) => {
    const response = await originalFetch(url, options);
    if (!dropped && String(url).endsWith('/api/agent/change')) { dropped = true; await response.text(); throw new TypeError('response lost after commit'); }
    return response;
  };
  try { await assert.rejects(f.client.change(request), error => error.status === 0); }
  finally { globalThis.fetch = originalFetch; }
  const beforeResolve = await f.app.store.read();
  const recovered = await f.client.resolvePending({ session: f.session, clientOperationId: id, resolution: 'retry', expectedRevision: beforeResolve.revision });
  assert.equal(recovered.state, 'recovered');
  assert.equal(recovered.outcome.clientOperationId, id);
  assert.deepEqual(await f.app.store.read(), beforeResolve);
  assert.deepEqual(await readdir(join(f.config.stateDir, 'pending')), []);
  assert.ok(await readFile(resolutionPath(f, id), 'utf8'));
});

test('discard 仅结清失败 pending，不改看板内容', async t => {
  const f = await fixture(t);
  const attached = await createBoundNode(f, 'discard');
  const id = 'discard-missing-node';
  const before = await f.app.store.read();
  await assert.rejects(f.client.change({
    session: f.session, clientOperationId: id, expectedRevision: attached.revision,
    change: { type: 'node.update', id: 'node-that-does-not-exist', patch: { progress: 'must not write' } },
  }), error => error.status === 404);
  assert.deepEqual(await f.app.store.read(), before);
  const discarded = await f.client.resolvePending({ session: f.session, clientOperationId: id, resolution: 'discard', expectedRevision: before.revision });
  assert.equal(discarded.state, 'discarded');
  assert.deepEqual(await f.app.store.read(), before);
  await assert.rejects(readFile(pendingPath(f, id)), error => error.code === 'ENOENT');
});

test('中断、其他会话和已变化运行均不能 retry', async t => {
  const interrupted = await fixture(t);
  const attached = await createBoundNode(interrupted, 'interrupt');
  const interruptedId = 'interrupt-pending';
  await assert.rejects(interrupted.client.change({ session: interrupted.session, clientOperationId: interruptedId, expectedRevision: attached.revision, change: { type: 'node.update', id: 'missing-node', patch: { progress: 'pending' } } }), error => error.status === 404);
  await interrupted.client.request('event', { session: interrupted.session, event: 'Interrupt' });
  await assert.rejects(interrupted.client.resolvePending({ session: interrupted.session, clientOperationId: interruptedId, resolution: 'retry', expectedRevision: (await interrupted.app.store.read()).revision }), error => error.details?.code === 'session-interrupted');

  const stale = await fixture(t);
  const started = await createBoundNode(stale, 'stale');
  const run = await stale.client.change({ session: stale.session, clientOperationId: 'stale-start', expectedRevision: started.revision, change: { type: 'node.start', id: started.nodeIdsByKey.node, owner: 'test host', model: null, modelSource: 'host-unavailable', executionRef: 'mcp:test:stale-run' } });
  const staleId = 'stale-run-pending';
  await assert.rejects(stale.client.change({ session: stale.session, clientOperationId: staleId, expectedRevision: run.revision, change: { type: 'node.run.update', id: started.nodeIdsByKey.node, runId: 'old-run-id', patch: { progress: 'old work' } } }), error => error.details?.code === 'stale-run');
  await assert.rejects(stale.client.resolvePending({ session: stale.session, clientOperationId: staleId, resolution: 'retry', expectedRevision: run.revision }), error => error.details?.code === 'stale-run');
  await assert.rejects(stale.client.resolvePending({ session: { ...stale.session, sessionId: 'resolution-session-B' }, clientOperationId: staleId, resolution: 'retry', expectedRevision: run.revision }), error => error.status === 403);
});

test('幂等冲突和超出回执窗口的未知请求均不能 retry', async t => {
  const conflict = await fixture(t);
  const attached = await createBoundNode(conflict, 'conflict');
  const id = 'same-id-different-body';
  await conflict.client.change({ session: conflict.session, clientOperationId: id, expectedRevision: attached.revision, change: { type: 'node.update', id: attached.nodeIdsByKey.node, patch: { progress: 'first committed value' } } });
  await assert.rejects(conflict.client.change({ session: conflict.session, clientOperationId: id, expectedRevision: (await conflict.app.store.read()).revision, change: { type: 'node.update', id: attached.nodeIdsByKey.node, patch: { progress: 'conflicting value' } } }), error => error.details?.code === 'idempotency-conflict');
  await assert.rejects(conflict.client.resolvePending({ session: conflict.session, clientOperationId: id, resolution: 'retry', expectedRevision: (await conflict.app.store.read()).revision }), error => error.details?.code === 'idempotency-conflict');
  assert.equal(JSON.parse(await readFile(pendingPath(conflict, id), 'utf8')).errorCode, 'idempotency-conflict');

  const expired = await fixture(t);
  const expAttached = await createBoundNode(expired, 'expired');
  const expiredId = 'expired-unknown-pending';
  await assert.rejects(expired.client.change({ session: expired.session, clientOperationId: expiredId, expectedRevision: expAttached.revision, change: { type: 'node.update', id: 'missing-node', patch: { progress: 'unknown history' } } }), error => error.status === 404);
  await expired.app.store.transact(board => ({
    next: { ...board, revision: board.revision + 1, agentOperationReplayFloorRevision: expAttached.revision },
    result: null,
  }));
  const current = await expired.app.store.read();
  await assert.rejects(expired.client.resolvePending({ session: expired.session, clientOperationId: expiredId, resolution: 'retry', expectedRevision: current.revision }), error => error.status === 410 && error.details?.code === 'operation-expired');
  assert.ok(await readFile(pendingPath(expired, expiredId), 'utf8'));
});

test('崩溃遗留的替代请求映射可由新 client 恢复回执，resolve 与 flush 都不重放原请求', async t => {
  const f = await fixture(t);
  const attached = await createBoundNode(f, 'crash');
  const queueCrashPoint = async (originalId, progress) => {
    const expectedRevision = (await f.app.store.read()).revision;
    const replacementId = `resolved-${digest(`${f.session.host}\0${f.session.profileId}\0${f.session.sessionId}\0${originalId}\0${expectedRevision}`)}`;
    const change = { type: 'node.update', id: attached.nodeIdsByKey.node, patch: { progress } };
    const replacement = await f.client.change({ session: f.session, clientOperationId: replacementId, expectedRevision, change });
    await atomicJson(pendingPath(f, originalId), {
      action: 'change',
      body: { session: f.session, clientOperationId: originalId, expectedRevision, change },
      state: 'needs-review',
      error: 'process exited after replacement commit and before settlement',
      resolutionAttempt: { clientOperationId: replacementId, expectedRevision },
    });
    return replacement;
  };
  const directReplacement = await queueCrashPoint('crash-original-resolve', 'saved by replacement receipt');
  const flushReplacement = await queueCrashPoint('crash-original-flush', 'saved by flush replacement receipt');
  const restarted = createClient(f.config);
  const beforeRecovery = await f.app.store.read();
  const resolved = await restarted.resolvePending({ session: f.session, clientOperationId: 'crash-original-resolve', resolution: 'retry', expectedRevision: beforeRecovery.revision });
  assert.equal(resolved.state, 'recovered');
  assert.equal(resolved.outcome.clientOperationId, directReplacement.clientOperationId);
  assert.deepEqual(await f.app.store.read(), beforeRecovery);

  const flushed = await restarted.flush(f.session);
  const recoveredByFlush = flushed.results.find(result => result.clientOperationId === 'crash-original-flush');
  assert.equal(recoveredByFlush.state, 'recovered');
  assert.equal(recoveredByFlush.outcome.clientOperationId, flushReplacement.clientOperationId);
  assert.deepEqual(await f.app.store.read(), beforeRecovery);
  assert.deepEqual(await readdir(join(f.config.stateDir, 'pending')), []);
});
