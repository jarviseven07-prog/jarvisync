import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { openAgentService } from '../server/agent-service.mjs';
import { BoardError, prepareHumanChange } from '../server/model.mjs';
import { openStore } from '../server/store.mjs';

const session = { host: 'codex', profileId: 'local-user', sessionId: 'thread-1', cwd: 'C:/same/workspace' };
const otherSession = { host: 'claude-code', profileId: 'local-user', sessionId: 'thread-2', cwd: 'C:/same/workspace' };

async function isolated(run) {
  const directory = await mkdtemp(join(tmpdir(), 'jarvisync-agent-service-'));
  const resolved = resolve(directory);
  assert.ok(dirname(resolved) === resolve(tmpdir()) && basename(resolved).startsWith('jarvisync-agent-service-') && resolved.startsWith(resolve(tmpdir()) + sep));
  let store = await openStore(directory);
  try {
    await run({ directory, store: () => store, service: () => openAgentService({ store }), reopen: async () => {
      await store.close();
      store = await openStore(directory);
    } });
  } finally {
    await store.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}

function request(store, values) {
  return { boardInstanceId: store.boardInstanceId, ...values };
}

async function createBoundProject(service, store, overrides = {}) {
  return service.attach(request(store, {
    session,
    clientOperationId: 'attach-create-1',
    expectedRevision: 0,
    create: {
      title: '跨宿主经营分析',
      summary: '整理数据并制作交付页面。',
      nodes: [
        { key: 'analysis', dependsOn: [], independentReason: '独立测试任务，无需上游成果', title: '整理经营数据', goal: '留下可核对的指标底稿。', next: '完成后交给页面节点。' },
        { key: 'page', title: '制作报告页面', dependsOn: ['analysis'] },
      ],
    },
    nodeKey: 'analysis',
    ...overrides,
  }));
}

test('数据目录实例 ID 独立持久，旧 board 无需改写即可获得身份', async () => isolated(async ({ directory, store, reopen }) => {
  const firstId = store().boardInstanceId;
  assert.match(firstId, /^bi-[0-9a-f-]{36}$/);
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'instance.json'), 'utf8')), { boardInstanceId: firstId });
  const before = await store().read();

  await reopen();
  assert.equal(store().boardInstanceId, firstId);
  assert.deepEqual(await store().read(), before);
  assert.equal(store().directory, resolve(directory));
}));

test('创建项目、节点、依赖与会话绑定在一次保存内完成，重试返回原结果', async () => isolated(async ({ store, service }) => {
  const first = await createBoundProject(service(), store());
  const saved = await store().read();
  assert.equal(first.binding.projectId, saved.projects.at(-1).id);
  assert.equal(first.binding.nodeId, first.nodeIdsByKey.analysis);
  assert.equal(saved.edges.at(-1).source, first.nodeIdsByKey.analysis);
  assert.equal(saved.edges.at(-1).target, first.nodeIdsByKey.page);
  assert.equal(saved.agentBindings.length, 1);
  assert.equal(saved.agentOperations.length, 1);
  assert.equal(saved.agentOperations[0].outcome.binding.id, first.binding.id);

  const replay = await createBoundProject(service(), store());
  assert.deepEqual(replay, first);
  assert.equal((await store().read()).revision, first.revision);
  assert.equal((await store().read()).projects.filter(project => !project.demo).length, 1);

  await assert.rejects(
    createBoundProject(service(), store(), { recording: false }),
    error => error instanceof BoardError && error.status === 409 && error.details?.code === 'idempotency-conflict',
  );
  assert.deepEqual(await service().operation(request(store(), { session, clientOperationId: 'attach-create-1' })), first);
  assert.equal(await service().operation(request(store(), { session: otherSession, clientOperationId: 'attach-create-1' })), null);
}));

