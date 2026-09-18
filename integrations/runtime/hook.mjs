import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isMainModule } from './client.mjs';
import { readSessionState, sessionStateKey, updateSessionState } from './session-state.mjs';

export { sessionStateKey, sessionStateFile, readSessionState, writeSessionState, updateSessionState } from './session-state.mjs';

const CONTEXT_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'SubagentStart']);
const HOOK_NETWORK_BUDGET_MS = 2000;
const OFFLINE_COOLDOWN_MS = 60000;
const PROGRESS_REMINDER_MS = 10 * 60 * 1000;
const PROGRESS_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreCompact', 'PostToolUse', 'Stop']);
const STAGE_CHECK = '关键阶段（诊断结论、实施转验证、验证结果、阻塞或决定变化、交接前）核对真实进展；有新事实才用 jarvisync_progress 写已完成、证据、剩余工作和下一步，无新事实不重复写。';

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function safeObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}


export function normalizeHookInput(rawInput, configuredHost, configuredProfileId) {
  const raw = safeObject(rawInput);
  const host = text(configuredHost) || text(raw.host) || 'unknown-host';
  const event = text(raw.hook_event_name) || text(raw.event) || 'Unknown';
  const emittedSessionId = text(raw.session_id) || text(raw.sessionId);
  const parentSessionId = event === 'SubagentStart'
    ? text(raw.parent_session_id) || text(raw.parentSessionId) || emittedSessionId
    : emittedSessionId;
  const profileId = text(configuredProfileId) || text(raw.profile_id) || text(raw.profileId) || 'default';
  if (!parentSessionId) throw new Error('Hook 未提供 session_id，无法安全关联会话。');

  const model = text(raw.model);
  const scope = text(raw.scope) || text(raw.agent_scope) || text(raw.task_scope) || null;
  const parentSession = { host, profileId, sessionId: parentSessionId };
  // Codex sends the parent session_id to SubagentStart.  An agent reference is
  // therefore namespaced below that parent rather than ever being used as the
  // parent session itself.  The explicit child_* fields are accepted for hosts
  // that expose a true child-session reference; Codex currently documents
  // agent_id as its available subagent identifier.
  const childSessionId = event === 'SubagentStart' ? text(raw.child_session_id) || text(raw.childSessionId) : null;
  const childRef = event === 'SubagentStart'
    ? childSessionId || text(raw.child_id) || text(raw.childId) || text(raw.agent_id) || text(raw.agentId)
    : null;
  const isolatedChildSessionId = childSessionId || (childRef
    ? `subagent:${createHash('sha256').update(`${parentSessionId}\u0000${childRef}`).digest('hex')}`
    : null);
  return {
    session: isolatedChildSessionId ? { host, profileId, sessionId: isolatedChildSessionId } : parentSession,
    parentSession,
    event,
    cwd: text(raw.cwd) || null,
    turnId: text(raw.turn_id) || text(raw.turnId) || null,
    model,
    modelSource: model ? 'host' : 'host-unavailable',
    source: text(raw.source) || text(raw.trigger) || null,
    agent: {
      id: text(raw.agent_id) || text(raw.agentId) || null,
      type: text(raw.agent_type) || text(raw.agentType) || null,
      scope,
      childRef,
      childSessionId,
    },
    terminal: {
      completed: raw.completed === true,
      failed: raw.failed === true,
      interrupted: raw.interrupted === true,
    },
  };
}

async function defaultLoadConnection(configPath) {
  const { loadConnection } = await import('./client.mjs');
  return loadConnection(configPath);
}

async function defaultCreateClient(config, options) {
  const { createClient } = await import('./client.mjs');
  return createClient(config, options);
}

function hookRuntimeFile(config) {
  return join(resolve(config.stateDir), 'hook-runtime.json');
}

