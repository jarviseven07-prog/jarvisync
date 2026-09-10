import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/index.mjs';
import { createClient } from '../integrations/runtime/client.mjs';
import { connectionOption, normalizeHookInput, readSessionState, runHook, sessionStateFile, updateSessionState, writeSessionState } from '../integrations/runtime/hook.mjs';

async function isolated(run) {
  const stateDir = await mkdtemp(join(tmpdir(), 'jarvisync-agent-hooks-'));
  try {
    await run({ stateDir, config: {
      url: 'http://127.0.0.1:4317', boardInstanceId: 'test-board', dataDir: stateDir,
      stateDir, host: 'codex', profileId: 'test-profile',
    } });
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

function fakeClient({ pendingOps = [], binding = { summary: '接续测试项目。' }, context = null } = {}) {
  const calls = [];
  return {
    calls,
    setBinding(value) { binding = value; },
    async discover(session) { calls.push(['discover', session]); return { binding }; },
    async request(action, body) {
      calls.push([action, body]);
      if (action === 'status') return { binding, pendingOps, lastCheckpoint: { summary: '最近检查点。' } };
      return { accepted: true };
    },
    async context(body) {
      calls.push(['context', body]);
      return context || { markdown: '当前绑定的直接范围。', binding };
    },
  };
}

test('会话启动只保存宿主元数据并注入短协作约定', async () => isolated(async ({ config }) => {
  const client = fakeClient();
  const result = await runHook({
    rawInput: { hook_event_name: 'SessionStart', session_id: 'thread-a', cwd: 'C:/work', model: 'gpt-test', source: 'resume' },
    loadConnection: async () => config,
    createClient: async () => client,
    now: () => '2026-09-10T00:00:00.000Z',
  });
  assert.equal(result.input.model, 'gpt-test');
  assert.equal(result.input.modelSource, 'host');
  assert.match(result.output.hookSpecificOutput.additionalContext, /thread-a/);
  assert.match(result.output.hookSpecificOutput.additionalContext, /普通问答/);
  const event = client.calls.find(([name]) => name === 'event')[1];
  assert.equal(event.event, 'SessionStart');
  assert.equal('prompt' in event, false);
  assert.equal('transcript_path' in event, false);
  const state = await readSessionState(config, result.input.session);
  assert.equal(state.model, 'gpt-test');
  assert.equal(state.binding.summary, '接续测试项目。');
}));

test('子 Agent 使用独立会话标识，不会把父会话的绑定交给子 Agent 写入', async () => isolated(async ({ config }) => {
  const client = fakeClient();
  const result = await runHook({
    rawInput: {
      hook_event_name: 'SubagentStart', session_id: 'thread-b', agent_id: 'child-1', agent_type: 'review',
      task_scope: '只复核当前改动', prompt: '不能写入此处',
    },
    loadConnection: async () => config,
    createClient: async () => client,
  });
  assert.equal(result.input.model, null);
  assert.equal(result.input.modelSource, 'host-unavailable');
  assert.equal(result.input.agent.scope, '只复核当前改动');
  assert.equal(result.input.parentSession.sessionId, 'thread-b');
  assert.notEqual(result.input.session.sessionId, 'thread-b');
  assert.match(result.input.session.sessionId, /^subagent:[a-f0-9]{64}$/);
  const event = client.calls.find(([name]) => name === 'event')[1];
  assert.equal(event.event, 'SubagentStart');
  assert.equal(event.session.sessionId, result.input.session.sessionId);
  assert.equal(JSON.stringify(event).includes('不能写入此处'), false);
  assert.deepEqual(result.state.lastAgent, { id: 'child-1', type: 'review', scope: '只复核当前改动', childRef: 'child-1', childSessionId: null });
  assert.match(result.output.hookSpecificOutput.additionalContext, /不得使用父会话 ID/);
  assert.equal(client.calls.some(([name]) => name === 'attach' || name === 'change'), false);
}));

test('Hermes 子 Agent 保留宿主提供的真实 child session ID，并单独保留父会话', () => {
  const input = normalizeHookInput({
    hook_event_name: 'SubagentStart', session_id: 'hermes-child', parent_session_id: 'hermes-parent',
    child_session_id: 'hermes-child', agent_id: 'worker-1', agent_type: 'research', task_scope: '查资料',
  }, 'hermes', 'profile-hermes');
  assert.deepEqual(input.parentSession, { host: 'hermes', profileId: 'profile-hermes', sessionId: 'hermes-parent' });
  assert.deepEqual(input.session, { host: 'hermes', profileId: 'profile-hermes', sessionId: 'hermes-child' });
  assert.equal(input.agent.childSessionId, 'hermes-child');
});

test('没有独立子 Agent 标识时不访问或记录父会话', async () => isolated(async ({ config }) => {
  let created = false;
  const result = await runHook({
    rawInput: { hook_event_name: 'SubagentStart', session_id: 'parent-thread' },
    loadConnection: async () => config,
    createClient: async () => { created = true; throw new Error('不应建立客户端'); },
  });
  assert.equal(created, false);
  assert.equal(result.state, null);
  assert.match(result.output.hookSpecificOutput.additionalContext, /未提供独立子 Agent 标识/);
  assert.match(result.output.hookSpecificOutput.additionalContext, /不得使用父会话 ID/);
}));

test('已绑定启动读取直接范围；缺少摘要时仍注入项目、节点和执行标识', async () => isolated(async ({ config }) => {
  const binding = { projectId: 'project-9', nodeId: 'node-7', runId: 'run-5', recording: true };
  const client = fakeClient({ binding, context: { markdown: 'x'.repeat(1000), binding } });
  const result = await runHook({
    rawInput: { hook_event_name: 'SessionStart', session_id: 'bound-thread', source: 'resume' },
    loadConnection: async () => config,
    createClient: async () => client,
  });
  const injected = result.output.hookSpecificOutput.additionalContext;
  assert.equal(client.calls.filter(([name]) => name === 'context').length, 1);
  assert.match(injected, /需用 jarvisync_context 读取完整上下文/);
  assert.doesNotMatch(injected, /最近检查点/);
  assert.ok(injected.indexOf('x'.repeat(20)) >= 0);

  const noSummary = fakeClient({ binding: { projectId: 'project-9', nodeId: 'node-7', runId: 'run-5', recording: false } });
  const fallback = await runHook({
    rawInput: { hook_event_name: 'UserPromptSubmit', session_id: 'bound-no-summary' },
    loadConnection: async () => config,
    createClient: async () => noSummary,
  });
  assert.match(fallback.output.hookSpecificOutput.additionalContext, /已关联项目 project-9；节点 node-7；执行 run-5；记录已停用/);
}));

test('重复上下文不再反复注入，恢复、模型、绑定和 recording 变化仍会提示', async () => isolated(async ({ config }) => {
  const binding = { projectId: 'project-9', nodeId: 'node-7', runId: 'run-5', recording: true, summary: '当前范围。' };
  const client = fakeClient({ binding });
  const options = { loadConnection: async () => config, createClient: async () => client };
  const start = await runHook({ rawInput: { hook_event_name: 'SessionStart', session_id: 'dedupe-thread', model: 'model-a', source: 'resume' }, ...options });
  assert.match(start.output.hookSpecificOutput.additionalContext, /普通问答/);
  assert.match(start.output.hookSpecificOutput.additionalContext, /model-a/);

  const duplicate = await runHook({ rawInput: { hook_event_name: 'UserPromptSubmit', session_id: 'dedupe-thread', model: 'model-a' }, ...options });
  assert.equal(duplicate.output, null);

  const modelChanged = await runHook({ rawInput: { hook_event_name: 'UserPromptSubmit', session_id: 'dedupe-thread', model: 'model-b' }, ...options });
  assert.match(modelChanged.output.hookSpecificOutput.additionalContext, /model-b/);
  const sameModel = await runHook({ rawInput: { hook_event_name: 'UserPromptSubmit', session_id: 'dedupe-thread', model: 'model-b' }, ...options });
  assert.equal(sameModel.output, null);

  const interrupted = await runHook({ rawInput: { hook_event_name: 'Interrupt', session_id: 'dedupe-thread', model: 'model-b' }, ...options });
  assert.match(interrupted.output.systemMessage, /已记录当前会话中断/);
  const resumed = await runHook({ rawInput: { hook_event_name: 'UserPromptSubmit', session_id: 'dedupe-thread', model: 'model-b' }, ...options });
  assert.match(resumed.output.hookSpecificOutput.additionalContext, /已清除此前的中断状态/);

  binding.summary = '变更后的范围。';
  const rebound = await runHook({ rawInput: { hook_event_name: 'UserPromptSubmit', session_id: 'dedupe-thread', model: 'model-b' }, ...options });
  assert.match(rebound.output.hookSpecificOutput.additionalContext, /变更后的范围/);
  binding.recording = false;
  const disabled = await runHook({ rawInput: { hook_event_name: 'UserPromptSubmit', session_id: 'dedupe-thread', model: 'model-b' }, ...options });
  assert.match(disabled.output.hookSpecificOutput.additionalContext, /记录已停用/);
  const disabledDuplicate = await runHook({ rawInput: { hook_event_name: 'UserPromptSubmit', session_id: 'dedupe-thread', model: 'model-b' }, ...options });
  assert.equal(disabledDuplicate.output, null);

  binding.recording = true;
  const compact = await runHook({ rawInput: { hook_event_name: 'SessionStart', session_id: 'dedupe-thread', model: 'model-b', source: 'compact' }, ...options });
  assert.match(compact.output.hookSpecificOutput.additionalContext, /普通问答/);
  assert.match(compact.output.hookSpecificOutput.additionalContext, /所有 MCP 调用必须带此 sessionId/);

  client.setBinding(null);
  const detached = await runHook({ rawInput: { hook_event_name: 'UserPromptSubmit', session_id: 'dedupe-thread', model: 'model-b' }, ...options });
  assert.match(detached.output.hookSpecificOutput.additionalContext, /尚未绑定项目/);
  assert.equal(detached.state.binding, null);
}));

test('Hook 网络总时限后先落本地状态，冷却期跨会话跳过联网并可恢复', async () => isolated(async ({ config }) => {
  let clock = 1_000_000;
  let creates = 0;
  let capturedOptions;
  const never = new Promise(() => {});
  const slowFactory = async (_config, options) => {
    creates += 1;
    capturedOptions = options;
    return { discover: async () => never, request: async () => never };
  };
  const started = Date.now();
  const timedOut = await runHook({
    rawInput: { hook_event_name: 'SessionStart', session_id: 'offline-a', model: 'model-a' },
    loadConnection: async () => ({ ...config, autoStart: true, nodeExecutable: process.execPath, serverEntry: import.meta.filename }),
    createClient: slowFactory,
    clock: () => clock,
    networkBudgetMs: 25,
    offlineCooldownMs: 60_000,
  });
  assert.ok(Date.now() - started < 500, 'Hook 应在自身预算内返回');
  assert.equal(capturedOptions.autoStart, false);
  assert.equal(capturedOptions.cacheEnsure, true);
  assert.equal(capturedOptions.signal.aborted, true);
  assert.equal(timedOut.state.connectionError, 'hook-network-timeout');
  assert.match(timedOut.output.hookSpecificOutput.additionalContext, /普通问答/);
  assert.equal((await readSessionState(config, timedOut.input.session)).lastEvent, 'SessionStart');

  const cooldown = await runHook({
    rawInput: { hook_event_name: 'SessionStart', session_id: 'offline-b' },
    loadConnection: async () => config,
    createClient: async () => { creates += 1; throw new Error('冷却期不应创建客户端'); },
    clock: () => clock,
    networkBudgetMs: 25,
  });
  assert.equal(creates, 1, '冷却期内的新会话也不重复访问离线服务');
  assert.equal(cooldown.state.connectionError, 'hook-offline-cooldown');

  clock += 60_001;
  const recoveredClient = fakeClient();
  const recovered = await runHook({
    rawInput: { hook_event_name: 'UserPromptSubmit', session_id: 'offline-b', model: 'model-b' },
    loadConnection: async () => config,
    createClient: async (_config, options) => { creates += 1; capturedOptions = options; return recoveredClient; },
    clock: () => clock,
    networkBudgetMs: 100,
  });
  assert.equal(creates, 2);
  assert.equal(recovered.state.connectionError, null);
  assert.equal(capturedOptions.autoStart, false);
  assert.match(recovered.output.hookSpecificOutput.additionalContext, /model-b/);
}));

test('真实 Hook 客户端即使配置允许，也不会从生命周期回调自动拉起服务', async () => isolated(async ({ config }) => {
  const result = await runHook({
    rawInput: { hook_event_name: 'SessionStart', session_id: 'no-autostart' },
    loadConnection: async () => ({
      ...config,
      url: 'http://127.0.0.1:1',
      autoStart: true,
      nodeExecutable: process.execPath,
      serverEntry: import.meta.filename,
    }),
    networkBudgetMs: 500,
  });
  assert.match(result.state.connectionError, /看板服务未启动/);
  assert.doesNotMatch(result.state.connectionError, /接入配置版本已更新/);
  assert.match(result.output.hookSpecificOutput.additionalContext, /普通问答/);
}));

test('显式 recording 偏好优先于旧观测，true 仅在服务重新确认后恢复', async () => isolated(async ({ config }) => {
  const session = { host: 'codex', profileId: 'test-profile', sessionId: 'recording-choice' };
  await writeSessionState(config, session, { explicitRecordingOverride: false, recordingDisabled: false });
  const binding = { projectId: 'project-9', recording: true, summary: '已启用范围。' };
  const enabledClient = fakeClient({ binding });
  let creates = 0;
  const off = await runHook({
    rawInput: { hook_event_name: 'SessionStart', session_id: session.sessionId },
    loadConnection: async () => config,
    createClient: async () => { creates += 1; return enabledClient; },
  });
  assert.equal(creates, 0, '显式 off 的 Hook 不访问服务');
  assert.equal(off.state.recordingDisabled, true);
  assert.match(off.output.hookSpecificOutput.additionalContext, /不要调用 JarviSync 写入/);

  await writeSessionState(config, session, { ...off.state, explicitRecordingOverride: true });
  const on = await runHook({
    rawInput: { hook_event_name: 'UserPromptSubmit', session_id: session.sessionId },
    loadConnection: async () => config,
    createClient: async () => { creates += 1; return enabledClient; },
  });
  assert.equal(creates, 1);
  assert.equal(on.state.explicitRecordingOverride, true);
  assert.equal(on.state.recordingDisabled, false);
  assert.match(on.output.hookSpecificOutput.additionalContext, /已启用范围/);
}));

test('并发开关更新完成后，旧 Hook 状态写入不会覆盖最新显式选择', async () => isolated(async ({ config }) => {
  const session = { host: 'codex', profileId: 'test-profile', sessionId: 'recording-race' };
  await writeSessionState(config, session, { explicitRecordingOverride: true, recordingDisabled: false });
  let releaseCommand;
  let commandLocked;
  const locked = new Promise(resolve => { commandLocked = resolve; });
  const release = new Promise(resolve => { releaseCommand = resolve; });
  const command = updateSessionState(config, session, async current => {
    commandLocked();
    await release;
    return { ...current, explicitRecordingOverride: false };
  });
  await locked;

  let hookReadOldState;
  const hookRead = new Promise(resolve => { hookReadOldState = resolve; });
  const client = fakeClient();
  const hook = runHook({
    rawInput: { hook_event_name: 'SessionStart', session_id: session.sessionId, model: 'model-a' },
    loadConnection: async () => config,
    createClient: async () => { hookReadOldState(); return client; },
  });
  await hookRead;
  releaseCommand();
  await command;
  const result = await hook;
  assert.equal(result.state.explicitRecordingOverride, false);
  assert.equal((await readSessionState(config, session)).explicitRecordingOverride, false);
}));

test('Stop 对同一未写回操作只提示一次，Interrupt 只记录宿主状态', async () => isolated(async ({ config, stateDir }) => {
  const client = fakeClient();
  await mkdir(join(stateDir, 'pending'), { recursive: true });
  await writeFile(join(stateDir, 'pending', `${'a'.repeat(64)}.json`), JSON.stringify({
    body: { session: { host: 'codex', profileId: 'test-profile', sessionId: 'thread-c' }, clientOperationId: 'op-1' }, state: 'needs-review',
  }), 'utf8');
  const options = { loadConnection: async () => config, createClient: async () => client };
  const first = await runHook({ rawInput: { hook_event_name: 'Stop', session_id: 'thread-c' }, ...options });
  const second = await runHook({ rawInput: { hook_event_name: 'Stop', session_id: 'thread-c' }, ...options });
  const interrupt = await runHook({ rawInput: { hook_event_name: 'Interrupt', session_id: 'thread-c', turn_id: 'turn-2' }, ...options });
  assert.match(first.output.systemMessage, /不会自动交付或继续/);
  assert.equal(second.output, null);
  assert.match(interrupt.output.systemMessage, /已记录当前会话中断/);
  assert.equal(client.calls.filter(([name]) => name === 'status').length, 2);
  assert.equal(client.calls.filter(([name]) => name === 'event').at(-1)[1].event, 'Interrupt');
}));

test('离线中断保持到下一次用户提交，Stop 与 SessionEnd 不会清除', async () => isolated(async ({ config }) => {
  const unavailable = {
    async discover() { throw new Error('offline'); },
    async request() { throw new Error('offline'); },
  };
  const options = { loadConnection: async () => config, createClient: async () => unavailable };
  const interrupted = await runHook({ rawInput: { hook_event_name: 'Interrupt', session_id: 'sticky-thread' }, ...options });
  assert.equal(interrupted.state.interrupted, true);
  const stopped = await runHook({ rawInput: { hook_event_name: 'Stop', session_id: 'sticky-thread' }, ...options });
  assert.equal(stopped.state.interrupted, true);
  const ended = await runHook({ rawInput: { hook_event_name: 'SessionEnd', session_id: 'sticky-thread' }, ...options });
  assert.equal(ended.state.interrupted, true);
  const resumed = await runHook({ rawInput: { hook_event_name: 'UserPromptSubmit', session_id: 'sticky-thread' }, ...options });
  assert.equal(resumed.state.interrupted, false);
}));

test('403 接入拒绝只注入停用信息，不再提示自动记录动作', async () => isolated(async ({ config }) => {
  const forbidden = {
    async discover() { const error = new Error('此 Agent 的自动记录已停用。'); error.status = 403; throw error; },
    async request() { throw new Error('不应继续访问'); },
  };
  const first = await runHook({
    rawInput: { hook_event_name: 'SessionStart', session_id: 'disabled-thread' },
    loadConnection: async () => config,
    createClient: async () => forbidden,
  });
  const notice = first.output.hookSpecificOutput.additionalContext;
  assert.match(notice, /自动记录当前已停用或未获授权/);
  assert.match(notice, /不要调用 JarviSync 写入/);
  assert.doesNotMatch(notice, /明确工作才|普通问答|关键进展/);
  assert.equal(first.state.connectionStatus, 403);
  assert.equal(first.state.recordingDisabled, true);

  const offline = {
    async discover() { throw new Error('offline'); },
    async request() { throw new Error('offline'); },
  };
  const second = await runHook({
    rawInput: { hook_event_name: 'SessionStart', session_id: 'disabled-thread' },
    loadConnection: async () => config,
    createClient: async () => offline,
  });
  assert.equal(second.state.recordingDisabled, true, '服务离线时不丢失此前停用状态');
  assert.match(second.output.hookSpecificOutput.additionalContext, /不要调用 JarviSync 写入/);
}));

test('并发会话用宿主、profile 和 session 的哈希分开存储', async () => isolated(async ({ config, stateDir }) => {
  const client = fakeClient();
  const options = { loadConnection: async () => config, createClient: async () => client };
  const one = await runHook({ rawInput: { hook_event_name: 'SessionStart', session_id: 'same-id', model: 'model-a' }, ...options });
  const two = await runHook({ rawInput: { hook_event_name: 'SessionStart', session_id: 'other-id', model: 'model-b' }, ...options });
  const firstPath = sessionStateFile(config, one.input.session);
  const secondPath = sessionStateFile(config, two.input.session);
  assert.notEqual(firstPath, secondPath);
  assert.match(firstPath, new RegExp(`${stateDir.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}[\\\\/]sessions[\\\\/][a-f0-9]{64}\\.json$`));
  assert.equal((await readFile(firstPath, 'utf8')).includes('same-id'), false);
  assert.equal((await readSessionState(config, two.input.session)).model, 'model-b');
}));

test('会话标识缺失时拒绝写入，不会退回到共享 last-session', () => {
  assert.throws(() => normalizeHookInput({ hook_event_name: 'SessionStart' }, 'codex'), /session_id/);
});

test('安装器可用 --connection 传入绝对连接文件', () => {
  assert.equal(connectionOption(['node', 'hook.mjs', '--connection', 'C:/Agent/plugin/runtime/connection.json']), 'C:/Agent/plugin/runtime/connection.json');
  assert.equal(connectionOption(['node', 'hook.mjs', '--config', 'legacy.json']), 'legacy.json');
});

test('真实本地服务只接收配置中的 host/profile 与规范事件', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jarvisync-hook-live-'));
  const app = await startServer({ port: 0, dataDir: directory });
  try {
    await app.onboarding.prepare({ host: 'codex', scope: 'work' });
    const profile = (await app.onboarding.read()).profiles.find(item => item.host === 'codex');
    const config = {
      url: app.url, boardInstanceId: app.store.boardInstanceId, dataDir: directory,
      stateDir: join(directory, 'agent-integrations', 'profiles', profile.id, 'state'),
      host: 'codex', profileId: profile.id, connectionToken: profile.connectionToken,
    };
    const result = await runHook({
      rawInput: { hook_event_name: 'UserPromptSubmit', session_id: 'live-thread', profile_id: 'forged', host: 'forged', turn_id: 'turn-live', model: 'gpt-live' },
      loadConnection: async () => config,
    });
    const status = await createClient(config).request('status', { session: result.input.session });
    assert.equal(result.input.session.host, 'codex');
    assert.equal(result.input.session.profileId, profile.id);
    assert.equal(status.session.lastEvent, 'UserPromptSubmit');
    assert.equal(status.session.lastTurn, 'turn-live');
    assert.equal(status.session.model, 'gpt-live');
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