test('操作结果只保存紧凑回执，超出窗口的原版本重试明确过期', async () => isolated(async ({ store, service }) => {
  const attached = await createBoundProject(service(), store());
  assert.equal(attached.committed, true);
  assert.equal(attached.operationKind, 'attach');
  let revision = attached.revision;
  const longProgress = `不应进入操作回执-${'x'.repeat(12000)}`;
  for (let index = 0; index < 256; index++) {
    const changed = await service().change(request(store(), {
      session,
      clientOperationId: `bounded-operation-${index}`,
      expectedRevision: revision,
      change: { type: 'node.update', id: attached.binding.nodeId, patch: { progress: index === 0 ? longProgress : `进展 ${index}` } },
    }));
    revision = changed.revision;
    assert.equal(changed.saved.type, 'node');
    assert.equal(changed.saved.id, attached.binding.nodeId);
    assert.equal(changed.saved.progress, undefined);
  }

  const board = await store().read();
  assert.equal(board.agentOperations.length, 256);
  assert.equal(board.agentOperationReplayFloorRevision, 0);
  assert.doesNotMatch(JSON.stringify(board.agentOperations), /不应进入操作回执/);
  assert.ok(JSON.stringify(board.agentOperations).length < 250000);
  assert.deepEqual(await service().operation(request(store(), { session, clientOperationId: 'attach-create-1' })), {
    state: 'unknown',
    replayFloorRevision: 0,
  });
  const beforeRetry = await store().read();
  await assert.rejects(
    createBoundProject(service(), store()),
    error => error instanceof BoardError && error.status === 410 && error.details?.code === 'operation-expired' && error.details.replayFloorRevision === 0,
  );
  assert.deepEqual(await store().read(), beforeRetry);
}));

test('新 attach 必须声明起始版本', async () => isolated(async ({ store, service }) => {
  await assert.rejects(
    service().attach(request(store(), { session, clientOperationId: 'attach-without-revision', projectId: 'p-example' })),
    error => error instanceof BoardError && /数据版本/.test(error.message),
  );
  assert.equal((await store().read()).agentOperations.length, 0);
}));

test('同目录的新会话不冒认旧绑定，未明确项目时返回候选冲突', async () => isolated(async ({ store, service }) => {
  const attached = await createBoundProject(service(), store());
  const discovery = await service().discover(request(store(), { session: otherSession }));
  assert.equal(discovery.binding, null);
  assert.deepEqual(discovery.candidates.map(item => item.projectId), [attached.binding.projectId]);
  assert.deepEqual(Object.keys(discovery.candidates[0]).sort(), ['projectId', 'projectNumber', 'title', 'updatedAt']);

  await assert.rejects(
    service().attach(request(store(), { session: otherSession, clientOperationId: 'attach-unspecified', expectedRevision: attached.revision })),
    error => error instanceof BoardError && error.status === 409 && error.details?.code === 'binding-conflict' && error.details.candidates[0].projectId === attached.binding.projectId,
  );
  assert.equal((await store().read()).agentBindings.length, 1);

  const selected = await service().attach(request(store(), {
    session: otherSession,
    clientOperationId: 'attach-explicit',
    expectedRevision: attached.revision,
    projectId: attached.binding.projectId,
  }));
  assert.equal(selected.binding.nodeId, undefined);
  const promoted = await service().attach(request(store(), {
    session: otherSession,
    clientOperationId: 'attach-node-after-project',
    expectedRevision: selected.revision,
    projectId: attached.binding.projectId,
    nodeId: attached.nodeIdsByKey.page,
  }));
  assert.equal(promoted.binding.nodeId, attached.nodeIdsByKey.page);
  const context = await service().context(request(store(), { session: otherSession }));
  assert.match(context.markdown, /当前节点：制作报告页面/);
  assert.match(context.markdown, /整理数据并制作交付页面/);
  await assert.rejects(
    service().context(request(store(), { session: otherSession, projectId: 'p-example' })),
    error => error instanceof BoardError && error.status === 409,
  );
}));

test('原子创建任一步失败都不留下项目、绑定或幂等记录', async () => isolated(async ({ store, service }) => {
  const before = await store().read();
  await assert.rejects(service().attach(request(store(), {
    session,
    clientOperationId: 'attach-cycle',
    expectedRevision: before.revision,
    create: {
      title: '循环依赖项目',
      nodes: [
        { key: 'a', title: 'A', dependsOn: ['b'] },
        { key: 'b', title: 'B', dependsOn: ['a'] },
      ],
    },
  })), error => error instanceof BoardError && /循环依赖/.test(error.message));
  assert.deepEqual(await store().read(), before);
  assert.equal(await service().operation(request(store(), { session, clientOperationId: 'attach-cycle' })), null);
}));

