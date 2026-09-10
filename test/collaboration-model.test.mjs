import test from 'node:test';
import assert from 'node:assert/strict';
import { applyChange, BoardError, buildContext, createInitialBoard, prepareHumanChange, validateBoard } from '../server/model.mjs';

function save(board, change) {
  return applyChange(board, change);
}
function rejects(change) {
  assert.throws(change, error => error instanceof BoardError);
}
function newProjectWithTwoNodes() {
  let board = createInitialBoard();
  board = save(board, { type: 'project.create', title: '协作演练', summary: '验证真实交接。', conversationRef: 'codex://thread/source', coordinator: '主负责 Agent' });
  const project = board.projects.at(-1);
  board = save(board, { type: 'node.create', projectId: project.id, title: '上游交付' });
  const upstream = board.nodes.at(-1);
  board = save(board, { type: 'node.create', projectId: project.id, title: '下游接续' });
  const downstream = board.nodes.at(-1);
  board = save(board, { type: 'edge.create', projectId: project.id, source: upstream.id, target: downstream.id });
  return { board, project, upstream, downstream };
}

test('运行回执限制普通覆盖，真实交付后才允许下游开始', () => {
  let { board, project, upstream, downstream } = newProjectWithTwoNodes();
  rejects(() => save(board, { type: 'node.start', id: downstream.id, executionRef: 'task-downstream', owner: '执行者' }));
  rejects(() => save(board, { type: 'node.update', id: upstream.id, patch: { status: 'done' } }));
  rejects(() => save(board, { type: 'node.update', id: upstream.id, patch: null }));

  board = save(board, { type: 'node.start', id: upstream.id, executionRef: 'task-upstream', owner: '执行者 A', model: 'Terra' });
  const firstRun = board.nodes.find(node => node.id === upstream.id).executions.at(-1);
  assert.match(firstRun.id, /^run-/);
  assert.equal(firstRun.ref, 'task-upstream');
  rejects(() => save(board, { type: 'node.update', id: upstream.id, patch: { progress: '不能绕过运行回执' } }));

  board = save(board, { type: 'node.run.update', id: upstream.id, runId: firstRun.id, patch: { progress: '已完成原件。', next: '交付前的旧下一步。', question: '是否采用此版本？', status: 'blocked' } });
  rejects(() => save(board, { type: 'node.deliver', id: upstream.id, runId: firstRun.id, summary: '不能把受阻伪装为交付。' }));
  board = save(board, { type: 'node.run.update', id: upstream.id, runId: firstRun.id, patch: { status: 'doing', question: '' } });
  board = save(board, { type: 'node.deliver', id: upstream.id, runId: firstRun.id, summary: '上游原件已交付。', links: ['C:/成果/upstream.md'], final: false });
  const deliveredUpstream = board.nodes.find(node => node.id === upstream.id);
  assert.equal(deliveredUpstream.status, 'done');
  assert.equal(deliveredUpstream.progress, '已完成原件。');
  assert.equal(deliveredUpstream.next, '');
  assert.equal(deliveredUpstream.question, '');
  assert.equal(deliveredUpstream.deliveries[0].runId, firstRun.id);
  assert.equal(deliveredUpstream.deliveries[0].summary, '上游原件已交付。');
  assert.equal(deliveredUpstream.executions[0].outcome, 'delivered');
  rejects(() => save(board, { type: 'node.run.update', id: upstream.id, runId: firstRun.id, patch: { progress: '旧执行覆盖' } }));
  board = save(board, { type: 'delivery.mark', id: upstream.id, deliveryId: deliveredUpstream.deliveries[0].id, final: true });

  const beforeStartContext = buildContext(board, { node: downstream.id }).markdown;
  assert.match(beforeStartContext, /来源对话：codex:\/\/thread\/source/);
  assert.match(beforeStartContext, /直接上游成果/);
  assert.match(beforeStartContext, /C:\/成果\/upstream.md/);

  board = save(board, { type: 'node.start', id: downstream.id, executionRef: 'task-downstream', owner: '执行者 B', model: 'Sol' });
  const secondRun = board.nodes.find(node => node.id === downstream.id).executions.at(-1);
  assert.deepEqual(secondRun.inputNodeIds, [upstream.id]);
  rejects(() => save(board, { type: 'project.update', id: project.id, patch: { archived: true } }));
  rejects(() => save(board, { type: 'node.run.update', id: downstream.id, runId: firstRun.id, patch: { progress: '错误运行 ID' } }));
  board = save(board, { type: 'node.stop', id: downstream.id, runId: secondRun.id, reason: '等待人确定下一步。' });
  assert.equal(board.nodes.find(node => node.id === downstream.id).status, 'blocked');
});

