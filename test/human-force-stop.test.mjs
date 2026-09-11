import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { openAgentService } from '../server/agent-service.mjs';
import { startServer } from '../server/index.mjs';
import { BoardError, prepareHumanChange } from '../server/model.mjs';
import { openStore } from '../server/store.mjs';
import { createClient, loadConnection } from '../integrations/runtime/client.mjs';

const sessionA = { host: 'codex', profileId: 'local-user', sessionId: 'force-a', cwd: 'C:/workspace' };
const sessionB = { host: 'claude-code', profileId: 'local-user', sessionId: 'force-b', cwd: 'C:/workspace' };
const sessionC = { host: 'codex', profileId: 'other-profile', sessionId: 'force-c', cwd: 'C:/workspace' };
const replacementSession = { host: 'codex', profileId: 'local-user', sessionId: 'force-replacement', cwd: 'C:/workspace' };
const freshAfterRemovalSession = { host: 'codex', profileId: 'local-user', sessionId: 'force-after-removal', cwd: 'C:/workspace' };

async function isolated(run) {
  const directory = await mkdtemp(join(tmpdir(), 'jarvisync-human-force-stop-'));
  const resolved = resolve(directory);
  assert.ok(dirname(resolved) === resolve(tmpdir()) && basename(resolved).startsWith('jarvisync-human-force-stop-') && resolved.startsWith(`${resolve(tmpdir())}${sep}`));
  const store = await openStore(directory);
  try {
    await run({ store, service: openAgentService({ store }) });
  } finally {
    await store.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}

function request(store, values) {
  return { boardInstanceId: store.boardInstanceId, ...values };
}

async function createProject({ store, service }, session, operation, title, nodes, nodeKey) {
  const board = await store.read();
  return service.attach(request(store, {
    session,
    clientOperationId: `${operation}-attach`,
    expectedRevision: board.revision,
    create: { title, summary: `${title}摘要`, nodes },
    nodeKey,
  }));
}

async function attachNode({ store, service }, session, operation, projectId, nodeId) {
  const board = await store.read();
  return service.attach(request(store, {
    session,
    clientOperationId: `${operation}-attach`,
    expectedRevision: board.revision,
    projectId,
    nodeId,
  }));
}

async function change({ store, service }, session, operation, payload) {
  const board = await store.read();
  return service.change(request(store, {
    session,
    clientOperationId: operation,
    expectedRevision: board.revision,
    change: payload,
  }));
}

async function startRun(fixture, session, operation, nodeId) {
  return change(fixture, session, operation, {
    type: 'node.start',
    id: nodeId,
    executionRef: `host:${operation}`,
    owner: `执行者-${operation}`,
    model: 'test-model',
    modelSource: 'host',
  });
}

test('项目人工结束精确结束快照中的全部活动运行，保留内容并隔离其他项目', async () => isolated(async fixture => {
  const { store, service } = fixture;
  const first = await createProject(fixture, sessionA, 'multi-a', '目标项目', [
    { key: 'a', dependsOn: [], independentReason: '独立测试任务，无需上游成果', title: '任务 A' },
    { key: 'b', dependsOn: [], independentReason: '独立测试任务，无需上游成果', title: '任务 B' },
  ], 'a');
  const nodeA = first.nodeIdsByKey.a;
  const nodeB = first.nodeIdsByKey.b;
  await change(fixture, sessionA, 'multi-a-before', { type: 'node.update', id: nodeA, patch: { decisions: '保留决定', links: ['C:/result-a'] } });
  const runA = await startRun(fixture, sessionA, 'multi-a-start', nodeA);
  await change(fixture, sessionA, 'multi-a-progress', { type: 'node.run.update', id: nodeA, runId: runA.runId, patch: { progress: '保留进展', next: '保留下一步', question: '保留问题' } });

  await attachNode(fixture, sessionB, 'multi-b', first.binding.projectId, nodeB);
  const runB = await startRun(fixture, sessionB, 'multi-b-start', nodeB);

  const other = await createProject(fixture, sessionC, 'other', '其他项目', [{ key: 'c', dependsOn: [], independentReason: '独立测试任务，无需上游成果', title: '任务 C' }], 'c');
  const runC = await startRun(fixture, sessionC, 'other-start', other.nodeIdsByKey.c);

  const duplicateBindingId = `b-${randomUUID()}`;
  await store.transact(board => {
    const at = new Date().toISOString();
    board.agentBindings.push({
      id: duplicateBindingId,
      host: 'codex',
      profileId: 'duplicate-profile',
      sessionId: 'duplicate-session',
      projectId: first.binding.projectId,
      nodeId: nodeA,
      runId: runA.runId,
      recording: true,
      createdAt: at,
      updatedAt: at,
    });
    board.revision++;
    return { next: board, result: null };
  });

  const before = await store.read();
  const beforeA = structuredClone(before.nodes.find(node => node.id === nodeA));
  const beforeOther = structuredClone(before.nodes.find(node => node.id === other.nodeIdsByKey.c));
  const stopped = await store.change(before.revision, prepareHumanChange({
    type: 'project.force-stop',
    id: first.binding.projectId,
    executions: [
      { nodeId: nodeB, runId: runB.runId },
      { nodeId: nodeA, runId: runA.runId },
    ],
  }));

  const stoppedA = stopped.nodes.find(node => node.id === nodeA);
  const stoppedB = stopped.nodes.find(node => node.id === nodeB);
  for (const [node, runId] of [[stoppedA, runA.runId], [stoppedB, runB.runId]]) {
    assert.equal(node.status, 'blocked');
    assert.deepEqual(node.executions.find(run => run.id === runId), {
      ...before.nodes.find(item => item.id === node.id).executions.find(run => run.id === runId),
      endedAt: node.executions.find(run => run.id === runId).endedAt,
      outcome: 'stopped',
      humanEnded: true,
    });
    assert.ok(Date.parse(node.executions.find(run => run.id === runId).endedAt));
    assert.deepEqual(node.deliveries ?? [], []);
  }
  assert.equal(stoppedA.progress, beforeA.progress);
  assert.equal(stoppedA.next, beforeA.next);
  assert.equal(stoppedA.question, beforeA.question);
  assert.equal(stoppedA.decisions, beforeA.decisions);
  assert.deepEqual(stoppedA.links, beforeA.links);
  assert.deepEqual(stopped.nodes.find(node => node.id === other.nodeIdsByKey.c), beforeOther);
  assert.equal(stopped.nodes.find(node => node.id === other.nodeIdsByKey.c).executions.at(-1).id, runC.runId);

  const revoked = stopped.agentBindings.filter(binding => binding.nodeId === nodeA && binding.runId === runA.runId);
  assert.equal(revoked.length, 2);
  assert.ok(revoked.every(binding => binding.humanEndedAt === stoppedA.executions.at(-1).endedAt));
  assert.equal(stopped.agentBindings.find(binding => binding.id === first.binding.id).humanEndedAt, stoppedA.executions.at(-1).endedAt);
  assert.equal(stopped.agentBindings.find(binding => binding.id === duplicateBindingId).humanEndedAt, stoppedA.executions.at(-1).endedAt);
  assert.equal(stopped.agentBindings.find(binding => binding.projectId === other.binding.projectId).humanEndedAt, undefined);
  assert.equal(stopped.humanEndedSessions.length, 3);
  assert.equal(stopped.humanEndedSessions.some(item => item.sessionId === sessionC.sessionId), false);
}));

test('项目快照、节点 runId、全局版本和字段校验任一不匹配都不产生部分结束', async () => isolated(async fixture => {
  const { store, service } = fixture;
  const attached = await createProject(fixture, sessionA, 'cas', '快照项目', [
    { key: 'a', dependsOn: [], independentReason: '独立测试任务，无需上游成果', title: '任务 A' },
    { key: 'b', dependsOn: [], independentReason: '独立测试任务，无需上游成果', title: '任务 B' },
  ], 'a');
  const runA = await startRun(fixture, sessionA, 'cas-a-start', attached.nodeIdsByKey.a);
  await attachNode(fixture, sessionB, 'cas-b', attached.binding.projectId, attached.nodeIdsByKey.b);
  const runB = await startRun(fixture, sessionB, 'cas-b-start', attached.nodeIdsByKey.b);
  const baseline = await store.read();

  const rejectsWithoutMutation = async (expectedRevision, payload, check) => {
    await assert.rejects(store.change(expectedRevision, prepareHumanChange(payload)), check);
    assert.deepEqual(await store.read(), baseline);
  };
  await rejectsWithoutMutation(baseline.revision, {
    type: 'project.force-stop', id: attached.binding.projectId,
    executions: [{ nodeId: attached.nodeIdsByKey.a, runId: runA.runId }],
  }, error => error instanceof BoardError && error.status === 409 && error.details?.code === 'force-stop-snapshot-conflict' && error.details.currentExecutions.length === 2);
  await rejectsWithoutMutation(baseline.revision, {
    type: 'project.force-stop', id: attached.binding.projectId,
    executions: [
      { nodeId: attached.nodeIdsByKey.a, runId: runA.runId },
      { nodeId: attached.nodeIdsByKey.a, runId: runA.runId },
    ],
  }, /不能包含重复运行/);
  await rejectsWithoutMutation(baseline.revision, {
    type: 'node.force-stop', id: attached.nodeIdsByKey.a, runId: runB.runId,
  }, error => error instanceof BoardError && error.status === 409 && error.details?.code === 'force-stop-run-conflict' && error.details.currentRunId === runA.runId);
  await rejectsWithoutMutation(baseline.revision - 1, {
    type: 'node.force-stop', id: attached.nodeIdsByKey.a, runId: runA.runId,
  }, error => error instanceof BoardError && error.status === 409);
  await rejectsWithoutMutation(baseline.revision, {
    type: 'node.force-stop', id: attached.nodeIdsByKey.a, runId: runA.runId, humanEnded: true,
  }, /无法识别的字段/);
  await assert.rejects(
    store.change(baseline.revision, { type: 'node.force-stop', id: attached.nodeIdsByKey.a, runId: runA.runId }),
    /无法识别的操作/,
  );
  await assert.rejects(service.change(request(store, {
    session: sessionA,
    clientOperationId: 'agent-forged-force-stop',
    expectedRevision: baseline.revision,
    change: { type: 'node.force-stop', id: attached.nodeIdsByKey.a, runId: runA.runId },
  })), /无法识别的操作/);
  await assert.rejects(service.change(request(store, {
    session: sessionA,
    clientOperationId: 'agent-forged-human-marker',
    expectedRevision: baseline.revision,
    change: { type: 'node.stop', id: attached.nodeIdsByKey.a, runId: runA.runId, reason: '伪造', humanEnded: true },
  })), /无法识别的字段/);
  assert.deepEqual(await store.read(), baseline);
}));

test('节点人工结束撤销旧会话全部写入入口，context 可读且新会话仍可续作', async () => isolated(async fixture => {
  const { store, service } = fixture;
  const attached = await createProject(fixture, sessionA, 'single', '单节点项目', [{ key: 'a', dependsOn: [], independentReason: '独立测试任务，无需上游成果', title: '任务 A' }], 'a');
  const nodeId = attached.nodeIdsByKey.a;
  await change(fixture, sessionA, 'single-before', { type: 'node.update', id: nodeId, patch: { decisions: '人工结束后仍保留' } });
  const started = await startRun(fixture, sessionA, 'single-start', nodeId);
  await change(fixture, sessionA, 'single-progress', { type: 'node.run.update', id: nodeId, runId: started.runId, patch: { progress: '已有进展', next: '已有下一步', question: '已有问题' } });

  const beforeStop = await store.read();
  const stopped = await store.change(beforeStop.revision, prepareHumanChange({ type: 'node.force-stop', id: nodeId, runId: started.runId }));
  const stoppedNode = stopped.nodes.find(node => node.id === nodeId);
  assert.equal(stoppedNode.progress, '已有进展');
  assert.equal(stoppedNode.next, '已有下一步');
  assert.equal(stoppedNode.question, '已有问题');
  assert.equal(stoppedNode.decisions, '人工结束后仍保留');
  assert.equal(stoppedNode.executions.at(-1).humanEnded, true);

  const discovery = await service.discover(request(store, { session: sessionA }));
  assert.equal(discovery.binding.humanEndedAt, stoppedNode.executions.at(-1).endedAt);
  const context = await service.context(request(store, { session: sessionA }));
  assert.equal(context.binding.humanEndedAt, stoppedNode.executions.at(-1).endedAt);
  assert.match(context.markdown, /已有进展/);

  const currentRevision = stopped.revision;
  const staleAttempts = [
    () => service.change(request(store, { session: sessionA, clientOperationId: 'stale-update', expectedRevision: currentRevision, change: { type: 'node.run.update', id: nodeId, runId: started.runId, patch: { progress: '不应写入' } } })),
    () => service.change(request(store, { session: sessionA, clientOperationId: 'stale-deliver', expectedRevision: currentRevision, change: { type: 'node.deliver', id: nodeId, runId: started.runId, summary: '不应交付', final: true } })),
    () => service.change(request(store, { session: sessionA, clientOperationId: 'stale-start', expectedRevision: currentRevision, change: { type: 'node.start', id: nodeId, executionRef: 'stale', owner: '旧执行者', model: 'test-model', modelSource: 'host' } })),
    () => service.attach(request(store, { session: sessionA, clientOperationId: 'stale-attach', expectedRevision: currentRevision, projectId: attached.binding.projectId, nodeId })),
    () => service.takeover(request(store, { session: sessionA, clientOperationId: 'stale-takeover', expectedRevision: currentRevision, nodeId, previousRunId: started.runId, reason: '不应接管', confirmation: 'user-confirmed', owner: '旧执行者', model: 'test-model', modelSource: 'host', executionRef: 'stale' })),
  ];
  for (const attempt of staleAttempts) {
    await assert.rejects(attempt(), error => error instanceof BoardError && error.status === 409 && error.details?.code === 'human-ended' && error.details.humanEndedAt === stoppedNode.executions.at(-1).endedAt);
  }
  assert.equal((await store.read()).revision, currentRevision);

  const replacement = await attachNode(fixture, replacementSession, 'replacement', attached.binding.projectId, nodeId);
  assert.equal(replacement.binding.humanEndedAt, undefined);
  const replacementRun = await startRun(fixture, replacementSession, 'replacement-start', nodeId);
  assert.notEqual(replacementRun.runId, started.runId);
  let board = await store.read();
  const active = board.nodes.find(node => node.id === nodeId).executions.at(-1);
  assert.equal(active.id, replacementRun.runId);
  assert.equal(active.endedAt, undefined);

  board = await store.change(board.revision, prepareHumanChange({ type: 'node.force-stop', id: nodeId, runId: replacementRun.runId }));
  board = await store.change(board.revision, prepareHumanChange({ type: 'project.archive', id: attached.binding.projectId, archived: true }));
  assert.equal(board.projects.find(project => project.id === attached.binding.projectId).archived, true);
  board = await store.change(board.revision, prepareHumanChange({ type: 'project.remove', id: attached.binding.projectId }));
  assert.equal(board.projects.some(project => project.id === attached.binding.projectId), false);
  assert.equal(board.nodes.some(node => node.projectId === attached.binding.projectId), false);
  assert.equal(board.agentBindings.some(binding => binding.projectId === attached.binding.projectId), false);
  const tombstone = board.humanEndedSessions.find(item => item.sessionId === sessionA.sessionId);
  assert.equal(tombstone.endedAt, stoppedNode.executions.at(-1).endedAt);

  const removedDiscovery = await service.discover(request(store, { session: sessionA }));
  assert.equal(removedDiscovery.binding, null);
  assert.equal(removedDiscovery.humanEndedAt, tombstone.endedAt);
  assert.deepEqual(removedDiscovery.candidates, []);
  assert.match(removedDiscovery.message, /新的宿主会话/);
  const removedContext = await service.context(request(store, { session: sessionA }));
  assert.equal(removedContext.binding, null);
  assert.equal(removedContext.humanEndedAt, tombstone.endedAt);
  assert.match(removedContext.markdown, /会话已由人在看板结束/);

  const afterRemovalRevision = board.revision;
  const removedSessionAttempts = [
    () => service.attach(request(store, {
      session: sessionA,
      clientOperationId: 'removed-session-create',
      expectedRevision: afterRemovalRevision,
      create: { title: '不应重建', summary: '', nodes: [{ key: 'x', dependsOn: [], independentReason: '独立测试任务，无需上游成果', title: '不应创建' }] },
      nodeKey: 'x',
    })),
    () => service.change(request(store, {
      session: sessionA,
      clientOperationId: 'removed-session-start',
      expectedRevision: afterRemovalRevision,
      change: { type: 'node.start', id: nodeId, executionRef: 'stale', owner: '旧执行者', model: 'test-model', modelSource: 'host' },
    })),
    () => service.takeover(request(store, {
      session: sessionA,
      clientOperationId: 'removed-session-takeover',
      expectedRevision: afterRemovalRevision,
      nodeId,
      previousRunId: started.runId,
      reason: '不应接管',
      confirmation: 'user-confirmed',
      owner: '旧执行者',
      model: 'test-model',
      modelSource: 'host',
      executionRef: 'stale',
    })),
  ];
  for (const attempt of removedSessionAttempts) {
    await assert.rejects(attempt(), error => error instanceof BoardError && error.status === 409 && error.details?.code === 'human-ended' && error.details.humanEndedAt === tombstone.endedAt);
  }
  assert.equal((await store.read()).revision, afterRemovalRevision);

  const fresh = await createProject(fixture, freshAfterRemovalSession, 'fresh-after-removal', '删除后新工作', [{ key: 'fresh', dependsOn: [], independentReason: '独立测试任务，无需上游成果', title: '新任务' }], 'fresh');
  const freshRun = await startRun(fixture, freshAfterRemovalSession, 'fresh-after-removal-start', fresh.nodeIdsByKey.fresh);
  assert.ok(freshRun.runId);
  assert.equal((await store.read()).nodes.find(node => node.id === fresh.nodeIdsByKey.fresh).status, 'doing');
}));

test('已结束或已被后续运行替代的目标不能再次人工结束', async () => isolated(async fixture => {
  const { store } = fixture;
  const attached = await createProject(fixture, sessionA, 'expired', '过期目标项目', [{ key: 'a', dependsOn: [], independentReason: '独立测试任务，无需上游成果', title: '任务 A' }], 'a');
  const nodeId = attached.nodeIdsByKey.a;
  const first = await startRun(fixture, sessionA, 'expired-first', nodeId);
  let board = await store.read();
  board = await store.change(board.revision, prepareHumanChange({ type: 'node.force-stop', id: nodeId, runId: first.runId }));
  await assert.rejects(
    store.change(board.revision, prepareHumanChange({ type: 'node.force-stop', id: nodeId, runId: first.runId })),
    error => error instanceof BoardError && error.status === 409 && error.details?.code === 'no-active-execution',
  );
  await assert.rejects(
    store.change(board.revision, prepareHumanChange({ type: 'project.force-stop', id: attached.binding.projectId, executions: [] })),
    error => error instanceof BoardError && error.status === 409 && error.details?.code === 'no-active-execution',
  );
}));

test('项目范围 HTTP 在人工结束后允许只读墓碑，并在归档删除后仍拒绝旧会话写入', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jarvisync-human-force-stop-http-'));
  const resolved = resolve(directory);
  assert.ok(dirname(resolved) === resolve(tmpdir()) && basename(resolved).startsWith('jarvisync-human-force-stop-http-') && resolved.startsWith(`${resolve(tmpdir())}${sep}`));
  const app = await startServer({ port: 0, dataDir: directory });
  try {
    const preparedResponse = await fetch(`${app.url}/api/onboarding/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: app.url, 'X-JarviSync-UI': '1' },
      body: JSON.stringify({ host: 'mcp', scope: 'project', projectId: 'p-example' }),
    });
    assert.equal(preparedResponse.status, 200, await preparedResponse.clone().text());
    const profile = await preparedResponse.json();
    const config = await loadConnection(profile.configPath);
    config.autoStart = false;
    const client = createClient(config);
    const session = { host: 'mcp', profileId: profile.id, sessionId: 'project-scoped-ended' };

    const attached = await client.attach({
      session,
      clientOperationId: 'http-attach',
      expectedRevision: (await app.store.read()).revision,
      projectId: 'p-example',
      nodeId: 'n-visual',
    });
    const started = await client.change({
      session,
      clientOperationId: 'http-start',
      expectedRevision: attached.revision,
      change: { type: 'node.start', id: 'n-visual', executionRef: 'http-host', owner: 'HTTP 测试', model: null, modelSource: 'host-unavailable' },
    });
    let board = await app.store.read();
    board = await app.store.change(board.revision, prepareHumanChange({ type: 'node.force-stop', id: 'n-visual', runId: started.runId }));
    const humanEndedAt = board.humanEndedSessions.find(item => item.sessionId === session.sessionId).endedAt;

    board = await app.store.change(board.revision, prepareHumanChange({ type: 'project.archive', id: 'p-example', archived: true }));
    const archivedDiscovery = await client.discover(session);
    assert.equal(archivedDiscovery.humanEndedAt, humanEndedAt);
    assert.equal(archivedDiscovery.binding.humanEndedAt, humanEndedAt);
    const archivedContext = await client.context({ session });
    assert.equal(archivedContext.humanEndedAt, humanEndedAt);
    assert.match(archivedContext.message, /仅供读取/);

    board = await app.store.change(board.revision, prepareHumanChange({ type: 'project.remove', id: 'p-example' }));
    const removedDiscovery = await client.discover(session);
    assert.equal(removedDiscovery.binding, null);
    assert.equal(removedDiscovery.humanEndedAt, humanEndedAt);
    assert.deepEqual(removedDiscovery.candidates, []);
    const removedContext = await client.context({ session });
    assert.equal(removedContext.binding, null);
    assert.equal(removedContext.humanEndedAt, humanEndedAt);
    assert.match(removedContext.markdown, /会话已由人在看板结束/);

    await assert.rejects(client.attach({
      session,
      clientOperationId: 'http-stale-create',
      expectedRevision: board.revision,
      create: { title: '旧会话不应新建', summary: '', nodes: [{ key: 'x', dependsOn: [], independentReason: '独立测试任务，无需上游成果', title: '不应创建' }] },
      nodeKey: 'x',
    }), error => error.status === 409 && error.details?.code === 'human-ended' && error.details.humanEndedAt === humanEndedAt);
    await assert.rejects(client.change({
      session,
      clientOperationId: 'http-stale-start',
      expectedRevision: board.revision,
      change: { type: 'node.start', id: 'n-visual', executionRef: 'stale', owner: '旧执行者', model: null, modelSource: 'host-unavailable' },
    }), error => error.status === 409 && error.details?.code === 'human-ended' && error.details.humanEndedAt === humanEndedAt);
    assert.equal((await app.store.read()).revision, board.revision);
  } finally {
    await app.close().catch(() => {});
    await rm(resolved, { recursive: true, force: true });
  }
});
