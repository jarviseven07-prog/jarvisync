import test from 'node:test';
import assert from 'node:assert/strict';
import { projectStatus } from '../src/project-status.ts';

const project = { id: 'project', archived: false };
const node = (status, extra = {}) => ({ projectId: project.id, status, archived: false, ...extra });
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
