import { useEffect, useRef } from 'react';

interface Props {
  title: string;
  tasks: Array<{ nodeId: string; title: string }>;
  project: boolean;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ForceStopDialog({ title, tasks, project, busy, error, onCancel, onConfirm }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  return (
    <dialog ref={dialogRef} className="delete-project-dialog force-stop-dialog" aria-labelledby="force-stop-title" aria-describedby="force-stop-description" onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
      <h2 id="force-stop-title">强制结束{project ? '项目中的任务' : '任务'}？</h2>
      <p id="force-stop-description">“{title}”{project ? `中这 ${tasks.length} 个任务` : ''}的本次执行将在看板结束。进展和成果保留，旧会话不能继续写回。所有执行结束后可归档或删除项目。</p>
      {project && <ul className="force-stop-tasks">{tasks.map(task => <li key={task.nodeId}>{task.title}</li>)}</ul>}
      <p>这不会关闭外部 Agent；如它仍在运行，请在原对话中停止。</p>
      {error && <p className="delete-project-error" role="alert">{error}</p>}
      <div className="delete-project-actions">
        <button type="button" autoFocus disabled={busy} onClick={onCancel}>取消</button>
        <button type="button" className="delete-project-confirm" disabled={busy} onClick={onConfirm}>{busy ? '正在结束…' : '强制结束'}</button>
      </div>
    </dialog>
  );
}
