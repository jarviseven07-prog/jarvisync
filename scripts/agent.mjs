import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { projectOverview } from '../shared/collaboration.mjs';
import { createClient, loadConnection } from '../integrations/runtime/client.mjs';

const help = `JarviSync

读取
  projects
  discover --connection <connection.json> --session <真实宿主会话ID>
  context <节点ID> [--json]
  context <项目ID> --project [--json]
  overview <项目ID>

写入（均需已安装的 connection、真实 session 和 --expected-revision）
  attach <项目ID> [--node <节点ID>] [--confirm-rebind]
  create-project <名称> [--summary <摘要>]
  update-project <项目ID> [--summary <摘要>] [--title <名称>] [--conversation-ref <来源对话>] [--coordinator <主负责Agent>]
  create-node <项目ID> --title <标题>
  update <节点ID> [--goal <目标与预期成果>] [--owner <计划负责人>] [--model <模型记录>] [--status idea|todo|doing|blocked] [--progress <进展>] [--next <下一步>] [--decisions <决定>] [--question <需要人回答的问题>] [--link <材料，可重复，替换全部>]
  connect <输入节点ID> --to <后续节点ID>
  archive <节点ID>
  restore <节点ID>

执行（宿主实际委派后，执行 Agent 先读 context 再记录开始）
  start <节点ID> --execution-ref <真实宿主执行/会话标识> --owner <实际执行者> --model <实际模型>
  update <节点ID> --run <开始返回的execution.id> [--progress <进展>] [--next <下一步>] [--question <问题>] [--status doing|blocked]
  deliver <节点ID> --run <execution.id> --summary <交付结论> [--output <成果原件，可重复>] [--unresolved <未决事项>] [--final]
  stop <节点ID> --run <execution.id> --reason <实际停止原因>
  mark-final <节点ID> --delivery <delivery.id> [--clear]
  完成节点必须使用 deliver，普通 update 不能将未完成节点直接改为 done。

对话与反馈
  transcribe <项目ID> --kind goal|material|feedback|decision --body <原话> --source-ref <来源消息/对话> --recorded-by <转录Agent> [--node <节点ID>]
  respond <输入ID> --body <处理结果> --owner <回应Agent> --disposition applied|needs-clarification|not-applied [--affected-node <影响节点，可重复>]

多行内容/结构化操作
  change --file <UTF-8 JSON文件> --expected-revision <版本>
  文件仅包含 change 对象，例如 {"type":"node.update","id":"n-…","patch":{"goal":"产出说明"}}。

只读命令可加 --url http://127.0.0.1:<端口>；否则沿用 connection、NODEBOARD_URL、桌面连接或 4317。
写入命令必须提供 --connection <安装器生成的connection.json> 与 --session <真实宿主会话ID>，也可分别使用 JARVISYNC_CONNECTION、JARVISYNC_SESSION_ID。--url 只能在已有 connection 上覆盖本机服务地址，不能单独授予写入。
写入还必须提供 --operation-id <稳定请求ID>。发生连接错误时请保留该 ID 核对 pending，不要换 ID 盲目重放。
写入冲突时重新读取并判断，不自动重试。owner/model 只作记录；start 必须写入宿主可核验的实际模型，不得继承计划或上次记录。start 不会启动模型，stop 不会停止外部进程。
详细接入流程：README.md 与 docs/agent-collaboration.md。`;

function localUrl(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname)
    || parsed.username || parsed.password || parsed.search || parsed.hash || !['', '/'].includes(parsed.pathname)) {
    throw new Error('JarviSync 服务地址必须是本地 HTTP 地址，例如 http://127.0.0.1:4317。');
  }
  return parsed.origin;
}

async function connectionUrl(override, connectionPath) {
  if (override) return localUrl(override);
  if (connectionPath) {
    try { return localUrl((await loadConnection(connectionPath)).url); }
    catch (error) { throw new Error(`无法读取接入配置：${error.message}`); }
  }
  if (process.env.NODEBOARD_URL) return localUrl(process.env.NODEBOARD_URL);
  const desktopData = process.env.NODEBOARD_DESKTOP_DATA_DIR || join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Nodeboard');
  try {
    const connection = JSON.parse(await readFile(join(desktopData, 'connection.json'), 'utf8'));
    return localUrl(connection.url);
  } catch { return 'http://127.0.0.1:4317'; }
}

