// A nudge to review real milestones, never a claim that the host is still working.
export const PROGRESS_REMINDER_MS = 10 * 60 * 1000;

export function getProgressCheckpoint(board, binding, { now = Date.now(), interrupted = false } = {}) {
  if (!binding?.recording || !binding.nodeId || !binding.runId || binding.humanEndedAt || interrupted) return null;
  if ((board.humanEndedSessions ?? []).some(item => item.host === binding.host
    && item.profileId === binding.profileId && item.sessionId === binding.sessionId)) return null;
  const project = board.projects.find(item => item.id === binding.projectId);
  const node = board.nodes.find(item => item.id === binding.nodeId && item.projectId === binding.projectId);
  const run = node?.executions?.at(-1);
  if (!project || project.archived || !node || node.archived || run?.id !== binding.runId || run.endedAt !== undefined) return null;
  // Existing runs predate checkpoints; their start is a conservative review signal.
  const lastProgressAt = binding.progressCheckpoint?.runId === run.id ? binding.progressCheckpoint.at : run.startedAt;
  const timestamp = Date.parse(lastProgressAt);
  if (!Number.isFinite(timestamp)) return null;
  const elapsedMs = Math.max(0, now - timestamp);
  return { runId: run.id, nodeId: node.id, lastProgressAt, elapsedMs, reminderDue: elapsedMs >= PROGRESS_REMINDER_MS };
}
