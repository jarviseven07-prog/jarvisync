import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import test from 'node:test';
import { startServer } from '../server/index.mjs';

const tempBase = resolve(tmpdir());

async function temporaryData(action) {
  const directory = await mkdtemp(join(tempBase, 'nodeboard-core-'));
  try {
    return await action(directory);
  } finally {
    const resolved = resolve(directory);
    assert.ok(resolved.startsWith(`${tempBase}${sep}`) && basename(resolved).startsWith('nodeboard-core-'), '只清理本测试创建的临时目录');
    await rm(resolved, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function withServer(action) {
  return temporaryData(async (dataDir) => {
    const app = await startServer({ port: 0, dataDir });
    try {
      return await action(app, dataDir);
    } finally {
      await app.close();
    }
  });
}

async function api(app, path, body) {
  const response = await fetch(`${app.url}${path}`, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function apiChange(app, body) {
  try { return { status: 200, body: await app.store.change(body.expectedRevision, body.change) }; }
  catch (error) { return { status: error.status || 500, body: { error: error.message } }; }
}

function change(expectedRevision, payload) {
  return { expectedRevision, change: payload };
}

test('保存后关闭并重开，项目与节点数据仍在', async () => {
  await temporaryData(async (dataDir) => {
    let app = await startServer({ port: 0, dataDir });
    try {
      const project = await apiChange(app, change(0, { type: 'project.create', title: '持久化项目', summary: '重开后仍可见' }));
      assert.equal(project.status, 200);
      const projectId = project.body.projects.at(-1).id;
      const node = await apiChange(app, change(1, { type: 'node.create', projectId, title: '保存节点' }));
      assert.equal(node.status, 200);
      const nodeId = node.body.nodes.at(-1).id;
      const updated = await apiChange(app, change(2, { type: 'node.update', id: nodeId, patch: { progress: '已保存的进度', next: '重开后继续' } }));
      assert.equal(updated.status, 200);
    } finally {
      await app.close();
    }

    app = await startServer({ port: 0, dataDir });
    try {
      const board = await api(app, '/api/board');
      assert.equal(board.status, 200);
      assert.equal(board.body.revision, 3);
      assert.equal(board.body.projects.at(-1).title, '持久化项目');
      assert.equal(board.body.nodes.at(-1).progress, '已保存的进度');
      assert.equal(board.body.nodes.at(-1).next, '重开后继续');
    } finally {
      await app.close();
    }
  });
});

test('过期版本不能覆盖新内容；同版本并发保存只成功一次', async () => {
  await withServer(async (app) => {
    const first = await apiChange(app, change(0, { type: 'project.create', title: '新内容' }));
    assert.equal(first.status, 200);

    const [left, right] = await Promise.all([
      apiChange(app, change(1, { type: 'project.create', title: '并发左' })),
      apiChange(app, change(1, { type: 'project.create', title: '并发右' })),
    ]);
    assert.deepEqual([left.status, right.status].sort(), [200, 409]);

    const stale = await apiChange(app, change(0, { type: 'project.create', title: '旧内容不得写入' }));
    assert.equal(stale.status, 409);
    const board = await api(app, '/api/board');
    assert.equal(board.body.revision, 2);
    assert.equal(board.body.projects.some((project) => project.title === '旧内容不得写入'), false);
    assert.equal(board.body.projects.filter((project) => ['并发左', '并发右'].includes(project.title)).length, 1);
  });
});

test('损坏的数据文件报错并保留原样，不创建新初始数据', async () => {
  await temporaryData(async (dataDir) => {
    const boardPath = join(dataDir, 'board.json');
    const damaged = '{ this is deliberately not JSON';
    await writeFile(boardPath, damaged, 'utf8');

    await assert.rejects(() => startServer({ port: 0, dataDir }), /无法读取项目数据/);
    assert.equal(await readFile(boardPath, 'utf8'), damaged);
  });
});

test('同一数据目录不能同时打开第二个服务', async () => {
  await temporaryData(async (dataDir) => {
    const first = await startServer({ port: 0, dataDir });
    try {
      await assert.rejects(() => startServer({ port: 0, dataDir }), /已有服务在使用/);
    } finally {
      await first.close();
    }
    const reopened = await startServer({ port: 0, dataDir });
    await reopened.close();
  });
});

test('归档项目可恢复，恢复前不能继续添加节点', async () => {
  await withServer(async (app) => {
    const archived = await apiChange(app, change(0, { type: 'project.update', id: 'p-example', patch: { archived: true } }));
    assert.equal(archived.status, 200);
    const blocked = await apiChange(app, change(1, { type: 'node.create', projectId: 'p-example', title: '不应添加' }));
    assert.equal(blocked.status, 400);
    const restored = await apiChange(app, change(1, { type: 'project.update', id: 'p-example', patch: { archived: false } }));
    assert.equal(restored.status, 200);
    const created = await apiChange(app, change(2, { type: 'node.create', projectId: 'p-example', title: '恢复后节点' }));
    assert.equal(created.status, 200);
  });
});

test('跨项目、循环与重复依赖全部被拒绝', async () => {
  await withServer(async (app) => {
    const other = await apiChange(app, change(0, { type: 'project.create', title: '另一个项目' }));
    assert.equal(other.status, 200);
    const otherId = other.body.projects.at(-1).id;
    const otherNode = await apiChange(app, change(1, { type: 'node.create', projectId: otherId, title: '外部节点' }));
    assert.equal(otherNode.status, 200);
    const otherNodeId = otherNode.body.nodes.at(-1).id;

    for (const payload of [
      { type: 'edge.create', projectId: 'p-example', source: 'n-brief', target: otherNodeId },
      { type: 'edge.create', projectId: 'p-example', source: 'n-visual', target: 'n-brief' },
      { type: 'edge.create', projectId: 'p-example', source: 'n-brief', target: 'n-visual' },
    ]) {
      const result = await apiChange(app, change(2, payload));
      assert.equal(result.status, 400);
    }
    const board = await api(app, '/api/board');
    assert.equal(board.body.revision, 2);
  });
});

test('节点上下文仅带当前项目、当前节点和直接输入', async () => {
  await withServer(async (app) => {
    const other = await apiChange(app, change(0, { type: 'project.create', title: '不相关项目' }));
    const otherId = other.body.projects.at(-1).id;
    const hidden = await apiChange(app, change(1, { type: 'node.create', projectId: otherId, title: '不相关节点隐藏文本' }));
    assert.equal(hidden.status, 200);

    const context = await api(app, '/api/context?node=n-visual');
    assert.equal(context.status, 200);
    assert.match(context.body.markdown, /# 作品集更新/);
    assert.match(context.body.markdown, /## 当前节点：搭建视觉方向/);
    assert.match(context.body.markdown, /### 明确项目目标（n-brief/);
    assert.doesNotMatch(context.body.markdown, /完成页面制作/);
    assert.doesNotMatch(context.body.markdown, /不相关项目|不相关节点隐藏文本/);
  });
});
