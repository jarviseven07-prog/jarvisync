import type { Project, WorkNode } from './types';

export type ProjectStatusKind = 'pending' | 'doing' | 'done' | 'blocked' | 'archived';
export interface ProjectStatusSummary { kind: ProjectStatusKind; label: string; detail: string }

export function projectStatus(project: Pick<Project, 'id' | 'archived'>, allNodes: WorkNode[]): ProjectStatusSummary {
  if (project.archived) return { kind: 'archived', label: '已归档', detail: '记录已保留，可恢复项目后继续。' };
  const nodes = allNodes.filter(node => node.projectId === project.id && !node.archived);
  const done = nodes.filter(node => node.status === 'done').length;
  const blocked = nodes.filter(node => node.status === 'blocked').length;
  const detail = nodes.length ? `${done} / ${nodes.length} 个任务已完成；按未归档任务自动汇总。` : '暂无未归档任务。';
  if (blocked) return { kind: 'blocked', label: '受阻', detail: `${blocked} 个任务受阻。${detail}` };
  if (nodes.length && done === nodes.length) return { kind: 'done', label: '已完成', detail };
  if (done || nodes.some(node => node.status === 'doing')) return { kind: 'doing', label: '进行中', detail };
  return { kind: 'pending', label: '未开始', detail };
}