let activeOperationId;
try {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: {
    'expected-revision': { type: 'string' }, url: { type: 'string' }, connection: { type: 'string' }, session: { type: 'string' }, 'operation-id': { type: 'string' }, file: { type: 'string' },
    progress: { type: 'string' }, next: { type: 'string' }, status: { type: 'string' }, owner: { type: 'string' }, model: { type: 'string' },
    goal: { type: 'string' }, decisions: { type: 'string' }, title: { type: 'string' }, summary: { type: 'string' }, question: { type: 'string' },
    link: { type: 'string', multiple: true }, to: { type: 'string' }, project: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
    'conversation-ref': { type: 'string' }, coordinator: { type: 'string' }, 'execution-ref': { type: 'string' }, run: { type: 'string' },
    output: { type: 'string', multiple: true }, unresolved: { type: 'string' }, final: { type: 'boolean' }, delivery: { type: 'string' }, clear: { type: 'boolean' },
    reason: { type: 'string' }, node: { type: 'string' }, kind: { type: 'string' }, body: { type: 'string' }, 'source-ref': { type: 'string' },
    'recorded-by': { type: 'string' }, disposition: { type: 'string' }, 'affected-node': { type: 'string', multiple: true }, 'confirm-rebind': { type: 'boolean' },
  } });
  const [command, id, ...extra] = positionals;
  if (extra.length) throw new Error('参数过多。多行内容请使用 change --file。');
  if (!command || values.help) {
    console.log(help);
  } else {
    const connectionPath = values.connection || process.env.JARVISYNC_CONNECTION;
    const base = await connectionUrl(values.url, connectionPath);
    const request = async (path, body) => {
      let response;
      try { response = await fetch(`${base}${path}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined); }
      catch { throw new Error(`无法连接 ${base}，请先启动 JarviSync。`); }
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      return result;
    };
    const only = (allowed) => {
      const unexpected = Object.keys(values).filter(key => !['url', 'connection', 'json', 'expected-revision', 'session', 'operation-id', ...allowed].includes(key));
      if (unexpected.length) throw new Error(`${command} 不支持参数：${unexpected.map(key => `--${key}`).join('、')}。`);
    };
    const required = (key, label = key) => {
      if (typeof values[key] !== 'string' || !values[key].trim()) throw new Error(`请提供 --${key}（${label}）。`);
      return values[key];
    };
    if (command === 'projects') {
      only([]);
      if (id) throw new Error('projects 不需要目标 ID。');
      const board = await request('/api/board');
      console.log(JSON.stringify({ revision: board.revision, projects: board.projects.map(p => ({ id: p.id, title: p.title, summary: p.summary, archived: p.archived, demo: p.demo, conversationRef: p.conversationRef, coordinator: p.coordinator })) }, null, 2));
    } else if (command === 'discover') {
      only([]);
      if (id) throw new Error('discover 不需要目标 ID。');
      if (!connectionPath) throw new Error('discover 需要 --connection <安装器生成的connection.json> 或 JARVISYNC_CONNECTION。');
      const sessionId = values.session || process.env.JARVISYNC_SESSION_ID;
      if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('discover 需要 --session <真实宿主会话ID> 或 JARVISYNC_SESSION_ID。');
      let config;
      try { config = await loadConnection(connectionPath); }
      catch (error) { throw new Error(`无法读取接入配置：${error.message}`); }
      config.url = base;
      console.log(JSON.stringify(await createClient(config).discover({ host: config.host, profileId: config.profileId, sessionId: sessionId.trim() }), null, 2));
    } else if (command === 'context') {
      only(['project']);
      if (!id) throw new Error('请提供节点 ID；项目摘要需同时加 --project。');
      const result = await request(`/api/context?${values.project ? 'project' : 'node'}=${encodeURIComponent(id)}`);
      console.log(values.json ? JSON.stringify(result, null, 2) : result.markdown);
    } else if (command === 'overview') {
      only([]);
      if (!id) throw new Error('请提供项目 ID。');
      const board = await request('/api/board');
      if (!board.projects.some(project => project.id === id)) throw new Error('项目不存在。');
      console.log(JSON.stringify({ revision: board.revision, projectId: id, ...projectOverview(board, id) }, null, 2));
    } else {
      if (!/^\d+$/.test(values['expected-revision'] || '') || !Number.isSafeInteger(Number(values['expected-revision']))) throw new Error('请先读取 context 或 projects，再填写 --expected-revision。');
      const expectedRevision = Number(values['expected-revision']);
      if (command !== 'change' && !id) throw new Error('请提供目标 ID 或项目名称。');
      let change;
      let attachCreate;
      let attachTarget;
      switch (command) {
        case 'change': {
          only(['file']);
          if (id) throw new Error('change 使用 --file 指定 JSON 文件，不接受目标 ID。');
          const raw = await readFile(required('file', 'UTF-8 JSON 文件'), 'utf8');
          try { change = JSON.parse(raw.replace(/^\uFEFF/, '')); }
          catch { throw new Error('变更文件不是有效的 UTF-8 JSON。'); }
          if (!change || typeof change !== 'object' || Array.isArray(change) || typeof change.type !== 'string') throw new Error('文件需直接包含带 type 的 change 对象，版本通过 --expected-revision 提供。');
          break;
        }
        case 'update': {
          const patchKeys = values.run ? ['progress', 'next', 'question', 'status'] : ['progress', 'next', 'status', 'owner', 'model', 'goal', 'decisions', 'title', 'question'];
          only([...patchKeys, ...(values.run ? ['run'] : ['link'])]);
          const patch = Object.fromEntries(patchKeys.filter(key => values[key] !== undefined).map(key => [key, values[key]]));
          if (values.link) patch.links = values.link;
          if (!Object.keys(patch).length) throw new Error('请至少提供一项更新内容。');
          change = values.run ? { type: 'node.run.update', id, runId: values.run, patch } : { type: 'node.update', id, patch };
          break;
        }
        case 'create-project': {
          only(['summary', 'confirm-rebind']);
          attachCreate = { title: id, summary: values.summary ?? '', nodes: [] };
          break;
        }
        case 'attach': {
          only(['node', 'confirm-rebind']);
          attachTarget = { projectId: id, ...(values.node ? { nodeId: values.node } : {}), ...(values['confirm-rebind'] ? { confirmRebind: true } : {}) };
          break;
        }
        case 'update-project': {
          only(['summary', 'title', 'conversation-ref', 'coordinator']);
          const patch = {};
          for (const key of ['summary', 'title', 'coordinator']) if (values[key] !== undefined) patch[key] = values[key];
          if (values['conversation-ref'] !== undefined) patch.conversationRef = values['conversation-ref'];
          if (!Object.keys(patch).length) throw new Error('请至少提供一项项目更新。');
          change = { type: 'project.update', id, patch };
          break;
        }
        case 'create-node':
          only(['title']);
          change = { type: 'node.create', projectId: id, title: required('title', '节点标题') };
          break;
        case 'archive':
        case 'restore':
          only([]);
          change = { type: 'node.update', id, patch: { archived: command === 'archive' } };
          break;
        case 'connect': {
          only(['to']);
          const target = required('to', '后续节点 ID');
          const board = await request('/api/board');
          const source = board.nodes.find(node => node.id === id);
          if (!source) throw new Error('输入节点不存在。');
          change = { type: 'edge.create', projectId: source.projectId, source: id, target };
          break;
        }
        case 'start':
          only(['execution-ref', 'owner', 'model']);
          change = { type: 'node.start', id, executionRef: required('execution-ref', '宿主实际执行标识'), owner: required('owner', '实际执行者'), model: required('model', '宿主可核验的实际模型'), modelSource: 'host' };
          break;
        case 'deliver':
          only(['run', 'summary', 'output', 'unresolved', 'final']);
          change = { type: 'node.deliver', id, runId: required('run', 'execution.id'), summary: required('summary', '交付结论'), links: values.output ?? [], unresolved: values.unresolved ?? '', final: values.final ?? false };
          break;
        case 'stop':
          only(['run', 'reason']);
          change = { type: 'node.stop', id, runId: required('run', 'execution.id'), reason: required('reason', '实际停止原因') };
          break;
        case 'mark-final':
          only(['delivery', 'clear']);
          change = { type: 'delivery.mark', id, deliveryId: required('delivery', 'delivery.id'), final: !values.clear };
          break;
        case 'transcribe':
          only(['kind', 'body', 'source-ref', 'recorded-by', 'node']);
          change = { type: 'feedback.transcribe', projectId: id, ...(values.node ? { nodeId: values.node } : {}), kind: required('kind', '原话类别'), body: required('body', '原话'), sourceRef: required('source-ref', '来源消息或对话'), recordedBy: required('recorded-by', '转录 Agent') };
          break;
        case 'respond':
          only(['body', 'owner', 'disposition', 'affected-node']);
          change = { type: 'feedback.respond', id, body: required('body', '处理回应'), owner: required('owner', '回应 Agent'), disposition: required('disposition', '处理结果'), affectedNodeIds: values['affected-node'] ?? [] };
          break;
        default: throw new Error('未知命令，请使用 --help 查看用法。');
      }
      if (!connectionPath) throw new Error('写入需要 --connection <安装器生成的connection.json> 或 JARVISYNC_CONNECTION；--url 不能授予写入。');
      const sessionId = values.session || process.env.JARVISYNC_SESSION_ID;
      if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('写入需要 --session <真实宿主会话ID> 或 JARVISYNC_SESSION_ID。');
      let config;
      try { config = await loadConnection(connectionPath); }
      catch (error) { throw new Error(`无法读取接入配置：${error.message}`); }
      config.url = base;
      const session = { host: config.host, profileId: config.profileId, sessionId: sessionId.trim() };
      activeOperationId = values['operation-id'];
      if (typeof activeOperationId !== 'string') throw new Error('写入需要 --operation-id <稳定请求ID>；重试必须复用同一个 ID。');
      if (!activeOperationId.trim() || activeOperationId.length > 240 || activeOperationId.includes('\0')) throw new Error('--operation-id 格式不正确。');
      const client = createClient(config);
      const result = attachCreate
        ? await client.attach({ session, clientOperationId: activeOperationId, expectedRevision, create: attachCreate, ...(values['confirm-rebind'] ? { confirmRebind: true } : {}) })
        : attachTarget
          ? await client.attach({ session, clientOperationId: activeOperationId, expectedRevision, ...attachTarget })
        : await client.change({ session, clientOperationId: activeOperationId, expectedRevision, change });
      console.log(JSON.stringify(result, null, 2));
    }
  }
} catch (error) {
  console.error(`${error.message}${activeOperationId ? `\n客户端操作 ID：${activeOperationId}` : ''}`);
  process.exitCode = 1;
}