async function readHookRuntime(config) {
  try { return JSON.parse(await readFile(hookRuntimeFile(config), 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return {}; throw error; }
}

async function writeHookRuntime(config, state) {
  const path = hookRuntimeFile(config);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temporary, 'wx');
    try { await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`); await handle.sync(); }
    finally { await handle.close(); }
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}

function pendingKey(pending) {
  if (!pending.length) return null;
  return createHash('sha256').update(JSON.stringify(pending.map((item) => ({
    id: item?.clientOperationId || item?.id || null,
    state: item?.state || item?.status || null,
  })))).digest('hex');
}

async function pendingOperations(config, session) {
  const pendingDir = join(resolve(config.stateDir), 'pending');
  const names = await readdir(pendingDir).catch(() => []);
  const pending = await Promise.all(names.filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(async (name) => {
    try { return JSON.parse(await readFile(join(pendingDir, name), 'utf8')); } catch { return null; }
  }));
  return pending.filter(item => item?.body?.session?.host === session.host
    && item.body.session.profileId === session.profileId && item.body.session.sessionId === session.sessionId);
}

function bindingText(binding) {
  const item = safeObject(binding);
  const description = text(item.context) || text(item.contextMarkdown) || text(item.summary);
  if (description) return description;
  if (text(item.projectId)) {
    const parts = [`已关联项目 ${item.projectId}`];
    if (text(item.nodeId)) parts.push(`节点 ${item.nodeId}`);
    if (text(item.runId)) parts.push(`执行 ${item.runId}`);
    parts.push(item.recording === false ? '记录已停用' : '记录已启用');
    return `${parts.join('；')}。`;
  }
  return '尚未绑定项目；仅在用户明确交办工作后再关联。';
}

function truncateContext(value) {
  const marker = '……需用 jarvisync_context 读取完整上下文。';
  const source = text(value) || '';
  return source.length > 650 ? `${source.slice(0, 650 - marker.length)}${marker}` : source;
}

function contextFor(input, { binding, directContext, parentBinding, interrupted = false, resumedFromInterrupt = false } = {}) {
  const id = input.session.sessionId;
  if (input.event === 'SubagentStart') {
    const parentScope = bindingText(parentBinding);
    const modelState = input.model ? `宿主本次报告的实际模型为 ${input.model}。` : '宿主未提供实际模型，记录为 host-unavailable，不得猜测。';
    return `JarviSync 子 Agent 会话 ${id}。父会话范围：${parentScope}\n`
      + `子 Agent 范围：${input.agent.scope || '宿主未提供；先向父任务核对，不要猜测。'}。仅把父范围作为参考；不得使用父会话 ID、沿用父项目/节点/执行绑定，或写入父执行。`
      + `此子会话尚未关联项目。只有父 Agent 明确传递节点后，才用这个子会话 ID 读取并显式关联；否则不写回。${modelState}`;
  }
  const markdown = text(directContext?.markdown);
  const nodeSection = markdown?.indexOf('## 当前节点：');
  const focused = binding?.nodeId && nodeSection >= 0 ? markdown.slice(nodeSection) : markdown;
  const identity = binding?.nodeId ? `项目 ${binding.projectId}；节点 ${binding.nodeId}；执行 ${binding.runId || '尚未开始'}。` : bindingText(binding);
  const scope = directContext ? `${identity}\n${truncateContext(focused)}` : bindingText(binding);
  const modelState = input.model ? `宿主本次报告的实际模型为 ${input.model}。` : '宿主未提供实际模型，记录为 host-unavailable，不得猜测。';
  const interruptionState = interrupted
    ? '当前会话仍标记为已中断；等待新的正常用户请求后再写回。'
    : resumedFromInterrupt ? '本次正常用户请求已清除此前的中断状态。' : '';
  return `JarviSync 会话 ${id}：${scope}\n`
    + '普通问答和未确认想法不建档；用户说不记录时不写回。明确工作才读取或关联项目，并在实际开始、关键进展、受阻或明确交付时写回。所有 MCP 调用必须带此 sessionId。'
    + `${STAGE_CHECK}Stop/SessionEnd 不是交付；不要自动 deliver、重启或无限续跑。${modelState}${interruptionState}`;
}

function injectionKey({ input, binding, parentBinding, recordingDisabled, interrupted }) {
  return createHash('sha256').update(JSON.stringify({
    binding: bindingText(binding),
    parentBinding: input.event === 'SubagentStart' ? bindingText(parentBinding) : null,
    recordingDisabled,
    model: input.model,
    modelSource: input.modelSource,
    interrupted,
    agentScope: input.event === 'SubagentStart' ? input.agent.scope : null,
  })).digest('hex');
}

function hookOutput(event, additionalContext, systemMessage) {
  const output = {};
  if (additionalContext) {
    output.hookSpecificOutput = { hookEventName: event, additionalContext };
  }
  if (systemMessage) output.systemMessage = systemMessage;
  return Object.keys(output).length ? output : null;
}

export async function runHook({
  rawInput,
  configPath,
  configuredHost,
  loadConnection = defaultLoadConnection,
  createClient = defaultCreateClient,
  now = () => new Date().toISOString(),
  clock = () => Date.now(),
  networkBudgetMs = HOOK_NETWORK_BUDGET_MS,
  offlineCooldownMs = OFFLINE_COOLDOWN_MS,
} = {}) {
  const config = await loadConnection(configPath);
  const input = normalizeHookInput(rawInput, configuredHost || config.host, config.profileId);
  if (input.event === 'SubagentStart' && !input.agent.childRef) {
    const additionalContext = 'JarviSync：宿主只提供了父会话 ID，未提供独立子 Agent 标识。不得使用父会话 ID 调用 JarviSync、沿用父项目/节点/执行绑定或写回父执行。请等待子会话入口，或由父 Agent 明确传递节点后再显式关联。';
    return { input, state: null, output: hookOutput(input.event, additionalContext, null) };
  }
  const previous = await readSessionState(config, input.session);
  if (input.event === 'Interrupt') {
    // Publish the interruption before any network wait. A prompt may clear only
    // the generation it observed on entry, never a later interruption.
    await updateSessionState(config, input.session, current => ({
      ...current, interrupted: true, interruptionGeneration: randomUUID(), progressCheckpoint: null,
    }));
  }
  if (input.event === 'PostToolUse') {
    if (!previous?.binding?.runId || (!previous.progressCheckpoint && !previous.connectionError) || previous.binding.recording !== true
        || previous.binding.humanEndedAt || previous.interrupted || previous.recordingDisabled
        || previous.explicitRecordingOverride === false
        || (previous.lastProgressPollAt && clock() - Date.parse(previous.lastProgressPollAt) < 60000)) {
      return { input, state: previous, output: null };
    }
    // Tool output is only a chance to check, never a progress fact. Reserve the
    // polling slot independently of updatedAt so frequent tools cannot defer it.
    let poll = false;
    const state = await updateSessionState(config, input.session, current => {
      if (!current?.binding?.runId || (!current.progressCheckpoint && !current.connectionError) || current.binding.recording !== true
          || current.binding.humanEndedAt || current.interrupted || current.recordingDisabled
          || current.explicitRecordingOverride === false
          || (current.lastProgressPollAt && clock() - Date.parse(current.lastProgressPollAt) < 60000)) return current;
      poll = true;
      return { ...current, lastProgressPollAt: now() };
    });
    if (!poll) return { input, state, output: null };
  }
  const runtime = await readHookRuntime(config);
  let discovery = null;
  let status = null;
  let directContext = null;
  let parentBinding = null;
  let connectionError = null;
  let connectionStatus = 0;
  let skippedForExplicitDisable = false;
  const offlineUntil = Number.isFinite(runtime.offlineUntil) ? runtime.offlineUntil : 0;
  if (previous?.explicitRecordingOverride === false) {
    skippedForExplicitDisable = true;
  } else if (offlineUntil > clock()) {
    connectionError = 'hook-offline-cooldown';
  } else {
    const controller = new AbortController();
    let timedOut = false;
    let timeout;
    const deadline = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error('hook-network-timeout'));
      }, Math.max(1, networkBudgetMs));
    });
    try {
      await Promise.race([
        (async () => {
          const client = await createClient(config, {
            autoStart: false,
            cacheEnsure: true,
            healthTimeoutMs: Math.min(750, Math.max(1, networkBudgetMs)),
            requestTimeoutMs: Math.max(1, networkBudgetMs),
            signal: controller.signal,
          });
          discovery = await client.discover(input.session);
          if (input.event === 'SubagentStart') {
            const parent = await client.discover(input.parentSession);
            parentBinding = parent?.binding ?? null;
          }
          if (['SessionStart', 'UserPromptSubmit', 'SubagentStart', 'Stop', 'Interrupt', 'SessionEnd', 'Checkpoint'].includes(input.event)) {
            await client.request('event', {
              session: input.session,
              event: input.event,
              ...(input.turnId ? { turnId: input.turnId } : {}),
              model: input.model,
              modelSource: input.modelSource,
            });
          }
          if (CONTEXT_EVENTS.has(input.event) || PROGRESS_EVENTS.has(input.event) || input.event === 'ProgressCheck') {
            status = await client.request('status', { session: input.session });
            status = { ...status, binding: discovery?.binding ?? null };
          }
          if (input.event === 'SessionStart' && discovery?.binding?.recording === true) {
            directContext = await client.context({ session: input.session });
          }
        })(),
        deadline,
      ]);
    } catch (error) {
      connectionError = timedOut ? 'hook-network-timeout' : text(error?.message) || 'local-service-unavailable';
      connectionStatus = Number.isInteger(error?.status) ? error.status : 0;
    } finally {
      clearTimeout(timeout);
    }
    if (connectionError && connectionStatus === 0) {
      await writeHookRuntime(config, { offlineUntil: clock() + Math.max(0, offlineCooldownMs), reason: connectionError, updatedAt: now() });
    } else if (offlineUntil) {
      await writeHookRuntime(config, { offlineUntil: 0, reason: null, updatedAt: now() });
    }
  }
  const interrupted = input.event === 'UserPromptSubmit'
    ? false
    : Boolean(input.event === 'Interrupt' || previous?.interrupted === true || status?.session?.interrupted === true);
  const explicitRecordingOverride = typeof previous?.explicitRecordingOverride === 'boolean' ? previous.explicitRecordingOverride : null;
  const recordingDisabled = skippedForExplicitDisable
    || explicitRecordingOverride === false
    || connectionStatus === 403
    || discovery?.binding?.recording === false
    || (connectionError ? previous?.recordingDisabled === true : false);
  const reminder = input.event === 'Stop' ? pendingKey(await pendingOperations(config, input.session)) : null;
  const shouldRemind = !recordingDisabled && reminder && previous?.stopReminderKey !== reminder;
  const binding = discovery ? discovery.binding ?? null : previous?.binding ?? null;
  // A successful live read is required: old/offline state must never imply active work.
  const progressCheckpoint = !connectionError && !recordingDisabled && !interrupted
    ? status && Object.hasOwn(status, 'progressCheckpoint') ? status.progressCheckpoint
      : discovery?.progressCheckpoint ?? directContext?.progressCheckpoint ?? null : null;
  const progressKey = progressCheckpoint?.reminderDue === true && binding?.recording === true
    && binding.runId === progressCheckpoint.runId && binding.nodeId === progressCheckpoint.nodeId
    ? `${progressCheckpoint.runId}:${progressCheckpoint.lastProgressAt}` : null;
  // PreCompact refreshes the cache only. Its output is not a verified model-input
  // channel (Claude discards systemMessage); resume/compact SessionStart delivers it.
  const progressReminder = PROGRESS_EVENTS.has(input.event) && input.event !== 'PreCompact' && progressKey
    && previous?.progressReminderKey !== progressKey
    && (!previous?.progressReminderAt || clock() - Date.parse(previous.progressReminderAt) >= PROGRESS_REMINDER_MS);
  const progressNotice = progressReminder
    ? `JarviSync：当前执行已一段时间没有进展记录，请核对是否已有关键阶段成果。${STAGE_CHECK}不会自动写入、交付、重启或继续本回合。` : null;
  const key = injectionKey({ input, binding, parentBinding, recordingDisabled, interrupted });
  const resumedFromInterrupt = input.event === 'UserPromptSubmit' && previous?.interrupted === true;
  const disabledNotice = discovery?.binding?.recording === false
    ? `JarviSync 会话 ${input.session.sessionId}：${bindingText(discovery.binding)}\n此会话记录已停用；不要调用 JarviSync 写入，继续正常处理用户请求。`
    : 'JarviSync 自动记录当前已停用或未获授权；不要调用 JarviSync 写入，继续正常处理用户请求。';
  const shouldInjectContext = CONTEXT_EVENTS.has(input.event)
    && (input.event === 'SessionStart' || resumedFromInterrupt || previous?.lastInjectionKey !== key);
  let additionalContext = shouldInjectContext
    ? recordingDisabled ? disabledNotice : contextFor(input, { binding, directContext, parentBinding, interrupted, resumedFromInterrupt })
    : null;
  const modelNotice = CONTEXT_EVENTS.has(input.event) || input.event === 'PostToolUse';
  if (progressNotice && modelNotice) additionalContext = [additionalContext, progressNotice].filter(Boolean).join('\n');
  const stateChanged = previous?.lastInjectionKey !== key;
  const lifecycleNotice = input.event === 'Interrupt' && stateChanged
    ? 'JarviSync 已记录当前会话中断；在下一次正常用户请求前不要写回。'
    : null;
  const systemMessage = recordingDisabled && !CONTEXT_EVENTS.has(input.event) && stateChanged
    ? disabledNotice
    : lifecycleNotice || (progressNotice && !modelNotice ? progressNotice : null)
      || (shouldRemind ? 'JarviSync 有待补的协作记录；请在下次正常对话中核对。不会自动交付或继续本回合。' : null);
  let state = {
    schemaVersion: 1,
    boardInstanceId: text(config.boardInstanceId) || null,
    host: input.session.host,
    profileId: input.session.profileId,
    sessionKey: sessionStateKey(input.session),
    binding,
    lastCheckpoint: status?.session?.lastCheckpoint ?? previous?.lastCheckpoint ?? null,
    model: input.model,
    modelSource: input.modelSource,
    lastEvent: input.event,
    lastTurnId: input.turnId,
    lastAgent: input.agent,
    updatedAt: now(),
    stopReminderKey: shouldRemind ? reminder : previous?.stopReminderKey ?? null,
    progressCheckpoint,
    progressObservedAt: connectionError ? null : now(),
    progressReminderKey: progressReminder ? progressKey : previous?.progressReminderKey ?? null,
    progressReminderAt: progressReminder ? now() : previous?.progressReminderAt ?? null,
    connectionError,
    connectionStatus,
    interrupted,
    recordingDisabled,
    explicitRecordingOverride,
    lastInjectionKey: additionalContext || systemMessage ? key : previous?.lastInjectionKey ?? null,
  };
  let suppressOutput = false;
  state = await updateSessionState(config, input.session, current => {
    const newerBinding = Number.isSafeInteger(current?.bindingRevision)
      && (!Number.isSafeInteger(discovery?.revision) || current.bindingRevision > discovery.revision);
    const interruptedNow = current?.interrupted === true && (input.event !== 'UserPromptSubmit'
      || current.interruptionGeneration !== previous?.interruptionGeneration);
    const disabledNow = current?.explicitRecordingOverride === false || current?.binding?.humanEndedAt;
    suppressOutput = Boolean(newerBinding || interruptedNow && !interrupted || disabledNow && !recordingDisabled);
    return {
      ...state,
      ...(newerBinding ? { binding: current.binding, progressCheckpoint: current.progressCheckpoint,
        progressObservedAt: current.progressObservedAt } : {}),
      bindingRevision: newerBinding ? current.bindingRevision : discovery?.revision ?? current?.bindingRevision,
      interrupted: interruptedNow || state.interrupted,
      interruptionGeneration: current?.interruptionGeneration ?? previous?.interruptionGeneration ?? null,
      ...(interruptedNow || disabledNow ? { progressCheckpoint: null } : {}),
      ...(suppressOutput ? { progressReminderKey: current?.progressReminderKey ?? null,
        progressReminderAt: current?.progressReminderAt ?? null } : {}),
      lastProgressPollAt: current?.lastProgressPollAt ?? null,
      explicitRecordingOverride: typeof current?.explicitRecordingOverride === 'boolean'
        ? current.explicitRecordingOverride : state.explicitRecordingOverride,
    };
  });

  return { input, state, output: suppressOutput ? null : hookOutput(input.event, additionalContext, systemMessage) };
}

async function readStdin() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function option(name, args = process.argv) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

export function connectionOption(args = process.argv) {
  return option('--connection', args) || option('--config', args);
}

if (isMainModule(import.meta.url)) {
  try {
    const result = await runHook({
      rawInput: await readStdin(),
      configPath: connectionOption(),
      configuredHost: option('--host'),
    });
    if (result.output) process.stdout.write(`${JSON.stringify(result.output)}\n`);
  } catch {
    // Lifecycle observation must not block a user task when the local service is unavailable.
  }
}
