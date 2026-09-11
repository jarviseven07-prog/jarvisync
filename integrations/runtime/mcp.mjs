import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createClient, loadConnection } from './client.mjs';

const string = description => ({ type: 'string', description });
const session = { sessionId: string('本次宿主真实会话 ID，来自 JarviSync 会话入口；不得猜测或沿用其他会话。') };
const write = { ...session, clientOperationId: string('本次请求唯一且稳定的 ID；响应未知时复用原 ID、版本、正文。409 后先读上下文，再用 jarvisync_resolve 核对原失败请求，不修改原 ID 对应的请求。'), expectedRevision: { type: 'integer', minimum: 0, description: '刚读取并核对的全局看板版本；其他项目的写入也可能使版本变化。' } };
const schema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const dependencyProperties = { dependsOn: { type: 'array', maxItems: 20, uniqueItems: true, items: { type: 'string', minLength: 1 } }, independentReason: { type: 'string', minLength: 1, maxLength: 2000, pattern: '\\S', description: '仅无真实上游时填写独立原因；不得为排版而连线。' } };
const dependencyChoice = [
  { properties: { dependsOn: { minItems: 1 } }, not: { required: ['independentReason'] } },
  { properties: { dependsOn: { maxItems: 0 } }, required: ['independentReason'] },
];
const nodePlan = { type: 'array', maxItems: 20, items: { ...schema({ key: string('此批次稳定短标识'), title: string('可交付节点标题'), goal: string('目标'), next: string('下一步'), ...dependencyProperties }, ['key', 'title', 'dependsOn']), oneOf: dependencyChoice } };
const strings = { type: 'array', items: { type: 'string' } };
const position = schema({ x: { type: 'number' }, y: { type: 'number' } }, ['x', 'y']);
const choice = values => ({ type: 'string', enum: values });
const variant = (type, properties, required) => schema({ type: { const: type, type: 'string' }, ...properties }, ['type', ...required]);
const changeSchema = { description: '按 type 选择对应字段。node.create 的返回 saved.id 是新节点 ID；目标和下一步用 node.update.patch 设置。创建节点与 dependsOn 连线原子保存；dependsOn 引用当前项目真实上游 ID，无上游必须说明 independentReason。创建节点不会启动外部 Agent。', oneOf: [
  { ...variant('node.create', { projectId: string('当前项目 ID'), title: string('成果名称'), position, ...dependencyProperties }, ['projectId', 'title', 'dependsOn']), oneOf: dependencyChoice },
  variant('node.update', { id: string('节点 ID'), patch: schema({ title: string('标题'), goal: string('目标'), next: string('下一步'), decisions: string('已定事项'), question: string('待回答事项'), owner: string('计划执行者；不等于派发成功'), model: string('计划模型；不作为实际执行依据'), progress: string('未开始节点的说明；运行中用 progress 工具'), status: choice(['idea', 'todo', 'blocked']), links: strings, position, archived: { type: 'boolean' } }, []) }, ['id', 'patch']),
  variant('edge.create', { projectId: string('当前项目 ID'), source: string('上游节点 ID'), target: string('依赖上游的节点 ID') }, ['projectId', 'source', 'target']),
  variant('edge.remove', { id: string('连线 ID') }, ['id']),
  variant('project.update', { id: string('当前项目 ID'), patch: schema({ title: string('项目名称'), summary: string('目标摘要'), archived: { type: 'boolean' } }, []) }, ['id', 'patch']),
  variant('node.stop', { id: string('当前节点 ID'), runId: string('本会话实际执行 ID'), reason: string('宿主已经停止执行的原因；此操作只记录停止') }, ['id', 'runId', 'reason']),
  variant('delivery.mark', { id: string('当前节点 ID'), deliveryId: string('已有成果 ID'), final: { type: 'boolean' } }, ['id', 'deliveryId', 'final']),
  variant('feedback.transcribe', { projectId: string('当前项目 ID'), nodeId: string('当前节点 ID'), kind: choice(['goal', 'material', 'feedback', 'decision']), body: string('原话转录'), sourceRef: string('原话来源'), recordedBy: string('转录执行者') }, ['projectId', 'kind', 'body', 'sourceRef', 'recordedBy']),
  variant('feedback.respond', { id: string('人工输入 ID'), body: string('处理说明'), owner: string('回应者'), disposition: choice(['applied', 'needs-clarification', 'not-applied']), affectedNodeIds: strings }, ['id', 'body', 'owner', 'disposition']),
] };
export const toolDefinitions = [
  { name: 'jarvisync_discover', description: '只读发现本次会话绑定和已有项目；普通问答不创建记录，工作目录不是项目身份。', inputSchema: schema(session, ['sessionId']), annotations: { readOnlyHint: true } },
  { name: 'jarvisync_attach', description: '用户明确交办工作后，关联已有项目/节点，或原子创建少量工作节点。当前执行结束后可直接关联同项目其他节点；切换项目需已获得用户确认。', inputSchema: { ...schema({ ...write, projectId: string('明确选择的已有项目；只给同项目 ID 可回到项目范围，须先结束当前执行'), nodeId: string('目标节点；切换时不要沿用旧节点 ID'), create: schema({ title: string('新项目名称'), summary: string('用户确认的目标'), nodes: nodePlan }, ['title', 'nodes']), nodeKey: string('新批次中当前执行节点 key'), recording: { type: 'boolean', description: '用户要求这次不记录时 false；不建立业务项目' }, confirmRebind: { type: 'boolean', description: '仅切换到其他项目需 true，且用户已经确认；不用于绕过未结束执行。' } }, ['sessionId', 'clientOperationId', 'expectedRevision']), allOf: [{ not: { required: ['projectId', 'create'] } }, { anyOf: [{ not: { required: ['nodeKey'] } }, { required: ['create'] }] }] } },
  { name: 'jarvisync_context', description: '读取当前项目、节点与直接上游。继续工作前必须读取，成果原件按返回路径另行读取。nodeId 与 projectId 最多提供一个；均省略则读当前绑定。', inputSchema: { ...schema({ ...session, nodeId: string('同一绑定项目中的节点'), projectId: string('本会话绑定项目') }, ['sessionId']), not: { required: ['nodeId', 'projectId'] } }, annotations: { readOnlyHint: true } },
  { name: 'jarvisync_start', description: '实际执行者已经开始新执行后，记录开始并取得 runId。实际模型从宿主入口元数据读取，不填写计划模型。若本会话已有活动运行，先读 context 后复用原 runId，不重复调用 start。', inputSchema: schema({ ...write, nodeId: string('当前绑定的执行节点'), owner: string('实际执行者/宿主名称') }, ['sessionId', 'clientOperationId', 'expectedRevision', 'nodeId', 'owner']) },
  { name: 'jarvisync_takeover', description: '新会话接续未结束节点：先关联并读上下文，仅在原宿主已中断或用户明确确认原执行停止后，原子保存停止回执并开始新执行。Stop/SessionEnd 不是已中断证据。', inputSchema: schema({ ...write, nodeId: string('已绑定的原节点'), previousRunId: string('上下文内原活动运行 ID'), reason: string('停止原因与接续依据'), confirmation: { type: 'string', enum: ['host-observed', 'user-confirmed'], description: 'host-observed 由服务核验原宿主 Interrupt；user-confirmed 仅在用户已明确确认停止时使用。' }, owner: string('本次实际执行者') }, ['sessionId', 'clientOperationId', 'expectedRevision', 'nodeId', 'previousRunId', 'reason', 'confirmation', 'owner']) },
  { name: 'jarvisync_progress', description: '记录本次实际执行的阶段进展、下一步或受阻问题；progress/next/question/status 至少提供一项，不是每次工具调用都要写。', inputSchema: { ...schema({ ...write, nodeId: string('当前节点'), runId: string('本次实际执行 ID'), progress: string('实际进展'), next: string('下一步'), question: string('需要用户回答的问题'), status: { type: 'string', enum: ['doing', 'blocked'] } }, ['sessionId', 'clientOperationId', 'expectedRevision', 'nodeId', 'runId']), anyOf: ['progress', 'next', 'question', 'status'].map(key => ({ required: [key] })) } },
  { name: 'jarvisync_deliver', description: '业务工作真正完成后提交结论、成果原件链接与未解决事项；结束一轮聊天不等于完成工作。', inputSchema: schema({ ...write, nodeId: string('当前节点'), runId: string('本次执行 ID'), summary: string('交付结论'), links: { type: 'array', items: { type: 'string' } }, unresolved: string('未解决事项'), final: { type: 'boolean' } }, ['sessionId', 'clientOperationId', 'expectedRevision', 'nodeId', 'runId', 'summary']) },
  { name: 'jarvisync_change', description: '当前项目安排后续节点、依赖、反馈或记录已停止执行。项目来源主会话即使绑定执行节点也可安排同项目节点；普通执行会话只能写当前节点。不能伪造业务完成或派发成功。', inputSchema: schema({ ...write, change: changeSchema }, ['sessionId', 'clientOperationId', 'expectedRevision', 'change']) },
  { name: 'jarvisync_sync', description: '先查询断线写入是否已提交，再核对原执行和版本。已变化的请求保留待核对；不重放其他会话或强制覆盖。', inputSchema: schema(session, ['sessionId']) },
  { name: 'jarvisync_resolve', description: '先读上下文核对当前内容，再处理本会话原失败请求：retry 保持原业务正文并生成新尝试、结清旧请求；discard 只撤销失败写回，不删除成果或停止实际工作。若原写入已提交，直接恢复回执。中断会话和旧运行不能重试。', inputSchema: schema({ ...write, resolution: choice(['retry', 'discard']) }, ['sessionId', 'clientOperationId', 'expectedRevision', 'resolution']) },
  { name: 'jarvisync_verify', description: '仅在用户进行接入验证时，依次 read、write、readback；隔离验证区不产生正式项目。write 必须带 read 的 challenge；readback 必须同时带原 challenge 和 write 的 receipt。', inputSchema: { ...schema({ ...session, phase: choice(['read','write','readback']), challenge: string('read 返回的验证值；write 和 readback 均必填'), receipt: string('write 返回的回执；readback 必填') }, ['sessionId', 'phase']), oneOf: [
    { properties: { phase: { const: 'read' } } },
    { properties: { phase: { const: 'write' } }, required: ['challenge'] },
    { properties: { phase: { const: 'readback' } }, required: ['challenge', 'receipt'] },
  ] } },
];

