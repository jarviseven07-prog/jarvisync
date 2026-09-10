import test from 'node:test';
import assert from 'node:assert/strict';
import { applyChange, createInitialBoard } from '../server/model.mjs';
import { dependencyState, nodePhase, projectOverview } from '../shared/collaboration.mjs';

test('协作摘要计入记录的进行中，但执行阶段仍区分未记录执行，不把参考材料当成果', () => {
  const board = createInitialBoard();
  const doing = board.nodes.find(node => node.status === 'doing');
  doing.owner = '仅记录负责人';
  doing.links = ['C:/资料/参考.md'];
  assert.equal(nodePhase(board, doing).kind, 'recorded');
  assert.deepEqual(projectOverview(board, 'p-example').doingIds.sort(), board.nodes.filter(node => node.status === 'doing' && !node.archived).map(node => node.id).sort());
  assert.deepEqual(projectOverview(board, 'p-example').deliveries, []);
  assert.equal(dependencyState(board, board.nodes.find(node => node.id === 'n-build')).ready, false);
  const upstream = board.nodes.find(node => node.id === 'n-brief');
  upstream.archived = true;
  assert.ok(dependencyState(board, doing).waitingIds.includes(upstream.id));
});

test('受阻节点无论有无问题只在需要你中计入一次，归档后移除', () => {
  const board = createInitialBoard();
  const node = board.nodes[0];
  board.nodes = [node];
  node.status = 'blocked';
  node.question = '';
  assert.deepEqual(projectOverview(board, node.projectId).attentionNodeIds, [node.id]);
  node.question = '需要澄清';
  assert.deepEqual(projectOverview(board, node.projectId).attentionNodeIds, [node.id]);
  node.archived = true;
  assert.deepEqual(projectOverview(board, node.projectId).attentionNodeIds, []);
});

test('重做不计入当前成果，澄清回应和问题汇总随最新记录更新', () => {
  let board = createInitialBoard();
  board = applyChange(board, { type: 'project.create', title: '演练', summary: '' });
  const projectId = board.projects.at(-1).id;
  board = applyChange(board, { type: 'node.create', projectId, title: '独立成果' });
  const nodeId = board.nodes.at(-1).id;
  board = applyChange(board, { type: 'node.start', id: nodeId, executionRef: 'test:run', owner: '测试执行者', model: 'test-model' });
  const runId = board.nodes.at(-1).executions.at(-1).id;
  board = applyChange(board, { type: 'node.deliver', id: nodeId, runId, summary: '初稿', links: ['C:/测试/初稿.md'], final: true });
  assert.equal(projectOverview(board, projectId).deliveries.length, 1);
  board = applyChange(board, { type: 'node.update', id: nodeId, patch: { status: 'todo', question: '需要保留哪一部分？' } });
  assert.equal(projectOverview(board, projectId).deliveries.length, 0);
  assert.equal(board.nodes.at(-1).deliveries.length, 1);
  assert.deepEqual(projectOverview(board, projectId).attentionNodeIds, [nodeId]);
  board = applyChange(board, { type: 'feedback.transcribe', projectId, kind: 'feedback', body: '调整一下。', sourceRef: 'test:message', recordedBy: '测试记录者' });
  const inputId = board.humanInputs.at(-1).id;
  board = applyChange(board, { type: 'feedback.respond', id: inputId, owner: '测试记录者', body: '请明确调整范围。', disposition: 'needs-clarification' });
  assert.deepEqual(projectOverview(board, projectId).clarificationInputIds, [inputId]);
  board = applyChange(board, { type: 'feedback.respond', id: inputId, owner: '测试记录者', body: '范围已确认并更新。', disposition: 'applied', affectedNodeIds: [nodeId] });
  assert.deepEqual(projectOverview(board, projectId).clarificationInputIds, []);
  board = applyChange(board, { type: 'project.update', id: projectId, patch: { archived: true } });
  assert.deepEqual(projectOverview(board, projectId).attentionNodeIds, []);
});
