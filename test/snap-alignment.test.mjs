import test from 'node:test';
import assert from 'node:assert/strict';
import { collectAlignment, SNAP_THRESHOLD } from '../src/snap-alignment.ts';

const node = (id, x, y, width = 120, height = 80) => ({ id, position: { x, y }, measured: { width, height } });

test('左缘接近目标节点左缘时水平吸附，并给出对齐参考线', () => {
  const moving = node('a', 304, 200);
  const other = node('b', 300, 40);
  const result = collectAlignment(moving, [other]);
  assert.equal(result.dx, -4);
  assert.equal(result.dy, 0);
  assert.deepEqual(result.guides, [{ x: 300 }]);
});

test('垂直边缘与目标节点顶边对齐', () => {
  const moving = node('a', 100, 260);
  const other = node('b', 400, 254); // 顶边 y = 254，移动节点顶边 260 → 偏移 -6
  const result = collectAlignment(moving, [other]);
  assert.equal(result.dy, -6);
  assert.equal(result.dx, 0);
  assert.deepEqual(result.guides, [{ y: 254 }]);
});

test('超出吸附阈值时不吸附、无参考线', () => {
  const moving = node('a', 100 + SNAP_THRESHOLD + 1, 100);
  const other = node('b', 100, 300);
  const result = collectAlignment(moving, [other]);
  assert.equal(result.dx, 0);
  assert.equal(result.dy, 0);
  assert.deepEqual(result.guides, []);
});

test('多个节点共享同一对齐时优先该偏移', () => {
  const moving = node('a', 305, 500);
  const others = [node('b', 300, 100), node('c', 300, 300)];
  const result = collectAlignment(moving, [others[0], ...[]]);
  assert.equal(result.dx, -5);
  const both = collectAlignment(moving, others);
  assert.equal(both.dx, -5);
});

test('缺少实测尺寸的节点不参与吸附', () => {
  const moving = node('a', 304, 200);
  const unmeasured = { id: 'b', position: { x: 300, y: 40 }, measured: null };
  const result = collectAlignment(moving, [unmeasured]);
  assert.equal(result.dx, 0);
  assert.deepEqual(result.guides, []);
});

test('自身不在候选中重复计算，对角位置各自独立吸附', () => {
  const moving = node('a', 300, 200);
  const other = node('b', 300, 400);
  const result = collectAlignment(moving, [other, node('a', 0, 0)]);
  assert.equal(result.dx, 0);
  assert.deepEqual(result.guides, [{ x: 300 }]);
});
