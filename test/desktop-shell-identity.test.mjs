import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { computeBuildId } from '../server/build-identity.mjs';

const { computeDesktopShellId, desktopShellFiles } = createRequire(import.meta.url)('../desktop/shell-identity.cjs');

test('desktop-only changes invalidate shell identity independently, including an optional launcher', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jarvisync-shell-identity-'));
  for (const directory of ['desktop/assets', 'server', 'shared', 'integrations', 'dist']) await mkdir(join(root, directory), { recursive: true });
  for (const path of desktopShellFiles.filter(path => !path.endsWith('.exe'))) await writeFile(join(root, path), path);
  await writeFile(join(root, 'server/index.mjs'), 'server');
  await writeFile(join(root, 'dist/index.html'), 'frontend');
  const buildBefore = await computeBuildId({ root, distDir: join(root, 'dist') });
  const withoutLauncher = computeDesktopShellId(root);
  await writeFile(join(root, 'desktop/JarviSync.exe'), 'launcher');
  const initial = computeDesktopShellId(root);
  assert.notEqual(initial, withoutLauncher);
  for (const path of desktopShellFiles) {
    const before = computeDesktopShellId(root);
    await writeFile(join(root, path), `changed ${path}`);
    assert.notEqual(computeDesktopShellId(root), before, path);
  }
  assert.equal(await computeBuildId({ root, distDir: join(root, 'dist') }), buildBefore);
});
