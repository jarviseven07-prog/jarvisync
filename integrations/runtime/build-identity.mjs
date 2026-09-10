import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';

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

// This file is copied into the installed Agent profile. It reads the listed
// runtime files but never imports code from the runtime being checked.
export async function computeBuildIdentity({ root, distDir }) {
  const projectRoot = resolve(root);
  const candidates = [];
  for (const name of BACKEND_ROOTS) candidates.push(...await filesBelow(resolve(projectRoot, name), name));
  candidates.push(...await filesBelow(resolve(distDir), 'frontend'));
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
  const hash = createHash('sha256').update(`${BUILD_ID_VERSION}\0`);
  for (const input of inputs) hash.update(input.path).update('\0').update(input.sha256).update('\n');
  return { version: BUILD_ID_VERSION, buildId: hash.digest('hex'), inputs };
}
