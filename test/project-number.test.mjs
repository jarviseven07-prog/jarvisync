import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import test from 'node:test';
import { openAgentService } from '../server/agent-service.mjs';
import { buildContext, createInitialBoard, formatProjectNumber, normalizeProjectNumbers, prepareHumanChange, validateBoard } from '../server/model.mjs';
import { openStore } from '../server/store.mjs';

const tempBase = resolve(tmpdir());

async function temporaryStore(action) {
  const directory = await mkdtemp(join(tempBase, 'nodeboard-project-number-'));
  let store;
  try {
    store = await openStore(directory);
    return await action(store, directory);
  } finally {
    await store?.close();
    const resolved = resolve(directory);
    assert.ok(resolved.startsWith(`${tempBase}${sep}`) && basename(resolved).startsWith('nodeboard-project-number-'), '只清理本测试创建的临时目录');
    await rm(resolved, { recursive: true, force: true, maxRetries: 3 });
  }
}

test('项目编号在改名和排序后保持，删除后不复用', async () => {
  await temporaryStore(async (store) => {
    let board = await store.read();
    assert.equal(board.projects[0].projectNumber, '001');
    assert.equal(board.nextProjectNumber, 2);

    board = await store.change(board.revision, prepareHumanChange({ type: 'project.create', title: '第二个项目' }));
    const second = board.projects.at(-1);
    assert.equal(second.projectNumber, '002');

    board = await store.change(board.revision, { type: 'project.update', id: second.id, patch: { title: '改名后的项目' } });
    board = await store.change(board.revision, prepareHumanChange({ type: 'project.group.create', title: '长期项目' }));
    board = await store.change(board.revision, prepareHumanChange({ type: 'project.move', id: second.id, groupId: board.projectGroups[0].id }));
    assert.equal(board.projects.find(project => project.id === second.id).projectNumber, '002');

    board = await store.change(board.revision, prepareHumanChange({ type: 'project.remove', id: second.id }));
    board = await store.change(board.revision, prepareHumanChange({ type: 'project.create', title: '删除后创建' }));
    assert.equal(board.projects.at(-1).projectNumber, '003');
    assert.equal(board.nextProjectNumber, 4);
  });
});

test('旧数据按既有项目顺序补号，并在下一次正常保存时持久化', async () => {
  const directory = await mkdtemp(join(tempBase, 'nodeboard-project-number-'));
  const boardPath = join(directory, 'board.json');
  let store;
  try {
    const legacy = createInitialBoard();
    legacy.projects.push({
      ...structuredClone(legacy.projects[0]),
      id: 'p-existing',
      title: '既有项目',
      demo: false,
      order: 1,
    });
    for (const project of legacy.projects) delete project.projectNumber;
    delete legacy.nextProjectNumber;
    await writeFile(boardPath, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');

    store = await openStore(directory);
    let board = await store.read();
    assert.deepEqual(board.projects.map(project => project.projectNumber), ['001', '002']);
    assert.equal(board.nextProjectNumber, 3);

    board = await store.change(board.revision, prepareHumanChange({ type: 'project.create', title: '迁移后新建' }));
    assert.equal(board.projects.at(-1).projectNumber, '003');
    const persisted = JSON.parse(await readFile(boardPath, 'utf8'));
    assert.deepEqual(persisted.projects.map(project => project.projectNumber), ['001', '002', '003']);
    assert.equal(persisted.nextProjectNumber, 4);
  } finally {
    await store?.close();
    const resolved = resolve(directory);
    assert.ok(resolved.startsWith(`${tempBase}${sep}`) && basename(resolved).startsWith('nodeboard-project-number-'), '只清理本测试创建的临时目录');
    await rm(resolved, { recursive: true, force: true, maxRetries: 3 });
  }
});

test('上下文和 Agent 发现同时给出项目编号与原始 ID', async () => {
  await temporaryStore(async (store) => {
    const board = await store.read();
    const context = buildContext(board, { project: board.projects[0].id });
    assert.match(context.markdown, /项目编号：001/);
    assert.match(context.markdown, /项目 ID：p-example/);

    const service = openAgentService({ store });
    const discovery = await service.discover({
      boardInstanceId: store.boardInstanceId,
      session: { host: 'codex', profileId: 'test-profile', sessionId: 'test-session' },
    });
    assert.deepEqual(discovery.candidates, []);

    let updated = await store.change(board.revision, prepareHumanChange({ type: 'project.create', title: '真实项目' }));
    const secondDiscovery = await service.discover({
      boardInstanceId: store.boardInstanceId,
      session: { host: 'codex', profileId: 'test-profile', sessionId: 'test-session' },
    });
    assert.deepEqual(
      secondDiscovery.candidates.map(({ projectId, projectNumber }) => ({ projectId, projectNumber })),
      [{ projectId: updated.projects.at(-1).id, projectNumber: '002' }],
    );
  });
});

test('带 JS 前缀和无前缀旧编号归一为数字格式，保留 UUID、流水和千位数', () => {
  const legacy = createInitialBoard();
  legacy.projects[0].projectNumber = 'JS-001';
  legacy.projects.push(
    { ...structuredClone(legacy.projects[0]), id: 'p-bare', projectNumber: '002', title: '无前缀旧项目' },
    { ...structuredClone(legacy.projects[0]), id: 'p-thousand', projectNumber: 'JS-1000', title: '千位旧项目' },
  );
  legacy.nextProjectNumber = 1001;

  const normalized = normalizeProjectNumbers(legacy);
  assert.deepEqual(normalized.projects.map(project => project.projectNumber), ['001', '002', '1000']);
  assert.deepEqual(normalized.projects.map(project => project.id), ['p-example', 'p-bare', 'p-thousand']);
  assert.equal(normalized.nextProjectNumber, 1001);
  assert.equal(formatProjectNumber(1000), '1000');
  assert.doesNotThrow(() => validateBoard(normalized));
});

test('重复编号、非规范编号和倒退流水均拒绝', () => {
  const duplicate = createInitialBoard();
  duplicate.projects.push({ ...structuredClone(duplicate.projects[0]), id: 'p-duplicate' });
  assert.throws(() => validateBoard(duplicate), /重复项目编号/);

  const malformed = createInitialBoard();
  malformed.projects[0].projectNumber = '编号-001';
  assert.throws(() => normalizeProjectNumbers(malformed), /项目编号格式不正确/);

  const aliasDuplicate = createInitialBoard();
  aliasDuplicate.projects[0].projectNumber = 'JS-001';
  aliasDuplicate.projects.push({ ...structuredClone(aliasDuplicate.projects[0]), id: 'p-alias', projectNumber: '001' });
  assert.throws(() => normalizeProjectNumbers(aliasDuplicate), /重复项目编号/);

  const reused = createInitialBoard();
  reused.nextProjectNumber = 1;
  assert.throws(() => normalizeProjectNumbers(reused), /项目编号流水不正确/);
});
