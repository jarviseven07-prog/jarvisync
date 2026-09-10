import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { prepareHumanChange } from '../server/model.mjs';
import { openStore } from '../server/store.mjs';

test('历史保存成功后保留最近快照和近几日每日最新一份', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nodeboard-history-retention-'));
  const resolved = resolve(directory);
  assert.ok(dirname(resolved) === resolve(tmpdir()) && basename(resolved).startsWith('nodeboard-history-retention-') && resolved.startsWith(resolve(tmpdir()) + sep));
  let store;
  try {
    const history = join(directory, 'history');
    await mkdir(history, { recursive: true });
    const now = new Date();
    const todayNoon = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12);
    const suffix = '00000000-0000-4000-8000-000000000000';
    const timestamps = [Date.now() - 1000, todayNoon - 86400000, todayNoon - 2 * 86400000, todayNoon - 4 * 86400000];
    const seeded = timestamps.map((timestamp, index) => `board-r${index}-${timestamp}-${suffix}.json`);
    await Promise.all(seeded.map(name => writeFile(join(history, name), '{}\n')));
    store = await openStore(directory, { historyRecent: 1, historyDailyDays: 3 });
    assert.deepEqual((await readdir(history)).sort(), [...seeded].sort(), '打开数据目录不会清理已有历史');

    await store.change(0, prepareHumanChange({ type: 'project.create', title: '触发成功保存' }));

    const retained = await readdir(history);
    assert.equal(retained.length, 3);
    assert.equal(retained.includes(seeded[0]), false, '当天较旧快照由刚保存的快照替代');
    assert.equal(retained.includes(seeded[1]), true);
    assert.equal(retained.includes(seeded[2]), true);
    assert.equal(retained.includes(seeded[3]), false, '日保留范围外快照已清理');
  } finally {
    await store?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
});
