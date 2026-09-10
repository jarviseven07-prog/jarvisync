import test from 'node:test';
import assert from 'node:assert/strict';
import { initialBoardView, orderedListNodes, preferredProject } from '../src/view-preferences.ts';

test('已保存的画布或列表偏好优先，宽度只决定无偏好时默认值', () => {
  assert.equal(initialBoardView('canvas', true), 'canvas');
  assert.equal(initialBoardView('list', false), 'list');
  assert.equal(initialBoardView(null, true), 'list');
  assert.equal(initialBoardView(null, false), 'canvas');
});

test('首开选最近更新正常项目，合法偏好仍优先于默认规则', () => {
  const projects = [
    { id: 'demo', updatedAt: '2026-09-11', demo: true },
    { id: 'old', updatedAt: '2026-09-09', demo: false },
    { id: 'new', updatedAt: '2026-09-10', demo: false },
    { id: 'archived', updatedAt: '2026-09-12', archived: true, demo: false },
  ];
  assert.equal(preferredProject(projects, null).id, 'new');
  assert.equal(preferredProject(projects, 'demo').id, 'demo');
  assert.equal(preferredProject(projects, 'old').id, 'old');
  assert.equal(preferredProject(projects, 'archived').id, 'new');
  assert.equal(preferredProject([], null), null);
});

test('最近更新排序与依赖排序独立，不修改原数组且筛选后仍保留全部节点', () => {
  const nodes = [
    { id: 'finish', updatedAt: '2026-09-10', createdAt: '2026-09-01' },
    { id: 'start', updatedAt: '2026-09-09', createdAt: '2026-09-02' },
    { id: 'middle', updatedAt: '2026-09-11', createdAt: '2026-09-03' },
  ];
  const edges = [{ source: 'start', target: 'middle' }, { source: 'middle', target: 'finish' }];
  const before = structuredClone(nodes);
  assert.deepEqual(orderedListNodes(nodes, edges, 'updated').map(node => node.id), ['middle', 'finish', 'start']);
  assert.deepEqual(orderedListNodes(nodes, edges, 'dependency').map(node => node.id), ['start', 'middle', 'finish']);
  assert.deepEqual(orderedListNodes(nodes.slice(0, 1), edges, 'dependency').map(node => node.id), ['finish']);
  assert.deepEqual(nodes, before);
});
