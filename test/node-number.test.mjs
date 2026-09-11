import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import test from 'node:test';
import { openAgentService } from '../server/agent-service.mjs';
import { applyChange, buildContext, createInitialBoard, formatNodeNumber, normalizeBoard, prepareHumanChange, validateBoard } from '../server/model.mjs';
import { openStore } from '../server/store.mjs';

const tempBase = resolve(tmpdir());

async function temporaryStore(action, initialBoard) {
  const directory = await mkdtemp(join(tempBase, 'nodeboard-node-number-'));
  const boardPath = join(directory, 'board.json');
  let store;
  try {
    if (initialBoard !== undefined) await writeFile(boardPath, `${JSON.stringify(initialBoard, null, 2)}\n`, 'utf8');
    store = await openStore(directory);
    return await action(store, { directory, boardPath });
  } finally {
    await store?.close();
    const resolved = resolve(directory);
    assert.ok(resolved.startsWith(`${tempBase}${sep}`) && basename(resolved).startsWith('nodeboard-node-number-'), '只清理本测试创建的临时目录');
    await rm(resolved, { recursive: true, force: true, maxRetries: 3 });
  }
}

test('示例和常规创建按项目独立分配固定节点编号', () => {
  let board = createInitialBoard();
  assert.deepEqual(board.nodes.map(node => node.nodeNumber), ['001', '002', '003', '004', '005', '006']);
  assert.equal(board.projects[0].nextNodeNumber, 7);

  board = applyChange(board, { type: 'project.create', title: '第二个项目' });
  const second = board.projects.at(-1);
  assert.equal(second.nextNodeNumber, 1);
  board = applyChange(board, { type: 'node.create', projectId: second.id, title: '第二项目首节点' });
  assert.equal(board.nodes.at(-1).nodeNumber, '001');
  board = applyChange(board, { type: 'node.create', projectId: 'p-example', title: '示例项目后续节点' });
  assert.equal(board.nodes.at(-1).nodeNumber, '007');
  assert.equal(formatNodeNumber(1000), '1000');
});

test('旧数据按创建时间和既有数组顺序补号，只读加载不改写磁盘', async () => {
  const legacy = createInitialBoard();
  legacy.nodes[0].createdAt = '2026-01-03T00:00:00.000Z';
  legacy.nodes[1].createdAt = '2026-01-01T00:00:00.000Z';
  legacy.nodes[2].createdAt = '2026-01-01T00:00:00.000Z';
  legacy.nodes[3].createdAt = '2026-01-02T00:00:00.000Z';
  const preserved = structuredClone(legacy.nodes[2]);
  legacy.nodes[4].nodeNumber = '009';
  legacy.nodes[5].nodeNumber = '0010';
  for (const node of legacy.nodes.slice(0, 4)) delete node.nodeNumber;
  delete legacy.projects[0].nextNodeNumber;
  const original = `${JSON.stringify(legacy, null, 2)}\n`;

  await temporaryStore(async (store, { boardPath }) => {
    const board = await store.read();
    const byId = Object.fromEntries(board.nodes.map(node => [node.id, node.nodeNumber]));
    assert.deepEqual(byId, { 'n-brief': '014', 'n-visual': '011', 'n-build': '012', 'n-content': '013', 'n-check': '009', 'n-handoff': '0010' });
    assert.equal(board.projects[0].nextNodeNumber, 15);
    assert.equal(await readFile(boardPath, 'utf8'), original);
    assert.deepEqual({ ...board.nodes.find(node => node.id === preserved.id), nodeNumber: preserved.nodeNumber }, preserved);

    const saved = await store.change(board.revision, { type: 'node.create', projectId: 'p-example', title: '迁移后新增' });
    assert.equal(saved.nodes.at(-1).nodeNumber, '015');
    const persisted = JSON.parse(await readFile(boardPath, 'utf8'));
    assert.equal(persisted.projects[0].nextNodeNumber, 16);
    assert.deepEqual(persisted.nodes.map(node => node.nodeNumber), ['014', '011', '012', '013', '009', '0010', '015']);
  }, legacy);
});

