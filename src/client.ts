import type { Board, ContextResult, HumanChange, HumanInputKind } from './types';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const payload = (await response.json().catch(() => null)) as { error?: string } | T | null;
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload && payload.error
      ? payload.error
      : `请求失败（${response.status}）`;
    throw new ApiError(message, response.status);
  }
  return payload as T;
}

export async function getBoard(signal?: AbortSignal): Promise<Board> {
  const response = await fetch('/api/board', { signal, headers: { Accept: 'application/json' } });
  return readJson<Board>(response);
}

export async function applyHumanChange(expectedRevision: number, change: HumanChange): Promise<Board> {
  const response = await fetch('/api/human/change', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ expectedRevision, change }),
  });
  return readJson<Board>(response);
}

export async function submitHumanInputWithAttachments(
  expectedRevision: number,
  input: { projectId: string; nodeId?: string; kind: HumanInputKind; body: string; files: File[] },
): Promise<Board> {
  const form = new FormData();
  form.append('expectedRevision', String(expectedRevision));
  form.append('projectId', input.projectId);
  if (input.nodeId) form.append('nodeId', input.nodeId);
  form.append('kind', input.kind);
  form.append('body', input.body);
  for (const file of input.files) form.append('files', file);
  const response = await fetch('/api/human/input', {
    method: 'POST',
    headers: { Accept: 'application/json' },
    body: form,
  });
  return readJson<Board>(response);
}

export async function getNodeContext(nodeId: string): Promise<ContextResult> {
  const response = await fetch(`/api/context?node=${encodeURIComponent(nodeId)}`, {
    headers: { Accept: 'application/json' },
  });
  return readJson<ContextResult>(response);
}
