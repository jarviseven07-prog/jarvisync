import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findHost } from '../integrations/installer.mjs';

test('Windows Claude Desktop 内置 Code 可执行文件不在 PATH 时仍能发现，按实际版本选最新', { skip: process.platform !== 'win32' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jarvisync-claude-discovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const appData = join(directory, 'AppData', 'Roaming');
  for (const version of ['2.1.9', '2.1.260']) {
    const base = join(appData, 'Claude', 'claude-code', version);
    await mkdir(base, { recursive: true });
    await writeFile(join(base, 'claude.exe'), 'fixture-only');
  }
  const result = await findHost('claude-code', { homeDir: directory, hostEnv: { APPDATA: appData, PATH: '' } });
  assert.equal(result, join(appData, 'Claude', 'claude-code', '2.1.260', 'claude.exe'));
});

test('macOS Claude Desktop 内置 Code 在 .app 包内且不在 PATH 时仍能发现，按实际版本选最新', { skip: process.platform !== 'darwin' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jarvisync-claude-discovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const support = join(directory, 'Library', 'Application Support');
  for (const version of ['2.1.9', '2.1.271']) {
    const base = join(support, 'Claude', 'claude-code', version, 'claude.app', 'Contents', 'MacOS');
    await mkdir(base, { recursive: true });
    await writeFile(join(base, 'claude'), 'fixture-only');
  }
  const result = await findHost('claude-code', { homeDir: directory, hostEnv: { PATH: '' } });
  assert.equal(result, join(support, 'Claude', 'claude-code', '2.1.271', 'claude.app', 'Contents', 'MacOS', 'claude'));
});

test('macOS 从 Finder 启动只有系统 PATH 时，仍能在常见 CLI 安装目录发现宿主', { skip: process.platform !== 'darwin' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'jarvisync-posix-discovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const local = join(directory, '.local', 'bin');
  await mkdir(local, { recursive: true });
  await writeFile(join(local, 'codex'), 'fixture-only');
  const finderPath = '/usr/bin:/bin:/usr/sbin:/sbin';
  assert.equal(await findHost('codex', { homeDir: directory, hostEnv: { PATH: finderPath } }), join(local, 'codex'));
  assert.equal(await findHost('hermes', { homeDir: directory, hostEnv: { PATH: finderPath } }), null);
});
