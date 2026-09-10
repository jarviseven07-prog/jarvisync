import assert from 'node:assert/strict';
import test from 'node:test';
import { getEdgeProgress } from '../src/edge-progress.ts';

const statuses = ['idea', 'todo', 'doing', 'blocked', 'done'];
const node = (status, archived = false) => ({ status, archived });

test('仅完成到进行中流动，完成到完成保持静态绿色', () => {
  for (const sourceStatus of statuses) {
    for (const targetStatus of statuses) {
      const expected = sourceStatus === 'done' && targetStatus === 'doing'
        ? 'active'
        : sourceStatus === 'done' && targetStatus === 'done'
          ? 'complete'
          : 'idle';

      assert.equal(
        getEdgeProgress(node(sourceStatus), node(targetStatus)),
        expected,
        `${sourceStatus} -> ${targetStatus}`,
      );
    }
  }
});

test('缺少端点或任一端归档时保持闲置', () => {
  assert.equal(getEdgeProgress(), 'idle');
  assert.equal(getEdgeProgress(node('done')), 'idle');
  assert.equal(getEdgeProgress(undefined, node('doing')), 'idle');

  for (const [sourceArchived, targetArchived] of [
    [true, false],
    [false, true],
    [true, true],
  ]) {
    assert.equal(
      getEdgeProgress(node('done', sourceArchived), node('doing', targetArchived)),
      'idle',
    );
    assert.equal(
      getEdgeProgress(node('done', sourceArchived), node('done', targetArchived)),
      'idle',
    );
  }
});
