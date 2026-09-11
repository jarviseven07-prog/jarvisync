import assert from 'node:assert/strict';
import test from 'node:test';
import { transitiveEdgeIds } from '../src/edge-visibility.ts';
import { dependencyState } from '../shared/collaboration.mjs';

const nodes = (...ids) => ids.map(id => ({ id }));
const edges = (...pairs) => pairs.map(([source, target], i) => ({ id: `e${i}`, projectId: 'p', source, target }));
const hidden = (ns, es) => [...transitiveEdgeIds(ns, es)].sort();

test('triangle hides only its direct shortcut', () => {
  assert.deepEqual(hidden(nodes('a', 'b', 'c'), edges(['a', 'b'], ['b', 'c'], ['a', 'c'])), ['e2']);
});

test('diamond preserves both parallel paths', () => {
  const es = edges(['a', 'b'], ['a', 'd'], ['b', 'c'], ['d', 'c']);
  assert.deepEqual(hidden(nodes('a', 'b', 'c', 'd'), es), []);
  assert.deepEqual(hidden(nodes('a', 'b', 'c', 'd'), [...es, ...edges(['a', 'c']).map(e => ({ ...e, id: 'shortcut' }))]), ['shortcut']);
});

test('long chain hides shortcuts across multiple hops', () => {
  assert.deepEqual(hidden(nodes('a', 'b', 'c', 'd'), edges(['a', 'b'], ['b', 'c'], ['c', 'd'], ['a', 'c'], ['a', 'd'], ['b', 'd'])), ['e3', 'e4', 'e5']);
});

test('filtered or archived middle node cannot supply a hidden replacement path', () => {
  assert.deepEqual(hidden(nodes('a', 'c'), edges(['a', 'b'], ['b', 'c'], ['a', 'c'])), []);
  assert.deepEqual(hidden(nodes('a'), edges(['a', 'missing'])), []);
});

test('any visible cycle falls back to all edges, including a disconnected cycle', () => {
  assert.deepEqual(hidden(nodes('a', 'b', 'c', 'x', 'y'), edges(['a', 'b'], ['b', 'c'], ['a', 'c'], ['x', 'y'], ['y', 'x'])), []);
  assert.deepEqual(hidden(nodes('a'), edges(['a', 'a'])), []);
  assert.deepEqual(hidden(nodes('a', 'b', 'c'), edges(['a', 'b'], ['b', 'c'], ['a', 'c'], ['x', 'x'])), ['e2']);
});

test('duplicate pairs cannot hide each other but may share a multi-hop replacement', () => {
  assert.deepEqual(hidden(nodes('a', 'b'), edges(['a', 'b'], ['a', 'b'])), []);
  assert.deepEqual(hidden(nodes('a', 'b', 'c'), edges(['a', 'b'], ['b', 'c'], ['a', 'c'], ['a', 'c'])), ['e2', 'e3']);
});

test('drawing projection does not mutate inputs or dependency readiness', () => {
  const ns = nodes('a', 'b', 'c').map(n => Object.freeze({ ...n, projectId: 'p', status: n.id === 'b' ? 'done' : 'todo', archived: false }));
  const es = edges(['a', 'b'], ['b', 'c'], ['a', 'c']).map(Object.freeze);
  Object.freeze(ns);
  Object.freeze(es);
  const before = JSON.stringify({ ns, es });
  const board = { projects: [{ id: 'p', archived: false }], nodes: ns, edges: es };
  assert.deepEqual(dependencyState(board, ns[2]), { ready: false, waitingIds: ['a'] });
  assert.deepEqual(hidden(ns, es), ['e2']);
  assert.equal(JSON.stringify({ ns, es }), before);
  assert.deepEqual(dependencyState(board, ns[2]), { ready: false, waitingIds: ['a'] });
});

test('empty graphs are safe', () => {
  assert.deepEqual(hidden([], []), []);
});
