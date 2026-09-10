import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import test from 'node:test';
import { startServer } from '../server/index.mjs';
import { applyChange, createInitialBoard } from '../server/model.mjs';

test('整理一次保存全部位置、只增加一个版本，刷新和重启可恢复', async () => {
  const base = resolve(tmpdir());
  const directory = await mkdtemp(join(base, 'jarvisync-layout-'));
  let app;
  try {
    app = await startServer({ port: 0, dataDir: directory });
    const before = await (await fetch(`${app.url}/api/board`)).json();
    const positions = before.nodes.map((node, index) => ({ id: node.id, position: { x: index * 350, y: index % 2 * 220 } }));
    const response = await fetch(`${app.url}/api/human/change`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: app.url, 'X-JarviSync-UI': '1' },
      body: JSON.stringify({ expectedRevision: before.revision, change: { type: 'nodes.layout', projectId: 'p-example', positions } }),
    });
    assert.equal(response.status, 200);
    const after = await response.json();
    assert.equal(after.revision, before.revision + 1);
    assert.deepEqual(after.nodes.map(({ id, position }) => ({ id, position })), positions);
    assert.deepEqual(after.edges, before.edges);
    const content = ({ position, updatedAt, ...rest }) => rest;
    assert.deepEqual(after.nodes.map(content), before.nodes.map(content));
    const history = await readdir(join(directory, 'history'));
    assert.equal(history.length, 1);
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'history', history[0]), 'utf8')), before);

    const stale = await fetch(`${app.url}/api/human/change`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: app.url, 'X-JarviSync-UI': '1' },
      body: JSON.stringify({ expectedRevision: before.revision, change: { type: 'nodes.layout', projectId: 'p-example', positions: positions.slice().reverse() } }),
    });
    assert.equal(stale.status, 409);
    assert.deepEqual(await (await fetch(`${app.url}/api/board`)).json(), after);
    await app.close();
    app = undefined;
    app = await startServer({ port: 0, dataDir: directory });
    assert.deepEqual(await (await fetch(`${app.url}/api/board`)).json(), after);
  } finally {
    if (app) await app.close();
    assert.ok(resolve(directory).startsWith(base + sep) && basename(directory).startsWith('jarvisync-layout-'));
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('整理拒绝跨项目、重复和无效位置，失败不改变原数据', () => {
  const initial = createInitialBoard();
  let board = applyChange(initial, { type: 'project.create', title: '另一个项目' });
  const otherId = board.projects.at(-1).id;
  board = applyChange(board, { type: 'node.create', projectId: otherId, title: '另一项目的节点' });
  const untouched = structuredClone(board);
  const valid = { id: 'n-brief', position: { x: 320, y: 200 } };
  for (const positions of [
    [],
    [valid, { id: board.nodes.at(-1).id, position: { x: 20, y: 20 } }],
    [valid, valid],
    [valid, { id: 'n-visual', position: { x: Number.NaN, y: 0 } }],
    [valid, { id: 'n-visual', position: { x: 100001, y: 0 } }],
    [valid, { id: 'n-visual', position: { x: 0, y: 0 }, status: 'done' }],
    [valid, { id: 'missing', position: { x: 0, y: 0 } }],
  ]) {
    assert.throws(() => applyChange(board, { type: 'nodes.layout', projectId: 'p-example', positions }));
    assert.deepEqual(board, untouched);
  }
  const next = applyChange(board, { type: 'nodes.layout', projectId: 'p-example', positions: [valid] });
  assert.deepEqual(next.nodes.at(-1), board.nodes.at(-1));
  assert.deepEqual(next.projects.at(-1), board.projects.at(-1));
  const archived = applyChange(board, { type: 'project.update', id: 'p-example', patch: { archived: true } });
  assert.throws(() => applyChange(archived, { type: 'nodes.layout', projectId: 'p-example', positions: [valid] }), /恢复项目/);
});