test('新接入诚实保存空模型来源，并用绑定运行阻止陈旧执行写回', async () => isolated(async ({ store, service }) => {
  const attached = await createBoundProject(service(), store());
  const startRequest = request(store(), {
    session,
    clientOperationId: 'start-unavailable',
    expectedRevision: attached.revision,
    change: { type: 'node.start', id: attached.nodeIdsByKey.analysis, executionRef: 'codex:thread-1:turn-1', owner: 'Codex', model: null, modelSource: 'host-unavailable' },
  });
  const [started, replay] = await Promise.all([service().change(startRequest), service().change(startRequest)]);
  assert.deepEqual(replay, started);
  const firstRunId = started.binding.runId;
  let board = await store().read();
  let node = board.nodes.find(item => item.id === attached.nodeIdsByKey.analysis);
  assert.equal(node.executions.length, 1);
  assert.equal(node.executions[0].model, null);
  assert.equal(node.executions[0].modelSource, 'host-unavailable');
  assert.equal(node.model, '');
  assert.match((await service().context(request(store(), { session }))).markdown, /模型：宿主未提供/);

  const stopped = await service().change(request(store(), {
    session,
    clientOperationId: 'stop-first',
    expectedRevision: started.revision,
    change: { type: 'node.stop', id: node.id, runId: firstRunId, reason: '宿主实际停止。' },
  }));
  await assert.rejects(service().change(request(store(), {
    session,
    clientOperationId: 'start-placeholder',
    expectedRevision: stopped.revision,
    change: { type: 'node.start', id: node.id, executionRef: 'codex:thread-1:turn-2', owner: 'Codex', model: 'unknown', modelSource: 'host' },
  })), error => error instanceof BoardError && /占位/.test(error.message));
  assert.equal((await store().read()).revision, stopped.revision);

  const restarted = await service().change(request(store(), {
    session,
    clientOperationId: 'start-known',
    expectedRevision: stopped.revision,
    change: { type: 'node.start', id: node.id, executionRef: 'codex:thread-1:turn-3', owner: 'Codex', model: 'gpt-6-astra', modelSource: 'host' },
  }));
  const secondRunId = restarted.binding.runId;
  assert.notEqual(secondRunId, firstRunId);

  await assert.rejects(service().change(request(store(), {
    session,
    clientOperationId: 'late-update',
    expectedRevision: restarted.revision,
    change: { type: 'node.run.update', id: node.id, runId: firstRunId, patch: { progress: '离线队列里的旧进展。' } },
  })), error => error instanceof BoardError && error.status === 409 && error.details?.code === 'stale-run');
  board = await store().read();
  node = board.nodes.find(item => item.id === node.id);
  assert.equal(node.executions[0].model, null);
  assert.equal(node.executions[0].modelSource, 'host-unavailable');
  assert.equal(node.executions[1].model, 'gpt-6-astra');
  assert.equal(node.executions[1].modelSource, 'host');
  assert.doesNotMatch(node.progress, /旧进展/);

  const ended = await service().change(request(store(), {
    session,
    clientOperationId: 'stop-second',
    expectedRevision: board.revision,
    change: { type: 'node.stop', id: node.id, runId: secondRunId, reason: '验证旧接口前停止。' },
  }));
  await assert.rejects(
    store().change(ended.revision, { type: 'node.start', id: attached.nodeIdsByKey.analysis, executionRef: 'legacy', owner: '旧接口' }),
    error => error instanceof BoardError && /实际模型/.test(error.message),
  );
}));

test('绑定有活动执行时不能切换，停用记录后拒绝写入', async () => isolated(async ({ store, service }) => {
  const attached = await createBoundProject(service(), store());
  const started = await service().change(request(store(), {
    session,
    clientOperationId: 'start-for-rebind',
    expectedRevision: attached.revision,
    change: { type: 'node.start', id: attached.nodeIdsByKey.analysis, executionRef: 'codex:thread-1', owner: 'Codex', model: 'gpt-6-astra', modelSource: 'host' },
  }));
  await assert.rejects(service().attach(request(store(), {
    session,
    clientOperationId: 'rebind-active',
    expectedRevision: started.revision,
    projectId: 'p-example',
    confirmRebind: true,
  })), error => error instanceof BoardError && error.status === 409 && /未结束执行/.test(error.message));

  const stopped = await service().change(request(store(), {
    session,
    clientOperationId: 'stop-for-disable',
    expectedRevision: started.revision,
    change: { type: 'node.stop', id: attached.nodeIdsByKey.analysis, runId: started.binding.runId, reason: '完成切换前停止。' },
  }));
  const disabled = await service().attach(request(store(), {
    session,
    clientOperationId: 'disable-recording',
    expectedRevision: stopped.revision,
    recording: false,
  }));
  assert.equal(disabled.binding.runId, started.binding.runId, '仅更新记录开关时保留原会话运行关联');
  await assert.rejects(service().change(request(store(), {
    session,
    clientOperationId: 'write-disabled',
    expectedRevision: disabled.revision,
    change: { type: 'node.update', id: attached.nodeIdsByKey.analysis, patch: { next: '不应保存。' } },
  })), error => error instanceof BoardError && error.status === 403 && error.details?.code === 'recording-disabled');
}));

