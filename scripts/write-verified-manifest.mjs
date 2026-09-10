import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { computeBuildIdentity } from '../server/build-identity.mjs';

const slash = value => value.split(sep).join('/');
const [rootArg, distArg, outputArg] = process.argv.slice(2);
if (!rootArg || !distArg || !outputArg) throw new Error('用法：node scripts/write-verified-manifest.mjs <root> <artifact-dist> <output>');
const root = resolve(rootArg);
const distDir = resolve(distArg);
const output = resolve(outputArg);
const identity = await computeBuildIdentity({ root, distDir });
const files = identity.inputs.map(input => ({
  path: input.path.startsWith('frontend/')
    ? slash(relative(root, join(distDir, input.path.slice('frontend/'.length))))
    : input.path,
  sha256: input.sha256.toUpperCase(),
}));
// Desktop and loading entrypoints are verified too, although the running HTTP
// service's build ID only describes its own source and frontend.
for (const path of ['desktop/main.cjs', 'desktop/preload.cjs', 'desktop/shell-identity.cjs', 'desktop/JarviSync.exe', 'desktop/assets/jarvisync.ico', 'scripts/install-start-menu.cjs', 'scripts/agent.mjs', 'scripts/launch-board.ps1', 'scripts/verified-update.ps1', 'scripts/write-verified-manifest.mjs', 'scripts/package-desktop.mjs', 'scripts/load-verified-update.ps1']) {
  let contents;
  try { contents = await readFile(join(root, path)); }
  catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  files.push({ path, sha256: createHash('sha256').update(contents).digest('hex').toUpperCase() });
}
const manifest = { buildId: identity.buildId, buildIdVersion: identity.version, files, verifiedAt: new Date().toISOString() };
const shellIdentityPath = join(root, 'desktop/shell-identity.cjs');
if (existsSync(shellIdentityPath)) manifest.desktopShellId = createRequire(import.meta.url)(shellIdentityPath).computeDesktopShellId(root);
await mkdir(dirname(output), { recursive: true });
const temporary = `${output}.${randomUUID()}.tmp`;
try { await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' }); await rename(temporary, output); }
finally { await unlink(temporary).catch(() => {}); }
process.stdout.write(`${manifest.buildId}\n`);
