import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  ArrowDownRight,
  ArrowUpLeft,
  Check,
  CircleAlert,
  Copy,
  ExternalLink,
  Paperclip,
  PanelRightClose,
  Settings2,
  Link2,
} from 'lucide-react';
import type { HumanInput, HumanInputKind, Project, WorkEdge, WorkNode } from '../types';
import { executionLabel, nodeExecutionLabel, formatRecordTime, inputSourceLabel, isHttpLink, latestDelivery, overviewFor, phaseFor } from '../collaboration-view';
import type { Board, Delivery, Execution } from '../types';
import { ReadableText } from './ReadableText';
import { NodeNumber } from './NodeNumber';
import './inspector-content.css';

interface RelatedNode {
  edge: WorkEdge;
  node: WorkNode;
}

interface InspectorProps {
  board: Board;
  project: Project;
  node: WorkNode | null;
  inputs: RelatedNode[];
  outputs: RelatedNode[];
  humanInputs: HumanInput[];
  busy: boolean;
  onClose: () => void;
  onSelectNode: (id: string) => void;
  onSubmitInput: (kind: HumanInputKind, body: string, files: File[]) => Promise<boolean>;
  onDraftChange: (dirty: boolean) => void;
}

const kindOptions: Array<{ value: HumanInputKind; label: string }> = [
  { value: 'goal', label: '目标与约束' },
  { value: 'material', label: '补充材料' },
  { value: 'feedback', label: '反馈与修改' },
  { value: 'decision', label: '明确决定' },
];

const kindLabel = Object.fromEntries(kindOptions.map((item) => [item.value, item.label])) as Record<HumanInputKind, string>;
const maxFileCount = 10;
const maxFileSize = 10 * 1024 * 1024;
const maxTotalFileSize = 20 * 1024 * 1024;
const readingDensityStorageKey = 'nodeboard.inspector.reading-density';

type ReadingDensity = 'compact' | 'standard' | 'relaxed';

const readingDensityOptions: Array<{ value: ReadingDensity; label: string; description: string }> = [
  { value: 'compact', label: '紧凑', description: '13px 字号，紧凑行距' },
  { value: 'standard', label: '标准', description: '14px 字号，标准行距' },
  { value: 'relaxed', label: '宽松', description: '16px 字号，宽松行距' },
];

function storedReadingDensity(): ReadingDensity {
  if (typeof window === 'undefined') return 'compact';
  try {
    const stored = window.localStorage.getItem(readingDensityStorageKey);
    return readingDensityOptions.some((option) => option.value === stored) ? stored as ReadingDensity : 'compact';
  } catch {
    return 'compact';
  }
}

function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

function ReadField({ label, value }: { label: string; value: string }) {
  if (!value.trim()) return null;
  return (
    <section className="read-field">
      <h3>{label}</h3>
      <ReadableText text={value.trim()} />
    </section>
  );
}

function sameBody(left: string, right: string) {
  const normalize = (value: string) => value.trim().replace(/\r\n?/g, '\n');
  return Boolean(normalize(left)) && normalize(left) === normalize(right);
}

function DeliveryRecord({ delivery, nodeTitle, current = true }: { delivery: Delivery; nodeTitle?: string; current?: boolean }) {
  return (
    <li className="delivery-record">
      <div><b>{current ? (delivery.final ? '最终成果 · 已交付' : '已交付') : (delivery.final ? '历史交付 · 曾标最终' : '历史交付')}</b>{nodeTitle && <span>{nodeTitle}</span>}<time dateTime={delivery.createdAt}>{formatRecordTime(delivery.createdAt)}</time></div>
      <ReadableText text={delivery.summary} />
      {delivery.unresolved.trim() && <section className="delivery-unresolved"><h4>未解决</h4><ReadableText text={delivery.unresolved} /></section>}
      {delivery.links.filter((link) => link.trim()).length > 0 && (
        <ul className="delivery-links">
          {delivery.links.filter((link) => link.trim()).map((link) => {
            const value = link.trim();
            return <li key={value}>{isHttpLink(value) ? <a href={value} target="_blank" rel="noreferrer">{value}<ExternalLink size={12} /></a> : <code>{value}</code>}</li>;
          })}
        </ul>
      )}
    </li>
  );
}

function ExecutionRecord({ execution }: { execution: Execution }) {
  const state = execution.endedAt
    ? (execution.outcome === 'delivered' ? '已交付' : '已停止')
    : '执行中';
  return (
    <li className="execution-record">
      <b>{state}</b>
      <code>{execution.ref}</code>
      <p>{executionLabel(execution) ? `${executionLabel(execution)} · ` : ''}开始 {formatRecordTime(execution.startedAt)}</p>
      {execution.stoppedReason && <ReadableText text={`停止原因：${execution.stoppedReason}${execution.stopConfirmation ? `（${execution.stopConfirmation === 'host-observed' ? '宿主已报告中断' : '用户已确认停止'}）` : ''}`} />}
    </li>
  );
}

