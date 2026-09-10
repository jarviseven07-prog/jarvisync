import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import test from 'node:test';
import { startServer } from '../server/index.mjs';
import { createInitialBoard, validateBoard } from '../server/model.mjs';

const tempBase = resolve(tmpdir());

async function temporaryData(action) {
  const directory = await mkdtemp(join(tempBase, 'jarvisync-project-organization-'));
  try {
    return await action(directory);
  } finally {
    const resolved = resolve(directory);
    assert.ok(resolved.startsWith(`${tempBase}${sep}`) && basename(resolved).startsWith('jarvisync-project-organization-'));
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

async function readBoard(app) {
  const response = await fetch(`${app.url}/api/board`);
  assert.equal(response.status, 200);
  return response.json();
}

async function postChange(app, path, expectedRevision, change) {
  const response = await fetch(`${app.url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision, change }),
  });
  return { status: response.status, body: await response.json() };
}

async function humanChange(app, board, change) {
  const result = await postChange(app, '/api/human/change', board.revision, change);
  assert.equal(result.status, 200, result.body.error);
  return result.body;
}

function projectsInGroup(board, groupId) {
  return board.projects
    .map((project, index) => ({ project, index }))
    .filter(({ project }) => (project.groupId ?? null) === groupId)
    .sort((left, right) => {
      const leftOrder = Number.isFinite(left.project.order) ? left.project.order : left.index;
      const rightOrder = Number.isFinite(right.project.order) ? right.project.order : right.index;
      return leftOrder - rightOrder || left.index - right.index;
    })
    .map(({ project }) => project);
}

function organizationFree(project) {
  const { groupId, order, ...content } = project;
  return content;
}

test('删除项目清除所属节点、连线和补充，保留其他项目与删除前历史', async () => {
  await withServer(async (app, dataDir) => {
    let board = await readBoard(app);
    const deletedId = board.projects[0].id;
    board = await humanChange(app, board, { type: 'project.create', title: '保留项目' });
    const keptId = board.projects.at(-1).id;
    board = await app.store.change(board.revision, { type: 'node.create', projectId: keptId, title: '保留节点' });
    for (const input of [
      { projectId: deletedId, body: '删除项目的目标' },
      { projectId: deletedId, nodeId: board.nodes[0].id, body: '删除节点的补充' },
      { projectId: keptId, body: '保留意见' },
    ]) board = await humanChange(app, board, { type: 'human.input.add', kind: 'goal', ...input });
    board = await humanChange(app, board, { type: 'project.group.create', title: '保留分组' });
    const before = structuredClone(board);
    board = await humanChange(app, board, { type: 'project.remove', id: deletedId });
    for (const collection of ['nodes', 'edges', 'humanInputs']) {
      assert.deepEqual(board[collection], before[collection].filter(item => item.projectId !== deletedId));
    }
    assert.deepEqual(board.projects, before.projects.filter(project => project.id !== deletedId));
    assert.deepEqual(board.projectGroups, before.projectGroups);
    assert.equal(board.revision, before.revision + 1);
    assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'board.json'), 'utf8')), board);
    const history = (await readdir(join(dataDir, 'history'))).find(name => name.startsWith(`board-r${before.revision}-`));
    assert.ok(history);
    assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'history', history), 'utf8')), before);
  });
});

test('项目归档和恢复只切换归档标记，完整保留项目组织与项目内记录', async () => {
  await withServer(async (app) => {
    let board = await readBoard(app);
    board = await humanChange(app, board, { type: 'project.create', title: '可归档项目', summary: '恢复后应完整保留。' });
    const projectId = board.projects.at(-1).id;
    board = await humanChange(app, board, { type: 'project.group.create', title: '归档分组' });
    const group = board.projectGroups.at(-1);
    board = await humanChange(app, board, { type: 'project.move', id: projectId, groupId: group.id });
    board = await app.store.change(board.revision, { type: 'node.create', projectId, title: '保留执行记录' });
    const firstNode = board.nodes.at(-1);
    board = await app.store.change(board.revision, { type: 'node.create', projectId, title: '保留连线' });
    const secondNode = board.nodes.at(-1);
    board = await app.store.change(board.revision, { type: 'edge.create', projectId, source: firstNode.id, target: secondNode.id });
    board = await humanChange(app, board, { type: 'human.input.add', projectId, kind: 'decision', body: '归档后仍须保留这条决定。' });
    board = await app.store.change(board.revision, { type: 'node.start', id: firstNode.id, executionRef: 'test:project-archive', owner: '测试执行者', model: 'test-model' });
    const runId = board.nodes.find(node => node.id === firstNode.id).executions.at(-1).id;
    board = await app.store.change(board.revision, { type: 'node.deliver', id: firstNode.id, runId, summary: '归档前交付', links: [], unresolved: '', final: true });

    const beforeArchive = structuredClone(board);
    const originalProject = beforeArchive.projects.find(project => project.id === projectId);
    const originalNodes = beforeArchive.nodes.filter(node => node.projectId === projectId);
    const originalEdges = beforeArchive.edges.filter(edge => edge.projectId === projectId);
    const originalInputs = beforeArchive.humanInputs.filter(input => input.projectId === projectId);
    board = await humanChange(app, board, { type: 'project.archive', id: projectId, archived: true });

    assert.deepEqual(board.projects.find(project => project.id === projectId), { ...originalProject, archived: true });
    assert.deepEqual(board.nodes.filter(node => node.projectId === projectId), originalNodes);
    assert.deepEqual(board.edges.filter(edge => edge.projectId === projectId), originalEdges);
    assert.deepEqual(board.humanInputs.filter(input => input.projectId === projectId), originalInputs);
    assert.deepEqual(board.projectGroups, beforeArchive.projectGroups);
    board = await humanChange(app, board, { type: 'project.archive', id: projectId, archived: false });
    assert.deepEqual(board.projects.find(project => project.id === projectId), originalProject);
    assert.deepEqual(board.nodes.filter(node => node.projectId === projectId), originalNodes);
    assert.deepEqual(board.edges.filter(edge => edge.projectId === projectId), originalEdges);
    assert.deepEqual(board.humanInputs.filter(input => input.projectId === projectId), originalInputs);
  });
});

test('实际执行中的项目不能归档或删除', async () => {
  await withServer(async (app) => {
    let board = await readBoard(app);
    board = await humanChange(app, board, { type: 'project.create', title: '执行中的项目' });
    const projectId = board.projects.at(-1).id;
    board = await app.store.change(board.revision, { type: 'node.create', projectId, title: '执行中的节点' });
    const nodeId = board.nodes.at(-1).id;
    board = await app.store.change(board.revision, { type: 'node.start', id: nodeId, executionRef: 'test:archive-protection', owner: '测试执行者', model: 'test-model' });
    const before = structuredClone(board);

    for (const change of [
      { type: 'project.archive', id: projectId, archived: true },
      { type: 'project.remove', id: projectId },
    ]) {
      const result = await postChange(app, '/api/human/change', board.revision, change);
      assert.equal(result.status, 400);
      assert.match(result.body.error, /实际执行/);
      assert.deepEqual(await readBoard(app), before);
    }
  });
});

test('已归档项目删除时只清除目标项目的数据', async () => {
  await withServer(async (app) => {
    let board = await readBoard(app);
    const retainedId = board.projects[0].id;
    board = await humanChange(app, board, { type: 'project.create', title: '待删除归档项目' });
    const removedId = board.projects.at(-1).id;
    board = await app.store.change(board.revision, { type: 'node.create', projectId: removedId, title: '删除目标节点' });
    board = await humanChange(app, board, { type: 'human.input.add', projectId: removedId, kind: 'goal', body: '删除目标补充。' });
    board = await humanChange(app, board, { type: 'project.archive', id: removedId, archived: true });
    const beforeRemove = structuredClone(board);
    board = await humanChange(app, board, { type: 'project.remove', id: removedId });

    assert.equal(board.projects.some(project => project.id === removedId), false);
    assert.equal(board.nodes.some(node => node.projectId === removedId), false);
    assert.equal(board.edges.some(edge => edge.projectId === removedId), false);
    assert.equal(board.humanInputs.some(input => input.projectId === removedId), false);
    assert.deepEqual(board.projects.find(project => project.id === retainedId), beforeRemove.projects.find(project => project.id === retainedId));
    assert.deepEqual(board.nodes.filter(node => node.projectId === retainedId), beforeRemove.nodes.filter(node => node.projectId === retainedId));
    assert.deepEqual(board.humanInputs.filter(input => input.projectId === retainedId), beforeRemove.humanInputs.filter(input => input.projectId === retainedId));
  });
});

test('项目归档要求有效项目 ID 和布尔归档状态，失败不改数据', async () => {
  await withServer(async (app) => {
    const board = await readBoard(app);
    const id = board.projects[0].id;
    for (const change of [
      { type: 'project.archive', id },
      { type: 'project.archive', archived: true },
      { type: 'project.archive', id, archived: 'true' },
      { type: 'project.archive', id, archived: true, extra: true },
      { type: 'project.archive', id: 'p-missing', archived: true },
    ]) {
      const result = await postChange(app, '/api/human/change', board.revision, change);
      assert.ok([400, 404].includes(result.status), `${JSON.stringify(change)}: ${result.status}`);
      assert.deepEqual(await readBoard(app), board);
    }
  });
});

test('删除拒绝陈旧版本、无效项目和 Agent 入口，删除最后项目后重启仍为空', async () => {
  await temporaryData(async (dataDir) => {
    let app = await startServer({ port: 0, dataDir });
    try {
      let board = await readBoard(app);
      const id = board.projects[0].id;
      const staleRevision = board.revision;
      board = await humanChange(app, board, { type: 'project.group.create', title: '分类' });
      const stale = await postChange(app, '/api/human/change', staleRevision, { type: 'project.remove', id });
      assert.equal(stale.status, 409);
      for (const change of [{ type: 'project.remove', id: 'p-missing' }, { type: 'project.remove', id, extra: true }]) {
        assert.ok((await postChange(app, '/api/human/change', board.revision, change)).status >= 400);
      }
      assert.ok((await postChange(app, '/api/change', board.revision, { type: 'project.remove', id })).status >= 400);
      assert.deepEqual(await readBoard(app), board);
      board = await humanChange(app, board, { type: 'project.remove', id });
      assert.equal(board.projects.length, 0);
      assert.equal(board.nodes.length, 0);
      assert.equal(board.edges.length, 0);
      await app.close();
      app = await startServer({ port: 0, dataDir });
      assert.deepEqual(await readBoard(app), board);
    } finally { await app.close(); }
  });
});

test('schemaVersion 1 旧数据无需分组和顺序字段，读取时不会迁移重写', async () => {
  await temporaryData(async (dataDir) => {
    const legacy = createInitialBoard();
    assert.equal(Object.hasOwn(legacy, 'projectGroups'), false);
    assert.equal(Object.hasOwn(legacy.projects[0], 'groupId'), false);
    assert.equal(Object.hasOwn(legacy.projects[0], 'order'), false);
    assert.equal(validateBoard(structuredClone(legacy)).schemaVersion, 1);

    const original = `${JSON.stringify(legacy, null, 2)}\n`;
    const boardPath = join(dataDir, 'board.json');
    await writeFile(boardPath, original, 'utf8');
    const app = await startServer({ port: 0, dataDir });
    try {
      assert.deepEqual(await readBoard(app), legacy);
    } finally {
      await app.close();
    }
    assert.equal(await readFile(boardPath, 'utf8'), original);
  });
});

test('分组创建、改名和删除保留项目、归档项目与全部节点', async () => {
  await withServer(async (app) => {
    let board = await readBoard(app);
    board = await humanChange(app, board, { type: 'project.create', title: '归档后仍保留', summary: '不能随分组删除。' });
    const retainedId = board.projects.at(-1).id;
    const nodesBefore = structuredClone(board.nodes);
    const projectsBefore = new Map(board.projects.map(project => [project.id, organizationFree(project)]));

    board = await humanChange(app, board, { type: 'project.group.create', title: '  客户项目  ' });
    const group = board.projectGroups[0];
    assert.equal(group.title, '客户项目');
    assert.ok(!Number.isNaN(Date.parse(group.createdAt)));
    board = await humanChange(app, board, { type: 'project.group.rename', id: group.id, title: '内部项目' });
    assert.deepEqual(board.projectGroups[0], { ...group, title: '内部项目' });
    board = await humanChange(app, board, { type: 'project.move', id: retainedId, groupId: group.id });

    board = await app.store.change(board.revision, { type: 'project.update', id: retainedId, patch: { archived: true } });
    const archivedBeforeRemove = structuredClone(board.projects.find(project => project.id === retainedId));
    board = await humanChange(app, board, { type: 'project.group.remove', id: group.id });

    assert.deepEqual(board.projectGroups, []);
    assert.deepEqual(board.nodes, nodesBefore);
    assert.equal(board.projects.length, projectsBefore.size);
    assert.deepEqual(
      organizationFree(board.projects.find(project => project.id === retainedId)),
      { ...organizationFree(archivedBeforeRemove) },
    );
    assert.equal(board.projects.find(project => project.id === retainedId).archived, true);
    assert.equal(Object.hasOwn(board.projects.find(project => project.id === retainedId), 'groupId'), false);
    for (const project of board.projects) {
      const expected = project.id === retainedId ? organizationFree(archivedBeforeRemove) : projectsBefore.get(project.id);
      assert.deepEqual(organizationFree(project), expected);
    }
  });
});

test('同组和跨组移动按 beforeId 持久排序，空 beforeId 放在组末尾', async () => {
  await withServer(async (app) => {
    let board = await readBoard(app);
    for (const title of ['项目 A', '项目 B', '项目 C']) board = await humanChange(app, board, { type: 'project.create', title });
    const [projectA, projectB, projectC] = board.projects.slice(-3);
    const projectAContent = organizationFree(structuredClone(projectA));
    board = await humanChange(app, board, { type: 'project.group.create', title: '第一组' });
    board = await humanChange(app, board, { type: 'project.group.create', title: '第二组' });
    const [firstGroup, secondGroup] = board.projectGroups;

    board = await humanChange(app, board, { type: 'project.move', id: projectA.id, groupId: firstGroup.id });
    board = await humanChange(app, board, { type: 'project.move', id: projectB.id, groupId: firstGroup.id, beforeId: null });
    board = await humanChange(app, board, { type: 'project.move', id: projectC.id, groupId: firstGroup.id, beforeId: projectB.id });
    assert.deepEqual(projectsInGroup(board, firstGroup.id).map(project => project.id), [projectA.id, projectC.id, projectB.id]);
    assert.deepEqual(projectsInGroup(board, firstGroup.id).map(project => project.order), [0, 1, 2]);

    board = await humanChange(app, board, { type: 'project.move', id: projectA.id, groupId: secondGroup.id });
    assert.deepEqual(projectsInGroup(board, firstGroup.id).map(project => project.id), [projectC.id, projectB.id]);
    assert.deepEqual(projectsInGroup(board, firstGroup.id).map(project => project.order), [0, 1]);
    board = await humanChange(app, board, { type: 'project.move', id: projectA.id, groupId: firstGroup.id, beforeId: projectC.id });
    assert.deepEqual(projectsInGroup(board, firstGroup.id).map(project => project.id), [projectA.id, projectC.id, projectB.id]);
    assert.deepEqual(projectsInGroup(board, secondGroup.id), []);
    assert.deepEqual(organizationFree(board.projects.find(project => project.id === projectA.id)), projectAContent);
  });
});

test('新项目默认进入未分组末尾，组织命令仍只允许人工路由', async () => {
  await withServer(async (app) => {
    let board = await readBoard(app);
    board = await humanChange(app, board, { type: 'project.create', title: '先创建' });
    const firstId = board.projects.at(-1).id;
    board = await humanChange(app, board, { type: 'project.create', title: '后创建' });
    const secondId = board.projects.at(-1).id;
    assert.deepEqual(projectsInGroup(board, null).slice(-2).map(project => project.id), [firstId, secondId]);

    const rejected = await postChange(app, '/api/change', board.revision, { type: 'project.group.create', title: 'Agent 不可建组' });
    assert.equal(rejected.status, 410);
    assert.deepEqual(await readBoard(app), board);
  });
});

test('重复名称、坏参数、未知分组、错误 beforeId 和归档对象均拒绝且不改数据', async () => {
  await withServer(async (app) => {
    let board = await readBoard(app);
    for (const title of ['甲项目', '乙项目', '丙项目']) board = await humanChange(app, board, { type: 'project.create', title });
    const [projectA, projectB, projectC] = board.projects.slice(-3);
    board = await humanChange(app, board, { type: 'project.group.create', title: 'Alpha' });
    board = await humanChange(app, board, { type: 'project.group.create', title: 'Beta' });
    const [alpha, beta] = board.projectGroups;
    board = await humanChange(app, board, { type: 'project.move', id: projectA.id, groupId: alpha.id });
    board = await humanChange(app, board, { type: 'project.move', id: projectB.id, groupId: beta.id });
    board = await app.store.change(board.revision, { type: 'project.update', id: projectC.id, patch: { archived: true } });

    const invalidChanges = [
      { type: 'project.group.create', title: ' alpha ' },
      { type: 'project.group.create', title: ' 未分组 ' },
      { type: 'project.group.rename', id: beta.id, title: 'ALPHA' },
      { type: 'project.group.remove', id: 'pg-missing' },
      { type: 'project.move', id: projectA.id, groupId: 'pg-missing' },
      { type: 'project.move', id: projectA.id, groupId: 42 },
      { type: 'project.move', id: projectA.id, groupId: alpha.id, beforeId: '' },
      { type: 'project.move', id: projectA.id, groupId: alpha.id, beforeId: 'p-missing' },
      { type: 'project.move', id: projectA.id, groupId: alpha.id, beforeId: projectB.id },
      { type: 'project.move', id: projectA.id, groupId: alpha.id, beforeId: projectA.id },
      { type: 'project.move', id: projectC.id, groupId: alpha.id },
      { type: 'project.move', id: projectA.id, groupId: null, beforeId: projectC.id },
      { type: 'project.move', id: projectA.id, groupId: alpha.id, surprise: true },
    ];
    for (const change of invalidChanges) {
      const before = structuredClone(board);
      const result = await postChange(app, '/api/human/change', board.revision, change);
      assert.ok([400, 404].includes(result.status), `${change.type}: ${result.status}`);
      board = await readBoard(app);
      assert.deepEqual(board, before);
    }
  });
});

test('过期版本的组织修改不落盘，成功分组和排序在重开后保持', async () => {
  await temporaryData(async (dataDir) => {
    let app = await startServer({ port: 0, dataDir });
    let persisted;
    try {
      let board = await readBoard(app);
      board = await humanChange(app, board, { type: 'project.create', title: '持久项目' });
      const projectId = board.projects.at(-1).id;
      board = await humanChange(app, board, { type: 'project.group.create', title: '长期项目' });
      const groupId = board.projectGroups[0].id;
      board = await humanChange(app, board, { type: 'project.move', id: projectId, groupId });
      persisted = structuredClone(board);
      const diskBeforeConflict = await readFile(join(dataDir, 'board.json'), 'utf8');

      const stale = await postChange(app, '/api/human/change', board.revision - 1, { type: 'project.group.rename', id: groupId, title: '不应写入' });
      assert.equal(stale.status, 409);
      assert.deepEqual(await readBoard(app), persisted);
      assert.equal(await readFile(join(dataDir, 'board.json'), 'utf8'), diskBeforeConflict);
    } finally {
      await app.close();
    }

    app = await startServer({ port: 0, dataDir });
    try {
      assert.deepEqual(await readBoard(app), persisted);
    } finally {
      await app.close();
    }
  });
});

test('坏的历史分组引用和顺序被拒绝，原文件保持不变', async () => {
  const invalidOrder = createInitialBoard();
  invalidOrder.projects[0].order = 'first';
  assert.throws(() => validateBoard(invalidOrder), /项目顺序不正确/);

  await temporaryData(async (dataDir) => {
    const invalid = createInitialBoard();
    invalid.projects[0].groupId = 'pg-missing';
    const original = `${JSON.stringify(invalid, null, 2)}\n`;
    const boardPath = join(dataDir, 'board.json');
    await writeFile(boardPath, original, 'utf8');
    await assert.rejects(() => startServer({ port: 0, dataDir }), /无法读取项目数据/);
    assert.equal(await readFile(boardPath, 'utf8'), original);
  });
});
