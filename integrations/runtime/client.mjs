import { readFile, open, mkdir, rename, readdir, unlink, link } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { computeBuildIdentity } from './build-identity.mjs';

export const digest = value => createHash('sha256').update(value).digest('hex');
// macOS resolves module URLs through symlinks (/var -> /private/var) while argv[1] keeps the
// spelling the caller passed, so an entry-point check has to compare real paths.
export function isMainModule(metaUrl) {
  const real = path => { try { return realpathSync(path); } catch { return null; } };
  const entry = process.argv[1] ? real(resolve(process.argv[1])) : null;
  return entry !== null && entry === real(fileURLToPath(metaUrl));
}
export async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx');
    try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    for (let attempt = 0; ; attempt++) {
      try { await rename(temp, path); break; }
      catch (error) {
        // Windows can transiently reject an atomic replacement while another
        // process holds the destination or is replacing the same file. Slow
        // machines and CI runners need a window well above a second for the
        // lock to clear, so keep retrying for roughly 2.7 seconds.
        if (!['EACCES', 'EBUSY', 'EPERM'].includes(error.code) || attempt >= 29) throw error;
        await new Promise(resolve => setTimeout(resolve, Math.min(5 * (attempt + 1), 90)));
      }
    }
  }
  finally { await unlink(temp).catch(() => {}); }
}
export async function loadConnection(path = process.env.JARVISYNC_CONNECTION || fileURLToPath(new URL('./connection.json', import.meta.url))) {
  const config = JSON.parse(await readFile(path, 'utf8'));
  config.stateDir ||= join(dirname(resolve(path)), 'state');
  return config;
}
export class ConnectionError extends Error {
  constructor(message, status = 0, details) { super(message); this.status = status; this.details = details; }
}
function localUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password || url.pathname !== '/') throw new ConnectionError('接入地址必须是已关联的本机看板。', 400);
  return url.origin;
}
export function createClient(config, options = {}) {
  if (!config.boardInstanceId || !config.profileId || !config.host || !config.stateDir) throw new ConnectionError('接入信息不完整，请回看板重新关联。', 400);
  const autoStart = options.autoStart ?? config.autoStart;
  const healthTimeoutMs = Number.isFinite(options.healthTimeoutMs) ? Math.max(1, options.healthTimeoutMs) : 1500;
  const requestTimeoutMs = Number.isFinite(options.requestTimeoutMs) ? Math.max(1, options.requestTimeoutMs) : 8000;
  const cacheEnsure = options.cacheEnsure === true;
  const externalSignal = options.signal;
  const requestSignal = timeoutMs => externalSignal
    ? AbortSignal.any([externalSignal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  let url = localUrl(config.url);
  let ensuring;
  let ensured = false;
  const check = async (candidate, expectedBuildId = null) => {
    let response;
    try { response = await fetch(`${localUrl(candidate)}/api/health`, { signal: requestSignal(healthTimeoutMs), redirect: 'error' }); }
    catch { return false; }
    if (!response.ok) throw new ConnectionError('这个地址不是已关联版本的看板，请在看板内修复接入。', 409);
    const data = await response.json();
    if (data.boardInstanceId !== config.boardInstanceId) throw new ConnectionError('看板实例不一致，已停止写入；请重新关联原看板。', 409);
    if (expectedBuildId && data.buildId !== expectedBuildId) throw new ConnectionError('已启动服务的构建标识与已关联接入不一致，已停止自动连接。请从开始菜单加载看板后重新准备或安装接入。', 409);
    url = localUrl(candidate);
    return true;
  };
  const ensure = async () => {
    if (config.dataDir) {
      let endpoint;
      try { endpoint = JSON.parse(await readFile(join(config.dataDir, 'agent-endpoint.json'), 'utf8')); } catch { /* A stopped service may have no endpoint. */ }
      if (endpoint?.boardInstanceId === config.boardInstanceId && endpoint.url !== url && await check(endpoint.url)) return;
    }
    if (await check(url)) return;
    if (!autoStart || !config.dataDir || !config.serverEntry || !config.nodeExecutable) throw new ConnectionError('看板服务未启动；待同步内容已保留。请打开已关联看板。');
    const runtime = config.runtimeBuild;
    if (!runtime || typeof runtime.sourceRoot !== 'string' || typeof runtime.distDir !== 'string' || typeof runtime.version !== 'string' || typeof runtime.buildId !== 'string') {
      throw new ConnectionError('接入配置版本已更新，离线时不会自动启动未验证来源。请先从开始菜单加载看板后重新准备或安装接入。', 409);
    }
    const sourceRoot = resolve(runtime.sourceRoot);
    const distDir = resolve(runtime.distDir);
    if (resolve(config.serverEntry) !== join(sourceRoot, 'server', 'index.mjs')) {
      throw new ConnectionError('接入记录的运行来源不完整，离线时不会自动启动。请先从开始菜单加载看板后重新准备或安装接入。', 409);
    }
    let currentRuntime;
    try {
      currentRuntime = await computeBuildIdentity({ root: sourceRoot, distDir });
    } catch {
      throw new ConnectionError('无法核对已关联看板的运行文件，离线时不会自动启动。请先从开始菜单加载看板后重新准备或安装接入。', 409);
    }
    if (currentRuntime.version !== runtime.version || currentRuntime.buildId !== runtime.buildId) {
      throw new ConnectionError('已关联看板的运行文件已变更，离线时不会自动启动未验证来源。请先从开始菜单加载看板后重新准备或安装接入。', 409);
    }
    // Never create a replacement data directory if the original installation moved.
    const identity = JSON.parse(await readFile(join(config.dataDir, 'instance.json'), 'utf8').catch(() => 'null'));
    if (identity?.boardInstanceId !== config.boardInstanceId) throw new ConnectionError('找不到原看板数据，已停止自动启动，请重新关联。', 409);
    await readFile(join(config.dataDir, 'board.json'));
    const child = spawn(config.nodeExecutable, [config.serverEntry], {
      detached: true, windowsHide: true, stdio: 'ignore',
      env: { ...process.env, ...(config.runtimeEnv || {}), NODEBOARD_DATA_DIR: config.dataDir, PORT: String(config.servicePort || 0) },
    });
    let launchError;
    child.on('error', error => { launchError = error; }); child.unref();
    for (let attempt = 0; attempt < 20; attempt++) {
      if (launchError) throw new ConnectionError('无法启动已关联看板，请从看板入口修复接入。');
      await new Promise(ok => setTimeout(ok, 150));
      let endpoint;
      try { endpoint = JSON.parse(await readFile(join(config.dataDir, 'agent-endpoint.json'), 'utf8')); } catch { continue; }
      if (endpoint.boardInstanceId === config.boardInstanceId) {
        try {
          if (await check(endpoint.url, runtime.buildId)) return;
        } catch (error) {
          child.kill();
          throw error;
        }
      }
    }
    throw new ConnectionError('原看板尚未就绪，待同步内容已保留。');
  };
  const request = async (action, body = {}) => {
    if (!cacheEnsure || !ensured) {
      if (!ensuring) ensuring = ensure().then(() => { ensured = true; }).finally(() => { ensuring = null; });
      await ensuring;
    }
    let response;
    try { response = await fetch(`${url}/api/agent/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, boardInstanceId: config.boardInstanceId, profileId: config.profileId, host: config.host, connectionToken: config.connectionToken }),
      signal: requestSignal(requestTimeoutMs), redirect: 'error',
    }); } catch { throw new ConnectionError('连接中断，尚未确认写入结果。'); }
    const result = await response.json();
    if (!response.ok) throw new ConnectionError(result.error || '操作未完成。', response.status, result.details);
    // Successful business replies make a newly attached/started run visible to
    // same-turn tool hooks. A cache failure must not turn a committed write into
    // a failed/retriable operation. No extra network request is needed.
    if (sessionMatches(body.session) && Object.hasOwn(result, 'binding')) {
      try {
        const { updateSessionState } = await import('./hook.mjs');
        await updateSessionState(config, body.session, current => {
          if (Number.isSafeInteger(result.revision) && Number.isSafeInteger(current?.bindingRevision)
              && result.revision < current.bindingRevision) return current;
          const binding = result.binding;
          const checkpoint = binding?.progressCheckpoint;
          const ended = action === 'change' && ['node.deliver', 'node.stop'].includes(body.change?.type);
          const progressCheckpoint = Object.hasOwn(result, 'progressCheckpoint') ? result.progressCheckpoint
            : !ended && checkpoint?.runId === binding?.runId && checkpoint?.at
              ? { runId: checkpoint.runId, nodeId: binding.nodeId, lastProgressAt: checkpoint.at,
                elapsedMs: Math.max(0, Date.now() - Date.parse(checkpoint.at)), reminderDue: false } : null;
          return { ...current, binding, progressCheckpoint, bindingRevision: result.revision ?? current?.bindingRevision,
            progressObservedAt: new Date().toISOString(), connectionError: null,
            recordingDisabled: current?.explicitRecordingOverride === false || binding?.recording === false,
          };
        });
      } catch { /* The authoritative successful response is still returned. */ }
    }
    return result;
  };
  const sessionMatches = session => session
    && session.host === config.host
    && session.profileId === config.profileId
    && typeof session.sessionId === 'string'
    && Boolean(session.sessionId.trim())
    && session.sessionId.length <= 400
    && !session.sessionId.includes('\0');
  const sessionState = async session => {
    const key = digest(`${session.host}\0${session.profileId}\0${session.sessionId}`);
    try { return JSON.parse(await readFile(join(resolve(config.stateDir), 'sessions', `${key}.json`), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const sameSession = (left, right) => left?.host === right?.host && left?.profileId === right?.profileId && left?.sessionId === right?.sessionId;
  const locallyRecordingDisabled = state => state?.explicitRecordingOverride === false || state?.recordingDisabled === true;
  const isExplicitRecordingToggle = (action, body, state) => {
    if (action !== 'attach' || typeof body?.recording !== 'boolean') return false;
    const remoteEnable = typeof state?.explicitRecordingOverride !== 'boolean'
      && state?.recordingDisabled === true && body.recording === true;
    if (state?.explicitRecordingOverride !== body.recording && !remoteEnable) return false;
    const allowed = new Set(['session', 'clientOperationId', 'expectedRevision', 'recording']);
    return Object.keys(body).every(key => allowed.has(key));
  };
  const recovery = (clientOperationId, details = {}) => ({ ...details, recovery: {
    tool: 'jarvisync_resolve', clientOperationId,
    next: '先读取 jarvisync_context 并核对当前内容，再用 expectedRevision 和 resolution=retry 重试相同业务内容；不再需要的失败请求用 resolution=discard 结清。不要改原请求的版本或正文直接重试。',
  } });
  const resolutionPath = id => join(config.stateDir, 'resolved', `${digest(id)}.json`);
  const readResolution = async id => {
    try { return JSON.parse(await readFile(resolutionPath(id), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const claimResolution = async ({ session, clientOperationId, resolution, expectedRevision }) => {
    const path = join(config.stateDir, 'resolution-claims', `${digest(clientOperationId)}.json`);
    const temporary = `${path}.${randomUUID()}.claim`;
    const proposed = { session, clientOperationId, resolution, expectedRevision };
    // A complete immutable file is linked atomically: concurrent processes can
    // agree on one decision without a stale PID lock after a crash.
    await atomicJson(temporary, proposed);
    try { await link(temporary, path); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    finally { await unlink(temporary).catch(() => {}); }
    const claimed = JSON.parse(await readFile(path, 'utf8'));
    if (!sameSession(claimed.session, session)) throw new ConnectionError('这个恢复请求不属于当前会话。', 403);
    if (claimed.resolution !== resolution) throw new ConnectionError(`这条请求已开始按 ${claimed.resolution} 核对；请用相同选择取回结果，再处理返回的替代请求。`, 409, { code: 'resolution-selected', resolution: claimed.resolution, clientOperationId });
    return claimed;
  };
  const mutate = async (action, body) => {
    if (!sessionMatches(body?.session) || typeof body.clientOperationId !== 'string' || !body.clientOperationId.trim() || body.clientOperationId.length > 240 || body.clientOperationId.includes('\0')) throw new ConnectionError('写回需要当前会话和稳定请求标识。', 400);
    const resolved = await readResolution(body.clientOperationId);
    if (resolved) throw new ConnectionError('这个失败请求已结清，不能重新使用原请求 ID。', 409, { code: 'operation-resolved', ...(sameSession(resolved.session, body.session) ? { resolution: resolved } : {}) });
    const path = join(config.stateDir, 'pending', `${digest(body.clientOperationId)}.json`);
    const record = { action, body, queuedAt: new Date().toISOString(), state: 'pending' };
    let prior;
    try { prior = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (prior && (prior.action !== action || JSON.stringify(prior.body) !== JSON.stringify(body))) throw new ConnectionError('这个请求标识已有不同的待同步内容。请核对后使用 jarvisync_resolve，不要修改原请求重试。', 409, sameSession(prior.body?.session, body.session) ? recovery(body.clientOperationId, { code: 'pending-content-conflict' }) : { code: 'pending-session-conflict' });
    const localState = await sessionState(body.session);
    const recordingToggle = isExplicitRecordingToggle(action, body, localState);
    if (locallyRecordingDisabled(localState) && !recordingToggle) throw new ConnectionError('此 Agent 的自动记录已停用。', 403, { code: 'recording-disabled' });
    if (localState?.interrupted === true && !recordingToggle) throw new ConnectionError('此会话仍处于已中断状态；等待下一次正常用户请求后再写回。', 409, { code: 'session-interrupted' });
    let preflightError;
    try {
      const authorization = await request('status', { session: body.session });
      if (authorization?.enabled === false && !(recordingToggle && body.recording === true)) throw new ConnectionError('此 Agent 的自动记录已停用。', 403);
    } catch (error) {
      if (error.status) throw error;
      preflightError = error;
    }
    if (preflightError) {
    }
    await atomicJson(path, prior || record);
    if (preflightError) throw preflightError;
    try { const result = await request(action, body); await unlink(path).catch(() => {}); return result; }
    catch (error) {
      if (error.status === 403) {
        if (!prior) await unlink(path).catch(() => {});
        throw error;
      }
      if (error.status) {
        await atomicJson(path, {
          ...record,
          state: 'needs-review',
          error: error.message,
          ...(error.details?.code ? { errorCode: error.details.code } : {}),
        });
        error.details = recovery(body.clientOperationId, error.details);
      }
      throw error;
    }
  };
  const resolvePending = async ({ session, clientOperationId, resolution, expectedRevision }) => {
    if (!sessionMatches(session) || typeof clientOperationId !== 'string' || !clientOperationId.trim() || clientOperationId.length > 240 || clientOperationId.includes('\0')) throw new ConnectionError('核对失败请求需要当前会话和原请求 ID。', 400);
    if (!['retry', 'discard'].includes(resolution) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new ConnectionError('请提供 resolution=retry/discard 和已经读取核对的 expectedRevision。', 400);
    const authorization = await request('status', { session });
    if (authorization?.enabled === false) throw new ConnectionError('此 Agent 的自动记录已停用。', 403);
    const localState = await sessionState(session);
    if (authorization.session?.interrupted || localState?.interrupted) throw new ConnectionError('此会话已被中断，等待用户下一次正常请求后再核对。', 409, { code: 'session-interrupted' });
    if (locallyRecordingDisabled(localState)) throw new ConnectionError('此会话已停用工作记录。', 403, { code: 'recording-disabled' });
    const path = join(config.stateDir, 'pending', `${digest(clientOperationId)}.json`);
    const priorResolution = await readResolution(clientOperationId);
    if (priorResolution) {
      if (!sameSession(priorResolution.session, session)) throw new ConnectionError('这个请求不属于当前会话。', 403);
      await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
      return priorResolution;
    }
    let entry;
    try { entry = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') throw new ConnectionError('没有找到当前接入的待核对请求，请先运行 jarvisync_sync。', 404); throw error; }
    if (!sameSession(entry.body?.session, session)) throw new ConnectionError('这个待核对请求不属于当前会话。', 403);
    const settle = async value => {
      const receipt = { clientOperationId, session, ...value, resolvedAt: new Date().toISOString() };
      await atomicJson(resolutionPath(clientOperationId), receipt);
      await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
      return receipt;
    };
    // The original owns a durable link before any replacement is sent. A crash
    // after the replacement commits must never create another attempt at a new revision.
    if (entry.resolutionAttempt) {
      const attempt = entry.resolutionAttempt;
      const replacementOperationId = attempt.clientOperationId;
      if (typeof replacementOperationId !== 'string' || !/^resolved-[a-f0-9]{64}$/.test(replacementOperationId) || !Number.isSafeInteger(attempt.expectedRevision)) throw new ConnectionError('失败请求的恢复记录不完整，原文件已保留。', 409);
      const replacement = await request('operation', { session, clientOperationId: replacementOperationId });
      if (replacement?.outcome?.committed === true) return settle({ state: 'recovered', replacementOperationId, outcome: replacement.outcome });
      const replacementPath = join(config.stateDir, 'pending', `${digest(replacementOperationId)}.json`);
      const pending = await readFile(replacementPath, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      if (pending && !sameSession(pending.body?.session, session)) throw new ConnectionError('替代请求不属于当前会话，已停止处理。', 403);
      if (!pending && !await readResolution(replacementOperationId)) {
        await atomicJson(replacementPath, { action: entry.action, body: { ...entry.body, clientOperationId: replacementOperationId, expectedRevision: attempt.expectedRevision }, queuedAt: new Date().toISOString(), state: 'needs-review', error: '上次核对中断，先核对这条已确定 ID 的替代请求。' });
      }
      return settle({ state: 'replaced', replacementOperationId, ...recovery(replacementOperationId) });
    }
    const committed = await request('operation', { session, clientOperationId });
    if (committed?.outcome?.committed === true && entry.errorCode !== 'idempotency-conflict') {
      return settle({ state: 'recovered', outcome: committed.outcome });
    }
    const current = await request('discover', { session });
    if (current.revision !== expectedRevision) throw new ConnectionError('核对期间看板又有更新，请重新读取后再处理失败请求。', 409, { code: 'revision-conflict', currentRevision: current.revision });
    if (resolution === 'discard') {
      await claimResolution({ session, clientOperationId, resolution, expectedRevision });
      return settle({ state: 'discarded', reviewedRevision: expectedRevision, message: '只撤销这条失败的写回请求，实际执行和已保存的看板内容没有改变。' });
    }
    if (entry.errorCode === 'idempotency-conflict' || committed?.outcome?.committed === true) throw new ConnectionError('原 ID 已对应另一份已提交结果。请核对后 discard 这份冲突副本，再用新请求提交所需变更。', 409, recovery(clientOperationId, { code: 'idempotency-conflict' }));
    if (committed?.outcome?.state === 'unknown' && entry.body.expectedRevision <= committed.outcome.replayFloorRevision) throw new ConnectionError('原请求已超出回执窗口，无法确认是否曾提交；不能自动重试。核对实际成果后可 discard 此请求。', 410, { code: 'operation-expired' });
    if (current.binding?.recording === false) throw new ConnectionError('此会话已停用工作记录。', 403, { code: 'recording-disabled' });
    if (entry.body.change?.runId && entry.body.change.runId !== current.binding?.runId) throw new ConnectionError('原执行已变化，不能重试旧运行的写回；核对后可 discard 此请求。', 409, { code: 'stale-run' });
    if (!['attach', 'change', 'takeover'].includes(entry.action)) throw new ConnectionError('无法识别原请求的操作类型，原内容已保留。', 400);
    const claim = await claimResolution({ session, clientOperationId, resolution, expectedRevision });
    const reviewedRevision = claim.expectedRevision;
    const replacementOperationId = `resolved-${digest(`${session.host}\0${session.profileId}\0${session.sessionId}\0${clientOperationId}\0${reviewedRevision}`)}`;
    const body = { ...entry.body, clientOperationId: replacementOperationId, expectedRevision: reviewedRevision };
    await atomicJson(path, { ...entry, resolutionAttempt: { clientOperationId: replacementOperationId, expectedRevision: reviewedRevision } });
    try {
      const outcome = await mutate(entry.action, body);
      return await settle({ state: 'retried', replacementOperationId, reviewedRevision, outcome });
    } catch (error) {
      const replacementPath = join(config.stateDir, 'pending', `${digest(replacementOperationId)}.json`);
      const replacement = await readFile(replacementPath, 'utf8').then(JSON.parse).catch(() => null);
      // The replacement must be durably queued before the original can be retired.
      if (replacement && sameSession(replacement.body?.session, session)) {
        await settle({ state: 'replaced', replacementOperationId, reviewedRevision, ...recovery(replacementOperationId) });
        error.details = recovery(replacementOperationId, { ...error.details, replaces: clientOperationId });
      }
      throw error;
    }
  };
  const flush = async session => {
    if (!sessionMatches(session)) throw new ConnectionError('会话不属于本接入。', 403);
    const localState = await sessionState(session);
    if (localState?.interrupted === true) throw new ConnectionError('此会话仍处于已中断状态；等待下一次正常用户请求后再核对待同步内容。', 409, { code: 'session-interrupted' });
    if (locallyRecordingDisabled(localState)) throw new ConnectionError('此 Agent 的自动记录已停用。', 403, { code: 'recording-disabled' });
    const files = await readdir(join(config.stateDir, 'pending')).catch(() => []);
    const results = [];
    for (const name of files.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
      const path = join(config.stateDir, 'pending', name);
      let entry;
      try { entry = JSON.parse(await readFile(path, 'utf8')); }
      catch { results.push({ state: 'needs-review', file: name, error: '待同步文件无法读取，原文件已保留。' }); continue; }
      if (!entry.body?.session || entry.body.session.host !== session.host || entry.body.session.profileId !== session.profileId || entry.body.session.sessionId !== session.sessionId) continue;
      if (entry.resolutionAttempt || await readResolution(entry.body.clientOperationId)) {
        // Resolve only the already-recorded attempt link/receipt; this branch
        // never chooses a new revision or automatically replays business work.
        results.push(await resolvePending({ session, clientOperationId: entry.body.clientOperationId, resolution: 'retry', expectedRevision: entry.body.expectedRevision }));
        continue;
      }
      if (entry.state === 'needs-review' && entry.errorCode === 'idempotency-conflict') { results.push(entry); continue; }
      try {
      const committed = await request('operation', { clientOperationId: entry.body.clientOperationId, session });
      if (committed?.outcome?.committed === true) { await unlink(path); results.push({ clientOperationId: entry.body.clientOperationId, state: 'recovered', outcome: committed.outcome }); continue; }
      if (committed?.outcome?.state === 'unknown' && entry.body.expectedRevision <= committed.outcome.replayFloorRevision) {
        entry.state = 'needs-review'; entry.error = '原请求已超出回执保留窗口，无法确定原结果；请读取当前上下文核对，不要改版本直接重放。';
        await atomicJson(path, entry); results.push(entry); continue;
      }
      if (entry.state === 'needs-review') { results.push(entry); continue; }
      const current = await request('discover', { session });
      // A stale revision or changed execution must be reviewed by the Agent, not replayed.
      if (entry.body.expectedRevision !== undefined && entry.body.expectedRevision !== current.revision || entry.body.change?.runId && entry.body.change.runId !== current.binding?.runId) {
        entry.state = 'needs-review'; entry.error = '看板版本或执行已变化，请读取当前上下文后核对。';
        await atomicJson(path, entry); results.push(entry); continue;
      }
      const outcome = await request(entry.action, entry.body); await unlink(path); results.push({ clientOperationId: entry.body.clientOperationId, state: 'recovered', outcome });
      } catch (error) {
        if (!error.status || error.status === 403 || error.details?.code === 'board-instance-mismatch') throw error;
        entry.state = 'needs-review'; entry.error = error.message; await atomicJson(path, entry); results.push(entry);
      }
    }
    return { results };
  };
  return { config, request, ensure, discover: session => request('discover', { session }), context: body => request('context', body), attach: body => mutate('attach', body), change: body => mutate('change', body), takeover: body => mutate('takeover', body), operation: (clientOperationId, session) => request('operation', { clientOperationId, session }), flush, resolvePending };
}