function validate(value, definition, path = '参数') {
  const matches = option => { try { validate(value, option, path); return true; } catch { return false; } };
  if (definition.allOf) definition.allOf.forEach(option => validate(value, option, path));
  if (definition.anyOf && !definition.anyOf.some(matches)) throw new Error(`${path} 缺少所需字段组合，请核对工具参数。`);
  if (definition.not && matches(definition.not)) throw new Error(`${path} 的字段组合不受支持，请核对互斥参数。`);
  if (definition.oneOf) {
    if (definition.oneOf.filter(matches).length !== 1) throw new Error(`${path} 不符合工具定义：请按 type/phase 使用对应字段与必填参数。`);
  }
  if (Object.hasOwn(definition, 'const') && value !== definition.const || definition.enum && !definition.enum.includes(value)) throw new Error(`${path} 的取值不受支持。`);
  if (definition.type) {
    const valid = definition.type === 'object' ? value && typeof value === 'object' && !Array.isArray(value)
      : definition.type === 'array' ? Array.isArray(value)
      : definition.type === 'integer' ? Number.isSafeInteger(value)
      : typeof value === definition.type && (definition.type !== 'number' || Number.isFinite(value));
    if (!valid) throw new Error(`${path} 的类型必须为 ${definition.type}。`);
  }
  if (definition.minimum !== undefined && value < definition.minimum) throw new Error(`${path} 不得小于 ${definition.minimum}。`);
  if (definition.properties || definition.required) {
    for (const key of definition.required || []) if (value?.[key] === undefined) throw new Error(`${path} 缺少 ${key}。`);
    if (value && typeof value === 'object' && !Array.isArray(value)) for (const [key, item] of Object.entries(value)) {
      if (definition.properties?.[key]) validate(item, definition.properties[key], `${path}.${key}`);
      else if (definition.additionalProperties === false) throw new Error(`${path} 包含不支持的参数 ${key}。`);
    }
  }
  if (typeof value === 'string') {
    if (definition.minLength !== undefined && value.length < definition.minLength || definition.maxLength !== undefined && value.length > definition.maxLength || definition.pattern && !new RegExp(definition.pattern).test(value)) throw new Error(`${path} 文本格式不正确。`);
  }
  if (Array.isArray(value)) {
    if (definition.minItems !== undefined && value.length < definition.minItems) throw new Error(`${path} 条目不足。`);
    if (definition.uniqueItems && new Set(value).size !== value.length) throw new Error(`${path} 条目不得重复。`);
    if (definition.maxItems !== undefined && value.length > definition.maxItems) throw new Error(`${path} 条目过多。`);
    if (definition.items) value.forEach((item, index) => validate(item, definition.items, `${path}[${index}]`));
  }
}

