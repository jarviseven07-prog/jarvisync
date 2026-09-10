import type { WorkEdge, WorkNode } from './types';

type PositionedNode = { id: string; position: { x: number; y: number } };
type ComponentLayout = { nodes: PositionedNode[]; width: number; height: number };

// Kept in sync with the fixed canvas card size. The gaps leave room for
// connector handles, shadows, and a clear read between parallel tasks.
const NODE_WIDTH = 248;
const NODE_HEIGHT = 152;
const COLUMN_GAP = 108;
const ROW_GAP = 60;
const COMPONENT_COLUMN_GAP = 96;
const COMPONENT_ROW_GAP = 72;
const MAX_ROWS_PER_LAYER = 6;
const COLUMN_STEP = NODE_WIDTH + COLUMN_GAP;
const ROW_STEP = NODE_HEIGHT + ROW_GAP;

function compareIds(left: string, right: string) {
  return left.localeCompare(right);
}

function average(values: number[]) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function orderLayers(layers: string[][], predecessors: Map<string, string[]>, successors: Map<string, string[]>) {
  const maxRank = layers.length - 1;

  // A few deterministic barycenter sweeps are enough to keep parallel paths
  // together without pulling in a graph-layout framework.
  for (let pass = 0; pass < 4; pass += 1) {
    const indexes = new Map<string, number>();
    layers.forEach((layer) => layer.forEach((id, index) => indexes.set(id, index)));

    for (let rank = 1; rank <= maxRank; rank += 1) {
      const currentIndexes = new Map(layers[rank].map((id, index) => [id, index]));
      layers[rank] = [...layers[rank]].sort((left, right) => {
        const leftNeighbors = predecessors.get(left) ?? [];
        const rightNeighbors = predecessors.get(right) ?? [];
        const leftValue = leftNeighbors.length ? average(leftNeighbors.map((id) => indexes.get(id)!)) : currentIndexes.get(left)!;
        const rightValue = rightNeighbors.length ? average(rightNeighbors.map((id) => indexes.get(id)!)) : currentIndexes.get(right)!;
        return leftValue - rightValue;
      });
      layers[rank].forEach((id, index) => indexes.set(id, index));
    }

    indexes.clear();
    layers.forEach((layer) => layer.forEach((id, index) => indexes.set(id, index)));

    for (let rank = maxRank - 1; rank >= 0; rank -= 1) {
      const currentIndexes = new Map(layers[rank].map((id, index) => [id, index]));
      layers[rank] = [...layers[rank]].sort((left, right) => {
        const leftNeighbors = successors.get(left) ?? [];
        const rightNeighbors = successors.get(right) ?? [];
        const leftValue = leftNeighbors.length ? average(leftNeighbors.map((id) => indexes.get(id)!)) : currentIndexes.get(left)!;
        const rightValue = rightNeighbors.length ? average(rightNeighbors.map((id) => indexes.get(id)!)) : currentIndexes.get(right)!;
        return leftValue - rightValue;
      });
      layers[rank].forEach((id, index) => indexes.set(id, index));
    }
  }
}

function spaceLayer(ids: string[], desired: Map<string, number>) {
  const positions = new Map<string, number>();
  let clusterStart = 0;

  while (clusterStart < ids.length) {
    let clusterEnd = clusterStart + 1;
    while (
      clusterEnd < ids.length
      && desired.get(ids[clusterEnd])! - desired.get(ids[clusterEnd - 1])! < ROW_STEP
    ) {
      clusterEnd += 1;
    }

    const cluster = ids.slice(clusterStart, clusterEnd);
    const center = average(cluster.map((id) => desired.get(id)!));
    cluster.forEach((id, index) => {
      positions.set(id, center + (index - (cluster.length - 1) / 2) * ROW_STEP);
    });
    clusterStart = clusterEnd;
  }

  // Adjacent clusters can shift slightly while they are centered. A final
  // forward pass makes the clearance guarantee explicit for every column.
  for (let index = 1; index < ids.length; index += 1) {
    const minimum = positions.get(ids[index - 1])! + ROW_STEP;
    if (positions.get(ids[index])! < minimum) positions.set(ids[index], minimum);
  }

  return positions;
}

function connectedComponents(nodeIds: string[], predecessors: Map<string, string[]>, successors: Map<string, string[]>) {
  const unseen = new Set(nodeIds);
  const components: string[][] = [];

  for (const seed of nodeIds) {
    if (!unseen.delete(seed)) continue;
    const component: string[] = [];
    const queue = [seed];

    while (queue.length) {
      const id = queue.shift()!;
      component.push(id);
      const neighbors = [...predecessors.get(id)!, ...successors.get(id)!].sort(compareIds);
      for (const neighbor of neighbors) {
        if (unseen.delete(neighbor)) queue.push(neighbor);
      }
    }

    component.sort(compareIds);
    components.push(component);
  }

  return components;
}

function chunks<T>(values: T[], size: number) {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size));
}

