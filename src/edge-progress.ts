import type { WorkNode } from './types';

export type EdgeProgress = 'active' | 'complete' | 'idle';
export type EdgeProgressNode = Pick<WorkNode, 'status' | 'archived'>;

export function getEdgeProgress(
  source?: EdgeProgressNode,
  target?: EdgeProgressNode,
): EdgeProgress {
  if (!source || !target || source.archived || target.archived) return 'idle';
  if (source.status === 'done' && target.status === 'doing') return 'active';
  if (source.status === 'done' && target.status === 'done') return 'complete';
  return 'idle';
}
