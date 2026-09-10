import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const read = relative => readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

test('shared collaboration guidance keeps node, dispatch, recovery, and stop boundaries explicit', async () => {
  const skill = await read('../integrations/shared/skill/SKILL.md');
  for (const phrase of [
    '按独立、可交付的成果建立少量节点',
    '新的独立成果时，建立或关联该成果自己的节点',
    '已有会话绑定只说明已有工作，不强迫新工作复用旧节点',
    '宿主没有子 Agent 能力时，仍可建立这些节点并由当前执行者顺序完成',
    '“在看板安排给 Codex”只记录计划或节点归属',
    '只有用户明确要求立即启动外部 Codex 进程时才请求宿主实际启动',
    '只有宿主真实派发成功后，才记录 `jarvisync_start` 和本次实际模型',
    '响应丢失时仍用原操作 ID、原版本和原正文重试',
    '409 后不能给旧操作 ID 换版本，先读取上下文核对',
    '再用 `jarvisync_resolve` 携带原失败请求的 `clientOperationId`、`resolution`（`retry` 或 `discard`）和当前 `expectedRevision`',
    '`retry` 只重提相同业务正文并结清旧 pending，`discard` 明确撤销失败请求但不停止实际执行',
    '用户中断、转向或停止立即生效',
  ]) assert.match(skill, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('Hermes prompt preserves the same collaboration boundaries and resolved recovery contract', async () => {
  const plugin = await read('../integrations/hermes/plugin/__init__.py');
  const compact = plugin.replace(/\s+/g, ' ');
  for (const phrase of [
    'independent deliverables',
    'deliverable gets its own node',
    'child-agent capability',
    'Planning a Codex node is not launching',
    'host successfully dispatches work',
    'milestones, blockers, and next steps',
    'original failed request ID',
    'discard without stopping work',
    'Respect a user redirect or stop immediately',
    'A previous binding does not make a new',
    'deliverable part of its old node',
    'Node ownership or a planned model is not evidence',
  ]) assert.match(compact, new RegExp(phrase));
  assert.match(compact, /jarvisync_resolve with that failed request's/);
  assert.match(compact, /clientOperationId, resolution retry or discard, and the current expectedRevision/);
  assert.doesNotMatch(plugin, /jarvisync_restore|jarvisync_resume/);
});

test('shared and Hermes guidance preserve readable multi-item records within the Hermes prompt limit', async () => {
  const [skill, plugin] = await Promise.all([
    read('../integrations/shared/skill/SKILL.md'),
    read('../integrations/hermes/plugin/__init__.py'),
  ]);
  assert.match(skill, /多个事项必须各占一行/);
  assert.match(skill, /真实换行的 `- ` 或 `1. `/);
  assert.match(skill, /绝不把 `\\n` 写成文字/);
  assert.match(skill, /已完成和待办分段；决定单列/);
  const normalizedPlugin = plugin.replace(/\r\n/g, '\n');
  const marker = '_SYSTEM_PROMPT = """\\\n';
  const start = normalizedPlugin.indexOf(marker);
  assert.notEqual(start, -1, 'Hermes system prompt should remain a static prompt section');
  const contentStart = start + marker.length;
  const contentEnd = normalizedPlugin.indexOf('"""', contentStart);
  assert.notEqual(contentEnd, -1, 'Hermes system prompt should close');
  const section = normalizedPlugin.slice(contentStart, contentEnd);
  assert.ok(section.length <= 1600, `Hermes system prompt exceeds 1600 chars: ${section.length}`);
  assert.match(section, /real new line/);
  assert.ok(section.includes('never a literal "\\\\n"'), 'Hermes source must escape the literal backslash-n twice');
  assert.match(section, /completed and pending work\s+in separate paragraphs; state decisions separately/);
});

