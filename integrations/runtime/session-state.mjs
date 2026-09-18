import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function sessionStateKey({ host, profileId, sessionId }) {
  return createHash('sha256').update(`${host}\u0000${profileId}\u0000${sessionId}`).digest('hex');
}

export function sessionStateFile(config, session) {
  const stateDir = text(config?.stateDir);
  if (!stateDir) throw new Error('JarviSync 连接缺少 stateDir，不能保存会话状态。');
  return join(resolve(stateDir), 'sessions', `${sessionStateKey(session)}.json`);
}

export async function readSessionState(config, session) {
  try {
    return JSON.parse(await readFile(sessionStateFile(config, session), 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeSessionStateFile(path, state) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx');
    try { await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return path;
}

async function withSessionStateLock(path, action) {
  const lockPath = `${path}.lock`;
  const token = randomUUID();
  const deadline = Date.now() + 750;
  await mkdir(dirname(path), { recursive: true });
  while (true) {
    try {
      const handle = await open(lockPath, 'wx');
      try { await handle.writeFile(token); await handle.sync(); }
      finally { await handle.close(); }
      break;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const age = await stat(lockPath).then(info => Date.now() - info.mtimeMs).catch(() => 0);
      if (age > 5000) { await unlink(lockPath).catch(() => {}); continue; }
      if (Date.now() >= deadline) throw new Error('JarviSync 会话状态正由另一进程更新。');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  try { return await action(); }
  finally {
    const owner = await readFile(lockPath, 'utf8').catch(() => null);
    if (owner === token) await unlink(lockPath).catch(() => {});
  }
}

export async function writeSessionState(config, session, state) {
  const path = sessionStateFile(config, session);
  await withSessionStateLock(path, () => writeSessionStateFile(path, state));
  return path;
}

export async function updateSessionState(config, session, update) {
  const path = sessionStateFile(config, session);
  return withSessionStateLock(path, async () => {
    const current = await readSessionState(config, session);
    const next = await update(current);
    await writeSessionStateFile(path, next);
    return next;
  });
}
