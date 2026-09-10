import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { BoardError } from './model.mjs';
import { atomicJson, digest } from '../integrations/runtime/client.mjs';
import { prepareIntegration, installIntegration, detectHosts } from '../integrations/installer.mjs';

const hosts = ['codex', 'claude-code', 'hermes', 'mcp'];
export function openOnboarding({ dataDir, root, store, getUrl, servicePort = 0, installerOptions = {} }) {
  const path = join(dataDir, 'agent-integrations', 'state.json');
  let queue = Promise.resolve();
  const read = async () => {
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { profiles: [] }; throw error; }
  };
  const transaction = mutator => {
    const work = queue.then(async () => { const state = await read(); const result = await mutator(state); await atomicJson(path, state); return result; });
    queue = work.catch(() => {}); return work;
  };
  const publicProfile = ({ connectionToken, verification, sessions, ...profile }) => ({
    ...profile,
    verification: { read: Boolean(verification?.readAt), write: Boolean(verification?.writeAt), readback: Boolean(verification?.readbackAt), verifiedAt: verification?.readbackAt || null },
    sessionCount: Object.keys(sessions || {}).length,
    hooksObserved: Object.values(sessions || {}).some(session => session.events?.includes('SessionStart')),
    lastSeen: Object.values(sessions || {}).map(session => session.lastSeen).sort().at(-1) || null,
  });
  const getProfile = async body => {
    await queue;
    const state = await read();
    const profile = state.profiles.find(p => p.id === body.profileId && p.host === body.host);
    if (!profile || typeof body.connectionToken !== 'string') throw new BoardError('接入未关联，请回看板安装。', 403);
    const a = Buffer.from(profile.connectionToken), b = Buffer.from(body.connectionToken);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new BoardError('接入凭据不匹配，请修复接入。', 403);
    if (!profile.enabled) throw new BoardError('此 Agent 的自动记录已停用。', 403);
    if (body.session && (body.session.profileId !== profile.id || body.session.host !== profile.host)) throw new BoardError('会话与接入身份不一致。', 403);
    return profile;
  };
  return {
    read,
    getProfile,
    async status() {
      await queue;
      const board = await store.read();
      return { boardInstanceId: store.boardInstanceId, hosts: await detectHosts(installerOptions), profiles: (await read()).profiles.map(profile => ({ ...publicProfile(profile), scopeInvalid: profile.scope === 'project' && !board.projects.some(p => p.id === profile.projectId && !p.archived) })) };
    },
    async prepare(body) {
      if (!hosts.includes(body.host) || !['work', 'project'].includes(body.scope)) throw new BoardError('请选择 Agent 和记录范围。');
      if (body.scope === 'project' && !(await store.read()).projects.some(p => p.id === body.projectId && !p.archived)) throw new BoardError('请选择当前存在的项目。');
      return transaction(async state => {
        const existing = state.profiles.find(p => p.host === body.host);
        if (existing) throw new BoardError('此宿主已有接入，请使用现有接入的安装或停用入口。', 409);
        const profile = { id: randomUUID(), host: body.host, scope: body.scope, projectId: body.scope === 'project' ? body.projectId : null,
          enabled: true, connectionToken: randomBytes(32).toString('hex'), createdAt: new Date().toISOString(), installation: 'prepared', sessions: {} };
        const prepared = await prepareIntegration({ root, dataDir, url: getUrl(), boardInstanceId: store.boardInstanceId, profile, servicePort, ...installerOptions });
        Object.assign(profile, prepared); state.profiles.push(profile);
        return publicProfile(profile);
      });
    },
    async install(body) {
      const profile = (await read()).profiles.find(p => p.id === body.profileId);
      if (!profile) throw new BoardError('请先准备接入包。', 404);
      const result = await installIntegration(profile, installerOptions);
      return transaction(state => { const item = state.profiles.find(p => p.id === profile.id); Object.assign(item, result); return publicProfile(item); });
    },
    async enable(body) {
      if (typeof body.enabled !== 'boolean') throw new BoardError('停用状态不正确。');
      return transaction(state => { const profile = state.profiles.find(p => p.id === body.profileId); if (!profile) throw new BoardError('接入不存在。', 404); profile.enabled = body.enabled; return publicProfile(profile); });
    },
    async configure(body) {
      if (!['work', 'project'].includes(body.scope)) throw new BoardError('请选择记录范围。');
      return transaction(async state => {
        const profile = state.profiles.find(p => p.id === body.profileId);
        if (!profile) throw new BoardError('接入不存在。', 404);
        const board = await store.read();
        if (body.scope === 'project' && !board.projects.some(p => p.id === body.projectId && !p.archived)) throw new BoardError('请选择当前存在的项目。');
        const conflictingRun = body.scope === 'project' && (board.agentBindings || []).some(binding => binding.host === profile.host && binding.profileId === profile.id && binding.projectId !== body.projectId && binding.runId && board.nodes.some(node => node.id === binding.nodeId && node.executions?.some(run => run.id === binding.runId && !run.endedAt)));
        if (conflictingRun) throw new BoardError('此 Agent 在其他项目仍有未结束执行。请先在宿主中实际停止并写回，再切换记录范围。', 409);
        profile.scope = body.scope; profile.projectId = body.scope === 'project' ? body.projectId : null;
        const connection = JSON.parse(await readFile(profile.configPath, 'utf8'));
        await atomicJson(profile.configPath, { ...connection, scope: profile.scope, projectId: profile.projectId });
        return publicProfile(profile);
      });
    },
    async agentEvent(body) {
      const profile = await getProfile(body);
      if (!body.session?.sessionId || typeof body.session.sessionId !== 'string' || body.session.sessionId.length > 300) throw new BoardError('缺少真实会话标识。');
      const event = body.event;
      if (!['SessionStart', 'UserPromptSubmit', 'SubagentStart', 'Stop', 'Interrupt', 'SessionEnd', 'Checkpoint'].includes(event)) throw new BoardError('无法识别的宿主事件。');
      return transaction(state => {
        const item = state.profiles.find(p => p.id === profile.id);
        const session = item.sessions[digest(body.session.sessionId)] ||= { events: [], sessionId: body.session.sessionId };
        if (!session.events.includes(event)) session.events.push(event);
        session.lastSeen = new Date().toISOString(); session.lastEvent = event;
        if (event === 'UserPromptSubmit') session.lastTurn = body.turnId || session.lastSeen;
        if (event === 'Checkpoint') session.lastCheckpoint = session.lastTurn;
        if (event === 'Interrupt') session.interrupted = true;
        if (event === 'UserPromptSubmit') session.interrupted = false;
        // Store metadata, never prompts or transcripts.
        if (Object.hasOwn(body, 'model')) {
          session.model = typeof body.model === 'string' && body.model.trim() ? body.model.trim().slice(0, 200) : null;
          session.modelSource = session.model ? 'host' : 'host-unavailable';
        }
        return { session, scope: item.scope, projectId: item.projectId };
      });
    },
    async agentStatus(body) {
      const profile = await getProfile(body);
      return { session: body.session?.sessionId ? profile.sessions[digest(body.session.sessionId)] || null : null, scope: profile.scope, projectId: profile.projectId, enabled: profile.enabled };
    },
    async verify(body) {
      const profile = await getProfile(body);
      if (!body.session?.sessionId || !['read', 'write', 'readback'].includes(body.phase)) throw new BoardError('验证需要实际会话和读取、写入、读回步骤。');
      return transaction(state => {
        const item = state.profiles.find(p => p.id === profile.id);
        if (body.phase === 'read') {
          item.verification = { challenge: randomUUID(), sessionId: body.session.sessionId, readAt: new Date().toISOString() };
          return { challenge: item.verification.challenge, message: '独立验证区可读。请把此 challenge 写回，再读回 receipt。' };
        }
        const v = item.verification;
        if (typeof body.challenge !== 'string' || !body.challenge) {
          throw new BoardError(`${body.phase} 需要传入 read 返回的 challenge。`, 400, { code: 'verification-challenge-required' });
        }
        if (!v) throw new BoardError('当前接入尚未开始验证，请先执行 read。', 409, { code: 'verification-read-required' });
        if (v.sessionId !== body.session.sessionId) throw new BoardError('验证步骤属于其他会话，请在当前会话重新执行 read。', 409, { code: 'verification-session-mismatch' });
        if (v.challenge !== body.challenge) throw new BoardError('challenge 与当前验证不匹配，请使用最近一次 read 返回的值。', 409, { code: 'verification-challenge-mismatch' });
        if (body.phase === 'write') { v.receipt = `已由 ${profile.host} 的当前会话写入 ${v.challenge}`; v.writeAt = new Date().toISOString(); return { receipt: v.receipt }; }
        if (!v.writeAt) throw new BoardError('当前 challenge 尚未完成 write，请先写回。', 409, { code: 'verification-write-required' });
        if (typeof body.receipt !== 'string' || !body.receipt) throw new BoardError('readback 需要传入 write 返回的 receipt。', 400, { code: 'verification-receipt-required' });
        if (body.receipt !== v.receipt) throw new BoardError('receipt 与当前验证不匹配，请使用 write 返回的完整值。', 409, { code: 'verification-receipt-mismatch' });
        v.readbackAt = new Date().toISOString();
        return { verified: true, verifiedAt: v.readbackAt, message: '工具读写验证通过；新会话自动触发仍需实际普通任务验证。' };
      });
    },
    async close() { await queue; },
  };
}