export function createToolHandler(config, client = createClient(config)) {
  return async (name, args) => {
    const definition = toolDefinitions.find(tool => tool.name === name);
    if (!definition) throw new Error('没有这个 JarviSync 工具。');
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('工具参数必须是对象。');
    validate(args, definition.inputSchema);
    if (typeof args.sessionId !== 'string' || !args.sessionId.trim() || args.sessionId.length > 300) throw new Error('请使用本次宿主入口提供的真实会话 ID。');
    const activeSession = { host: config.host, profileId: config.profileId, sessionId: args.sessionId };
    const common = { session: activeSession, clientOperationId: args.clientOperationId, expectedRevision: args.expectedRevision };
    if (name === 'jarvisync_discover') return client.discover(activeSession);
    if (name === 'jarvisync_context') return client.context({ session: activeSession, nodeId: args.nodeId, projectId: args.projectId });
    if (name === 'jarvisync_sync') return client.flush(activeSession);
    if (name === 'jarvisync_resolve') return client.resolvePending({ ...common, resolution: args.resolution });
    if (name === 'jarvisync_verify') return client.request('verify', { session: activeSession, phase: args.phase, challenge: args.challenge, receipt: args.receipt });
    if (name === 'jarvisync_attach') {
      const { sessionId, ...body } = args;
      if (args.recording === false && !(await client.discover(activeSession)).binding) return { recording: false, binding: null, message: '此会话未建档；请继续遵循用户本次不记录的指示。' };
      return client.attach({ ...body, session: activeSession });
    }
    let change;
    if (name === 'jarvisync_start' || name === 'jarvisync_takeover') {
      const state = await client.request('status', { session: activeSession });
      const model = state.session?.model || null;
      if (name === 'jarvisync_takeover') return client.takeover({ ...common, nodeId: args.nodeId, previousRunId: args.previousRunId, reason: args.reason, confirmation: args.confirmation, owner: args.owner, model, modelSource: model ? 'host' : 'host-unavailable', executionRef: `${config.host}:${config.profileId}:${args.sessionId}` });
      change = { type: 'node.start', id: args.nodeId, owner: args.owner, model, modelSource: model ? 'host' : 'host-unavailable', executionRef: `${config.host}:${config.profileId}:${args.sessionId}` };
    } else if (name === 'jarvisync_progress') {
      change = { type: 'node.run.update', id: args.nodeId, runId: args.runId, patch: Object.fromEntries(['progress','next','question','status'].filter(key => args[key] !== undefined).map(key => [key, args[key]])) };
    } else if (name === 'jarvisync_deliver') {
      change = { type: 'node.deliver', id: args.nodeId, runId: args.runId, summary: args.summary, ...(args.links !== undefined ? { links: args.links } : {}), ...(args.unresolved !== undefined ? { unresolved: args.unresolved } : {}), ...(args.final !== undefined ? { final: args.final } : {}) };
    } else change = args.change;
    if (name === 'jarvisync_change' && !['project.update','node.create','node.update','edge.create','edge.remove','node.stop','delivery.mark','feedback.transcribe','feedback.respond'].includes(change?.type)) throw new Error('请使用相应的开始、进展或交付工具。');
    return client.change({ ...common, change });
  };
}

