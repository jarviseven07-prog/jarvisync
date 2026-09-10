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
