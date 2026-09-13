import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Controls,
  Handle,
  Panel,
  Position,
  ReactFlow,
  applyNodeChanges,
  useStore,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import type { WorkEdge, WorkNode } from '../types';
import { nodeExecutionLabel, nodeSummary, formatRecordTime, phaseFor } from '../collaboration-view';
import type { Board } from '../types';
import { getEdgeProgress } from '../edge-progress';
import { transitiveEdgeIds } from '../edge-visibility';
import { ProgressEdge, type ProgressFlowEdge } from './ProgressEdge';
import { NodeNumber } from './NodeNumber';
import { collectAlignment } from '../snap-alignment';

type Relation = 'selected' | 'input' | 'output' | 'other' | 'none';
type CanvasNodeData = { workNode: WorkNode; relation: Relation; phaseLabel: string; phaseKind: string } & Record<string, unknown>;
type CanvasNode = Node<CanvasNodeData, 'work'>;

function WorkNodeCard({ data, selected }: NodeProps<CanvasNode>) {
  const node = data.workNode;
  const execution = nodeExecutionLabel(node);
  const active = data.phaseKind === 'running' || data.phaseKind === 'recorded';
  return (
    <article className={`flow-node status-${node.status} phase-${data.phaseKind} relation-${data.relation} ${selected ? 'is-selected' : ''}`}>
      <Handle className="node-port input-port" type="target" position={Position.Left} aria-label="前置任务连接端" title="当前任务依赖的前置任务" isConnectable={false} />
      <header>
        <span className="node-phase-label">{data.phaseLabel}{active && <i className="active-status-dot" aria-hidden="true" />}</span>
        <NodeNumber value={node.nodeNumber} />
      </header>
      <h3 title={node.title}>{node.title}</h3>
      <p>{nodeSummary(node)}</p>
      <footer>
        <span className="node-execution">
          {execution && <span className="node-execution-label" title={execution}>{execution}</span>}
          <time dateTime={node.updatedAt}>{formatRecordTime(node.updatedAt)}</time>
        </span>
        {node.archived && <b>已归档</b>}
        {node.status === 'done' && !node.archived && <span className="completion-seal" aria-label="已完成">完成</span>}
      </footer>
      <Handle className="node-port output-port" type="source" position={Position.Right} aria-label="后续任务连接端" title="依赖当前任务的后续任务" isConnectable={false} />
    </article>
  );
}

interface NodeCanvasProps {
  board: Board;
  nodes: WorkNode[];
  edges: WorkEdge[];
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  moveDisabled: boolean;
  layoutFitRevision: number;
  onMoveNode: (id: string, position: { x: number; y: number }) => Promise<boolean>;
  onSelectNode: (id: string) => void;
  onSelectEdge: (id: string | null) => void;
}

type Guide = { x?: number; y?: number };

// ReactFlow 子组件：在 Provider 上下文内读取视口，把吸附参考线画到画布坐标系
function SnapGuides({ guides }: { guides: Guide[] }) {
  const transform = useStore((state) => state.transform);
  if (guides.length === 0) return null;
  return (
    <div className="snap-guides" aria-hidden="true">
      {guides.map((guide, index) => guide.x !== undefined
        ? <span key={`x${index}`} className="snap-guide snap-guide-x" style={{ left: guide.x * transform[2] + transform[0], height: '100%' }} />
        : <span key={`y${index}`} className="snap-guide snap-guide-y" style={{ top: (guide.y ?? 0) * transform[2] + transform[1], width: '100%' }} />)}
    </div>
  );
}

const nodeTypes = { work: WorkNodeCard };
const edgeTypes = { progress: ProgressEdge };

