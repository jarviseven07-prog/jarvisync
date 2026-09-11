// Pure projections of saved records, shared by the local service and the UI.
// These functions never poll an agent or infer that an assigned agent is online.
export function dependencyState(board, node) {
  const project = board.projects.find(item => item.id === node.projectId);
  const waitingIds = [...new Set(board.edges
    .filter(edge => edge.projectId === node.projectId && edge.target === node.id)
    .map(edge => edge.source))]
    .filter(id => {
      const input = board.nodes.find(item => item.id === id && item.projectId === node.projectId);
      return !input || input.archived || input.status !== 'done';
    });
  return { ready: Boolean(project && !project.archived && !node.archived && waitingIds.length === 0), waitingIds };
}

export function isHumanEnded(node) {
  const latest = node.executions?.at(-1);
  return node.status === 'blocked' && latest?.humanEnded === true && Boolean(latest.endedAt) && latest.outcome === 'stopped';
}

export function nodePhase(board, node) {
  const project = board.projects.find(item => item.id === node.projectId);
  if (!project || project.archived || node.archived) return { kind: 'archived', label: '已归档' };
  if (node.status === 'idea') return { kind: 'idea', label: '想法' };
  if (node.status === 'done') return { kind: 'done', label: '已完成' };
  if (isHumanEnded(node)) return { kind: 'stopped', label: '人工已结束' };
  if (node.status === 'blocked') return { kind: 'blocked', label: '受阻' };
  if (node.status === 'doing') {
    const execution = node.executions?.at(-1);
    if (execution && !execution.endedAt && !execution.outcome) return { kind: 'running', label: '进行中' };
    return { kind: 'recorded', label: '进行中 · 未记录执行' };
  }
  return dependencyState(board, node).ready
    ? { kind: 'ready', label: '可接续' }
    : { kind: 'waiting', label: '等待上游' };
}

export function projectOverview(board, projectId) {
  const result = { doingIds: [], readyIds: [], waitingIds: [], attentionNodeIds: [], clarificationInputIds: [], deliveries: [] };
  const project = board.projects.find(item => item.id === projectId);
  if (!project || project.archived) return result;
  const nodes = board.nodes.filter(node => node.projectId === projectId && !node.archived);
  for (const node of nodes) {
    const phase = nodePhase(board, node).kind;
    if (phase === 'running' || phase === 'recorded') result.doingIds.push(node.id);
    if (phase === 'ready') result.readyIds.push(node.id);
    if (phase === 'waiting') result.waitingIds.push(node.id);
    if (phase !== 'stopped' && (phase === 'blocked' || node.question?.trim())) result.attentionNodeIds.push(node.id);
    const delivery = node.deliveries?.at(-1);
    if (phase === 'done' && delivery) result.deliveries.push({ nodeId: node.id, nodeTitle: node.title, delivery });
  }
  for (const input of board.humanInputs ?? []) {
    if (input.projectId !== projectId || (input.nodeId && !nodes.some(node => node.id === input.nodeId))) continue;
    if (input.nodeId && nodes.some(node => node.id === input.nodeId && isHumanEnded(node))) continue;
    if (input.responses?.at(-1)?.disposition === 'needs-clarification') result.clarificationInputIds.push(input.id);
  }
  result.deliveries.sort((a, b) => Number(b.delivery.final) - Number(a.delivery.final)
    || b.delivery.createdAt.localeCompare(a.delivery.createdAt)
    || a.nodeId.localeCompare(b.nodeId));
  return result;
}
