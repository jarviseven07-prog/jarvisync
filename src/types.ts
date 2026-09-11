export type NodeStatus = 'idea' | 'todo' | 'doing' | 'blocked' | 'done';
export interface ProjectGroup {
  id: string;
  title: string;
  createdAt: string;
}
export interface Project {
  id: string;
  projectNumber: string;
  nextNodeNumber: number;
  title: string;
  summary: string;
  groupId?: string;
  order?: number;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  demo: boolean;
  conversationRef?: string;
  coordinator?: string;
}
export interface Execution {
  id: string;
  ref: string;
  owner: string;
  model: string | null;
  modelSource?: 'host' | 'host-unavailable';
  startedAt: string;
  endedAt?: string;
  outcome?: 'delivered' | 'stopped';
  humanEnded?: boolean;
  stoppedReason?: string;
  stopConfirmation?: 'host-observed' | 'user-confirmed';
  stoppedByRunId?: string;
  inputNodeIds: string[];
}
export interface Delivery {
  id: string;
  runId: string;
  summary: string;
  links: string[];
  unresolved: string;
  createdAt: string;
  final: boolean;
}
export interface WorkNode {
  id: string;
  nodeNumber: string;
  projectId: string;
  title: string;
  status: NodeStatus;
  owner: string;
  model?: string;
  goal: string;
  progress: string;
  next: string;
  decisions: string;
  links: string[];
  position: { x: number; y: number };
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  question?: string;
  executions?: Execution[];
  deliveries?: Delivery[];
}
export interface WorkEdge { id: string; projectId: string; source: string; target: string }
export type HumanInputKind = 'goal' | 'material' | 'feedback' | 'decision';
export type ResponseDisposition = 'applied' | 'needs-clarification' | 'not-applied';
export interface InputResponse {
  id: string;
  body: string;
  owner: string;
  disposition: ResponseDisposition;
  affectedNodeIds: string[];
  createdAt: string;
}
export interface HumanInputAttachment {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  sha256: string;
}
export interface HumanInput {
  id: string;
  projectId: string;
  nodeId?: string;
  kind: HumanInputKind;
  body: string;
  createdAt: string;
  attachments?: HumanInputAttachment[];
  source?: { ref: string; recordedBy: string };
  responses?: InputResponse[];
}
export interface Board { schemaVersion: 1; revision: number; nextProjectNumber: number; projects: Project[]; projectGroups?: ProjectGroup[]; nodes: WorkNode[]; edges: WorkEdge[]; humanInputs?: HumanInput[]; humanEndedSessions?: Array<{ host: string; profileId: string; sessionId: string; endedAt: string }> }
export type NodePatch = Partial<Pick<WorkNode, 'title' | 'status' | 'owner' | 'model' | 'goal' | 'progress' | 'next' | 'decisions' | 'links' | 'position' | 'archived' | 'question'>>;
export type Change =
  | { type: 'project.create'; title: string; summary?: string; conversationRef?: string; coordinator?: string }
  | { type: 'project.update'; id: string; patch: Partial<Pick<Project, 'title' | 'summary' | 'archived' | 'conversationRef' | 'coordinator'>> }
  | { type: 'node.create'; projectId: string; title: string; position?: { x: number; y: number } }
  | { type: 'node.update'; id: string; patch: NodePatch }
  | { type: 'nodes.layout'; projectId: string; positions: Array<{ id: string; position: { x: number; y: number } }> }
  | { type: 'edge.create'; projectId: string; source: string; target: string }
  | { type: 'edge.remove'; id: string }
  | { type: 'node.start'; id: string; executionRef: string; owner: string; model: string }
  | { type: 'node.run.update'; id: string; runId: string; patch: { progress?: string; next?: string; question?: string; status?: 'doing' | 'blocked' } }
  | { type: 'node.stop'; id: string; runId: string; reason: string }
  | { type: 'node.deliver'; id: string; runId: string; summary: string; links?: string[]; unresolved?: string; final?: boolean }
  | { type: 'delivery.mark'; id: string; deliveryId: string; final: boolean }
  | { type: 'feedback.transcribe'; projectId: string; nodeId?: string; kind: HumanInputKind; body: string; sourceRef: string; recordedBy: string }
  | { type: 'feedback.respond'; id: string; body: string; owner: string; disposition: ResponseDisposition; affectedNodeIds?: string[] };
export type HumanChange =
  | { type: 'project.force-stop'; id: string; executions: Array<{ nodeId: string; runId: string }> }
  | { type: 'node.force-stop'; id: string; runId: string }
  | { type: 'project.archive'; id: string; archived: boolean }
  | { type: 'project.remove'; id: string }
  | { type: 'human.input.add'; projectId: string; nodeId?: string; kind: HumanInputKind; body: string }
  | { type: 'node.move'; id: string; position: { x: number; y: number } }
  | { type: 'nodes.layout'; projectId: string; positions: Array<{ id: string; position: { x: number; y: number } }> }
  | { type: 'project.create'; title: string; summary?: string }
  | { type: 'project.group.create'; title: string }
  | { type: 'project.group.rename'; id: string; title: string }
  | { type: 'project.group.remove'; id: string }
  | { type: 'project.move'; id: string; groupId: string | null; beforeId?: string | null };
export interface ContextResult { revision: number; markdown: string }

// GET /api/board -> Board
// Agent writes use authenticated /api/agent/* receipts; browser writes use /api/human/*.
// POST /api/human/change { expectedRevision: number, change: HumanChange } -> Board
// POST /api/human/input multipart/form-data { expectedRevision, projectId, nodeId?, kind, body, files[] } -> Board
// GET /api/attachments/<id> downloads an attached file
// GET /api/context?node=<id> -> ContextResult (project summary, node, direct inputs)
// GET /api/context?project=<id> -> ContextResult (project summary, active node index)
// Errors: { error: string }; 409 means reload before resubmitting, never automatic retry.
