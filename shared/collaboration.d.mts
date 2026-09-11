import type { Board, WorkNode, Delivery } from '../src/types';

export interface DependencyState { ready: boolean; waitingIds: string[] }
export interface NodePhase {
  kind: 'archived' | 'idea' | 'waiting' | 'ready' | 'running' | 'recorded' | 'blocked' | 'done' | 'stopped';
  label: string;
}
export interface ProjectOverview {
  doingIds: string[];
  readyIds: string[];
  waitingIds: string[];
  attentionNodeIds: string[];
  clarificationInputIds: string[];
  deliveries: Array<{ nodeId: string; nodeTitle: string; delivery: Delivery }>;
}
export function dependencyState(board: Board, node: WorkNode): DependencyState;
export function nodePhase(board: Board, node: WorkNode): NodePhase;
export function isHumanEnded(node: WorkNode): boolean;
export function projectOverview(board: Board, projectId: string): ProjectOverview;