test('后续会话接手同一节点后，旧会话不能再修改节点或新交付', async () => isolated(async ({ store, service }) => {
  const attached = await createBoundProject(service(), store());
  const first = await service().change(request(store(), {
    session,
    clientOperationId: 'takeover-start-first',
    expectedRevision: attached.revision,
    change: { type: 'node.start', id: attached.nodeIdsByKey.analysis, executionRef: 'codex:first', owner: 'Codex', model: 'gpt-6-astra', modelSource: 'host' },
  }));
  const stopped = await service().change(request(store(), {
    session,
    clientOperationId: 'takeover-stop-first',
    expectedRevision: first.revision,
    change: { type: 'node.stop', id: attached.nodeIdsByKey.analysis, runId: first.binding.runId, reason: '交给另一个宿主。' },
  }));
  const secondBinding = await service().attach(request(store(), {
    session: otherSession,
    clientOperationId: 'takeover-bind-second',
    expectedRevision: stopped.revision,
    projectId: attached.binding.projectId,
    nodeId: attached.nodeIdsByKey.analysis,
  }));
  const second = await service().change(request(store(), {
    session: otherSession,
    clientOperationId: 'takeover-start-second',
    expectedRevision: secondBinding.revision,
    change: { type: 'node.start', id: attached.nodeIdsByKey.analysis, executionRef: 'claude:second', owner: 'Claude', model: 'claude-opus', modelSource: 'host' },
  }));

  await assert.rejects(service().change(request(store(), {
    session,
    clientOperationId: 'takeover-old-plan-write',
    expectedRevision: second.revision,
    change: { type: 'node.update', id: attached.nodeIdsByKey.analysis, patch: { next: '旧会话不应覆盖。' } },
  })), error => error instanceof BoardError && error.status === 409 && error.details?.code === 'stale-run');
  await assert.rejects(service().change(request(store(), {
    session,
    clientOperationId: 'takeover-old-run-write',
    expectedRevision: second.revision,
    change: { type: 'node.run.update', id: attached.nodeIdsByKey.analysis, runId: first.binding.runId, patch: { progress: '旧执行写回。' } },
  })), error => error instanceof BoardError && error.status === 409 && error.details?.code === 'stale-run');
  const node = (await store().read()).nodes.find(item => item.id === attached.nodeIdsByKey.analysis);
  assert.equal(node.executions.at(-1).id, second.binding.runId);
  assert.doesNotMatch(node.next, /旧会话/);
  assert.doesNotMatch(node.progress, /旧执行/);
}));

test('过期交付只为当前绑定的受阻节点附诊断，越界身份和运行不泄漏当前状态', async () => isolated(async ({ store, service }) => {
  const attached = await createBoundProject(service(), store());
  const started = await service().change(request(store(), {
    session,
    clientOperationId: 'blocked-diagnostic-start',
    expectedRevision: attached.revision,
    change: { type: 'node.start', id: attached.nodeIdsByKey.analysis, executionRef: 'codex:blocked-diagnostic', owner: 'Codex', model: 'gpt-6-astra', modelSource: 'host' },
  }));
  const blocked = await service().change(request(store(), {
    session,
    clientOperationId: 'blocked-diagnostic-progress',
    expectedRevision: started.revision,
    change: { type: 'node.run.update', id: started.binding.nodeId, runId: started.binding.runId, patch: { status: 'blocked', question: '等待当前问题解决。' } },
  }));
  await store().change(blocked.revision, { type: 'project.create', title: '推进全局版本的无关项目' });
  const before = await store().read();

  const conflict = async (clientOperationId, change, requestSession = session, expectsObstacle = false) => {
    await assert.rejects(service().change(request(store(), {
      session: requestSession,
      clientOperationId,
      expectedRevision: blocked.revision,
      change,
    })), error => error instanceof BoardError
      && error.status === 409
      && error.details?.code === 'revision-conflict'
      && error.details.currentRevision === before.revision
      && (expectsObstacle
        ? error.details.currentObstacle?.code === 'node-blocked'
          && /jarvisync_progress/.test(error.details.currentObstacle.recovery)
          && /jarvisync_resolve retry 原交付请求并保留原正文/.test(error.details.currentObstacle.recovery)
          && /discard/.test(error.details.currentObstacle.recovery)
        : error.details.currentObstacle === undefined));
  };

  await conflict('blocked-diagnostic-match', {
    type: 'node.deliver', id: started.binding.nodeId, runId: started.binding.runId, summary: '当前仍不能交付。',
  }, session, true);
  await conflict('blocked-diagnostic-wrong-run', {
    type: 'node.deliver', id: started.binding.nodeId, runId: 'run-not-bound', summary: '不应看到节点状态。',
  });
  await conflict('blocked-diagnostic-wrong-node', {
    type: 'node.deliver', id: attached.nodeIdsByKey.page, runId: started.binding.runId, summary: '不应看到节点状态。',
  });
  await conflict('blocked-diagnostic-missing-node', {
    type: 'node.deliver', id: 'node-not-present', runId: started.binding.runId, summary: '不应看到节点状态。',
  });
  await conflict('blocked-diagnostic-unbound', {
    type: 'node.deliver', id: started.binding.nodeId, runId: started.binding.runId, summary: '不应看到节点状态。',
  }, otherSession);

  assert.deepEqual(await store().read(), before);
}));

