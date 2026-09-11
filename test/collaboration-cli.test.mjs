import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/index.mjs';
import { createClient, loadConnection } from '../integrations/runtime/client.mjs';

const exec = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/agent.mjs', import.meta.url));

async function isolated(run) {
  const directory = await mkdtemp(join(tmpdir(), 'jarvisync-collaboration-'));
  let app = await startServer({ port: 0, dataDir: directory });
  const profile = await app.onboarding.prepare({ host: 'mcp', scope: 'work' });
  const board = () => fetch(`${app.url}/api/board`).then(response => response.json());
  const cliAs = async (sessionId, args) => JSON.parse((await exec(process.execPath, [script, ...args, '--connection', profile.configPath, '--session', sessionId, '--url', app.url], {
    // Explicit --url must win over environment/desktop defaults.
    env: { ...process.env, NODEBOARD_URL: 'http://127.0.0.1:1' }, windowsHide: true, encoding: 'utf8',
  })).stdout);
  const cli = args => cliAs('cli-real-session', args);
  let operation = 0;
  const save = async (args) => cli([...args, '--expected-revision', String((await board()).revision), '--operation-id', `cli-test-${++operation}`]);
  try {
    await run({ directory, profile, board, cli, cliAs, save, url: () => app.url, onboarding: () => app.onboarding, restart: async () => {
      await app.close(); app = await startServer({ port: 0, dataDir: directory });
    } });
  } finally {
    await app.close();
    const target = resolve(directory);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('jarvisync-collaboration-'));
    await rm(target, { recursive: true, force: true });
  }
}

test('CLI 将对话规划、上游交付、下游接续和最终成果保存到同一服务', async () => isolated(async ({ directory, board, cli, save, restart }) => {
  const createdProject = await save(['create-project', '协作接口测试', '--summary', '仅为隔离测试。']);
  const project = (await board()).projects.find(item => item.id === createdProject.binding.projectId);
  const up = (await save(['create-node', project.id, '--title', '整理原件', '--independent-reason', '直接整理用户原件，没有上游节点。'])).saved;
  const down = (await save(['create-node', project.id, '--title', '接续汇总', '--depends-on', up.id])).saved;
  await save(['update', up.id, '--owner', '已安排但未开始的执行者']);
  let overview = await cli(['overview', project.id]);
  assert.deepEqual(overview.doingIds, []);
  assert.deepEqual(overview.readyIds, [up.id]);
  assert.deepEqual(overview.waitingIds, [down.id]);
  await assert.rejects(save(['start', down.id, '--execution-ref', 'test:run:down', '--owner', '测试下游', '--model', 'test-downstream-model']), /上游/);

  const file = join(directory, 'change.json');
  await writeFile(file, '\uFEFF' + JSON.stringify({ type: 'node.update', id: up.id, patch: { goal: '保留中文与换行\n产出可引用的原件。', links: ['C:/测试/参考材料.md'] } }), 'utf8');
  await save(['change', '--file', file]);
  await assert.rejects(save(['start', up.id, '--execution-ref', 'test:run:missing-model', '--owner', '测试上游']), /请提供 --model（宿主可核验的实际模型）/);
  const started = await save(['start', up.id, '--execution-ref', 'test:run:up', '--owner', '测试上游', '--model', 'test-model']);
  const runId = started.runId;
  const revision = (await board()).revision;
  await assert.rejects(save(['update', up.id, '--progress', '普通更新不能覆盖运行']), /运行 ID/);
  await assert.rejects(save(['update', up.id, '--run', 'wrong-run', '--progress', '错误运行不能覆盖']), /运行 ID 与当前会话绑定不一致|不是当前执行/);
  assert.equal((await board()).revision, revision);
  await save(['update', up.id, '--run', runId, '--progress', '已整理原件。\n正在检查。']);
  await save(['deliver', up.id, '--run', runId, '--summary', '原件与结论已保存。', '--output', 'C:/测试/上游成果.md']);
  await assert.rejects(save(['deliver', up.id, '--run', runId, '--summary', '重复结束']), /已结束/);

  const transcript = (await save(['transcribe', project.id, '--node', up.id, '--kind', 'feedback', '--body', '把结论压缩成三点。', '--source-ref', 'test:conversation:round1:message2', '--recorded-by', '测试协调者'])).saved;
  await save(['attach', project.id, '--confirm-rebind']);
  await save(['respond', transcript.id, '--body', '已让下游按三点整理。', '--owner', '测试协调者', '--disposition', 'applied', '--affected-node', down.id]);
  const context = (await cli(['context', down.id, '--json'])).markdown;
  assert.match(context, /mcp:.*:cli-real-session/);
  assert.match(context, /C:\/测试\/上游成果.md/);
  assert.match(context, /Agent 转录/);
  assert.match(context, /已让下游按三点整理/);
  assert.doesNotMatch(context, /搭建视觉方向/);
  const second = await save(['start', down.id, '--execution-ref', 'test:run:down', '--owner', '测试下游', '--model', 'test-downstream-model']);
  const secondRun = (await board()).nodes.find(item => item.id === down.id).executions.at(-1);
  assert.equal(secondRun.id, second.runId);
  assert.deepEqual(secondRun.inputNodeIds, [up.id]);
  await save(['deliver', down.id, '--run', secondRun.id, '--summary', '三点结论已汇总。', '--output', 'C:/测试/最终成果.md', '--final']);
  const finalNode = (await board()).nodes.find(item => item.id === down.id);
  overview = await cli(['overview', project.id]);
  assert.equal(overview.deliveries.length, 2);
  assert.equal(overview.deliveries[0].nodeId, down.id);
  assert.equal(overview.deliveries[0].delivery.final, true);
  assert.ok(overview.deliveries.every(item => !item.delivery.links.includes('C:/测试/参考材料.md')));
  await save(['mark-final', down.id, '--delivery', finalNode.deliveries.at(-1).id, '--clear']);
  assert.equal((await cli(['overview', project.id])).deliveries.find(item => item.nodeId === down.id).delivery.final, false);
  const beforeRestart = await board();
  await restart();
  assert.deepEqual(await board(), beforeRestart);
}));