export function NodeCanvas({
  board, nodes,
  edges,
  selectedNodeId,
  selectedEdgeId,
  moveDisabled,
  layoutFitRevision,
  onMoveNode,
  onSelectNode,
  onSelectEdge,
}: NodeCanvasProps) {
  const flow = useRef<ReactFlowInstance<CanvasNode, ProgressFlowEdge> | null>(null);
  const localPositions = useRef(new Map<string, { x: number; y: number }>());
  const dragOffsets = useRef({ dx: 0, dy: 0 });
  const savedNodes = useRef(nodes);
  const [showAllEdges, setShowAllEdges] = useState(false);
  const [guides, setGuides] = useState<Guide[]>([]);
  const snappingDisabled = useRef(false);
  const altRef = snappingDisabled;
  useEffect(() => {
    const readAlt = (event: Event) => { altRef.current = (event as KeyboardEvent).altKey; };
    window.addEventListener('keydown', readAlt);
    window.addEventListener('keyup', readAlt);
    window.addEventListener('blur', readAlt);
    return () => {
      window.removeEventListener('keydown', readAlt);
      window.removeEventListener('keyup', readAlt);
      window.removeEventListener('blur', readAlt);
    };
  }, [altRef]);
  savedNodes.current = nodes;
  const layoutSignature = nodes.map(node => node.id).sort().join('|');
  const relations = useMemo(() => {
    const map = new Map<string, Relation>();
    nodes.forEach((node) => map.set(node.id, selectedNodeId ? 'other' : 'none'));
    if (!selectedNodeId) return map;
    map.set(selectedNodeId, 'selected');
    edges.forEach((edge) => {
      if (edge.target === selectedNodeId) map.set(edge.source, 'input');
      if (edge.source === selectedNodeId) map.set(edge.target, 'output');
    });
    return map;
  }, [nodes, edges, selectedNodeId]);

  const mappedNodes = useMemo<CanvasNode[]>(() => nodes.map((node) => {
    const phase = phaseFor(board, node);
    return {
      id: node.id,
      type: 'work',
      position: node.position,
      draggable: !moveDisabled && !node.archived,
      data: { workNode: node, relation: relations.get(node.id) ?? 'other', phaseLabel: phase.label, phaseKind: phase.kind },
      selected: node.id === selectedNodeId,
      ariaLabel: `${node.title}，${phase.label}`,
    };
  }), [board, nodes, moveDisabled, relations, selectedNodeId]);

  const [flowNodes, setFlowNodes] = useState<CanvasNode[]>(mappedNodes);
  useEffect(() => setFlowNodes(mappedNodes.map(node => ({ ...node, position: localPositions.current.get(node.id) ?? node.position }))), [mappedNodes]);

  useEffect(() => {
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        void flow.current?.fitView({ padding: 0.2, maxZoom: 1, duration: reducedMotion ? 0 : 320 });
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [layoutSignature, layoutFitRevision]);

  const transitiveIds = useMemo(() => transitiveEdgeIds(nodes, edges), [nodes, edges]);
  const drawnEdges = useMemo(() => edges.filter(edge => showAllEdges || !transitiveIds.has(edge.id)
    || edge.id === selectedEdgeId || edge.source === selectedNodeId || edge.target === selectedNodeId),
  [edges, showAllEdges, transitiveIds, selectedEdgeId, selectedNodeId]);
  const hiddenEdgeCount = edges.length - drawnEdges.length;

  const flowEdges = useMemo<ProgressFlowEdge[]>(() => {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    return drawnEdges.map((edge) => {
      const source = byId.get(edge.source);
      const target = byId.get(edge.target);
      const progress = getEdgeProgress(source, target);
      return {
        ...edge,
        type: 'progress',
        selected: edge.id === selectedEdgeId,
        data: { progress, transitive: transitiveIds.has(edge.id), related: Boolean(selectedNodeId && (edge.source === selectedNodeId || edge.target === selectedNodeId)) },
        ariaLabel: `${source?.title ?? edge.source} → ${target?.title ?? edge.target}，${transitiveIds.has(edge.id) ? '跨级依赖，' : ''}${progress === 'active' ? '进行中' : progress === 'complete' ? '已完成' : '依赖连接'}`,
      };
    });
  }, [nodes, drawnEdges, transitiveIds, selectedEdgeId, selectedNodeId]);

  function changeNodes(changes: NodeChange<CanvasNode>[]) {
    const canvasChanges = changes.filter((change) => change.type === 'dimensions' || change.type === 'position');
    let guides: Guide[] = [];
    const dragChange = canvasChanges.find((change) => change.type === 'position' && change.dragging === true);
    const endChange = canvasChanges.find((change) => change.type === 'position' && change.dragging === false);
    if (dragChange?.type === 'position' && dragChange.position && !snappingDisabled.current) {
      const moving = flowNodes.find((node) => node.id === dragChange.id);
      if (moving) {
        const others = flowNodes.filter((node) => node.id !== dragChange.id && !node.dragging);
        const alignment = collectAlignment({ ...moving, position: dragChange.position }, others);
        if (alignment.dx !== 0 || alignment.dy !== 0) {
          for (const change of canvasChanges) {
            if (change.type === 'position' && change.position) {
              change.position = { x: change.position.x + alignment.dx, y: change.position.y + alignment.dy };
            }
          }
        }
        dragOffsets.current = { dx: alignment.dx, dy: alignment.dy };
        guides = alignment.guides;
      }
    } else if (endChange?.type === 'position' && endChange.position) {
      // 松手事件带的还是内部 dragItems 的原始位置：补上吸附偏移，避免覆盖吸附结果
      const { dx, dy } = dragOffsets.current;
      dragOffsets.current = { dx: 0, dy: 0 };
      if (dx !== 0 || dy !== 0) {
        for (const change of canvasChanges) {
          if (change.type === 'position' && change.position) {
            change.position = { x: change.position.x + dx, y: change.position.y + dy };
          }
        }
      }
    }
    if (endChange) setGuides([]);
    else setGuides(guides);
    for (const change of canvasChanges) {
      if (change.type === 'position' && change.position) localPositions.current.set(change.id, change.position);
    }
    setFlowNodes((current) => {
      const changed = canvasChanges.length ? applyNodeChanges(canvasChanges, current) : current;
      return changed.map((node) => ({ ...node, selected: node.id === selectedNodeId }));
    });
  }

  async function finishMove(node: CanvasNode) {
    setGuides([]);
    // 松手事件已把吸附后的位置写入 localPositions，以它为准（回调参数是未吸附的原始位置）
    const position = localPositions.current.get(node.id) ?? node.position;
    const original = savedNodes.current.find(item => item.id === node.id);
    const unchanged = original?.position.x === position.x && original?.position.y === position.y;
    const saved = unchanged || await onMoveNode(node.id, position);
    localPositions.current.delete(node.id);
    if (!saved) {
      const restore = savedNodes.current.find(item => item.id === node.id)?.position;
      if (restore) setFlowNodes(current => current.map(item => item.id === node.id ? { ...item, position: restore } : item));
    }
  }

  return (
    <div className="node-canvas" aria-label="节点依赖画布" onKeyDownCapture={(event) => {
      const element = (event.target as HTMLElement).closest<HTMLElement>('.react-flow__node');
      if (!element?.dataset.id) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        onSelectNode(element.dataset.id);
      } else if (event.key.startsWith('Arrow')) {
        // Keyboard reading and selection stay available; pointer dragging is
        // the explicit save gesture for positions.
        event.preventDefault();
        event.stopPropagation();
      }
    }}>
      <ReactFlow<CanvasNode, ProgressFlowEdge>
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onInit={(instance) => { flow.current = instance; }}
        onNodesChange={changeNodes}
        onNodeDragStop={(_, node) => { void finishMove(node); }}
        onNodeClick={(_, node) => onSelectNode(node.id)}
        onEdgeClick={(_, edge) => onSelectEdge(edge.id)}
        onPaneClick={() => onSelectEdge(null)}
        onMove={() => setGuides(current => current.length ? [] : current)}
        nodesDraggable={!moveDisabled}
        nodesFocusable
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        selectionOnDrag={false}
        nodesConnectable={false}
        edgesFocusable
        deleteKeyCode={null}
        minZoom={0.15}
        maxZoom={1.8}
        fitView
        fitViewOptions={{ padding: 0.22, maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
      >
        {guides.length > 0 && <SnapGuides guides={guides} />}
        {transitiveIds.size > 0 && <Panel position="top-right" className="canvas-relations" aria-label="连线显示">
          <span className="canvas-relations__hint" aria-live="polite">
            {showAllEdges ? '跨级连线以虚线显示' : hiddenEdgeCount > 0 ? `已收起 ${hiddenEdgeCount} 条跨级连线` : '当前关联连线已展开'}
          </span>
          <button type="button" aria-pressed={showAllEdges}
            title="总览收起已有间接路径的跨级连线；选中节点展开直接关系，完整输入与输出见右侧详情。"
            onClick={() => { onSelectEdge(null); setShowAllEdges(value => !value); }}>
            {showAllEdges ? '简洁连线' : '全部连线'}
          </button>
        </Panel>}
        <Controls position="bottom-left" showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