test('项目来源会话执行当前节点时仍可安排同项目后续节点，普通节点会话不能越界', async () => isolated(async ({ store, service }) => {
  const projectBinding = await createBoundProject(service(), store());
  const started = await service().change(request(store(), {
    session,
    clientOperationId: 'coordinator-start-node',
    expectedRevision: projectBinding.revision,
    change: { type: 'node.start', id: projectBinding.binding.nodeId, executionRef: 'codex:coordinator', owner: 'Codex', model: 'gpt-6-astra', modelSource: 'host' },
  }));
  const planned = await service().change(request(store(), {
    session,
    clientOperationId: 'coordinator-create-while-running',
    expectedRevision: started.revision,
    change: { type: 'node.create', dependsOn: [], independentReason: '独立测试任务，无需上游成果', projectId: projectBinding.binding.projectId, title: '协调者新增后续节点' },
  }));
  assert.equal(planned.binding.nodeId, started.binding.nodeId);
  assert.equal(planned.binding.runId, started.binding.runId);
  const described = await service().change(request(store(), {
    session,
    clientOperationId: 'coordinator-describe-follow-up',
    expectedRevision: planned.revision,
    change: { type: 'node.update', id: planned.saved.id, patch: { goal: '形成独立成果。', next: '等待当前节点交付。' } },
  }));
  const connected = await service().change(request(store(), {
    session,
    clientOperationId: 'coordinator-connect-follow-up',
    expectedRevision: described.revision,
    change: { type: 'edge.create', projectId: projectBinding.binding.projectId, source: started.binding.nodeId, target: planned.saved.id },
  }));
  assert.equal(connected.binding.nodeId, started.binding.nodeId);
  assert.equal(connected.binding.runId, started.binding.runId);

  const worker = await service().attach(request(store(), {
    session: otherSession,
    clientOperationId: 'worker-bind-current-node',
    expectedRevision: connected.revision,
    projectId: projectBinding.binding.projectId,
    nodeId: started.binding.nodeId,
  }));
  await assert.rejects(service().change(request(store(), {
    session: otherSession,
    clientOperationId: 'worker-cannot-create-node',
    expectedRevision: worker.revision,
    change: { type: 'node.create', dependsOn: [], independentReason: '独立测试任务，无需上游成果', projectId: projectBinding.binding.projectId, title: '普通执行者不应新增' },
  })), error => error instanceof BoardError
    && error.status === 409
    && error.details?.code === 'binding-scope-conflict'
    && /项目主负责会话/.test(error.message)
    && /普通执行会话/.test(error.details.recovery));
  await assert.rejects(service().change(request(store(), {
    session: otherSession,
    clientOperationId: 'worker-cannot-update-project',
    expectedRevision: worker.revision,
    change: { type: 'project.update', id: projectBinding.binding.projectId, patch: { summary: '普通执行者不应修改项目。' } },
  })), error => error instanceof BoardError && error.status === 409 && error.details?.code === 'binding-scope-conflict');

  const delivered = await service().change(request(store(), {
    session,
    clientOperationId: 'coordinator-deliver-current',
    expectedRevision: worker.revision,
    change: { type: 'node.deliver', id: started.binding.nodeId, runId: started.binding.runId, summary: '当前节点已实际交付。' },
  }));
  const continued = await service().attach(request(store(), {
    session,
    clientOperationId: 'coordinator-continue-same-project',
    expectedRevision: delivered.revision,
    projectId: projectBinding.binding.projectId,
    nodeId: planned.saved.id,
  }));
  assert.equal(continued.binding.nodeId, planned.saved.id);
  assert.equal(continued.binding.runId, undefined);
}));

