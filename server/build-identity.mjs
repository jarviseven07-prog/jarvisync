import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUILD_ID_VERSION = 'jarvisync-build-v1';
const BACKEND_ROOTS = ['server', 'shared', 'integrations'];

function slash(path) { return path.split(sep).join('/'); }
function generatedCache(name) { return name === '__pycache__' || /\.(pyc|pyo|tmp|temp)$/i.test(name); }

async function filesBelow(root, virtualRoot) {
  const output = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (generatedCache(entry.name)) continue;
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`构建输入不能包含符号链接：${path}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) output.push({ path, virtualPath: `${virtualRoot}/${slash(relative(root, path))}` });
    }
  }
  await visit(root);
  return output;
}

/**
 * Return the complete, content-addressed runtime input list.  Backend files
 * always use their repository-relative paths.  Frontend files use the virtual
 * `frontend/` root, so a verified artifact directory and the installed `dist/`
 * directory produce identical input names and therefore identical build IDs.
 */
export async function collectBuildInputs({ root, distDir }) {
  const projectRoot = resolve(root);
  const frontend = resolve(distDir);
  const candidates = [];
  for (const name of BACKEND_ROOTS) candidates.push(...await filesBelow(resolve(projectRoot, name), name));
  candidates.push(...await filesBelow(frontend, 'frontend'));
  const seen = new Set();
  const inputs = [];
  for (const entry of candidates.sort((left, right) => left.virtualPath.localeCompare(right.virtualPath))) {
    if (seen.has(entry.virtualPath)) throw new Error(`构建输入路径重复：${entry.virtualPath}`);
    seen.add(entry.virtualPath);
    inputs.push({ path: entry.virtualPath, sha256: createHash('sha256').update(await readFile(entry.path)).digest('hex') });
  }
  if (!inputs.some(input => input.path.startsWith('server/')) || !inputs.some(input => input.path.startsWith('frontend/'))) {
    throw new Error('构建标识必须同时包含后台源码和前端构建产物。');
  }
  return inputs;
}

/** Compute the stable ID from the ordered virtual path and SHA-256 of every runtime input. */
export async function computeBuildId({ root, distDir }) {
  const inputs = await collectBuildInputs({ root, distDir });
  const hash = createHash('sha256').update(`${BUILD_ID_VERSION}\0`);
  for (const input of inputs) hash.update(input.path).update('\0').update(input.sha256).update('\n');
  return hash.digest('hex');
}

export async function computeBuildIdentity({ root, distDir }) {
  const inputs = await collectBuildInputs({ root, distDir });
  const hash = createHash('sha256').update(`${BUILD_ID_VERSION}\0`);
  for (const input of inputs) hash.update(input.path).update('\0').update(input.sha256).update('\n');
  return { version: BUILD_ID_VERSION, buildId: hash.digest('hex'), inputs };
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) {
  const [root, distDir] = process.argv.slice(2);
  if (!root || !distDir) throw new Error('用法：node server/build-identity.mjs <root> <distDir>');
  process.stdout.write(`${JSON.stringify(await computeBuildIdentity({ root, distDir }))}\n`);
}
