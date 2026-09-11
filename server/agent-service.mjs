import { createHash, randomUUID } from 'node:crypto';
import { BoardError, agentOperationLimit, applyChange, buildContext, prepareAgentChange, validateBoard } from './model.mjs';

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BoardError(`${label}格式不正确。`);
  return value;
}

function onlyKeys(value, allowed, label = '请求') {
  object(value, label);
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new BoardError(`${label}包含无法识别的字段。`);
}

function requiredText(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new BoardError(`${label}格式不正确。`);
  return value.trim();
}

function optionalText(value, label, max = 20000) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new BoardError(`${label}格式不正确。`);
  return value;
}

function normalizeSession(value) {
  onlyKeys(value, ['host', 'profileId', 'sessionId', 'cwd'], '宿主会话');
  return {
    host: requiredText(value.host, '宿主', 120),
    profileId: requiredText(value.profileId, '宿主配置 ID', 240),
    sessionId: requiredText(value.sessionId, '宿主会话 ID', 400),
    ...(value.cwd === undefined ? {} : { cwd: requiredText(value.cwd, '工作目录', 4000) }),
  };
}

function sessionIdentity(session) {
  return { host: session.host, profileId: session.profileId, sessionId: session.sessionId };
}

function sameSession(left, right) {
  return left.host === right.host && left.profileId === right.profileId && left.sessionId === right.sessionId;
}

function sessionConversationRef(session) {
  return `${session.host}:${session.profileId}:${session.sessionId}`;
}

function isProjectCoordinator(project, session) {
  return project.conversationRef === sessionConversationRef(session);
}

function findBinding(board, session) {
  return (board.agentBindings ?? []).find(binding => sameSession(binding, session)) ?? null;
}

function findHumanEndedSession(board, session) {
  return (board.humanEndedSessions ?? []).find(item => sameSession(item, session)) ?? null;
}

