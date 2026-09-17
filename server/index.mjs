import { createServer } from 'node:http';
import { readFile, stat, unlink } from 'node:fs/promises';
import { resolve, join, extname, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.mjs';
import { openAgentService } from './agent-service.mjs';
import { openOnboarding } from './onboarding.mjs';
import { computeBuildId } from './build-identity.mjs';
import { atomicJson, digest, isMainModule } from '../integrations/runtime/client.mjs';
import { BoardError, buildContext, normalizeAttachmentMimeType, normalizeAttachmentName, prepareHumanChange, prepareHumanInputChange } from './model.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const maxMultipartBodySize = 22 * 1024 * 1024;
const maxAttachmentSize = 10 * 1024 * 1024;
const maxAttachmentTotalSize = 20 * 1024 * 1024;
export async function startServer({ port = Number(process.env.PORT || 4317), dataDir = process.env.NODEBOARD_DATA_DIR || join(root, 'data'), distDir = join(root, 'dist'), installerOptions = {} } = {}) {
  const buildId = await computeBuildId({ root, distDir });
  const store = await openStore(dataDir);
  const agents = await openAgentService({ store });
  let actualUrl;
  const onboarding = openOnboarding({ dataDir, root, store, getUrl: () => actualUrl, servicePort: port, installerOptions });
  const json = (res, value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
  const readAgentBody = async req => {
    if ((req.headers['content-type'] || '').split(';')[0] !== 'application/json') throw new BoardError('接入内容必须为 JSON。', 415);
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw new BoardError('接入内容过大。', 413); chunks.push(chunk); }
    let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new BoardError('接入内容不是有效 JSON。'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BoardError('接入内容格式不正确。');
    return body;
  };
  const readChangeBody = async (req) => {
    if ((req.headers['content-type'] || '').split(';')[0] !== 'application/json') throw new BoardError('保存内容必须为 JSON。', 415);
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw new BoardError('单次保存内容超过 1MB，请拆小后再保存。', 413); chunks.push(chunk); }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new BoardError('保存内容不是有效 JSON。'); }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['expectedRevision', 'change'].includes(key))) throw new BoardError('保存格式不正确。');
    return body;
  };
  const hasBrowserWriteHeaders = (req) => {
    if (req.headers.origin) return true;
    const names = Object.keys(req.headers).filter(name => name.startsWith('sec-fetch-'));
    // Node's built-in fetch adds only `sec-fetch-mode: cors`; browsers also send
    // origin/site/destination metadata. Keep existing local Node clients working.
    return names.length > 0 && !(names.length === 1 && names[0] === 'sec-fetch-mode' && req.headers['user-agent'] === 'node');
  };
  const requireHumanOrigin = (req, host) => {
    if (req.headers.origin && ![`http://${host}`, 'http://127.0.0.1:5173', 'http://localhost:5173'].includes(req.headers.origin)) throw new BoardError('请在 JarviSync 页面中保存。', 403);
  };
  const readMultipartInput = async (req) => {
    const contentType = req.headers['content-type'] || '';
    if (contentType.split(';')[0].trim().toLowerCase() !== 'multipart/form-data') throw new BoardError('附件上传必须使用 multipart/form-data。', 415);
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maxMultipartBodySize) tooLarge = true;
      else chunks.push(chunk);
    }
    if (tooLarge) throw new BoardError('上传请求过大，请减少附件后重试。', 413);
    let form;
    try {
      form = await new Request('http://localhost/', { method: 'POST', headers: { 'Content-Type': contentType }, body: Buffer.concat(chunks) }).formData();
    } catch {
      throw new BoardError('附件上传格式不正确。');
    }
    const allowedTextFields = new Set(['expectedRevision', 'projectId', 'nodeId', 'kind', 'body']);
    const fields = new Map();
    const uploaded = [];
    for (const [key, value] of form.entries()) {
      if (key === 'files') {
        if (typeof value === 'string') throw new BoardError('files 字段必须是文件。');
        uploaded.push(value);
      } else {
        if (!allowedTextFields.has(key)) throw new BoardError('包含无法识别的字段。');
        if (typeof value !== 'string' || fields.has(key)) throw new BoardError('表单字段不能重复。');
        fields.set(key, value);
      }
    }
    for (const key of ['expectedRevision', 'projectId', 'kind', 'body']) if (!fields.has(key)) throw new BoardError('附件上传缺少必填字段。');
    const revisionText = fields.get('expectedRevision');
    if (!/^(0|[1-9]\d*)$/.test(revisionText)) throw new BoardError('数据版本格式不正确。');
    const expectedRevision = Number(revisionText);
    if (!Number.isSafeInteger(expectedRevision)) throw new BoardError('数据版本格式不正确。');
    if (uploaded.length > 10) throw new BoardError('每次最多可以附加 10 个文件。', 413);
    let totalSize = 0;
    const files = [];
    const attachments = [];
    for (const file of uploaded) {
      if (file.size > maxAttachmentSize) throw new BoardError('单个附件不能超过 10MiB。', 413);
      totalSize += file.size;
      if (totalSize > maxAttachmentTotalSize) throw new BoardError('每次附件总大小不能超过 20MiB。', 413);
      const data = Buffer.from(await file.arrayBuffer());
      const attachment = {
        id: `a-${randomUUID()}`,
        name: normalizeAttachmentName(file.name),
        size: data.length,
        mimeType: normalizeAttachmentMimeType(file.type),
        sha256: createHash('sha256').update(data).digest('hex'),
      };
      attachments.push(attachment);
      files.push({ attachment, data });
    }
    const change = {
      type: 'human.input.add',
      projectId: fields.get('projectId'),
      ...(fields.has('nodeId') ? { nodeId: fields.get('nodeId') } : {}),
      kind: fields.get('kind'),
      body: fields.get('body'),
    };
    return { expectedRevision, change, attachments, files };
  };
  const attachmentDisposition = (name) => {
    const extension = /^[.][a-z0-9]{1,12}$/i.test(extname(name)) ? extname(name) : '';
    const encoded = encodeURIComponent(name).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    return `attachment; filename="attachment${extension}"; filename*=UTF-8''${encoded}`;
  };
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const host = req.headers.host;
      if (!host || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) throw new BoardError('请通过本机地址打开 JarviSync。', 403);
      const url = new URL(req.url, `http://${host}`);
      if (url.pathname === '/api/health' && req.method === 'GET') return json(res, { product: 'JarviSync', boardInstanceId: store.boardInstanceId, buildId });
      if (url.pathname === '/api/onboarding' && req.method === 'GET') return json(res, await onboarding.status());
      if (url.pathname.startsWith('/api/onboarding/') && req.method === 'POST') {
        if (req.headers.origin !== `http://${host}` && req.headers.origin !== 'http://127.0.0.1:5173' && req.headers.origin !== 'http://localhost:5173') throw new BoardError('请在本机看板内管理接入。', 403);
        if (req.headers['x-jarvisync-ui'] !== '1') throw new BoardError('请从看板的接入入口操作。', 403);
        const action = url.pathname.slice('/api/onboarding/'.length);
        if (!['prepare', 'install', 'enable', 'configure'].includes(action)) throw new BoardError('没有这个接入操作。', 404);
        return json(res, await onboarding[action](await readAgentBody(req)));
      }
      if (url.pathname.startsWith('/api/agent/') && req.method === 'POST') {
        if (hasBrowserWriteHeaders(req)) throw new BoardError('Agent 接入接口不接受网页请求。', 403);
        const body = await readAgentBody(req);
        if (body.boardInstanceId !== store.boardInstanceId) throw new BoardError('看板实例不一致，已停止接入。', 409);
        const profile = await onboarding.getProfile(body);
        const action = url.pathname.slice('/api/agent/'.length);
        if (action === 'event') return json(res, await onboarding.agentEvent(body));
        if (action === 'status') return json(res, await onboarding.agentStatus(body));
        if (action === 'verify') return json(res, await onboarding.verify(body));
        if (!['discover', 'context', 'attach', 'change', 'takeover', 'operation'].includes(action)) throw new BoardError('没有这个 Agent 操作。', 404);
        const { profileId: transportProfile, host: transportHost, connectionToken, ...serviceBody } = body;
        // A committed receipt must remain recoverable after its project is deleted
        // or the integration scope changes. Identity checks still apply above.
        if (action === 'operation') return json(res, { outcome: await agents.operation(serviceBody) });
        if (['attach', 'change', 'takeover'].includes(action) && body.session?.sessionId && profile.sessions[digest(body.session.sessionId)]?.interrupted) throw new BoardError('用户已中断此会话，迟到写回已停止。等待用户下一次正常请求后再核对。', 409, { code: 'session-interrupted' });
        if (profile.scope === 'project') {
          const board = await store.read();
          const project = board.projects.find(p => p.id === profile.projectId && !p.archived);
          const humanEndedSession = (board.humanEndedSessions ?? []).some(item => item.host === body.session?.host && item.profileId === body.session?.profileId && item.sessionId === body.session?.sessionId);
          if (!project && !humanEndedSession) throw new BoardError('已选项目不存在或已归档，请在看板“接入我的 Agent”中修改记录范围。', 409, { code: 'connection-scope-missing' });
          if (project) {
            if (body.create || body.projectId && body.projectId !== profile.projectId) throw new BoardError('此接入仅记录已选项目。', 403);
            const current = await agents.discover({ boardInstanceId: store.boardInstanceId, session: body.session });
            const outside = current.binding && current.binding.projectId !== profile.projectId;
            if (action === 'attach') { serviceBody.projectId = profile.projectId; if (outside) serviceBody.confirmRebind = true; }
            else if (action === 'discover' && outside) return json(res, { ...current, binding: null, progressCheckpoint: null, candidates: [{ projectId: project.id, projectNumber: project.projectNumber, title: project.title, summary: project.summary }], message: '记录范围已改变，请重新关联当前已选项目。' });
            else if (outside) throw new BoardError('当前会话不属于已授权项目，请重新关联后继续。', 403);
          }
        }
        if (action === 'takeover' && body.confirmation === 'host-observed') {
          const board = await store.read();
          const oldBindings = (board.agentBindings || []).filter(binding => binding.nodeId === body.nodeId && binding.runId === body.previousRunId);
          const { profiles } = await onboarding.read();
          const observed = oldBindings.some(binding => profiles.find(item => item.id === binding.profileId && item.host === binding.host)?.sessions[digest(binding.sessionId)]?.interrupted);
          if (!observed) throw new BoardError('尚未观察到原宿主中断。请先实际停止原执行，或在用户明确确认原执行已停止后接管。', 409, { code: 'takeover-stop-unconfirmed' });
        }
        if (action === 'discover') {
          const result = await agents.discover(serviceBody);
          if (profile.sessions[digest(body.session.sessionId)]?.interrupted) result.progressCheckpoint = null;
          if (profile.scope === 'project') result.candidates = result.candidates.filter(item => item.projectId === profile.projectId);
          return json(res, result);
        }
        const result = await agents[action](serviceBody);
        if (action === 'context' && profile.sessions[digest(body.session.sessionId)]?.interrupted) result.progressCheckpoint = null;
        if (action === 'takeover' || action === 'change' && ['node.start', 'node.run.update'].includes(body.change?.type)) {
          await onboarding.agentEvent({ ...body, event: 'Checkpoint' });
        }
        return json(res, result);
      }
      if (url.pathname === '/api/board' && req.method === 'GET') return json(res, await store.read());
      if (url.pathname === '/api/context' && req.method === 'GET') {
        if (url.searchParams.getAll('node').length > 1 || url.searchParams.getAll('project').length > 1) throw new BoardError('请只指定一个节点或项目。');
        return json(res, buildContext(await store.read(), { node: url.searchParams.get('node'), project: url.searchParams.get('project'), attachmentPath: attachment => store.attachmentPath(attachment) }));
      }
      if (url.pathname === '/api/human/input' && req.method === 'POST') {
        requireHumanOrigin(req, host);
        const input = await readMultipartInput(req);
        return json(res, await store.change(input.expectedRevision, prepareHumanInputChange(input.change, input.attachments), { files: input.files }));
      }
      if (url.pathname === '/api/human/change' && req.method === 'POST') {
        requireHumanOrigin(req, host);
        const body = await readChangeBody(req);
        return json(res, await store.change(body.expectedRevision, prepareHumanChange(body.change)));
      }
      if (url.pathname === '/api/change' && req.method === 'POST') {
        throw new BoardError('旧 Agent 写入入口已停用。请使用看板生成的接入配置与真实宿主会话写入。', 410, { code: 'agent-session-required' });
      }
      const attachmentMatch = /^\/api\/attachments\/([^/]+)$/.exec(url.pathname);
      if (attachmentMatch) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new BoardError('不支持此操作。', 405);
        let attachmentId;
        try { attachmentId = decodeURIComponent(attachmentMatch[1]); } catch { throw new BoardError('附件不存在。', 404); }
        if (!/^a-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(attachmentId)) throw new BoardError('附件不存在。', 404);
        const board = await store.read();
        const attachment = (board.humanInputs ?? []).flatMap(input => input.attachments ?? []).find(item => item.id === attachmentId);
        if (!attachment) throw new BoardError('附件不存在。', 404);
        const content = await store.readAttachment(attachment);
        res.writeHead(200, {
          'Content-Type': attachment.mimeType,
          'Content-Length': content.length,
          'Content-Disposition': attachmentDisposition(attachment.name),
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        return res.end(req.method === 'HEAD' ? undefined : content);
      }
      if (url.pathname.startsWith('/api/')) throw new BoardError('没有这个接口或操作。', 404);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw new BoardError('不支持此操作。', 405);
      const base = resolve(distDir);
      let path = resolve(base, `.${decodeURIComponent(url.pathname)}`);
      if (path !== base && !path.startsWith(base + sep)) throw new BoardError('文件路径不正确。', 400);
      const info = await stat(path).catch(() => null);
      if (info?.isDirectory()) path = join(path, 'index.html');
      else if (!info && !extname(url.pathname)) path = join(base, 'index.html');
      let content;
      try { content = await readFile(path); } catch { throw new BoardError('页面尚未构建，请先运行 npm run build。', 404); }
      res.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream', 'Cache-Control': extname(path) === '.html' ? 'no-store' : 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) { if (!res.headersSent) json(res, { error: error.message || '操作未完成，请刷新核对。', ...(error.details ? { details: error.details } : {}) }, error.status || 500); else res.end(); }
  });
  try { await new Promise((ok, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', ok); }); }
  catch (error) { await store.close(); throw error; }
  const address = server.address();
  actualUrl = `http://127.0.0.1:${address.port}`;
  const endpointPath = join(dataDir, 'agent-endpoint.json');
  try { await atomicJson(endpointPath, { boardInstanceId: store.boardInstanceId, url: actualUrl, pid: process.pid }); }
  catch (error) { await new Promise(ok => server.close(ok)); await store.close(); throw error; }
  return { url: actualUrl, buildId, store, onboarding, close: async () => { await new Promise((ok, fail) => server.close(error => error ? fail(error) : ok())); await onboarding.close(); await store.close();
    const endpoint = JSON.parse(await readFile(endpointPath, 'utf8').catch(() => 'null'));
    if (endpoint?.url === actualUrl && endpoint?.pid === process.pid) await unlink(endpointPath).catch(() => {});
  } };
}
if (isMainModule(import.meta.url)) {
  try {
    const app = await startServer();
    console.log(`JarviSync 已启动：${app.url}`);
    let closing = false;
    const stop = async () => { if (closing) return; closing = true; await app.close(); process.exitCode = 0; };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