test('CLI 新节点要求显式依赖声明并保留多个实际上游', async () => isolated(async ({ board, save }) => {
  const project = (await save(['create-project', '显式依赖测试'])).binding.projectId;
  const before = await board();
  await assert.rejects(save(['create-node', project, '--title', '未声明']), /请提供 --independent-reason/);
  await assert.rejects(save(['create-node', project, '--title', '空理由', '--independent-reason', ' ']), /请提供 --independent-reason/);
  assert.deepEqual(await board(), before);
  const first = (await save(['create-node', project, '--title', '资料甲', '--independent-reason', '用户独立提供的甲资料。'])).saved;
  const second = (await save(['create-node', project, '--title', '资料乙', '--independent-reason', '用户独立提供的乙资料。'])).saved;
  await assert.rejects(save(['create-node', project, '--title', '混合声明', '--depends-on', first.id, '--independent-reason', '不应混用']), /不能同时提供/);
  const combined = (await save(['create-node', project, '--title', '汇总', '--depends-on', first.id, '--depends-on', second.id])).saved;
  const current = await board();
  assert.deepEqual(current.edges.filter(edge => edge.target === combined.id).map(edge => edge.source).sort(), [first.id, second.id].sort());
  assert.equal(current.nodes.find(node => node.id === first.id).independentReason, '用户独立提供的甲资料。');
}));