export function Inspector({
  board, project,
  node,
  inputs,
  outputs,
  humanInputs,
  busy,
  onClose,
  onSelectNode,
  onSubmitInput,
  onDraftChange,
}: InspectorProps) {
  const [kind, setKind] = useState<HumanInputKind>('feedback');
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [showAllInputs, setShowAllInputs] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [readingDensity, setReadingDensity] = useState<ReadingDensity>(storedReadingDensity);
  const [readingSettingsOpen, setReadingSettingsOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const readingSettingsRef = useRef<HTMLDivElement>(null);
  const readingSettingsButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!readingSettingsOpen) return;
    function closeOnOutsidePointer(event: PointerEvent) {
      if (!readingSettingsRef.current?.contains(event.target as Node)) setReadingSettingsOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setReadingSettingsOpen(false);
      readingSettingsButtonRef.current?.focus();
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [readingSettingsOpen]);

  const scopedInputs = useMemo(() => humanInputs
    .filter((item) => node ? (!item.nodeId || item.nodeId === node.id || item.responses?.some((response) => response.affectedNodeIds.includes(node.id))) : !item.nodeId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [humanInputs, node]);
  const visibleInputs = showAllInputs ? scopedInputs : scopedInputs.slice(0, 8);
  const phase = node ? phaseFor(board, node) : null;
  const overview = overviewFor(board, project.id);
  const inputDeliveries = inputs
    .filter(({ node: input }) => !input.archived && input.status === 'done')
    .map(({ node: input }) => ({ node: input, delivery: latestDelivery(input) }))
    .filter((item): item is { node: WorkNode; delivery: Delivery } => Boolean(item.delivery));
  const latestNodeDelivery = node?.deliveries?.at(-1);
  const progressRepeatsLatestDelivery = Boolean(node && latestNodeDelivery && sameBody(node.progress, latestNodeDelivery.summary));
  const readFields = node ? [
    { label: node.status === 'done' ? '最后进展' : '当前进度', value: progressRepeatsLatestDelivery ? '' : node.progress },
    { label: '下一步', value: node.status === 'done' ? '' : node.next },
    { label: '目标', value: node.goal },
    { label: '决定', value: node.decisions },
    { label: '需要你回答', value: node.question ?? '' },
  ].filter((field) => field.value.trim()) : [];
  const relationCount = inputs.length + outputs.length;
  const projectConversationRef = project.conversationRef?.trim() ?? '';
  const projectCoordinator = project.coordinator?.trim() ?? '';
  const identity = node?.id ?? project.id;
  const resourceCopyError = Boolean(copyError && node?.links.some((link) => link.trim() === copyError));

  function updateBody(value: string) {
    setBody(value);
    setSubmitError(false);
    onDraftChange(Boolean(value.trim()) || files.length > 0);
  }

  function addFiles(event: ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = '';
    if (selected.length === 0) return;
    const nextFiles = [...files, ...selected];
    if (nextFiles.length > maxFileCount) {
      setFileError(`附件最多保留 ${maxFileCount} 个；当前已有 ${files.length} 个，未添加这次选择的文件。`);
      return;
    }
    const oversized = selected.find((file) => file.size > maxFileSize);
    if (oversized) {
      setFileError(`“${oversized.name}”超过单个 ${formatFileSize(maxFileSize)} 的限制，未添加这次选择的文件。`);
      return;
    }
    const totalSize = nextFiles.reduce((total, file) => total + file.size, 0);
    if (totalSize > maxTotalFileSize) {
      setFileError(`附件总计不能超过 ${formatFileSize(maxTotalFileSize)}；未添加这次选择的文件。`);
      return;
    }
    setFiles(nextFiles);
    setFileError(null);
    setSubmitError(false);
    onDraftChange(Boolean(body.trim()) || nextFiles.length > 0);
  }

  function removeFile(index: number) {
    const nextFiles = files.filter((_, fileIndex) => fileIndex !== index);
    setFiles(nextFiles);
    setFileError(null);
    onDraftChange(Boolean(body.trim()) || nextFiles.length > 0);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const nextBody = body.trim();
    const nextFiles = [...files];
    if ((!nextBody && nextFiles.length === 0) || busy || submitting) return;
    setSubmitting(true);
    setSubmitError(false);
    try {
      const saved = await onSubmitInput(kind, nextBody, nextFiles);
      if (saved) {
        setBody('');
        setFiles([]);
        setFileError(null);
        if (fileInputRef.current) fileInputRef.current.value = '';
        onDraftChange(false);
      } else {
        setSubmitError(true);
      }
    } catch {
      setSubmitError(true);
    } finally {
      setSubmitting(false);
    }
  }

  async function copyValue(value: string) {
    setCopyError(null);
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(value);
      setCopied(value);
      window.setTimeout(() => setCopied((current) => current === value ? null : current), 1400);
    } catch {
      setCopyError(value);
    }
  }

  function updateReadingDensity(value: ReadingDensity) {
    setReadingDensity(value);
    try {
      window.localStorage.setItem(readingDensityStorageKey, value);
    } catch {
      // The selection still applies for this session when storage is unavailable.
    }
    setReadingSettingsOpen(false);
    readingSettingsButtonRef.current?.focus();
  }

  return (
    <aside className="inspector" data-reading-density={readingDensity} aria-label={node ? '节点详情' : '项目说明与要求'}>
      <header className="inspector-header">
        <div className="inspector-header-status" aria-hidden="true">
          {node && <span className={`status-dot status-${node.status}`} />}
          {node?.archived && <b>已归档</b>}
        </div>
        <div className="inspector-header-actions">
          <div className="reading-settings" ref={readingSettingsRef}>
            <button
              ref={readingSettingsButtonRef}
              className="icon-button"
              type="button"
              aria-label="阅读设置"
              title="阅读设置"
              aria-haspopup="dialog"
              aria-expanded={readingSettingsOpen}
              aria-controls="inspector-reading-settings"
              onClick={() => setReadingSettingsOpen((open) => !open)}
            >
              <Settings2 size={17} />
            </button>
            {readingSettingsOpen && (
              <div className="reading-settings-popover" id="inspector-reading-settings" role="dialog" aria-label="阅读设置">
                <span className="reading-settings-title">正文阅读</span>
                <div className="reading-density-control" role="group" aria-label="正文阅读密度">
                  {readingDensityOptions.map((option) => (
                    <button
                      type="button"
                      className={readingDensity === option.value ? 'is-active' : ''}
                      aria-pressed={readingDensity === option.value}
                      title={option.description}
                      onClick={() => updateReadingDensity(option.value)}
                      key={option.value}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <button className="icon-button" type="button" onClick={() => { setReadingSettingsOpen(false); onClose(); }} aria-label="收起详情" title="收起详情"><PanelRightClose size={18} /></button>
        </div>
      </header>

      <section className="inspector-overview">
        <div className="inspector-node-heading">
          {node && <NodeNumber value={node.nodeNumber} />}
          <span className="inspector-kicker">{node ? 'Agent 记录' : '项目说明'}</span>
        </div>
        <h2>{node?.title ?? project.title}</h2>
        {node ? (
          <p className="inspector-meta">
            <span>{phase?.label}</span>
            {nodeExecutionLabel(node) && <span>{nodeExecutionLabel(node)}</span>}
          </p>
        ) : (
          <>
            {project.summary.trim() && <ReadableText className="project-overview-copy" text={project.summary.trim()} />}
            {(projectConversationRef || projectCoordinator) && (
              <div className="project-collaboration-meta">
                {projectConversationRef && <><span>来源</span>{isHttpLink(projectConversationRef) ? <a href={projectConversationRef} target="_blank" rel="noreferrer">对话 <ExternalLink size={12} /></a> : <code>{projectConversationRef}</code>}</>}
                {projectCoordinator && <><span>协调</span><b>{projectCoordinator}</b></>}
              </div>
            )}
          </>
        )}
      </section>

      {!node && overview.deliveries.length > 0 && (
        <section className="inspector-section overview-deliveries" aria-labelledby="project-deliveries-heading">
          <div className="section-title"><h3 id="project-deliveries-heading">成果集合</h3><span>{overview.deliveries.length}</span></div>
          <ol className="delivery-list">{overview.deliveries.map((item) => <DeliveryRecord key={item.delivery.id} nodeTitle={item.nodeTitle} delivery={item.delivery} />)}</ol>
        </section>
      )}

      {node && (
        <>
          {relationCount > 0 && <div className={`context-spine parts-${1 + Number(inputs.length > 0) + Number(outputs.length > 0)}`} aria-label="节点关系摘要">
            {inputs.length > 0 && <div className="spine-part input" title="当前任务依赖的任务"><ArrowUpLeft size={15} /><span>前置任务</span><strong>{inputs.length}</strong></div>}
            <div className="spine-part current"><span>当前节点</span></div>
            {outputs.length > 0 && <div className="spine-part output" title="依赖当前任务的任务"><ArrowDownRight size={15} /><span>后续任务</span><strong>{outputs.length}</strong></div>}
          </div>}

          {readFields.length > 0 && <div className="read-fields">{readFields.map((field) => <ReadField key={field.label} label={field.label} value={field.value} />)}</div>}

          {Boolean(node.executions?.length) && <section className="inspector-section" aria-labelledby="execution-heading">
            <div className="section-title"><h3 id="execution-heading">执行记录</h3><span>{node.executions?.length ?? 0}</span></div>
            <ol className="execution-list">{[...(node.executions ?? [])].reverse().map((execution) => <ExecutionRecord key={execution.id} execution={execution} />)}</ol>
          </section>}

          {Boolean(node.deliveries?.length) && <section className="inspector-section" aria-labelledby="deliveries-heading">
            <div className="section-title"><h3 id="deliveries-heading">当前与历史交付</h3><span>{node.deliveries?.length ?? 0}</span></div>
            <ol className="delivery-list">{[...(node.deliveries ?? [])].reverse().map((delivery, index) => <DeliveryRecord key={delivery.id} delivery={delivery} current={index === 0} />)}</ol>
          </section>}

          {inputDeliveries.length > 0 && <section className="inspector-section" aria-labelledby="input-deliveries-heading">
            <div className="section-title"><h3 id="input-deliveries-heading">前置任务成果</h3><span>{inputDeliveries.length}</span></div>
            <ol className="delivery-list">{inputDeliveries.map(({ node: input, delivery }) => <DeliveryRecord key={delivery.id} nodeTitle={input.title} delivery={delivery} />)}</ol>
          </section>}

          {relationCount > 0 && <section className="inspector-section relation-section" aria-labelledby="relation-heading">
            <div className="section-title"><h3 id="relation-heading">节点关系</h3><span>{inputs.length + outputs.length}</span></div>
            {inputs.length > 0 && <div className="relation-group">
              <span>前置任务 · 当前任务依赖它们</span>
              <ul className="relation-list">
                {inputs.map(({ edge, node: input }) => (
                  <li key={edge.id}>
                    <button type="button" onClick={() => onSelectNode(input.id)} aria-label={input.title} title={`内部 ID：${input.id}`}>
                      <span>{input.title}</span><ArrowUpLeft size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>}
            {outputs.length > 0 && <div className="relation-group">
              <span>后续任务 · 它们依赖当前任务</span>
              <ul className="relation-list">
                {outputs.map(({ edge, node: output }) => (
                  <li key={edge.id}>
                    <button type="button" onClick={() => onSelectNode(output.id)} aria-label={output.title} title={`内部 ID：${output.id}`}>
                      <span>{output.title}</span><ArrowDownRight size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>}
          </section>}

          {node.links.filter((link) => link.trim()).length > 0 && (
            <section className="inspector-section" aria-labelledby="links-heading">
              <div className="section-title"><h3 id="links-heading">资料</h3><Link2 size={15} /></div>
              <ul className="resource-list">
                {node.links.filter((link) => link.trim()).map((link) => {
                  const value = link.trim();
                  return (
                    <li key={value}>
                      {isHttpLink(value) ? (
                        <a href={value} target="_blank" rel="noreferrer"><span>{value}</span><ExternalLink size={14} /></a>
                      ) : (
                        <button type="button" onClick={() => void copyValue(value)} aria-label={`复制路径 ${value}`}>
                          <span>{value}</span>{copied === value ? <Check size={14} /> : copyError === value ? <CircleAlert size={14} /> : <Copy size={14} />}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
              {resourceCopyError && <p className="inline-error" role="alert">路径未复制，请手动选择。</p>}
            </section>
          )}
        </>
      )}

      <section className="human-input-section" aria-labelledby="human-input-heading">
        <div className="human-input-heading">
          <div>
            <span className="inspector-kicker">人类输入</span>
            <h3 id="human-input-heading">你的补充</h3>
          </div>
          <small>保存为补充记录</small>
        </div>

        <form className="human-input-form" onSubmit={submit}>
          <div className="human-kind-switch" aria-label="补充类型">
            {kindOptions.map((option) => (
              <button
                type="button"
                className={kind === option.value ? 'is-active' : ''}
                aria-pressed={kind === option.value}
                disabled={busy || submitting}
                onClick={() => setKind(option.value)}
                key={option.value}
              >
                {option.label}
              </button>
            ))}
          </div>
          <label>
            <span>内容</span>
            <textarea
              value={body}
              onChange={(event) => updateBody(event.target.value)}
              placeholder="写下希望后续工作参考的内容。"
              rows={4}
              maxLength={4000}
              disabled={busy || submitting}
            />
          </label>
          <div className="human-file-picker">
            <input ref={fileInputRef} type="file" multiple onChange={addFiles} disabled={busy || submitting} tabIndex={-1} aria-hidden="true" />
            <button className="quiet-button compact" type="button" onClick={() => fileInputRef.current?.click()} disabled={busy || submitting}>
              <Paperclip size={14} /> 添加文件
            </button>
            <span>单个 ≤ 10 MiB，最多 10 个，总计 ≤ 20 MiB</span>
          </div>
          {fileError && <p className="inline-error" role="alert">{fileError}</p>}
          {files.length > 0 && (
            <ul className="human-file-list" aria-label="待上传文件">
              {files.map((file, index) => (
                <li key={`${file.name}-${file.size}-${file.lastModified}-${index}`}>
                  <span title={file.name}>{file.name}</span><small>{formatFileSize(file.size)}</small>
                  <button type="button" onClick={() => removeFile(index)} disabled={busy || submitting} aria-label={`移除 ${file.name}`}>移除</button>
                </li>
              ))}
            </ul>
          )}
          {submitError && <p className="inline-error" role="alert">没有保存成功，内容仍保留在这里。</p>}
          <div className="human-input-actions">
            <span>{body.length} / 4000{files.length > 0 ? ` · ${files.length} 个文件` : ''}</span>
            <button className="primary-button compact" type="submit" disabled={(!body.trim() && files.length === 0) || busy || submitting}>
              {submitting ? (files.length > 0 ? '上传中…' : '保存中…') : '留下补充'}
            </button>
          </div>
        </form>

        {scopedInputs.length > 0 && <div className="human-history">
          <div className="section-title"><h3>最近补充</h3><span>{scopedInputs.length}</span></div>
          <ol>
              {visibleInputs.map((item) => (
                <li key={item.id}>
                  <div><b>{kindLabel[item.kind]}</b><span>{item.nodeId ? (item.nodeId === node?.id ? '当前节点' : `来源节点：${board.nodes.find((source) => source.id === item.nodeId)?.title ?? item.nodeId}`) : '项目'} · {inputSourceLabel(item)}</span><time dateTime={item.createdAt}>{formatRecordTime(item.createdAt)}</time></div>
                  {item.body.trim() && <ReadableText text={item.body} />}
                  {item.attachments && item.attachments.length > 0 && (
                    <ul className="input-attachments" aria-label="附件">
                      {item.attachments.map((attachment) => (
                        <li key={attachment.id}>
                          <a href={`/api/attachments/${encodeURIComponent(attachment.id)}`} download={attachment.name} title={`下载 ${attachment.name}`}>
                            <span>{attachment.name}</span><small>{formatFileSize(attachment.size)}</small>
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                  {item.source && <small className="input-source">来源 {item.source.ref} · 记录 {item.source.recordedBy}</small>}
                  {item.responses?.filter((response) => !node || !item.nodeId || item.nodeId === node.id || response.affectedNodeIds.includes(node.id)).map((response) => (
                    <div className="input-response" key={response.id}>
                      <div><b>Agent 处理回应</b><span>{response.owner} · {response.disposition === 'applied' ? '已采纳' : response.disposition === 'needs-clarification' ? '需要澄清' : '未采纳'}</span><time dateTime={response.createdAt}>{formatRecordTime(response.createdAt)}</time></div>
                      <ReadableText text={response.body} />
                      {response.affectedNodeIds.length > 0 && <p className="affected-nodes">影响节点：{response.affectedNodeIds.map((id) => <button type="button" key={id} onClick={() => onSelectNode(id)}>{board.nodes.find((item) => item.id === id)?.title ?? id}</button>)}</p>}
                    </div>
                  ))}
                </li>
              ))}
          </ol>
          {scopedInputs.length > 8 && (
            <button className="history-toggle" type="button" onClick={() => setShowAllInputs((value) => !value)}>
              {showAllInputs ? '收起较早记录' : `查看更早的 ${scopedInputs.length - 8} 条`}
            </button>
          )}
        </div>}
      </section>
      <footer className="inspector-identity" aria-label="内部身份">
        <span>内部 ID</span>
        <button type="button" onClick={() => void copyValue(identity)} aria-label={`复制内部 ID ${identity}`} title="复制内部 ID">
          <code>{identity}</code>{copied === identity ? <Check size={13} /> : copyError === identity ? <CircleAlert size={13} /> : <Copy size={13} />}
        </button>
      </footer>
    </aside>
  );
}
