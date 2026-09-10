import { mkdir, open, readFile, readdir, rename, unlink, copyFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { BoardError, applyChange, createInitialBoard, normalizeBoard, validateBoard } from './model.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

function retentionCount(value, fallback, label, { allowZero = false } = {}) {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < (allowZero ? 0 : 1) || result > 10000) throw new TypeError(`${label} must be ${allowZero ? 'a non-negative' : 'a positive'} safe integer`);
  return result;
}

export async function openStore(directory, options = {}) {
  const historyRecent = retentionCount(options.historyRecent, 32, 'historyRecent');
  const historyDailyDays = retentionCount(options.historyDailyDays, 30, 'historyDailyDays', { allowZero: true });
  const root = resolve(directory);
  const uploadsRoot = join(root, 'uploads');
  const attachmentPath = ({ id, name }) => {
    if (typeof id !== 'string' || !/^a-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw new BoardError('附件 ID 格式不正确。');
    const directoryPath = join(uploadsRoot, id);
    const path = resolve(directoryPath, name);
    if (path === directoryPath || !path.startsWith(`${directoryPath}${sep}`)) throw new BoardError('附件路径不正确。');
    return path;
  };
  await mkdir(root, { recursive: true });
  const lockPath = join(root, 'server.lock');
  const owner = JSON.stringify({ pid: process.pid, instance: randomUUID() });
  try {
    const handle = await open(lockPath, 'wx');
    try { await handle.writeFile(owner); } finally { await handle.close(); }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let old;
    try { old = JSON.parse(await readFile(lockPath, 'utf8')); } catch { throw new Error('数据目录的服务锁无法读取。请确认旧服务已退出后，保留备份并移除 server.lock。'); }
    let alive = true;
    try { process.kill(old.pid, 0); } catch (e) { if (e.code === 'ESRCH') alive = false; }
    if (alive) throw new Error('这个数据目录已有服务在使用，请打开已启动的 JarviSync。');
    await unlink(lockPath);
    return openStore(root, { historyRecent, historyDailyDays });
  }
  const path = join(root, 'board.json');
  const instancePath = join(root, 'instance.json');
  let queue = Promise.resolve();
  let closed = false;
  const read = async () => {
    if (closed) throw new BoardError('服务已关闭。', 503);
    try { return validateBoard(normalizeBoard(JSON.parse(await readFile(path, 'utf8')))); }
    catch (error) { throw new BoardError(`无法读取项目数据，原文件已保留。${error.message}`, 500); }
  };
  const close = async () => {
    await queue.catch(() => {});
    closed = true;
    if (await readFile(lockPath, 'utf8').catch(() => '') === owner) await unlink(lockPath);
  };
  const pruneHistory = async historyRoot => {
    const entries = await readdir(historyRoot, { withFileTypes: true });
    const snapshots = entries.flatMap(entry => {
      if (!entry.isFile()) return [];
      const match = /^board-r\d+-(\d{13})-[0-9a-f-]+\.json$/i.exec(entry.name);
      if (!match || !Number.isSafeInteger(Number(match[1]))) return [];
      return [{ name: entry.name, timestamp: Number(match[1]) }];
    }).sort((left, right) => right.timestamp - left.timestamp || right.name.localeCompare(left.name));
    const keep = new Set(snapshots.slice(0, historyRecent).map(item => item.name));
    const today = new Date();
    const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    const daily = new Set();
    for (const snapshot of snapshots) {
      const date = new Date(snapshot.timestamp);
      const day = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
      const age = Math.floor((todayUtc - day) / DAY_MS);
      if (age < 0 || age >= historyDailyDays) continue;
      const key = date.toISOString().slice(0, 10);
      if (!daily.has(key)) {
        daily.add(key);
        keep.add(snapshot.name);
      }
    }
    const cleanup = await Promise.allSettled(snapshots.filter(item => !keep.has(item.name)).map(item => unlink(join(historyRoot, item.name))));
    const failures = cleanup.filter(result => result.status === 'rejected');
    if (failures.length) console.warn(`[nodeboard] history cleanup failed for ${failures.length} snapshot(s); first code=${failures[0].reason?.code ?? 'unknown'}`);
  };
  const saveBoard = async (current, next) => {
    const historyRoot = join(root, 'history');
    await mkdir(historyRoot, { recursive: true });
    const suffix = `${Date.now()}-${randomUUID()}`;
    await copyFile(path, join(historyRoot, `board-r${current.revision}-${suffix}.json`));
    const temp = join(root, `board-${suffix}.tmp`);
    try {
      const handle = await open(temp, 'wx');
      try { await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
      await rename(temp, path);
      await pruneHistory(historyRoot).catch(error => {
        console.warn(`[nodeboard] history cleanup did not run; code=${error?.code ?? 'unknown'}`);
      });
    } catch (error) { await unlink(temp).catch(() => {}); throw error; }
  };
  const readOrCreateBoardInstanceId = async () => {
    let value;
    try { value = JSON.parse(await readFile(instancePath, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw new BoardError(`无法读取看板实例身份，原文件已保留。${error.message}`, 500);
      value = { boardInstanceId: `bi-${randomUUID()}` };
      const handle = await open(instancePath, 'wx');
      try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
    }
    if (!value || typeof value !== 'object' || Object.keys(value).some(key => key !== 'boardInstanceId') || typeof value.boardInstanceId !== 'string' || !/^bi-[a-f0-9-]{36}$/i.test(value.boardInstanceId)) throw new BoardError('看板实例身份格式不正确，原文件已保留。', 500);
    return value.boardInstanceId;
  };
  const writeAttachments = async (files) => {
    if (!Array.isArray(files)) throw new BoardError('附件写入格式不正确。');
    const createdDirectories = [];
    try {
      if (files.length) await mkdir(uploadsRoot, { recursive: true });
      for (const file of files) {
        if (!file || typeof file !== 'object' || !Buffer.isBuffer(file.data) || !file.attachment) throw new BoardError('附件写入格式不正确。');
        if (file.data.length !== file.attachment.size || createHash('sha256').update(file.data).digest('hex') !== file.attachment.sha256) throw new BoardError('附件内容与摘要不一致。');
        const target = attachmentPath(file.attachment);
        const directoryPath = join(uploadsRoot, file.attachment.id);
        await mkdir(directoryPath);
        createdDirectories.push(directoryPath);
        const handle = await open(target, 'wx');
        try { await handle.writeFile(file.data); await handle.sync(); } finally { await handle.close(); }
      }
      return createdDirectories;
    } catch (error) {
      await Promise.allSettled(createdDirectories.map(directoryPath => rm(directoryPath, { recursive: true, force: true })));
      throw error;
    }
  };
  try {
    try { await readFile(path, 'utf8'); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const handle = await open(path, 'wx');
      try { await handle.writeFile(`${JSON.stringify(createInitialBoard(), null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
    }
    await read();
  } catch (error) { await close(); throw error; }
  let boardInstanceId;
  try { boardInstanceId = await readOrCreateBoardInstanceId(); }
  catch (error) { await close(); throw error; }
  return {
    boardInstanceId,
    directory: root,
    read,
    transact(mutator) {
      if (typeof mutator !== 'function') throw new TypeError('transact requires a mutator function');
      const work = queue.then(async () => {
        const current = await read();
        const transaction = await mutator(structuredClone(current));
        if (!transaction || typeof transaction !== 'object' || !Object.hasOwn(transaction, 'result')) throw new TypeError('transaction must return a result');
        if (!transaction.next) return transaction.result;
        const next = validateBoard(transaction.next);
        if (!Number.isSafeInteger(next.revision) || next.revision <= current.revision) throw new BoardError('事务保存的数据版本没有前进。', 500);
        await saveBoard(current, next);
        return transaction.result;
      });
      queue = work.catch(() => {});
      return work;
    },
    change(expectedRevision, change, { files = [] } = {}) {
      const work = queue.then(async () => {
        const current = await read();
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== current.revision) throw new BoardError('内容已有更新。请刷新核对后再保存；当前修改不会自动覆盖。', 409);
        const next = applyChange(current, change);
        const currentIds = new Set((current.humanInputs ?? []).flatMap(input => input.attachments ?? []).map(attachment => attachment.id));
        const added = (next.humanInputs ?? []).flatMap(input => input.attachments ?? []).filter(attachment => !currentIds.has(attachment.id));
        const referenced = new Map(added.map(attachment => [attachment.id, attachment]));
        if (files.length !== referenced.size) throw new BoardError('附件记录与待写入文件不一致。');
        for (const file of files) {
          const attachment = referenced.get(file?.attachment?.id);
          if (!attachment || JSON.stringify(attachment) !== JSON.stringify(file.attachment)) throw new BoardError('附件未关联到本次人工补充。');
        }
        const createdDirectories = await writeAttachments(files);
        try {
          await saveBoard(current, next);
        } catch (error) {
          await Promise.allSettled(createdDirectories.map(directoryPath => rm(directoryPath, { recursive: true, force: true })));
          throw error;
        }
        return next;
      });
      queue = work.catch(() => {});
      return work;
    },
    attachmentPath,
    async readAttachment(attachment) {
      try { return await readFile(attachmentPath(attachment)); }
      catch (error) {
        if (error.code === 'ENOENT') throw new BoardError('附件不存在。', 404);
        throw error;
      }
    },
    close,
  };
}