test('接管原子停止最新活动运行并启动新运行，并发重试只创建一次', async () => isolated(async ({ store, service }) => {
  const attached = await createBoundProject(service(), store());
  const first = await service().change(request(store(), {
    session,
    clientOperationId: 'takeover-original-start',
    expectedRevision: attached.revision,
    change: { type: 'node.start', id: attached.nodeIdsByKey.analysis, executionRef: 'codex:original', owner: 'Codex', model: 'gpt-6-astra', modelSource: 'host' },
  }));
  const joining = { host: 'claude-code', profileId: 'local-user', sessionId: 'takeover-thread' };
  const joined = await service().attach(request(store(), {
    session: joining,
    clientOperationId: 'takeover-join-node',
    expectedRevision: first.revision,
    projectId: attached.binding.projectId,
    nodeId: attached.nodeIdsByKey.analysis,
  }));
  assert.equal(joined.binding.runId, undefined);

  const takeoverRequest = request(store(), {
    session: joining,
    clientOperationId: 'takeover-replace-run',
    expectedRevision: joined.revision,
    nodeId: attached.nodeIdsByKey.analysis,
    previousRunId: first.binding.runId,
    reason: '宿主已观察到原执行被用户中断。',
    confirmation: 'host-observed',
    model: null,
    modelSource: 'host-unavailable',
    owner: 'Claude',
    executionRef: 'claude:replacement',
  });
  const [takenOver, replay] = await Promise.all([service().takeover(takeoverRequest), service().takeover(takeoverRequest)]);
  assert.deepEqual(replay, takenOver);
  assert.notEqual(takenOver.runId, first.binding.runId);

  let board = await store().read();
  let node = board.nodes.find(item => item.id === attached.nodeIdsByKey.analysis);
  assert.equal(node.executions.length, 2);
  assert.deepEqual(node.executions[0], {
    ...node.executions[0],
    outcome: 'stopped',
    stoppedReason: '宿主已观察到原执行被用户中断。',
    stopConfirmation: 'host-observed',
    stoppedByRunId: takenOver.runId,
  });
  assert.equal(node.executions[1].model, null);
  assert.equal(node.executions[1].modelSource, 'host-unavailable');
  assert.equal(node.progress, '宿主已观察到原执行被用户中断。');
  assert.equal(board.agentBindings.find(item => item.id === attached.binding.id).runId, first.binding.runId, '旧宿主绑定仍停留在旧运行');
  assert.equal(board.agentBindings.find(item => item.id === joined.binding.id).runId, takenOver.runId);
  assert.deepEqual(await service().operation(request(store(), { session: joining, clientOperationId: 'takeover-replace-run' })), takenOver);

  await assert.rejects(service().change(request(store(), {
    session,
    clientOperationId: 'takeover-old-session-write',
    expectedRevision: takenOver.revision,
    change: { type: 'node.run.update', id: node.id, runId: first.binding.runId, patch: { progress: '旧执行不应回来。' } },
  })), error => error instanceof BoardError && error.status === 409 && error.details?.code === 'stale-run');

  const competing = ['a', 'b'].map(suffix => service().takeover(request(store(), {
    session: joining,
    clientOperationId: `takeover-competing-${suffix}`,
    expectedRevision: takenOver.revision,
    nodeId: node.id,
    previousRunId: takenOver.runId,
    reason: `用户明确确认旧执行已停止 ${suffix}`,
    confirmation: 'user-confirmed',
    model: 'claude-opus',
    modelSource: 'host',
    owner: 'Claude',
    executionRef: `claude:restart-${suffix}`,
  })));
  const settled = await Promise.allSettled(competing);
  assert.equal(settled.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(settled.filter(item => item.status === 'rejected' && item.reason instanceof BoardError && item.reason.status === 409).length, 1);
  board = await store().read();
  node = board.nodes.find(item => item.id === node.id);
  assert.equal(node.executions.length, 3);
  assert.equal(node.executions.filter(run => run.endedAt === undefined).length, 1);
}));

test('接管拒绝错误运行、错误范围和缺少停止依据且不改变看板', async () => isolated(async ({ store, service }) => {
  const attached = await createBoundProject(service(), store());
  const started = await service().change(request(store(), {
    session,
    clientOperationId: 'takeover-validation-start',
    expectedRevision: attached.revision,
    change: { type: 'node.start', id: attached.nodeIdsByKey.analysis, executionRef: 'codex:active', owner: 'Codex', model: 'gpt-6-astra', modelSource: 'host' },
  }));
  const before = await store().read();
  const base = {
    session,
    expectedRevision: started.revision,
    nodeId: attached.nodeIdsByKey.analysis,
    previousRunId: started.binding.runId,
    reason: '用户明确确认原执行已停止。',
    confirmation: 'user-confirmed',
    model: 'gpt-6-astra',
    modelSource: 'host',
    owner: 'Codex',
    executionRef: 'codex:restart',
  };
  await assert.rejects(service().takeover(request(store(), { ...base, clientOperationId: 'takeover-wrong-run', previousRunId: 'run-wrong' })), error => error instanceof BoardError && error.status === 409);
  await assert.rejects(service().takeover(request(store(), { ...base, clientOperationId: 'takeover-no-reason', reason: '  ' })), error => error instanceof BoardError && /原因/.test(error.message));
  await assert.rejects(service().takeover(request(store(), { ...base, clientOperationId: 'takeover-wrong-node', nodeId: attached.nodeIdsByKey.page })), error => error instanceof BoardError && error.status === 409);
  assert.deepEqual(await store().read(), before);
}));

test('删除项目清除当前幂等结果中的业务正文，旧请求只返回删除墓碑', async () => isolated(async ({ directory, store, service }) => {
  const privateSummary = 'PRIVATE-PROJECT-SUMMARY-7e1b';
  const privateProgress = 'PRIVATE-NODE-PROGRESS-8f2c';
  const createRequest = request(store(), {
    session,
    clientOperationId: 'private-create-operation',
    expectedRevision: 0,
    create: { title: '待删除私密项目', summary: privateSummary, nodes: [{ key: 'private', dependsOn: [], independentReason: '独立测试任务，无需上游成果', title: '私密节点' }] },
    nodeKey: 'private',
  });
  const attached = await service().attach(createRequest);
  const updateRequest = request(store(), {
    session,
    clientOperationId: 'private-update-operation',
    expectedRevision: attached.revision,
    change: { type: 'node.update', id: attached.binding.nodeId, patch: { progress: privateProgress } },
  });
  const updated = await service().change(updateRequest);
  await store().change(updated.revision, prepareHumanChange({ type: 'project.remove', id: attached.binding.projectId }));

  const current = await store().read();
  const serialized = JSON.stringify(current);
  assert.doesNotMatch(serialized, new RegExp(privateSummary));
  assert.doesNotMatch(serialized, new RegExp(privateProgress));
  assert.equal(current.agentBindings.some(item => item.projectId === attached.binding.projectId), false);
  const tombstones = current.agentOperations.filter(item => ['private-create-operation', 'private-update-operation'].includes(item.id));
  assert.equal(tombstones.length, 2);
  for (const operation of tombstones) assert.deepEqual(operation.outcome, {
    boardInstanceId: store().boardInstanceId,
    revision: operation.id === 'private-create-operation' ? attached.revision : updated.revision,
    committed: true,
    deleted: true,
    clientOperationId: operation.id,
    operationKind: operation.id === 'private-create-operation' ? 'attach' : 'change',
  });

  assert.deepEqual(await service().attach(createRequest), tombstones.find(item => item.id === 'private-create-operation').outcome);
  assert.equal((await store().read()).projects.some(item => item.id === attached.binding.projectId), false);
  assert.deepEqual(await service().operation(request(store(), { session, clientOperationId: 'private-update-operation' })), tombstones.find(item => item.id === 'private-update-operation').outcome);
  const historyNames = await readdir(join(directory, 'history'));
  const historyContents = await Promise.all(historyNames.map(name => readFile(join(directory, 'history', name), 'utf8')));
  assert.ok(historyContents.some(content => content.includes(privateSummary) && content.includes(privateProgress)), '删除前历史仍保留原始项目记录');
}));


test('Agent 新节点必须说明真实依赖或独立原因，失败不留下散点', async () => isolated(async ({ store, service }) => {
  const attached = await createBoundProject(service(), store());
  const before = await store().read();
  const base = { type: 'node.create', projectId: attached.binding.projectId, title: '新成果' };
  for (const [index, plan] of [ {}, { dependsOn: [] }, { dependsOn: [], independentReason: '   ' }, { dependsOn: [attached.nodeIdsByKey.analysis], independentReason: '矛盾' }, { dependsOn: [attached.nodeIdsByKey.analysis, attached.nodeIdsByKey.analysis] }, { dependsOn: ['n-brief'] }, { dependsOn: ['missing-node'] } ].entries()) {
    await assert.rejects(service().change(request(store(), { session, expectedRevision: before.revision, clientOperationId: `bad-plan-${index}`, change: { ...base, ...plan } })));
    assert.deepEqual(await store().read(), before);
  }
  const req = request(store(), { session, expectedRevision: before.revision, clientOperationId: 'atomic-node', change: { ...base, dependsOn: [attached.nodeIdsByKey.analysis] } });
  const saved = await service().change(req);
  const after = await store().read();
  assert.equal(after.nodes.length, before.nodes.length + 1);
  assert.ok(after.edges.some(edge => edge.source === attached.nodeIdsByKey.analysis && edge.target === saved.saved.id));
  assert.deepEqual(await service().change(req), saved);
  assert.deepEqual(await store().read(), after);
  const independent = await service().change(request(store(), { session, expectedRevision: after.revision, clientOperationId: 'independent', change: { ...base, dependsOn: [], independentReason: '无需上游成果' } }));
  assert.equal((await store().read()).nodes.find(node => node.id === independent.saved.id).independentReason, '无需上游成果');
  assert.match((await service().context(request(store(), { session, nodeId: independent.saved.id }))).markdown, /创建时独立原因[\s\S]*无需上游成果/);
}));

test('attach 不再把省略依赖默认成独立，已归档上游创建原子失败', async () => isolated(async ({ store, service }) => {
  await assert.rejects(createBoundProject(service(), store(), { create: { title: '缺失关系', nodes: [{ key: 'a', title: 'A' }] }, nodeKey: 'a' }), /dependsOn/);
  assert.equal((await store().read()).revision, 0);
  const attached = await createBoundProject(service(), store());
  await store().change(attached.revision, { type: 'node.update', id: attached.nodeIdsByKey.page, patch: { archived: true } });
  const before = await store().read();
  await assert.rejects(service().change(request(store(), { session, expectedRevision: before.revision, clientOperationId: 'archived-dependency', change: { type: 'node.create', projectId: attached.binding.projectId, title: '不能连归档', dependsOn: [attached.nodeIdsByKey.page] } })), /未归档/);
  assert.deepEqual(await store().read(), before);
}));


test('旧版本已成功的无依赖声明请求仍能重放原回执', async () => isolated(async ({ store, service }) => {
  const legacyAttach = request(store(), { session, clientOperationId: 'legacy-attach', expectedRevision: 0, create: { title: '旧版本项目', nodes: [{ key: 'a', title: '旧节点' }] } });
  const attached = await service().attach({ ...legacyAttach, create: { ...legacyAttach.create, nodes: [{ ...legacyAttach.create.nodes[0], dependsOn: [], independentReason: '独立测试' }] } });
  const legacyChange = request(store(), { session, clientOperationId: 'legacy-change', expectedRevision: attached.revision, change: { type: 'node.create', projectId: attached.binding.projectId, title: '旧追加节点' } });
  const created = await service().change({ ...legacyChange, change: { ...legacyChange.change, dependsOn: [], independentReason: '独立测试' } });
  // Seed the historical request hashes: old successful receipts have no declaration fields.
  const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  await store().transact(board => {
    for (const [kind, req] of [['attach', legacyAttach], ['change', legacyChange]]) {
      const { boardInstanceId, clientOperationId, ...content } = req;
      content.session = { host: session.host, profileId: session.profileId, sessionId: session.sessionId };
      board.agentOperations.find(operation => operation.id === clientOperationId).requestHash = createHash('sha256').update(canonical({ kind, request: content })).digest('hex');
    }
    board.revision++;
    return { next: board, result: null };
  });
  const before = await store().read();
  assert.deepEqual(await service().attach(legacyAttach), attached);
  assert.deepEqual(await service().change(legacyChange), created);
  assert.deepEqual(await store().read(), before);
}));
