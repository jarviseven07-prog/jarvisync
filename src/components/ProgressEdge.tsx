import { useId, type CSSProperties } from 'react';
import {
  BaseEdge,
  getBezierPath,
  type Edge,
  type EdgeProps,
} from '@xyflow/react';
import type { EdgeProgress } from '../edge-progress';
import './progress-edge.css';

export type ProgressEdgeData = {
  progress: EdgeProgress;
  related?: boolean;
  transitive?: boolean;
} & Record<string, unknown>;

export type ProgressFlowEdge = Edge<ProgressEdgeData, 'progress'>;

export function ProgressEdge({
  id,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  data,
  selected,
  style,
  interactionWidth,
}: EdgeProps<ProgressFlowEdge>) {
  const markerId = `progress-arrow-${useId().replaceAll(':', '')}`;
  const progress = data?.progress ?? 'idle';
  const related = data?.related === true;
  const [bezierPath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    curvature: 0.5,
  });
  const span = targetX - sourceX;
  const bow = Math.min(22, Math.max(12, span * 0.16));
  const edgePath = span > 0 && Math.abs(targetY - sourceY) < 16
    ? `M ${sourceX},${sourceY} C ${sourceX + span * 0.36},${sourceY - bow} ${targetX - span * 0.36},${targetY - bow} ${targetX},${targetY}`
    : bezierPath;
  const edgeStyle: CSSProperties = {
    ...style,
    stroke: 'var(--progress-edge-color)',
    strokeWidth: 'var(--progress-edge-width)',
  };
  const stateClasses = [
    'progress-edge',
    `progress-edge--${progress}`,
    selected ? 'is-selected' : '',
    related ? 'is-related' : '',
    data?.transitive ? 'is-transitive' : '',
  ].filter(Boolean).join(' ');

  return (
    <g className={stateClasses} data-progress={progress}>
      {data?.transitive && <title>跨级依赖：已有间接路径，直接输入仍保留。</title>}
      <defs aria-hidden="true">
        <marker
          id={markerId}
          markerWidth="6"
          markerHeight="6"
          refX="5.4"
          refY="3"
          orient="auto"
          markerUnits="strokeWidth"
          viewBox="0 0 6 6"
        >
          <path className="progress-edge__arrow" d="M 0 0 L 6 3 L 0 6 z" />
        </marker>
      </defs>

      {(selected || related) && (
        <path
          aria-hidden="true"
          className="progress-edge__relation"
          d={edgePath}
          fill="none"
        />
      )}

      <BaseEdge
        id={id}
        path={edgePath}
        className="progress-edge__base"
        markerEnd={`url(#${markerId})`}
        interactionWidth={interactionWidth}
        style={edgeStyle}
      />

      {progress === 'active' && (
        <>
          <path aria-hidden="true" className="progress-edge__pulse-glow" d={edgePath} pathLength={100} fill="none" />
          <path aria-hidden="true" className="progress-edge__pulse-core" d={edgePath} pathLength={100} fill="none" />
        </>
      )}
    </g>
  );
}
