import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { startServer } from '../server/index.mjs';
import { applyChange, buildContext, createInitialBoard, validateBoard } from '../server/model.mjs';

const tempBase = resolve(tmpdir());
const exec = promisify(execFile);

async function temporaryData(action) {
  const directory = await mkdtemp(join(tempBase, 'nodeboard-human-'));
  try {
    return await action(directory);
  } finally {
    const resolved = resolve(directory);
    assert.ok(resolved.startsWith(`${tempBase}${sep}`) && basename(resolved).startsWith('nodeboard-human-'));
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

async function postChange(app, path, expectedRevision, change, headers = {}) {
  const response = await fetch(`${app.url}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ expectedRevision, change }),
  });
  return { status: response.status, body: await response.json() };
}

test('不含 humanInputs 的旧看板可以原样读取且不会被迁移重写', async () => {
  await temporaryData(async (dataDir) => {
    const legacy = createInitialBoard();
    delete legacy.humanInputs;
    for (const node of legacy.nodes) delete node.model;
    const original = `${JSON.stringify(legacy, null, 2)}\n`;
    const boardPath = join(dataDir, 'board.json');
    await writeFile(boardPath, original, 'utf8');

    const app = await startServer({ port: 0, dataDir });
    try {
      const board = await readBoard(app);
      assert.equal(Object.hasOwn(board, 'humanInputs'), false);
      assert.equal(Object.hasOwn(board.nodes[0], 'model'), false);
    } finally {
      await app.close();
    }
    assert.equal(await readFile(boardPath, 'utf8'), original);
  });
});

test('人工输入只追加独立记录，保留节点 Agent 字段并可在重启后恢复', async () => {
  await temporaryData(async (dataDir) => {
    let app = await startServer({ port: 0, dataDir });
    try {
      const before = await readBoard(app);
      const nodeBefore = structuredClone(before.nodes.find(node => node.id === 'n-visual'));
      const saved = await postChange(app, '/api/human/change', before.revision, {
        type: 'human.input.add',
        projectId: 'p-example',
        nodeId: 'n-visual',
        kind: 'feedback',
        body: '  封面间距需要收紧。  ',
      });
      assert.equal(saved.status, 200);
      assert.equal(saved.body.revision, before.revision + 1);
      assert.deepEqual(saved.body.nodes.find(node => node.id === 'n-visual'), nodeBefore);
      assert.equal(saved.body.humanInputs.length, 1);
      assert.match(saved.body.humanInputs[0].id, /^h-/);
      assert.equal(saved.body.humanInputs[0].body, '封面间距需要收紧。');
      assert.equal(saved.body.humanInputs[0].kind, 'feedback');
      assert.ok(!Number.isNaN(Date.parse(saved.body.humanInputs[0].createdAt)));

      const persisted = structuredClone(saved.body);
      await app.close();
      app = await startServer({ port: 0, dataDir });
      assert.deepEqual(await readBoard(app), persisted);
    } finally {
      await app.close();
    }
  });
});

test('人工路由只接受约定动作，Agent 路由不能冒充人工输入', async () => {
  await withServer(async (app) => {
    const initial = await readBoard(app);
    for (const change of [
      { type: 'node.update', id: 'n-visual', patch: { progress: '人工伪造进度' } },
      { type: 'human.input.add', projectId: 'p-example', kind: 'goal', body: '目标', status: 'done' },
      { type: 'human.input.add', projectId: 'p-example', kind: 'material', body: 'x'.repeat(4001) },
      { type: 'node.move', id: 'n-visual', position: { x: 10, y: 20 }, owner: '人工改负责人' },
    ]) {
      const result = await postChange(app, '/api/human/change', initial.revision, change);
      assert.equal(result.status, 400);
    }

    const impersonation = await postChange(app, '/api/change', initial.revision, {
      type: 'human.input.add', projectId: 'p-example', kind: 'decision', body: '伪造人工决定',
    });
    assert.equal(impersonation.status, 410);

    const byOrigin = await postChange(app, '/api/change', initial.revision, {
      type: 'node.update', id: 'n-visual', patch: { progress: '浏览器写 Agent 字段' },
    }, { Origin: app.url });
    assert.equal(byOrigin.status, 410);

    const byFetchMetadata = await postChange(app, '/api/change', initial.revision, {
      type: 'node.update', id: 'n-visual', patch: { progress: '浏览器写 Agent 字段' },
    }, { 'Sec-Fetch-Site': 'same-origin' });
    assert.equal(byFetchMetadata.status, 410);

    const after = await readBoard(app);
    assert.equal(after.revision, initial.revision);
    assert.deepEqual(after.humanInputs, []);
    assert.notEqual(after.nodes.find(node => node.id === 'n-visual').progress, '人工伪造进度');
  });
});

test('人工移动只改位置，批量布局与创建项目仍使用同一版本控制', async () => {
  await withServer(async (app) => {
    const initial = await readBoard(app);
    const before = structuredClone(initial.nodes.find(node => node.id === 'n-visual'));
    const moved = await postChange(app, '/api/human/change', initial.revision, {
      type: 'node.move', id: before.id, position: { x: 321, y: 123 },
    });
    assert.equal(moved.status, 200);
    assert.deepEqual(moved.body.nodes.find(node => node.id === before.id), { ...before, position: { x: 321, y: 123 } });

    const laidOut = await postChange(app, '/api/human/change', moved.body.revision, {
      type: 'nodes.layout',
      projectId: 'p-example',
      positions: [
        { id: 'n-brief', position: { x: 20, y: 30 } },
        { id: 'n-visual', position: { x: 340, y: 30 } },
      ],
    });
    assert.equal(laidOut.status, 200);
    assert.deepEqual(laidOut.body.nodes.find(node => node.id === 'n-brief').position, { x: 20, y: 30 });

    const created = await postChange(app, '/api/human/change', laidOut.body.revision, {
      type: 'project.create', title: '人工新建项目', summary: '等待 Agent 接续。',
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.projects.at(-1).title, '人工新建项目');
  });
});

test('同版本人工输入并发时只保存一条，另一条返回冲突', async () => {
  await withServer(async (app) => {
    const initial = await readBoard(app);
    const [left, right] = await Promise.all([
      postChange(app, '/api/human/change', initial.revision, { type: 'human.input.add', projectId: 'p-example', kind: 'goal', body: '左侧目标' }),
      postChange(app, '/api/human/change', initial.revision, { type: 'human.input.add', projectId: 'p-example', kind: 'goal', body: '右侧目标' }),
    ]);
    assert.deepEqual([left.status, right.status].sort(), [200, 409]);
    const board = await readBoard(app);
    assert.equal(board.revision, initial.revision + 1);
    assert.equal(board.humanInputs.length, 1);
  });
});

test('节点上下文展开项目、当前节点和直接输入的人工补充，不展开下游与无关节点', async () => {
  await withServer(async (app) => {
    let board = await readBoard(app);
    const projectGoal = `项目级目标：${'甲'.repeat(1050)}项目级完整尾标`;
    const currentFeedback = `当前节点反馈：${'乙'.repeat(1050)}当前节点完整尾标`;
    const upstreamMaterial = `上游资料：${'丙'.repeat(1050)}上游资料完整尾标`;
    for (const change of [
      { type: 'human.input.add', projectId: 'p-example', kind: 'goal', body: projectGoal },
      { type: 'human.input.add', projectId: 'p-example', nodeId: 'n-visual', kind: 'feedback', body: currentFeedback },
      { type: 'human.input.add', projectId: 'p-example', nodeId: 'n-brief', kind: 'decision', body: '上游决定：保留手工纸质感。' },
      { type: 'human.input.add', projectId: 'p-example', nodeId: 'n-brief', kind: 'material', body: upstreamMaterial },
      { type: 'human.input.add', projectId: 'p-example', nodeId: 'n-build', kind: 'feedback', body: '下游反馈：交付前增加动效。' },
      { type: 'human.input.add', projectId: 'p-example', nodeId: 'n-content', kind: 'material', body: '旁支资料：内部路径。' },
      { type: 'project.create', title: '无关项目', summary: '' },
    ]) {
      const saved = await postChange(app, '/api/human/change', board.revision, change);
      assert.equal(saved.status, 200);
      board = saved.body;
    }
    const otherProject = board.projects.at(-1);
    const unrelated = await postChange(app, '/api/human/change', board.revision, {
      type: 'human.input.add', projectId: otherProject.id, kind: 'decision', body: '无关项目秘密决定。',
    });
    assert.equal(unrelated.status, 200);
    board = unrelated.body;

    const modelSaved = await app.store.change(board.revision, {
      type: 'node.update', id: 'n-visual', patch: { owner: 'Jarvis', model: 'GPT6 Astra' },
    });
    assert.equal(modelSaved.nodes.find(node => node.id === 'n-visual').model, 'GPT6 Astra');

    const nodeContext = await (await fetch(`${app.url}/api/context?node=n-visual`)).json();
    assert.match(nodeContext.markdown, /人工输入（按时间顺序）/);
    assert.match(nodeContext.markdown, /项目级完整尾标/);
    assert.match(nodeContext.markdown, /当前节点完整尾标/);
    assert.equal(nodeContext.markdown.split(currentFeedback).length - 1, 1, '当前节点人工输入只展开一次');
    assert.match(nodeContext.markdown, /上游决定：保留手工纸质感/);
    assert.match(nodeContext.markdown, /上游资料：丙+/);
    assert.match(nodeContext.markdown, /人工补充（节点 n-brief） · 决定 · 看板补充 · \d{4}-[^·]+ · h-/);
    assert.match(nodeContext.markdown, /人工补充（节点 n-brief） · 资料 · 看板补充 · \d{4}-[^·]+ · h-/);
    assert.match(nodeContext.markdown, /人工输入已截短，请按节点 ID n-brief 读取完整上下文/);
    assert.doesNotMatch(nodeContext.markdown, /上游资料完整尾标/);
    assert.match(nodeContext.markdown, /其他节点另有 2 条人工输入/);
    assert.doesNotMatch(nodeContext.markdown, /下游反馈：交付前增加动效|旁支资料：内部路径|无关项目秘密决定/);
    assert.match(nodeContext.markdown, /负责人：Jarvis/);
    assert.match(nodeContext.markdown, /执行模型：GPT6 Astra/);

    const upstreamContext = await (await fetch(`${app.url}/api/context?node=n-brief`)).json();
    assert.match(upstreamContext.markdown, /上游资料完整尾标/);

    const projectContext = await (await fetch(`${app.url}/api/context?project=p-example`)).json();
    assert.match(projectContext.markdown, /项目级完整尾标/);
    assert.match(projectContext.markdown, /其他节点另有 5 条人工输入/);
    assert.doesNotMatch(projectContext.markdown, /当前节点反馈：|上游决定：|上游资料：|下游反馈：|旁支资料：|无关项目秘密决定/);
  });
});

test('旧节点没有 model 时仍可验证，上下文明确显示未记录', () => {
  const legacy = createInitialBoard();
  for (const node of legacy.nodes) delete node.model;
  validateBoard(legacy);
  assert.match(buildContext(legacy, { node: 'n-visual' }).markdown, /执行模型：未记录/);

  const updated = applyChange(legacy, { type: 'node.update', id: 'n-visual', patch: { model: 'GPT6 Astra' } });
  assert.equal(updated.nodes.find(node => node.id === 'n-visual').model, 'GPT6 Astra');
});

test('JarviSync CLI 可分别记录负责人和实际执行模型', async () => {
  await withServer(async (app) => {
    const initial = await readBoard(app);
    const profile = await app.onboarding.prepare({ host: 'mcp', scope: 'work' });
    const script = fileURLToPath(new URL('../scripts/agent.mjs', import.meta.url));
    const options = { env: { ...process.env, NODEBOARD_URL: app.url, JARVISYNC_CONNECTION: profile.configPath, JARVISYNC_SESSION_ID: 'human-inputs-cli-session' }, windowsHide: true, encoding: 'utf8' };
    const created = JSON.parse((await exec(process.execPath, [script, 'create-project', 'CLI 模型记录', '--expected-revision', String(initial.revision), '--operation-id', 'model-create-project'], options)).stdout);
    const node = JSON.parse((await exec(process.execPath, [script, 'create-node', created.binding.projectId, '--title', '记录模型', '--expected-revision', String(created.revision), '--operation-id', 'model-create-node'], options)).stdout);
    const updated = await exec(process.execPath, [
      script,
      'update',
      node.saved.id,
      '--expected-revision',
      String(node.revision),
      '--operation-id',
      'model-update-node',
      '--owner',
      'Jarvis',
      '--model',
      'GPT6 Astra',
    ], options);
    const result = JSON.parse(updated.stdout);
    assert.equal(result.saved.id, node.saved.id);
    const saved = (await readBoard(app)).nodes.find(item => item.id === node.saved.id);
    assert.equal(saved.owner, 'Jarvis');
    assert.equal(saved.model, 'GPT6 Astra');

    const context = await exec(process.execPath, [script, 'context', node.saved.id], options);
    assert.match(context.stdout, /负责人：Jarvis/);
    assert.match(context.stdout, /执行模型：GPT6 Astra/);
  });
});
