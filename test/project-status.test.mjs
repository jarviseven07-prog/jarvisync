import test from 'node:test';
import assert from 'node:assert/strict';
import { projectStatus } from '../src/project-status.ts';
import { nodePhase, projectOverview } from '../shared/collaboration.mjs';

const project = { id: 'project', archived: false };
const node = (status, extra = {}) => ({ projectId: project.id, status, archived: false, ...extra });
const stopped = () => node('blocked', { id: 'ended', question: '历史问题', executions: [{ humanEnded: true, endedAt: '2026-09-11T05:00:00Z', outcome: 'stopped' }] });
test('人工结束保留未完成语义，项目显示已结束或已停止', () => {
  assert.equal(projectStatus(project, [stopped()]).label, '已结束');
  assert.equal(projectStatus(project, [stopped(), node('done')]).kind, 'stopped');
  assert.equal(projectStatus(project, [stopped(), node('todo')]).label, '已停止');
  assert.equal(projectStatus(project, [stopped(), node('doing')]).kind, 'doing');
  assert.equal(projectStatus(project, [stopped(), node('blocked')]).kind, 'blocked');
});
test('人工结束任务不再计为进行中或待处理，也不成为交付成果', () => {
  const board = { projects: [project], nodes: [stopped()], edges: [] };
  assert.equal(nodePhase(board, board.nodes[0]).label, '人工已结束');
  const overview = projectOverview(board, project.id);
  for (const key of ['doingIds', 'readyIds', 'attentionNodeIds', 'deliveries']) assert.deepEqual(overview[key], []);
  board.nodes[0].status = 'doing';
  board.nodes[0].executions.push({ id: 'new-run' });
  assert.equal(nodePhase(board, board.nodes[0]).kind, 'running');
});
test('人工结束只移出该任务的待澄清计数，项目级问题和历史原文保留', () => {
  const inputs = [
    { id: 'node-question', projectId: project.id, nodeId: 'ended', responses: [{ disposition: 'needs-clarification', body: '请提供资料' }] },
    { id: 'project-question', projectId: project.id, responses: [{ disposition: 'needs-clarification', body: '确认项目目标' }] },
  ];
  const before = structuredClone(inputs);
  const board = { projects: [project], nodes: [stopped()], edges: [], humanInputs: inputs };
  assert.deepEqual(projectOverview(board, project.id).clarificationInputIds, ['project-question']);
  assert.deepEqual(inputs, before);
});
test('空项目和仅有待办或想法的项目未开始', () => {
  for (const nodes of [[], [node('todo')], [node('idea'), node('todo')]]) assert.equal(projectStatus(project, nodes).kind, 'pending');
});
test('实际进行中或已完成一部分时汇总为进行中', () => {
  assert.equal(projectStatus(project, [node('doing')]).kind, 'doing');
  assert.equal(projectStatus(project, [node('done'), node('todo')]).kind, 'doing');
});
test('受阻任务优先提示，全部完成才显示已完成', () => {
  assert.equal(projectStatus(project, [node('done'), node('blocked'), node('doing')]).kind, 'blocked');
  assert.equal(projectStatus(project, [node('done'), node('done')]).kind, 'done');
});
test('忽略已归档任务和其他项目，并且不改写源记录', () => {
  const nodes = [node('done'), node('blocked', { archived: true }), node('doing', { projectId: 'other' })];
  const before = structuredClone(nodes);
  assert.equal(projectStatus(project, nodes).kind, 'done');
  assert.deepEqual(nodes, before);
});
test('项目归档是独立人工状态，不由任务完成自动归档', () => {
  assert.equal(projectStatus({ ...project, archived: true }, [node('todo')]).kind, 'archived');
  assert.equal(projectStatus(project, [node('done')]).kind, 'done');
  assert.equal(project.archived, false);
});