test('新执行必须记录宿主实际模型，交付通过运行保留该次模型', () => {
  let { board, upstream } = newProjectWithTwoNodes();
  board = save(board, { type: 'node.update', id: upstream.id, patch: { model: '计划中的模型' } });

  assert.throws(
    () => save(board, { type: 'node.start', id: upstream.id, executionRef: 'task:missing-model', owner: '执行者' }),
    error => error instanceof BoardError && /请填写实际模型/.test(error.message),
  );
  assert.throws(
    () => save(board, { type: 'node.start', id: upstream.id, executionRef: 'task:blank-model', owner: '执行者', model: '  ' }),
    error => error instanceof BoardError && /请填写实际模型/.test(error.message),
  );
  assert.equal(board.nodes.find(node => node.id === upstream.id).executions, undefined);

  board = save(board, { type: 'node.start', id: upstream.id, executionRef: 'task:actual-model', owner: '执行者', model: 'gpt-6-astra' });
  const started = board.nodes.find(node => node.id === upstream.id);
  const run = started.executions.at(-1);
  assert.equal(run.model, 'gpt-6-astra');
  assert.equal(started.model, 'gpt-6-astra');

  board = save(board, { type: 'node.deliver', id: upstream.id, runId: run.id, summary: '已交付实际模型绑定的成果。' });
  const delivered = board.nodes.find(node => node.id === upstream.id);
  assert.equal(delivered.deliveries.at(-1).runId, run.id);
  assert.equal(delivered.executions.find(execution => execution.id === delivered.deliveries.at(-1).runId).model, 'gpt-6-astra');
  assert.match(buildContext(board, { node: upstream.id }).markdown, /模型：gpt-6-astra/);
});

test('受影响节点读取相关对话反馈，不重复直接上游或混入旁支回应', () => {
  let { board, project, upstream, downstream } = newProjectWithTwoNodes();
  board = save(board, { type: 'node.create', projectId: project.id, title: '不相邻来源节点' });
  const side = board.nodes.at(-1);

  board = save(board, { type: 'feedback.transcribe', projectId: project.id, nodeId: upstream.id, kind: 'feedback', body: '上游原话只应出现一次。', sourceRef: 'codex://thread/source#upstream', recordedBy: '主负责 Agent' });
  const upstreamInput = board.humanInputs.at(-1);
  board = save(board, { type: 'feedback.respond', id: upstreamInput.id, body: '上游回应影响下游。', owner: '主负责 Agent', disposition: 'applied', affectedNodeIds: [downstream.id] });

  board = save(board, { type: 'feedback.transcribe', projectId: project.id, nodeId: side.id, kind: 'feedback', body: '不相邻节点的原话。', sourceRef: 'codex://thread/source#side', recordedBy: '主负责 Agent' });
  const sideInput = board.humanInputs.at(-1);
  board = save(board, { type: 'feedback.respond', id: sideInput.id, body: '这条回应影响下游。', owner: '主负责 Agent', disposition: 'applied', affectedNodeIds: [downstream.id] });
  board = save(board, { type: 'feedback.respond', id: sideInput.id, body: '这条回应只影响上游。', owner: '主负责 Agent', disposition: 'not-applied', affectedNodeIds: [upstream.id] });

  const context = buildContext(board, { node: downstream.id }).markdown;
  assert.equal(context.split('上游原话只应出现一次。').length - 1, 1);
  assert.match(context, new RegExp(`来源节点 ${side.id}`));
  assert.match(context, /回应影响当前节点/);
  assert.match(context, /不相邻节点的原话。/);
  assert.match(context, /这条回应影响下游。/);
  assert.doesNotMatch(context, /这条回应只影响上游。/);
});

