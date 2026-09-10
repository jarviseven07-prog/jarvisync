import { useEffect, useRef } from 'react';

interface Props {
  title: string;
  nodeCount: number;
  busy: boolean;
  error: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteProjectDialog({ title, nodeCount, busy, error, onCancel, onConfirm }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  return (
    <dialog ref={dialogRef} className="delete-project-dialog" aria-labelledby="delete-project-title" aria-describedby="delete-project-description" onCancel={(event) => { event.preventDefault(); if (!busy) onCancel(); }}>
      <h2 id="delete-project-title">删除项目“{title}”？</h2>
      <p id="delete-project-description">项目及其 {nodeCount} 个节点、连线和补充记录将从看板删除。其他项目不受影响。</p>
      {error && <p className="delete-project-error" role="alert">{error}</p>}
      <div className="delete-project-actions">
        <button type="button" autoFocus disabled={busy} onClick={onCancel}>取消</button>
        <button type="button" className="delete-project-confirm" disabled={busy} onClick={onConfirm}>{busy ? '正在删除…' : '删除项目'}</button>
      </div>
    </dialog>
  );
}
