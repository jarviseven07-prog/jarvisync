import { Archive, Check, TriangleAlert } from 'lucide-react';
import type { ProjectStatusSummary } from '../project-status';
import './project-status.css';

export function ProjectStatus({ status }: { status: ProjectStatusSummary }) {
  return (
    <span className={`project-status is-${status.kind}`} title={status.detail} aria-label={`项目状态：${status.label}`}>
      <span className="project-status-symbol" aria-hidden="true">
        {status.kind === 'done' ? <Check size={10} strokeWidth={2.5} /> : status.kind === 'blocked' ? <TriangleAlert size={12} /> : status.kind === 'archived' ? <Archive size={12} /> : null}
      </span>
      <span>{status.label}</span>
    </span>
  );
}
