import type { Project, WorkEdge, WorkNode } from './types';

export type BoardView = 'canvas' | 'list';
export type ListOrder = 'dependency' | 'updated';

export function initialBoardView(stored: string | null, narrow: boolean): BoardView {
  return stored === 'canvas' || stored === 'list' ? stored : narrow ? 'list' : 'canvas';
}

export function preferredProject(projects: Project[], preferredId: string | null): Project | null {
  const available = projects.filter(project => !project.archived);
  return available.find(project => project.id === preferredId)
    ?? [...available].sort((a, b) => Number(a.demo) - Number(b.demo)
      || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))[0]
    ?? null;
}

export function orderedListNodes(nodes: WorkNode[], edges: WorkEdge[], order: ListOrder): WorkNode[] {
  const compare = (a: WorkNode, b: WorkNode) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id);
  if (order === 'updated') return [...nodes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || compare(a, b));
  const byId = new Map(nodes.map(node => [node.id, node]));
  const predecessors = new Map(nodes.map(node => [node.id, new Set<string>()]));
  const successors = new Map(nodes.map(node => [node.id, new Set<string>()]));
  for (const edge of edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    predecessors.get(edge.target)!.add(edge.source);
    successors.get(edge.source)!.add(edge.target);
  }
  const ready = nodes.filter(node => !predecessors.get(node.id)!.size).sort(compare);
  const result: WorkNode[] = [];
  while (ready.length) {
    const node = ready.shift()!;
    result.push(node);
    for (const target of successors.get(node.id)!) {
      predecessors.get(target)!.delete(node.id);
      if (!predecessors.get(target)!.size) ready.push(byId.get(target)!);
    }
    ready.sort(compare);
  }
  // Keep all records visible even if imported data contains a cycle.
  const seen = new Set(result.map(node => node.id));
  return result.concat(nodes.filter(node => !seen.has(node.id)).sort(compare));
}
