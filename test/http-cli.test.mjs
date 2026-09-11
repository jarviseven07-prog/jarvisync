import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/index.mjs';

const exec = promisify(execFile);
test('网页与两个 Agent 通过同一服务完成创建、交接、续接和重启恢复', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nodeboard-http-'));
  let app;
  try {
    app = await startServer({ port: 0, dataDir: directory });
    const read = async () => (await fetch(`${app.url}/api/board`)).json();
    const initial = await read();
    assert.equal(initial.projects[0].demo, true);
    const profile = await app.onboarding.prepare({ host: 'mcp', scope: 'work' });
    const script = fileURLToPath(new URL('../scripts/agent.mjs', import.meta.url));
    const options = { env: { ...process.env, JARVISYNC_CONNECTION: profile.configPath, JARVISYNC_SESSION_ID: 'http-cli-real-session', NODEBOARD_URL: app.url }, windowsHide: true, encoding: 'utf8' };
    const created = JSON.parse((await exec(process.execPath, [script, 'create-project', '我的真实项目', '--summary', '只完成页面和交接。', '--expected-revision', String(initial.revision), '--operation-id', 'http-create-project'], options)).stdout);
    const project = (await read()).projects.find(item => item.id === created.binding.projectId);
    assert.equal(project.demo, false);
    assert.equal((await read()).nodes.filter(n => n.projectId === project.id).length, 0);
    const nodeResult = JSON.parse((await exec(process.execPath, [script, 'create-node', project.id, '--title', '首页制作', '--independent-reason', '首页制作为本项目首个独立成果。', '--expected-revision', String(created.revision), '--operation-id', 'http-create-node'], options)).stdout);
    const node = (await read()).nodes.find(item => item.id === nodeResult.saved.id);
    const agentAContext = await exec(process.execPath, [script, 'context', node.id, '--json'], options);
    const context = JSON.parse(agentAContext.stdout);
    assert.equal(context.revision, nodeResult.revision);
    assert.match(context.markdown, /只完成页面和交接/);
    const first = await exec(process.execPath, [script, 'update', node.id, '--expected-revision', String(context.revision), '--operation-id', 'http-update-node', '--progress', '布局已完成\n还没有验证窄屏。', '--next', '检查 390px 宽度的正文换行。', '--link', 'C:/项目/首页.html'], options);
    assert.equal(JSON.parse(first.stdout).saved.id, node.id);
    assert.equal((await read()).nodes.find(item => item.id === node.id).progress, '布局已完成\n还没有验证窄屏。');
    const agentB = JSON.parse((await exec(process.execPath, [script, 'context', node.id, '--json'], options)).stdout);
    assert.match(agentB.markdown, /布局已完成/);
    assert.match(agentB.markdown, /检查 390px/);
    assert.match(agentB.markdown, /C:\/项目\/首页.html/);
    assert.doesNotMatch(agentB.markdown, /搭建视觉方向/);
    await assert.rejects(exec(process.execPath, [script, 'update', node.id, '--expected-revision', String(context.revision), '--operation-id', 'http-stale-update', '--progress', '旧窗口意外覆盖'], options), /已有更新/);
    const beforeRestart = await read();
    assert.equal(beforeRestart.nodes.find(n => n.id === node.id).progress, '布局已完成\n还没有验证窄屏。');
    await app.close();
    app = await startServer({ port: 0, dataDir: directory });
    assert.deepEqual(await read(), beforeRestart);
  } finally {
    if (app) await app.close();
    if (dirname(directory) === tmpdir() && basename(directory).startsWith('nodeboard-http-')) await rm(directory, { recursive: true, force: true });
  }
});
