import { nodePhase, projectOverview } from '../shared/collaboration.mjs';
import type { Board, Delivery, HumanInput, Project, WorkNode } from './types';

export type SummaryFilter = 'doing' | 'ready' | 'attention' | 'deliveries';

export function executionLabel(value: { model?: string | null; modelSource?: string; owner?: string }) {
  if (value.modelSource === 'host-unavailable') return `${value.owner?.trim() || 'Agent'} · 模型未标注`;
  return value.model?.trim() || value.owner?.trim() || '';
}

export function nodeExecutionLabel(node: WorkNode) {
  return executionLabel(node.executions?.at(-1) ?? node);
}

export function nodeSummary(node: WorkNode) {
  return (node.status === 'done' ? node.deliveries?.at(-1)?.summary : '') || node.progress || node.goal || '还没有补充上下文';
}

export function formatRecordTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || '时间未记录';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

export function isHttpLink(value: string) {
  return /^https?:\/\//i.test(value);
}

export function phaseFor(board: Board, node: WorkNode) {
  return nodePhase(board, node);
}

export function overviewFor(board: Board, projectId: string) {
  return projectOverview(board, projectId);
}

export function filterNodeIds(board: Board, project: Project, filter: SummaryFilter) {
  const overview = overviewFor(board, project.id);
  if (filter === 'doing') return new Set(overview.doingIds);
  if (filter === 'ready') return new Set(overview.readyIds);
  if (filter === 'deliveries') return new Set(overview.deliveries.map((item) => item.nodeId));
  const responseNodes = (board.humanInputs ?? [])
    .filter((input) => overview.clarificationInputIds.includes(input.id))
    .flatMap((input) => input.nodeId ? [input.nodeId] : []);
  return new Set([...overview.attentionNodeIds, ...responseNodes]);
}

export function latestDelivery(node: WorkNode): Delivery | null {
  return node.deliveries?.at(-1) ?? null;
}

export function inputSourceLabel(input: HumanInput) {
  return input.source ? '对话原话 · Agent 转录' : '看板补充';
}