test('对话转录保留原话，回应追加且限制同项目影响节点', () => {
  let { board, project, downstream } = newProjectWithTwoNodes();
  board = save(board, { type: 'feedback.transcribe', projectId: project.id, nodeId: downstream.id, kind: 'feedback', body: '请把交付收紧一些。', sourceRef: 'codex://thread/source#message-8', recordedBy: '主负责 Agent' });
  const input = board.humanInputs.at(-1);
  const original = input.body;
  board = save(board, { type: 'feedback.respond', id: input.id, body: '已将范围写入下游节点。', owner: '主负责 Agent', disposition: 'applied', affectedNodeIds: [downstream.id] });
  const responded = board.humanInputs.find(item => item.id === input.id);
  assert.equal(responded.body, original);
  assert.equal(responded.responses.length, 1);
  assert.equal(responded.responses[0].affectedNodeIds[0], downstream.id);

  board = save(board, prepareHumanChange({ type: 'human.input.add', projectId: project.id, kind: 'goal', body: '这是看板直接补充。' }));
  assert.equal(board.humanInputs.at(-1).source, undefined);
  const context = buildContext(board, { node: downstream.id }).markdown;
  assert.match(context, /对话原话 · Agent 转录/);
  assert.match(context, /Agent 处理回应/);
  assert.match(context, /看板直接补充/);

  board = save(board, { type: 'project.create', title: '其他项目', summary: '' });
  const otherProject = board.projects.at(-1);
  board = save(board, { type: 'node.create', projectId: otherProject.id, title: '其他节点' });
  const otherNode = board.nodes.at(-1);
  rejects(() => save(board, { type: 'feedback.respond', id: input.id, body: '错误跨项目。', owner: '主负责 Agent', disposition: 'applied', affectedNodeIds: [otherNode.id] }));
});

test('旧数据无需迁移，新增协作字段仍有严格校验', () => {
  const legacy = createInitialBoard();
  for (const node of legacy.nodes) delete node.question;
  validateBoard(legacy);
  assert.doesNotThrow(() => buildContext(legacy, { node: legacy.nodes[0].id }));
  assert.doesNotThrow(() => save(legacy, { type: 'node.update', id: legacy.nodes[0].id, patch: { status: 'done' } }));

  const at = new Date().toISOString();
  const legacyExecution = createInitialBoard();
  legacyExecution.nodes[1].executions = [{ id: 'run-legacy', ref: 'task-legacy', owner: '执行者', model: '', startedAt: at, inputNodeIds: [] }];
  assert.doesNotThrow(() => validateBoard(legacyExecution));
  assert.match(buildContext(legacyExecution, { node: legacyExecution.nodes[1].id }).markdown, /模型：未记录/);

  const invalid = createInitialBoard();
  invalid.nodes[0].status = 'doing';
  invalid.nodes[0].executions = [{ id: 'run-invalid', ref: 'task-invalid', owner: '执行者', model: '', startedAt: 'not-a-date', inputNodeIds: [] }];
  rejects(() => validateBoard(invalid));

  const invalidDelivery = createInitialBoard();
  invalidDelivery.nodes[0].executions = [{ id: 'run-delivered', ref: 'task-delivered', owner: '执行者', model: '', startedAt: at, endedAt: at, outcome: 'delivered', inputNodeIds: [] }];
  invalidDelivery.nodes[0].deliveries = [{ id: 'd-invalid', runId: 'run-other', summary: '错误关联。', links: [], unresolved: '', createdAt: at, final: false }];
  rejects(() => validateBoard(invalidDelivery));

  const unordered = createInitialBoard();
  unordered.nodes[1].executions = [
    { id: 'run-active', ref: 'task-active', owner: '执行者', model: '', startedAt: at, inputNodeIds: [] },
    { id: 'run-stopped', ref: 'task-stopped', owner: '执行者', model: '', startedAt: at, endedAt: at, outcome: 'stopped', inputNodeIds: [] },
  ];
  rejects(() => validateBoard(unordered));

  const backwards = createInitialBoard();
  backwards.nodes[1].executions = [{ id: 'run-backwards', ref: 'task-backwards', owner: '执行者', model: '', startedAt: '2026-01-02T00:00:00.000Z', endedAt: '2026-01-01T00:00:00.000Z', outcome: 'stopped', inputNodeIds: [] }];
  rejects(() => validateBoard(backwards));
});