function layoutComponent(componentIds: string[], predecessors: Map<string, string[]>, successors: Map<string, string[]>): ComponentLayout {
  const componentSet = new Set(componentIds);
  const inDegree = new Map(componentIds.map((id) => [id, predecessors.get(id)!.filter((source) => componentSet.has(source)).length]));
  const rank = new Map(componentIds.map((id) => [id, 0]));
  const ready = componentIds.filter((id) => inDegree.get(id) === 0);
  const topological: string[] = [];

  while (ready.length) {
    const id = ready.shift()!;
    topological.push(id);
    for (const target of successors.get(id)!) {
      if (!componentSet.has(target)) continue;
      rank.set(target, Math.max(rank.get(target)!, rank.get(id)! + 1));
      const nextDegree = inDegree.get(target)! - 1;
      inDegree.set(target, nextDegree);
      if (nextDegree === 0) {
        ready.push(target);
        ready.sort(compareIds);
      }
    }
  }

  if (topological.length !== componentIds.length) {
    throw new Error('无法整理：依赖关系存在循环。');
  }

  const maxRank = Math.max(...rank.values());
  const layers = Array.from({ length: maxRank + 1 }, () => [] as string[]);
  componentIds.forEach((id) => layers[rank.get(id)!].push(id));
  orderLayers(layers, predecessors, successors);

  const layerChunks = layers.map((layer) => chunks(layer, MAX_ROWS_PER_LAYER));
  const wrapsLayer = layerChunks.some((chunksForLayer) => chunksForLayer.length > 1);
  const sinkIds = componentIds.filter((id) => successors.get(id)!.length === 0);
  const sinkRow = new Map(sinkIds.map((id, index) => [id, index * ROW_STEP]));
  const layerStartX: number[] = [];
  let nextLayerX = 0;
  for (let currentRank = 0; currentRank <= maxRank; currentRank += 1) {
    layerStartX[currentRank] = nextLayerX;
    nextLayerX += layerChunks[currentRank].length * COLUMN_STEP;
  }

  const x = new Map<string, number>();
  layerChunks.forEach(chunksForLayer => chunksForLayer.forEach((chunk, column) => {
    chunk.forEach((id) => x.set(id, layerStartX[rank.get(id)!] + column * COLUMN_STEP));
  }));

  const y = new Map<string, number>();

  // Process right to left so a dependency is centered on its direct outputs.
  // Layers taller than six cards continue in a new x column. Each wrapped
  // column gets its own compact row range because its cards cannot overlap.
  for (let currentRank = maxRank; currentRank >= 0; currentRank -= 1) {
    for (const chunk of layerChunks[currentRank]) {
      const desired = new Map<string, number>();
      chunk.forEach((id, row) => {
        const outputs = successors.get(id)!;
        desired.set(id, outputs.length
          ? average(outputs.map((output) => y.get(output)!))
          : wrapsLayer ? row * ROW_STEP : sinkRow.get(id)!);
      });
      spaceLayer(chunk, desired).forEach((value, id) => y.set(id, value));
    }
  }

  const minimumY = Math.min(...y.values());
  const maximumY = Math.max(...y.values());
  const maximumX = Math.max(...x.values());
  return {
    nodes: componentIds.map((id) => ({ id, position: { x: x.get(id)!, y: y.get(id)! - minimumY } })),
    width: maximumX + NODE_WIDTH,
    height: maximumY - minimumY + NODE_HEIGHT,
  };
}

function packComponents(layouts: ComponentLayout[]) {
  if (layouts.length === 1) return layouts[0].nodes;

  const footprintArea = layouts.reduce(
    (total, layout) => total + (layout.width + COMPONENT_COLUMN_GAP) * (layout.height + COMPONENT_ROW_GAP),
    0,
  );
  const widestPair = layouts.length > 1 ? layouts[0].width + COMPONENT_COLUMN_GAP + layouts[1].width : 0;
  const targetRowWidth = Math.max(
    ...layouts.map((layout) => layout.width),
    widestPair,
    Math.ceil(Math.sqrt(footprintArea * 1.6)),
  );
  const positioned: PositionedNode[] = [];
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;

  for (const layout of layouts) {
    if (cursorX > 0 && cursorX + layout.width > targetRowWidth) {
      cursorX = 0;
      cursorY += rowHeight + COMPONENT_ROW_GAP;
      rowHeight = 0;
    }
    layout.nodes.forEach((node) => positioned.push({
      id: node.id,
      position: { x: node.position.x + cursorX, y: node.position.y + cursorY },
    }));
    cursorX += layout.width + COMPONENT_COLUMN_GAP;
    rowHeight = Math.max(rowHeight, layout.height);
  }

  return positioned;
}

/**
 * Arrange dependency DAGs from left to right without changing the board data.
 * Missing edge endpoints are ignored. A cycle has no dependency order, so it
 * throws instead of returning a misleading partial arrangement.
 */
export function layoutNodes(nodes: WorkNode[], edges: WorkEdge[]): PositionedNode[] {
  const nodeIds = nodes.map((node) => node.id).sort(compareIds);
  if (new Set(nodeIds).size !== nodeIds.length) {
    throw new Error('无法整理：存在重复的节点 ID。');
  }
  if (nodeIds.length === 0) return [];

  const nodeSet = new Set(nodeIds);
  const predecessors = new Map(nodeIds.map((id) => [id, [] as string[]]));
  const successors = new Map(nodeIds.map((id) => [id, [] as string[]]));
  const uniqueRelations = new Set<string>();

  for (const edge of edges) {
    if (!nodeSet.has(edge.source) || !nodeSet.has(edge.target)) continue;
    const key = edge.source + '\u0000' + edge.target;
    if (uniqueRelations.has(key)) continue;
    uniqueRelations.add(key);
    successors.get(edge.source)!.push(edge.target);
    predecessors.get(edge.target)!.push(edge.source);
  }
  predecessors.forEach((ids) => ids.sort(compareIds));
  successors.forEach((ids) => ids.sort(compareIds));

  const components = connectedComponents(nodeIds, predecessors, successors);
  const positioned = packComponents(components.map((component) => layoutComponent(component, predecessors, successors)));
  const positions = new Map(positioned.map((item) => [item.id, item.position]));

  return nodeIds.map((id) => ({ id, position: positions.get(id)! }));
}