test('归档、数组排序、删除和重启都不改变编号或复用流水', async () => {
  let board = createInitialBoard();
  const removedId = board.nodes[1].id;
  board.nodes = board.nodes.filter(node => node.id !== removedId).reverse();
  board.edges = board.edges.filter(edge => edge.source !== removedId && edge.target !== removedId);
  board = applyChange(board, prepareHumanChange({ type: 'node.move', id: 'n-build', position: { x: 80, y: 90 } }));
  board = applyChange(board, { type: 'node.update', id: 'n-content', patch: { archived: true } });
  board = applyChange(board, { type: 'node.create', projectId: 'p-example', title: '删除与归档后新增' });
  assert.equal(board.nodes.at(-1).nodeNumber, '007');
  const expected = Object.fromEntries(board.nodes.map(node => [node.id, node.nodeNumber]));

  await temporaryStore(async (store) => {
    assert.deepEqual(Object.fromEntries((await store.read()).nodes.map(node => [node.id, node.nodeNumber])), expected);
  }, board);
});

test('同项目重复、非法编号和倒退流水拒绝，跨项目可使用相同编号', () => {
  const malformed = createInitialBoard();
  malformed.nodes[0].nodeNumber = '1';
  assert.throws(() => normalizeBoard(malformed), /节点编号格式不正确/);

  const duplicate = createInitialBoard();
  duplicate.nodes[1].nodeNumber = '0001';
  assert.throws(() => normalizeBoard(duplicate), /重复节点编号/);

  const backwards = createInitialBoard();
  backwards.projects[0].nextNodeNumber = 6;
  assert.throws(() => validateBoard(backwards), /节点编号流水不正确/);

  let independent = applyChange(createInitialBoard(), { type: 'project.create', title: '独立项目' });
  const project = independent.projects.at(-1);
  independent = applyChange(independent, { type: 'node.create', projectId: project.id, title: '可重复 001' });
  assert.equal(independent.nodes.find(node => node.projectId === project.id).nodeNumber, '001');
  assert.doesNotThrow(() => validateBoard(independent));
});

test('节点编号拒绝超长前导零，并接受可继续持有流水的 16 位安全整数边界', () => {
  const oversized = createInitialBoard();
  oversized.nodes[0].nodeNumber = `${'0'.repeat(10_000)}1`;
  assert.throws(() => normalizeBoard(oversized), /节点编号格式不正确/);

  const boundary = createInitialBoard();
  boundary.nodes[0].nodeNumber = String(Number.MAX_SAFE_INTEGER - 1);
  boundary.projects[0].nextNodeNumber = Number.MAX_SAFE_INTEGER;
  assert.equal(boundary.nodes[0].nodeNumber.length, 16);
  assert.equal(formatNodeNumber(Number.MAX_SAFE_INTEGER), String(Number.MAX_SAFE_INTEGER));
  assert.doesNotThrow(() => validateBoard(boundary));
  assert.equal(normalizeBoard(boundary), boundary);
});

test('Agent 一次创建项目与多个节点时沿用同一项目流水', async () => {
  await temporaryStore(async (store) => {
    const initial = await store.read();
    const service = openAgentService({ store });
    const session = { host: 'codex', profileId: 'node-number-test', sessionId: 'agent-create' };
    const result = await service.attach({
      boardInstanceId: store.boardInstanceId,
      session,
      clientOperationId: 'create-with-nodes',
      expectedRevision: initial.revision,
      create: {
        title: 'Agent 创建项目',
        nodes: [
          { key: 'first', dependsOn: [], independentReason: '独立测试任务，无需上游成果', title: '第一节点' },
          { key: 'second', title: '第二节点', dependsOn: ['first'] },
        ],
      },
      nodeKey: 'second',
    });
    const board = await store.read();
    const project = board.projects.find(item => item.id === result.binding.projectId);
    const nodes = board.nodes.filter(node => node.projectId === project.id);
    assert.deepEqual(nodes.map(node => node.nodeNumber), ['001', '002']);
    assert.equal(project.nextNodeNumber, 3);
    assert.equal(result.binding.nodeId, nodes[1].id);
  });
});

test('项目、当前节点和直接输入上下文都显示编号到 UUID 的映射', () => {
  const board = createInitialBoard();
  const projectContext = buildContext(board, { project: 'p-example' }).markdown;
  assert.match(projectContext, /- #001 \| n-brief \| 明确项目目标/);
  assert.match(projectContext, /- #006 \| n-handoff \| 交付与下一步/);

  const nodeContext = buildContext(board, { node: 'n-visual' }).markdown;
  assert.match(nodeContext, /节点编号：#002\n节点 ID：n-visual/);
  assert.match(nodeContext, /### 明确项目目标（n-brief · #001/);
});
