import { ArrowDownRight, ArrowUpLeft, ChevronRight } from 'lucide-react';
import { nodeExecutionLabel, nodeSummary, formatRecordTime, phaseFor } from '../collaboration-view';
import type { Board, WorkEdge, WorkNode } from '../types';
import { NodeNumber } from './NodeNumber';

interface NodeListProps {
  board: Board;
  nodes: WorkNode[];
  edges: WorkEdge[];
  selectedNodeId: string | null;
  onSelectNode: (id: string) => void;
}

export function NodeList({ board, nodes, edges, selectedNodeId, onSelectNode }: NodeListProps) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return (
    <div className="node-list" aria-label="节点列表">
      {nodes.map((node) => {
        const phase = phaseFor(board, node);
        const active = phase.kind === 'running' || phase.kind === 'recorded';
        const inputs = edges.filter((edge) => edge.target === node.id).map((edge) => byId.get(edge.source)).filter(Boolean) as WorkNode[];
        const outputs = edges.filter((edge) => edge.source === node.id).map((edge) => byId.get(edge.target)).filter(Boolean) as WorkNode[];
        return (
          <button
            type="button"
            className={`list-node status-${node.status} phase-${phase.kind} ${selectedNodeId === node.id ? 'is-selected' : ''}`}
            key={node.id}
            onClick={() => onSelectNode(node.id)}
          >
            <span className="list-node-status">{phase.label}{active && <i className="active-status-dot" aria-hidden="true" />}</span>
            <span className="list-node-main">
              <span className="list-node-title"><NodeNumber value={node.nodeNumber} />{node.title}{node.archived && <em>已归档</em>}</span>
              <span className="list-node-copy">{nodeSummary(node)}</span>
              <span className="list-node-copy">{nodeExecutionLabel(node) ? `${nodeExecutionLabel(node)} · ` : ''}{formatRecordTime(node.updatedAt)}{node.question?.trim() ? ' · 需要你' : ''}</span>
              <span className="list-node-relations">
                {inputs.length > 0 && <span title="当前任务依赖的任务"><ArrowUpLeft size={13} /> 前置任务：{inputs.map((item) => item.title).join('、')}</span>}
                {outputs.length > 0 && <span title="依赖当前任务的任务"><ArrowDownRight size={13} /> 后续任务：{outputs.map((item) => item.title).join('、')}</span>}
              </span>
            </span>
            <ChevronRight size={18} className="list-node-arrow" />
          </button>
        );
      })}
    </div>
  );
}
