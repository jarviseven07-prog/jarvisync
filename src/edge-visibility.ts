import type { WorkEdge, WorkNode } from './types';

// A drawing projection only: saved dependencies and their business meaning stay intact.
export function transitiveEdgeIds(
  nodes: readonly Pick<WorkNode, 'id'>[],
  edges: readonly WorkEdge[],
): Set<string> {
  const adjacency = new Map(nodes.map(node => [node.id, new Set<string>()]));
  const visibleEdges = edges.filter(edge => adjacency.has(edge.source) && adjacency.has(edge.target));
  for (const edge of visibleEdges) adjacency.get(edge.source)!.add(edge.target);

  // Kahn's algorithm also handles disconnected graphs without recursive stack limits.
  const incoming = new Map([...adjacency.keys()].map(id => [id, 0]));
  for (const targets of adjacency.values()) {
    for (const target of targets) incoming.set(target, incoming.get(target)! + 1);
  }
  const queue = [...incoming.keys()].filter(id => incoming.get(id) === 0);
  for (let index = 0; index < queue.length; index++) {
    for (const target of adjacency.get(queue[index])!) {
      incoming.set(target, incoming.get(target)! - 1);
      if (incoming.get(target) === 0) queue.push(target);
    }
  }
  if (queue.length !== adjacency.size) return new Set();

  const hidden = new Set<string>();
  for (const edge of visibleEdges) {
    // Exclude the entire direct pair, so duplicate edges cannot hide each other.
    const pending = [...adjacency.get(edge.source)!].filter(id => id !== edge.target);
    const visited = new Set<string>();
    for (let index = 0; index < pending.length; index++) {
      const current = pending[index];
      if (current === edge.target) {
        hidden.add(edge.id);
        break;
      }
      if (visited.has(current)) continue;
      visited.add(current);
      pending.push(...adjacency.get(current)!);
    }
  }
  return hidden;
}
