import assert from 'node:assert/strict';
import test from 'node:test';
import { layoutNodes } from '../src/layout.ts';

const CARD_WIDTH = 248;
const CARD_HEIGHT = 152;

function node(id, position = { x: 700, y: 900 }) {
  return { id, position };
}

function edge(id, source, target) {
  return { id, source, target };
}

function positionsById(layout) {
  return new Map(layout.map((item) => [item.id, item.position]));
}

function assertNoOverlap(layout) {
  for (let left = 0; left < layout.length; left += 1) {
    for (let right = left + 1; right < layout.length; right += 1) {
      const a = layout[left].position;
      const b = layout[right].position;
      const overlaps = a.x < b.x + CARD_WIDTH && b.x < a.x + CARD_WIDTH
        && a.y < b.y + CARD_HEIGHT && b.y < a.y + CARD_HEIGHT;
      assert.equal(overlaps, false, `${layout[left].id} and ${layout[right].id} must not overlap`);
    }
  }
}

function assertEdgesPointRight(layout, edges) {
  const byId = positionsById(layout);
  for (const { source, target } of edges) {
    if (!byId.has(source) || !byId.has(target)) continue;
    assert.ok(byId.get(target).x > byId.get(source).x, `${source} should be left of ${target}`);
  }
}

test('依赖图按层从左到右，分支和汇合保持居中且卡片不重叠', () => {
  const nodes = ['brief', 'visual', 'copy', 'page', 'archive'].map(node);
  const edges = [
    edge('e-brief-visual', 'brief', 'visual'),
    edge('e-brief-copy', 'brief', 'copy'),
    edge('e-visual-page', 'visual', 'page'),
    edge('e-copy-page', 'copy', 'page'),
    edge('e-absent', 'page', 'not-on-board'),
  ];
  const layout = layoutNodes(nodes, edges);
  const byId = positionsById(layout);

  assert.deepEqual(layout.map((item) => item.id), ['archive', 'brief', 'copy', 'page', 'visual']);
  assert.equal(new Set(layout.map((item) => item.id)).size, nodes.length);
  assertEdgesPointRight(layout, edges);
  assert.equal(byId.get('visual').x, byId.get('copy').x, 'forked work belongs in the same layer');
  assert.equal(byId.get('brief').y, (byId.get('visual').y + byId.get('copy').y) / 2, 'the fork should center on its branches');
  assert.equal(byId.get('page').y, (byId.get('visual').y + byId.get('copy').y) / 2, 'the merge should center on its inputs');
  assertNoOverlap(layout);
});

test('相同数据无论输入顺序如何都返回同一布局，且不修改数据', () => {
  const nodes = ['a', 'b', 'c', 'd'].map((id, index) => node(id, { x: index * 9, y: index * 13 }));
  const edges = [edge('a-b', 'a', 'b'), edge('a-c', 'a', 'c'), edge('b-d', 'b', 'd'), edge('c-d', 'c', 'd')];
  const beforeNodes = structuredClone(nodes);
  const beforeEdges = structuredClone(edges);
  const first = layoutNodes(nodes, edges);
  const second = layoutNodes([...nodes].reverse(), [...edges].reverse());

  assert.deepEqual(second, first);
  assert.deepEqual(nodes, beforeNodes);
  assert.deepEqual(edges, beforeEdges);
});

test('两条并行链在汇合前保持同一行序，不交叉', () => {
  const nodes = ['n-content', 'n-visual', 'n-check', 'n-build', 'n-publish'].map(node);
  const edges = [
    edge('content-check', 'n-content', 'n-check'),
    edge('visual-build', 'n-visual', 'n-build'),
    edge('check-publish', 'n-check', 'n-publish'),
    edge('build-publish', 'n-build', 'n-publish'),
  ];
  const byId = positionsById(layoutNodes(nodes, edges));

  assert.ok(byId.get('n-content').y < byId.get('n-visual').y);
  assert.ok(byId.get('n-check').y < byId.get('n-build').y);
  assert.equal(byId.get('n-content').x, 0);
  assert.equal(byId.get('n-check').x, 356);
  assert.equal(byId.get('n-build').x, 356);
  assert.equal(byId.get('n-publish').x, 712);
});

test('空图、单节点和无依赖节点都能布局', () => {
  assert.deepEqual(layoutNodes([], []), []);
  assert.deepEqual(layoutNodes([node('only')], []), [{ id: 'only', position: { x: 0, y: 0 } }]);

  const layout = layoutNodes([node('z'), node('x'), node('y')], []);
  assert.deepEqual(layout.map((item) => item.id), ['x', 'y', 'z']);
  assert.ok(new Set(layout.map((item) => item.position.x)).size > 1);
  assertNoOverlap(layout);
});

test('大量无依赖节点按多个弱连通分量紧凑排列，不形成单列高塔', () => {
  const nodes = Array.from({ length: 24 }, (_, index) => node(`isolated-${String(index).padStart(2, '0')}`));
  const layout = layoutNodes(nodes, []);
  const width = Math.max(...layout.map((item) => item.position.x)) + CARD_WIDTH;
  const height = Math.max(...layout.map((item) => item.position.y)) + CARD_HEIGHT;

  assert.ok(new Set(layout.map((item) => item.position.x)).size >= 4);
  assert.ok(new Set(layout.map((item) => item.position.y)).size >= 3);
  assert.ok(height < nodes.length * CARD_HEIGHT / 2, `packed height ${height} should be well below a vertical stack`);
  assert.ok(width > height, 'the isolated-node grid should suit the wide canvas');
  assertNoOverlap(layout);
});

test('大扇出和大扇入层折成多列，所有依赖边仍从左指向右', () => {
  const branchIds = Array.from({ length: 17 }, (_, index) => `branch-${String(index).padStart(2, '0')}`);
  const nodes = [node('source'), ...branchIds.map(node), node('target')];
  const edges = [
    ...branchIds.map((id) => edge(`source-${id}`, 'source', id)),
    ...branchIds.map((id) => edge(`${id}-target`, id, 'target')),
  ];
  const layout = layoutNodes(nodes, edges);
  const byId = positionsById(layout);
  const branchColumns = new Set(branchIds.map((id) => byId.get(id).x));
  const height = Math.max(...layout.map((item) => item.position.y)) + CARD_HEIGHT;

  assert.equal(branchColumns.size, 3);
  assert.ok(height <= 6 * CARD_HEIGHT + 5 * 60);
  assertEdgesPointRight(layout, edges);
  assertNoOverlap(layout);
});

test('循环依赖明确失败而不会返回局部布局', () => {
  assert.throws(
    () => layoutNodes([node('a'), node('b'), node('c')], [edge('a-b', 'a', 'b'), edge('b-c', 'b', 'c'), edge('c-a', 'c', 'a')]),
    /循环/,
  );
});