export async function runMcp(config, { input = process.stdin, output = process.stdout } = {}) {
  config ||= await loadConnection();
  const execute = createToolHandler(config);
  const send = value => output.write(`${JSON.stringify(value)}\n`);
  let initialized = false;
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    if (line.length > 1024 * 1024) { send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: '请求过大。' } }); continue; }
    let request;
    try { request = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '无效 JSON。' } }); continue; }
    if (!request || typeof request !== 'object' || Array.isArray(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') { send({ jsonrpc: '2.0', id: request?.id ?? null, error: { code: -32600, message: '无效请求。' } }); continue; }
    if (request.id === undefined) continue;
    const reply = result => send({ jsonrpc: '2.0', id: request.id, result });
    if (request.method === 'initialize') {
      initialized = true;
      reply({ protocolVersion: ['2024-11-05','2025-03-26','2025-06-18','2025-11-25'].includes(request.params?.protocolVersion) ? request.params.protocolVersion : '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'jarvisync', version: '0.1.1' }, instructions: 'JarviSync 本机协作：会话身份从宿主入口获取。明确交办的工作先发现并关联项目，再开始/记录/交付；普通问答和用户要求不记录的内容不建档。服务离线保留回执，用户中断立即尊重。工具连接不等于任务执行。' });
    } else if (request.method === 'ping') reply({});
    else if (!initialized) send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: '请先初始化。' } });
    else if (request.method === 'tools/list') reply({ tools: toolDefinitions });
    else if (request.method === 'tools/call') {
      try { const result = await execute(request.params?.name, request.params?.arguments || {}); reply({ content: [{ type: 'text', text: JSON.stringify(result) }] }); }
      catch (error) { reply({ isError: true, content: [{ type: 'text', text: JSON.stringify({ error: error.message, status: error.status || 0, ...(error.details ? { details: error.details } : {}) }) }] }); }
    } else send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: '不支持的方法。' } });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runMcp().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