test('CLI 写入必须复用显式接入与真实会话，旧中断和伪造 profile 不能旁路', async () => isolated(async ({ directory, profile, board, cli, save, url, onboarding }) => {
  const cleanEnv = { ...process.env };
  delete cleanEnv.JARVISYNC_CONNECTION;
  delete cleanEnv.JARVISYNC_SESSION_ID;
  const runRaw = args => exec(process.execPath, [script, ...args], { env: cleanEnv, windowsHide: true, encoding: 'utf8' });
  await assert.rejects(runRaw(['create-project', '无授权', '--url', url(), '--expected-revision', String((await board()).revision), '--operation-id', 'missing-connection']), /写入需要 --connection/);
  await assert.rejects(runRaw(['create-project', '无会话', '--url', url(), '--connection', profile.configPath, '--expected-revision', String((await board()).revision), '--operation-id', 'missing-session']), /写入需要 --session/);
  await assert.rejects(runRaw(['create-project', '无操作号', '--url', url(), '--connection', profile.configPath, '--session', 'real-cli-session', '--expected-revision', String((await board()).revision)]), /写入需要 --operation-id/);

  const created = await save(['create-project', '中断边界']);
  const node = (await save(['create-node', created.binding.projectId, '--title', '当前节点', '--independent-reason', '独立检查中断边界。'])).saved;
  const discovered = await cli(['discover']);
  assert.equal(discovered.binding.projectId, created.binding.projectId);
  const config = await loadConnection(profile.configPath);
  const client = createClient(config);
  const session = { host: config.host, profileId: config.profileId, sessionId: 'cli-real-session' };
  await client.request('event', { session, event: 'UserPromptSubmit', turnId: 'turn-1' });
  await client.request('event', { session, event: 'Interrupt' });
  const before = await board();
  await assert.rejects(save(['update', node.id, '--next', '不应写入']), /中断/);
  assert.deepEqual(await board(), before);

  const fakePath = join(directory, 'fake-connection.json');
  const fake = { ...JSON.parse(await readFile(profile.configPath, 'utf8')), profileId: 'fresh-cli-profile' };
  await writeFile(fakePath, JSON.stringify(fake), 'utf8');
  await assert.rejects(runRaw(['attach', created.binding.projectId, '--url', url(), '--connection', fakePath, '--session', 'fresh-session', '--expected-revision', String(before.revision), '--operation-id', 'fake-profile-attach']), /接入未关联/);
  assert.equal((await onboarding().status()).profiles.length, 1);
  assert.deepEqual(await board(), before);
}));

test('结构化写入拒绝旧版本、跨项目反馈关联和伪装的人类来源', async () => isolated(async ({ directory, board, cli, cliAs, save, url }) => {
  const projectResult = await save(['create-project', '来源边界测试']);
  const project = (await board()).projects.find(item => item.id === projectResult.binding.projectId);
  const node = (await save(['create-node', project.id, '--title', '当前任务', '--independent-reason', '独立检查来源边界。'])).saved;
  await assert.rejects(save(['create-project', '其他项目']), /切换到其他项目需要用户确认/);
  const otherProjectResponse = await fetch(`${url()}/api/human/change`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url(), 'X-JarviSync-UI': '1' }, body: JSON.stringify({ expectedRevision: (await board()).revision, change: { type: 'project.create', title: '其他项目', summary: '' } }) });
  assert.equal(otherProjectResponse.status, 200);
  const other = (await otherProjectResponse.json()).projects.at(-1);
  const alternateSession = 'cli-other-project-session';
  await cliAs(alternateSession, ['attach', other.id, '--expected-revision', String((await board()).revision), '--operation-id', 'other-attach']);
  const otherNodeResult = await cliAs(alternateSession, ['create-node', other.id, '--title', '其他任务', '--independent-reason', '另一项目的独立任务。', '--expected-revision', String((await board()).revision), '--operation-id', 'other-create-node']);
  const otherNode = otherNodeResult.saved;
  const input = (await save(['transcribe', project.id, '--kind', 'goal', '--body', '仅做当前任务。', '--source-ref', 'test:message', '--recorded-by', '测试记录者'])).saved;
  const rawBefore = await readFile(join(directory, 'board.json'), 'utf8');
  await assert.rejects(save(['respond', input.id, '--body', '错误关联', '--owner', '测试记录者', '--disposition', 'applied', '--affected-node', otherNode.id]), /同一项目/);
  const file = join(directory, 'stale.json');
  await writeFile(file, JSON.stringify({ type: 'node.update', id: node.id, patch: { goal: '过期的目标' } }), 'utf8');
  await assert.rejects(cli(['change', '--file', file, '--expected-revision', '0', '--operation-id', 'stale-change']), /已有更新/);
  const post = async (path, change, origin) => fetch(`${url()}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify({ expectedRevision: (await board()).revision, change }) });
  assert.equal((await post('/api/change', { type: 'human.input.add', projectId: project.id, kind: 'decision', body: '伪装为直接人类输入' })).status, 410);
  assert.equal((await post('/api/human/change', { type: 'human.input.add', projectId: project.id, kind: 'decision', body: '带任意来源字段', source: { ref: 'fake', recordedBy: 'fake' } }, url())).status, 400);
  assert.equal((await post('/api/change', { type: 'node.start', id: node.id, executionRef: 'test:browser', owner: '网页' }, url())).status, 410);
  assert.equal(await readFile(join(directory, 'board.json'), 'utf8'), rawBefore);
}));