function candidates(board) {
  return board.projects
    .filter(project => !project.archived && !project.demo)
    .map(project => ({
      projectId: project.id,
      projectNumber: project.projectNumber,
      title: project.title,
      updatedAt: project.updatedAt,
    }));
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function requestHash(kind, request, session) {
  const content = { ...request, session: sessionIdentity(session) };
  delete content.boardInstanceId;
  delete content.clientOperationId;
  return createHash('sha256').update(canonical({ kind, request: content })).digest('hex');
}

function operationId(value) {
  return requiredText(value, '客户端操作 ID', 240);
}

function assertExpectedRevision(value, current, optional = false, conflictDetails) {
  if (optional && value === undefined) return;
  if (!Number.isSafeInteger(value) || value < 0) throw new BoardError('数据版本格式不正确。');
  if (value !== current) throw new BoardError('内容已有更新。请重新读取并核对后再保存。', 409, { ...conflictDetails, code: 'revision-conflict', currentRevision: current });
}

function currentDeliveryObstacle(board, binding, change) {
  if (!binding || binding.recording !== true || change?.type !== 'node.deliver') return null;
  if (!binding.nodeId || binding.nodeId !== change.id || !binding.runId || binding.runId !== change.runId) return null;
  const node = board.nodes.find(item => item.id === binding.nodeId);
  if (!node || node.projectId !== binding.projectId || node.status !== 'blocked') return null;
  const latestRun = (node.executions ?? []).at(-1);
  if (!latestRun || latestRun.id !== binding.runId || latestRun.endedAt !== undefined) return null;
  return {
    code: 'node-blocked',
    message: '当前节点仍处于受阻状态，不能直接交付。',
    recovery: '先读取上下文并解决当前问题，再用 jarvisync_progress 恢复为 doing 并清空 question；重新读取当前版本后，通过 jarvisync_resolve retry 原交付请求并保留原正文；原交付不再需要则 discard。',
  };
}

function compactBinding(binding) {
  if (!binding) return null;
  return {
    id: binding.id,
    host: binding.host,
    profileId: binding.profileId,
    sessionId: binding.sessionId,
    projectId: binding.projectId,
    ...(binding.nodeId ? { nodeId: binding.nodeId } : {}),
    ...(binding.runId ? { runId: binding.runId } : {}),
    recording: binding.recording,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
    ...(binding.humanEndedAt ? { humanEndedAt: binding.humanEndedAt } : {}),
  };
}

function compactSaved(saved, changeType) {
  if (!saved || typeof saved !== 'object') return undefined;
  const type = changeType?.startsWith('node.') || changeType === 'delivery.mark' || changeType === 'nodes.layout'
    ? 'node'
    : changeType?.startsWith('project.')
      ? 'project'
      : changeType?.startsWith('feedback.')
        ? 'humanInput'
        : changeType?.startsWith('edge.')
          ? 'edge'
          : saved.source !== undefined && saved.target !== undefined
            ? 'edge'
            : saved.status !== undefined || saved.executions !== undefined
              ? 'node'
              : saved.kind !== undefined
                ? 'humanInput'
                : 'record';
  return {
    type,
    ...(saved.id === undefined ? {} : { id: saved.id }),
    ...(saved.projectId === undefined ? {} : { projectId: saved.projectId }),
    ...(saved.status === undefined ? {} : { status: saved.status }),
    ...(saved.source === undefined ? {} : { source: saved.source }),
    ...(saved.target === undefined ? {} : { target: saved.target }),
    ...(saved.nodeId === undefined ? {} : { nodeId: saved.nodeId }),
  };
}

function compactOutcome(operation) {
  const outcome = operation.outcome ?? {};
  return {
    boardInstanceId: outcome.boardInstanceId,
    revision: outcome.revision,
    committed: true,
    clientOperationId: operation.id,
    operationKind: operation.kind,
    ...(outcome.changeType ? { changeType: outcome.changeType } : {}),
    ...(outcome.binding ? { binding: compactBinding(outcome.binding) } : {}),
    ...(outcome.created ? { created: true } : {}),
    ...(outcome.nodeIdsByKey ? { nodeIdsByKey: structuredClone(outcome.nodeIdsByKey) } : {}),
    ...(outcome.previousRunId ? { previousRunId: outcome.previousRunId } : {}),
    ...(outcome.runId ? { runId: outcome.runId } : {}),
    ...(outcome.saved ? { saved: compactSaved(outcome.saved, outcome.changeType) } : {}),
    ...(outcome.deleted ? { deleted: true } : {}),
  };
}

function existingOperation(board, { id, kind, hash, session, expectedRevision }) {
  const operation = (board.agentOperations ?? []).find(item => item.id === id);
  if (!operation) {
    if (Number.isSafeInteger(expectedRevision) && expectedRevision <= (board.agentOperationReplayFloorRevision ?? -1)) {
      throw new BoardError('这个操作已超出自动重试保留范围，请读取当前看板并核对结果。', 410, {
        code: 'operation-expired',
        replayFloorRevision: board.agentOperationReplayFloorRevision,
      });
    }
    return null;
  }
  if (operation.kind !== kind || operation.requestHash !== hash || !sameSession(operation.session, session)) {
    throw new BoardError('这个客户端操作 ID 已用于不同内容，不能覆盖原结果。', 409, { code: 'idempotency-conflict' });
  }
  return compactOutcome(operation);
}

function addOperation(board, { id, kind, hash, session, outcome, at, baseRevision }) {
  board.agentOperations ??= [];
  board.agentOperations = board.agentOperations.map(operation => ({ ...operation, outcome: compactOutcome(operation) }));
  const operation = { id, kind, requestHash: hash, session: sessionIdentity(session), outcome, createdAt: at, baseRevision };
  operation.outcome = compactOutcome(operation);
  board.agentOperations.push(operation);
  while (board.agentOperations.length > agentOperationLimit) {
    const expired = board.agentOperations.shift();
    const expiredBase = Number.isSafeInteger(expired.baseRevision) ? expired.baseRevision : Math.max(0, (expired.outcome?.revision ?? 1) - 1);
    board.agentOperationReplayFloorRevision = Math.max(board.agentOperationReplayFloorRevision ?? -1, expiredBase);
  }
  return operation.outcome;
}

function assertInstance(store, value) {
  if (value !== store.boardInstanceId) throw new BoardError('看板实例不一致，请重新关联原看板。', 409, { code: 'board-instance-mismatch', boardInstanceId: store.boardInstanceId });
}

function projectById(board, id) {
  const project = board.projects.find(item => item.id === id);
  if (!project) throw new BoardError('项目不存在，请重新读取后核对。', 404);
  return project;
}

function nodeById(board, id) {
  const node = board.nodes.find(item => item.id === id);
  if (!node) throw new BoardError('节点不存在，请重新读取后核对。', 404);
  return node;
}

function publicBinding(binding) {
  return binding ? structuredClone(binding) : null;
}

function activeBoundRun(board, binding) {
  if (!binding?.nodeId || !binding.runId) return null;
  return (nodeById(board, binding.nodeId).executions ?? []).find(run => run.id === binding.runId && run.endedAt === undefined) ?? null;
}

function bindingConflict(board, binding, message = '这个会话已经关联了其他工作。', recovery) {
  return new BoardError(message, 409, {
    code: 'binding-conflict',
    binding: publicBinding(binding),
    candidates: candidates(board),
    ...(recovery ? { recovery } : {}),
  });
}

function assertSessionNotHumanEnded(board, session, binding = findBinding(board, session)) {
  const tombstone = findHumanEndedSession(board, session);
  const humanEndedAt = tombstone?.endedAt ?? binding?.humanEndedAt;
  if (!humanEndedAt) return;
  throw new BoardError('这个会话绑定的执行已由人在看板结束，不能继续写回。请在新的宿主会话中重新关联后继续。', 409, {
    code: 'human-ended',
    humanEndedAt,
    binding: publicBinding(binding),
  });
}

function validateCreate(value) {
  onlyKeys(value, ['title', 'summary', 'nodes'], '新项目');
  const title = requiredText(value.title, '项目名称', 120);
  const summary = optionalText(value.summary, '项目摘要') ?? '';
  const nodes = value.nodes ?? [];
  if (!Array.isArray(nodes) || nodes.length > 20) throw new BoardError('新项目最多可以一次建立 20 个节点。');
  const keys = new Set();
  const normalizedNodes = nodes.map(item => {
    onlyKeys(item, ['key', 'title', 'goal', 'next', 'dependsOn'], '新节点');
    const key = requiredText(item.key, '节点 key', 100);
    if (!/^[a-zA-Z0-9_-]+$/.test(key) || keys.has(key)) throw new BoardError('节点 key 格式不正确或重复。');
    keys.add(key);
    const dependsOn = item.dependsOn ?? [];
    if (!Array.isArray(dependsOn) || dependsOn.length > 20 || dependsOn.some(dependency => typeof dependency !== 'string') || new Set(dependsOn).size !== dependsOn.length) throw new BoardError('节点依赖格式不正确。');
    return {
      key,
      title: requiredText(item.title, '节点标题', 160),
      goal: optionalText(item.goal, '节点目标'),
      next: optionalText(item.next, '节点下一步'),
      dependsOn,
    };
  });
  for (const node of normalizedNodes) {
    for (const dependency of node.dependsOn) if (!keys.has(dependency) || dependency === node.key) throw new BoardError('节点依赖必须引用本次创建的其他节点 key。');
  }
  return { title, summary, nodes: normalizedNodes };
}

function savedRecord(board, change) {
  if (change.type === 'project.update') return board.projects.find(item => item.id === change.id);
  if (change.type === 'node.create') return board.nodes.at(-1);
  if (change.type === 'feedback.transcribe') return board.humanInputs.at(-1);
  if (change.type === 'feedback.respond') return board.humanInputs.find(item => item.id === change.id);
  if (change.type === 'edge.create') return board.edges.at(-1);
  if (change.type.startsWith('node.') || change.type === 'delivery.mark') return board.nodes.find(item => item.id === change.id);
  return { type: change.type, id: change.id, projectId: change.projectId };
}

function ensureBindingScope(board, binding, session, change) {
  assertSessionNotHumanEnded(board, session, binding);
  if (!binding.recording) throw new BoardError('这个会话已停用工作记录。', 403, { code: 'recording-disabled' });
  if (!change || typeof change !== 'object' || Array.isArray(change) || typeof change.type !== 'string') throw new BoardError('变更格式不正确。');
  if (change.type === 'project.create') throw new BoardError('新建项目请使用 attach 的 create。');
  if (binding.nodeId && binding.runId) {
    const latestRun = (nodeById(board, binding.nodeId).executions ?? []).at(-1);
    if (!latestRun || latestRun.id !== binding.runId) throw new BoardError('这个会话绑定的执行已被后续执行接替，不能再写回。', 409, { code: 'stale-run', binding: publicBinding(binding) });
  }

  const coordinator = isProjectCoordinator(projectById(board, binding.projectId), session);

  const ensureProject = projectId => {
    if (projectId !== binding.projectId) throw new BoardError('变更不属于这个会话绑定的项目。', 409, { code: 'binding-scope-conflict', binding: publicBinding(binding) });
    return projectById(board, projectId);
  };
  const ensureNode = (nodeId, coordinatorCanPlan = false) => {
    const node = nodeById(board, nodeId);
    ensureProject(node.projectId);
    if (binding.nodeId && node.id !== binding.nodeId && !(coordinator && coordinatorCanPlan)) {
      throw new BoardError('变更不属于这个会话绑定的节点。请由项目主负责会话安排后续节点，或在当前执行结束后关联目标节点。', 409, {
        code: 'binding-scope-conflict',
        binding: publicBinding(binding),
        recovery: '普通执行会话只能写当前节点；结束当前执行后可直接关联同项目的目标节点。',
      });
    }
    return node;
  };

  const ensureProjectStructure = () => {
    if (binding.nodeId && !coordinator) {
      throw new BoardError('当前会话只绑定了执行节点，不能修改项目结构。请由项目主负责会话新增后续节点或依赖。', 409, {
        code: 'binding-scope-conflict',
        binding: publicBinding(binding),
        recovery: '由项目来源会话安排节点；普通执行会话结束当前执行后可关联同项目的其他节点。',
      });
    }
  };

  if (change.type === 'project.update') {
    ensureProject(change.id);
    ensureProjectStructure();
  }
  else if (change.type === 'node.create' || change.type === 'nodes.layout') {
    ensureProject(change.projectId);
    ensureProjectStructure();
  } else if (change.type === 'edge.create') {
    ensureProject(change.projectId);
    ensureProjectStructure();
    ensureProject(nodeById(board, change.source).projectId);
    ensureProject(nodeById(board, change.target).projectId);
  } else if (change.type === 'edge.remove') {
    ensureProjectStructure();
    const edge = board.edges.find(item => item.id === change.id);
    if (!edge) throw new BoardError('连线不存在，请重新读取后核对。', 404);
    ensureProject(edge.projectId);
  } else if (change.type === 'feedback.transcribe') {
    ensureProject(change.projectId);
    if (change.nodeId) ensureNode(change.nodeId);
    else if (binding.nodeId) throw new BoardError('节点会话只能记录当前节点范围内的反馈。', 409, { code: 'binding-scope-conflict', binding: publicBinding(binding) });
  } else if (change.type === 'feedback.respond') {
    const input = (board.humanInputs ?? []).find(item => item.id === change.id);
    if (!input) throw new BoardError('人工输入不存在，请重新读取后核对。', 404);
    ensureProject(input.projectId);
    if (binding.nodeId) {
      if (input.nodeId && input.nodeId !== binding.nodeId) throw new BoardError('回应不属于这个会话绑定的节点。', 409, { code: 'binding-scope-conflict', binding: publicBinding(binding) });
      for (const nodeId of change.affectedNodeIds ?? []) ensureNode(nodeId);
    }
  } else if (change.type === 'node.update') ensureNode(change.id, true);
  else if (change.type === 'delivery.mark' || change.type.startsWith('node.')) ensureNode(change.id);
  else throw new BoardError('无法识别的操作。');

  if (change.type === 'delivery.mark') {
    const delivery = (nodeById(board, change.id).deliveries ?? []).at(-1);
    if (!binding.runId || delivery?.runId !== binding.runId) throw new BoardError('交付不属于当前会话绑定的执行。', 409, { code: 'stale-run', binding: publicBinding(binding) });
  }
  if (['node.run.update', 'node.stop', 'node.deliver'].includes(change.type)) {
    if (!binding.runId || binding.runId !== change.runId) throw new BoardError('运行 ID 与当前会话绑定不一致，旧执行不能写回。', 409, { code: 'stale-run', binding: publicBinding(binding) });
  }
}

export function openAgentService({ store }) {
  if (!store || typeof store.read !== 'function' || typeof store.transact !== 'function' || typeof store.boardInstanceId !== 'string') throw new TypeError('openAgentService requires an open store');

  return {
    async discover(request) {
      onlyKeys(request, ['boardInstanceId', 'session']);
      assertInstance(store, request.boardInstanceId);
      const session = normalizeSession(request.session);
      const board = await store.read();
      const binding = findBinding(board, session);
      const tombstone = findHumanEndedSession(board, session);
      const humanEndedAt = tombstone?.endedAt ?? binding?.humanEndedAt;
      return {
        boardInstanceId: store.boardInstanceId,
        revision: board.revision,
        binding: publicBinding(binding),
        candidates: binding || humanEndedAt ? [] : candidates(board),
        ...(humanEndedAt ? { humanEndedAt, message: '这个会话绑定的执行已由人在看板结束；只读上下文仍可查看，后续工作请使用新的宿主会话。' } : {}),
      };
    },

    async attach(request) {
      onlyKeys(request, ['boardInstanceId', 'session', 'clientOperationId', 'expectedRevision', 'projectId', 'nodeId', 'create', 'nodeKey', 'recording', 'confirmRebind']);
      assertInstance(store, request.boardInstanceId);
      const session = normalizeSession(request.session);
      const id = operationId(request.clientOperationId);
      if (request.projectId !== undefined && request.create !== undefined) throw new BoardError('projectId 与 create 只能提供一个。');
      if (request.recording !== undefined && typeof request.recording !== 'boolean') throw new BoardError('记录开关格式不正确。');
      if (request.confirmRebind !== undefined && typeof request.confirmRebind !== 'boolean') throw new BoardError('重新关联确认格式不正确。');
      if (request.nodeKey !== undefined && request.create === undefined) throw new BoardError('nodeKey 只能用于本次新建的节点。');
      const create = request.create === undefined ? undefined : validateCreate(request.create);
      if (request.nodeKey !== undefined && !create.nodes.some(node => node.key === request.nodeKey)) throw new BoardError('nodeKey 不属于本次创建的节点。');
      const hash = requestHash('attach', request, session);

      return store.transact(board => {
        const replay = existingOperation(board, { id, kind: 'attach', hash, session, expectedRevision: request.expectedRevision });
        if (replay) return { result: structuredClone(replay) };
        assertExpectedRevision(request.expectedRevision, board.revision);
        let binding = findBinding(board, session);
        assertSessionNotHumanEnded(board, session, binding);
        const hasTarget = request.projectId !== undefined || request.nodeId !== undefined || create !== undefined;
        const requestedNode = request.nodeId === undefined ? null : nodeById(board, requiredText(request.nodeId, '节点 ID', 100));
        const requestedProjectId = request.projectId ?? requestedNode?.projectId;
        const sameProjectTarget = Boolean(binding && !create && requestedProjectId === binding.projectId);
        const targetIsCurrent = Boolean(binding && sameProjectTarget && requestedNode?.id === binding.nodeId)
          || Boolean(binding && sameProjectTarget && request.nodeId === undefined && binding.nodeId === undefined);
        if (binding && hasTarget && !sameProjectTarget && !request.confirmRebind) {
          throw bindingConflict(
            board,
            binding,
            '切换到其他项目需要用户确认。确认后请重新关联。',
            '用户确认跨项目切换后，使用 confirmRebind: true 重试。',
          );
        }
        if (binding && hasTarget && !targetIsCurrent && activeBoundRun(board, binding)) {
          throw bindingConflict(
            board,
            binding,
            '当前节点仍有未结束执行，不能切换绑定。',
            '先完成实际交付；若宿主确已停止，则记录停止。结束后可直接关联同项目节点，跨项目仍需用户确认。',
          );
        }
        if (!binding && !hasTarget) throw bindingConflict(board, null, '这个会话尚未关联项目，请明确选择或新建。');
        const applyTarget = !binding || Boolean(hasTarget && !targetIsCurrent && (sameProjectTarget || request.confirmRebind === true));

        const originalRevision = board.revision;
        const at = new Date().toISOString();
        let projectId = binding?.projectId;
        let nodeId = binding?.nodeId;
        let created = false;
        let nodeIdsByKey;

        if (create && applyTarget) {
          board = applyChange(board, { type: 'project.create', title: create.title, summary: create.summary, conversationRef: `${session.host}:${session.profileId}:${session.sessionId}`, coordinator: session.host });
          projectId = board.projects.at(-1).id;
          nodeIdsByKey = {};
          for (const item of create.nodes) {
            board = applyChange(board, { type: 'node.create', projectId, title: item.title });
            const createdNode = board.nodes.at(-1);
            nodeIdsByKey[item.key] = createdNode.id;
            const patch = {};
            if (item.goal !== undefined) patch.goal = item.goal;
            if (item.next !== undefined) patch.next = item.next;
            if (Object.keys(patch).length) board = applyChange(board, { type: 'node.update', id: createdNode.id, patch });
          }
          for (const item of create.nodes) for (const dependency of item.dependsOn) {
            board = applyChange(board, { type: 'edge.create', projectId, source: nodeIdsByKey[dependency], target: nodeIdsByKey[item.key] });
          }
          nodeId = request.nodeKey === undefined ? undefined : nodeIdsByKey[request.nodeKey];
          created = true;
        } else if (hasTarget && applyTarget) {
          if (request.nodeId !== undefined) {
            const node = nodeById(board, requiredText(request.nodeId, '节点 ID', 100));
            if (request.projectId !== undefined && node.projectId !== request.projectId) throw new BoardError('节点不属于指定项目。');
            projectId = node.projectId;
            nodeId = node.id;
          } else {
            projectId = requiredText(request.projectId, '项目 ID', 100);
            nodeId = undefined;
          }
          const project = projectById(board, projectId);
          if (project.archived) throw new BoardError('不能关联已归档项目。');
          if (nodeId && nodeById(board, nodeId).archived) throw new BoardError('不能关联已归档节点。');
        }

        board.agentBindings ??= [];
        if (!binding) {
          binding = { id: `b-${randomUUID()}`, ...sessionIdentity(session), projectId, ...(nodeId ? { nodeId } : {}), recording: request.recording ?? true, createdAt: at, updatedAt: at };
          board.agentBindings.push(binding);
        } else {
          binding = board.agentBindings.find(item => item.id === binding.id);
          if (applyTarget) {
            binding.projectId = projectId;
            if (nodeId) binding.nodeId = nodeId;
            else delete binding.nodeId;
            delete binding.runId;
          }
          if (request.recording !== undefined) binding.recording = request.recording;
          binding.updatedAt = at;
        }
        if (board.revision === originalRevision) board.revision++;
        let outcome = {
          boardInstanceId: store.boardInstanceId,
          revision: board.revision,
          committed: true,
          clientOperationId: id,
          operationKind: 'attach',
          binding: publicBinding(binding),
          ...(created ? { created: true, nodeIdsByKey } : {}),
        };
        outcome = addOperation(board, { id, kind: 'attach', hash, session, outcome, at, baseRevision: request.expectedRevision });
        validateBoard(board);
        return { next: board, result: structuredClone(outcome) };
      });
    },

    async context(request) {
      onlyKeys(request, ['boardInstanceId', 'session', 'nodeId', 'projectId']);
      assertInstance(store, request.boardInstanceId);
      const session = normalizeSession(request.session);
      const board = await store.read();
      const binding = findBinding(board, session);
      const tombstone = findHumanEndedSession(board, session);
      if (!binding && tombstone) {
        const message = '这个会话绑定的执行已由人在看板结束，原工作上下文已不存在；后续工作请使用新的宿主会话重新关联。';
        return { boardInstanceId: store.boardInstanceId, revision: board.revision, binding: null, humanEndedAt: tombstone.endedAt, message, markdown: `# 会话已由人在看板结束\n\n${message}` };
      }
      if (!binding) throw new BoardError('这个会话尚未关联项目。', 404, { code: 'binding-not-found', candidates: candidates(board) });
      let nodeId = request.nodeId;
      let projectId = request.projectId;
      if (nodeId !== undefined && projectId !== undefined) throw new BoardError('请只指定一个节点或项目。');
      if (nodeId !== undefined) {
        const node = nodeById(board, requiredText(nodeId, '节点 ID', 100));
        if (node.projectId !== binding.projectId) throw new BoardError('上下文不属于这个会话绑定的项目。', 409, { code: 'binding-scope-conflict' });
      } else if (projectId !== undefined) {
        projectId = requiredText(projectId, '项目 ID', 100);
        if (projectId !== binding.projectId) throw new BoardError('上下文不属于这个会话绑定的项目。', 409, { code: 'binding-scope-conflict' });
      } else if (binding.nodeId) nodeId = binding.nodeId;
      else projectId = binding.projectId;
      const context = buildContext(board, { node: nodeId, project: projectId, attachmentPath: attachment => store.attachmentPath(attachment) });
      const humanEndedAt = tombstone?.endedAt ?? binding.humanEndedAt;
      return { boardInstanceId: store.boardInstanceId, ...context, binding: publicBinding(binding), ...(humanEndedAt ? { humanEndedAt, message: '这个会话绑定的执行已由人在看板结束；当前内容仅供读取，后续工作请使用新的宿主会话。' } : {}) };
    },

    async change(request) {
      onlyKeys(request, ['boardInstanceId', 'session', 'clientOperationId', 'expectedRevision', 'change']);
      assertInstance(store, request.boardInstanceId);
      const session = normalizeSession(request.session);
      const id = operationId(request.clientOperationId);
      const hash = requestHash('change', request, session);
      return store.transact(board => {
        const replay = existingOperation(board, { id, kind: 'change', hash, session, expectedRevision: request.expectedRevision });
        if (replay) return { result: structuredClone(replay) };
        let binding = findBinding(board, session);
        const obstacle = Number.isSafeInteger(request.expectedRevision) && request.expectedRevision !== board.revision
          ? currentDeliveryObstacle(board, binding, request.change)
          : null;
        assertExpectedRevision(request.expectedRevision, board.revision, false, obstacle ? { currentObstacle: obstacle } : undefined);
        assertSessionNotHumanEnded(board, session, binding);
        if (!binding) throw new BoardError('这个会话尚未关联项目。', 404, { code: 'binding-not-found', candidates: candidates(board) });
        ensureBindingScope(board, binding, session, request.change);
        const next = applyChange(board, request.change.type === 'node.start' ? prepareAgentChange(request.change) : request.change);
        binding = (next.agentBindings ?? []).find(item => item.id === binding.id);
        if (request.change.type === 'node.start') {
          const node = nodeById(next, request.change.id);
          const run = node.executions.at(-1);
          binding.nodeId = node.id;
          binding.runId = run.id;
          binding.updatedAt = new Date().toISOString();
        }
        let outcome = {
          boardInstanceId: store.boardInstanceId,
          revision: next.revision,
          committed: true,
          clientOperationId: id,
          operationKind: 'change',
          changeType: request.change.type,
          binding: publicBinding(binding),
          saved: structuredClone(savedRecord(next, request.change)),
        };
        if (binding?.runId) outcome.runId = binding.runId;
        outcome = addOperation(next, { id, kind: 'change', hash, session, outcome, at: new Date().toISOString(), baseRevision: request.expectedRevision });
        validateBoard(next);
        return { next, result: structuredClone(outcome) };
      });
    },

    async takeover(request) {
      onlyKeys(request, ['boardInstanceId', 'session', 'clientOperationId', 'expectedRevision', 'nodeId', 'previousRunId', 'reason', 'confirmation', 'model', 'modelSource', 'owner', 'executionRef']);
      assertInstance(store, request.boardInstanceId);
      const session = normalizeSession(request.session);
      const id = operationId(request.clientOperationId);
      const nodeId = requiredText(request.nodeId, '节点 ID', 100);
      const previousRunId = requiredText(request.previousRunId, '原运行 ID', 100);
      const reason = requiredText(request.reason, '接管停止原因', 20000);
      if (!['host-observed', 'user-confirmed'].includes(request.confirmation)) throw new BoardError('接管停止确认来源不正确。');
      const hash = requestHash('takeover', request, session);
      return store.transact(board => {
        const replay = existingOperation(board, { id, kind: 'takeover', hash, session, expectedRevision: request.expectedRevision });
        if (replay) return { result: structuredClone(replay) };
        assertExpectedRevision(request.expectedRevision, board.revision);
        let binding = findBinding(board, session);
        assertSessionNotHumanEnded(board, session, binding);
        if (!binding) throw new BoardError('这个会话尚未关联项目。', 404, { code: 'binding-not-found', candidates: candidates(board) });
        if (!binding.recording) throw new BoardError('这个会话已停用工作记录。', 403, { code: 'recording-disabled' });
        const node = nodeById(board, nodeId);
        if (binding.projectId !== node.projectId || binding.nodeId !== node.id) throw new BoardError('接管目标不属于这个会话绑定的节点。', 409, { code: 'binding-scope-conflict', binding: publicBinding(binding) });
        if (binding.runId !== undefined && binding.runId !== previousRunId) throw new BoardError('当前会话绑定的运行与待接管运行不一致。', 409, { code: 'stale-run', binding: publicBinding(binding) });
        const previousRun = (node.executions ?? []).at(-1);
        if (!previousRun || previousRun.id !== previousRunId || previousRun.endedAt !== undefined) throw new BoardError('待接管运行不是节点最新的活动执行。', 409, { code: 'takeover-conflict', currentRunId: previousRun?.endedAt === undefined ? previousRun.id : null });

        const stoppedAt = new Date().toISOString();
        Object.assign(previousRun, { endedAt: stoppedAt, outcome: 'stopped' });
        Object.assign(node, { status: 'blocked', progress: reason, updatedAt: stoppedAt });
        const next = applyChange(board, prepareAgentChange({
          type: 'node.start',
          id: node.id,
          executionRef: request.executionRef,
          owner: request.owner,
          model: request.model,
          modelSource: request.modelSource,
        }));
        const savedNode = nodeById(next, node.id);
        const newRun = savedNode.executions.at(-1);
        const stoppedRun = savedNode.executions.find(run => run.id === previousRunId);
        Object.assign(stoppedRun, { stoppedReason: reason, stopConfirmation: request.confirmation, stoppedByRunId: newRun.id });
        binding = (next.agentBindings ?? []).find(item => item.id === binding.id);
        binding.nodeId = savedNode.id;
        binding.runId = newRun.id;
        binding.updatedAt = newRun.startedAt;
        let outcome = {
          boardInstanceId: store.boardInstanceId,
          revision: next.revision,
          committed: true,
          clientOperationId: id,
          operationKind: 'takeover',
          binding: publicBinding(binding),
          previousRunId,
          runId: newRun.id,
          saved: structuredClone(savedNode),
        };
        outcome = addOperation(next, { id, kind: 'takeover', hash, session, outcome, at: newRun.startedAt, baseRevision: request.expectedRevision });
        validateBoard(next);
        return { next, result: structuredClone(outcome) };
      });
    },

    async operation(request) {
      if (typeof request === 'string') throw new BoardError('查询操作结果需要提供看板实例与宿主会话。');
      onlyKeys(request, ['boardInstanceId', 'session', 'clientOperationId']);
      assertInstance(store, request.boardInstanceId);
      const session = normalizeSession(request.session);
      const id = operationId(request.clientOperationId);
      const board = await store.read();
      const operation = (board.agentOperations ?? []).find(item => item.id === id && sameSession(item.session, session));
      if (operation) return structuredClone(compactOutcome(operation));
      if (Number.isSafeInteger(board.agentOperationReplayFloorRevision)) {
        return { state: 'unknown', replayFloorRevision: board.agentOperationReplayFloorRevision };
      }
      return null;
    },
  };
}
