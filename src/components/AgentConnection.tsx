import { useEffect, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, LoaderCircle, Plug, RefreshCw, X } from 'lucide-react';
import type { Project } from '../types';
import './agent-connection.css';

interface Profile {
  id: string; host: string; enabled: boolean; scope: string; projectId: string | null;
  installation: string; message?: string; viewUrl?: string; pluginRoot: string; mcpConfigPath: string;
  verification: { read: boolean; write: boolean; readback: boolean; verifiedAt: string | null };
  hooksObserved: boolean; sessionCount: number; lastSeen: string | null;
  scopeInvalid?: boolean;
}
interface Status { boardInstanceId: string; hosts: Array<{ host: string; name: string; available: boolean }>; profiles: Profile[] }
const labels: Record<string, string> = { codex: 'Codex', 'claude-code': 'Claude Code', hermes: 'Hermes', mcp: '其他 Agent' };
async function api<T>(action = '', body?: object): Promise<T> {
  const response = await fetch(`/api/onboarding${action ? `/${action}` : ''}`, body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-JarviSync-UI': '1' }, body: JSON.stringify(body),
  } : undefined);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '接入操作未完成。');
  return value;
}
const verifyPrompt = '请验证 JarviSync 是否可以使用：在独立验证区依次读取、写入、读回，不创建正式项目。';

export function AgentConnection({ projects, activeProjectId, onClose }: { projects: Project[]; activeProjectId: string | null; onClose: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [host, setHost] = useState('codex');
  const [scope, setScope] = useState('work');
  const [projectId, setProjectId] = useState(activeProjectId || projects[0]?.id || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [editingScope, setEditingScope] = useState(false);
  const modal = useRef<HTMLElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const profile = status?.profiles.find(p => p.host === host);
  const hostInfo = status?.hosts.find(h => h.host === host);
  useEffect(() => { setEditingScope(false); }, [host]);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key !== 'Tab') return;
      const items = Array.from(modal.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input, select, textarea') || []);
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, [onClose]);
  useEffect(() => {
    let cancelled = false;
    const refresh = async () => { try { const next = await api<Status>(); if (!cancelled) setStatus(next); } catch (e) { if (!cancelled) setError((e as Error).message); } };
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);
  async function perform(action: string, body: object) {
    setBusy(true); setError('');
    try { await api(action, body); setStatus(await api<Status>()); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function copyPrompt() {
    try { await navigator.clipboard.writeText(verifyPrompt); setCopied(true); }
    catch { setError('复制未完成，请选中下面的验证文字复制。'); }
  }
  return <div className="connection-backdrop">
    <section className="connection-dialog" role="dialog" aria-modal="true" aria-labelledby="connection-title" ref={modal}>
      <header className="connection-header"><div><span className="connection-eyebrow"><Plug size={14} />从你的对话继续</span><h2 id="connection-title">接入我的 Agent</h2></div><button className="icon-button" ref={closeButton} onClick={onClose} aria-label="关闭接入窗口"><X size={20}/></button></header>
      <p className="connection-intro">沿用你已有的 Agent 和账号。完成一次接入后，在对话里交办工作，这里保留进展和成果。</p>
      <div className="connection-hosts" aria-label="选择 Agent">{Object.entries(labels).map(([key,label]) => <button key={key} className={host === key ? 'is-selected' : ''} aria-pressed={host === key} onClick={() => { setHost(key); setError(''); setCopied(false); }} disabled={busy}>{label}{status?.profiles.find(p => p.host === key)?.verification.readback && <Check size={14}/>}</button>)}</div>
      {host === 'claude-code' && <p className="connection-note">Claude Code 当前无法把所有用户中断通知看板。需要立即阻止后续写回时，请在这里停用此接入。</p>}
      {error && <p className="connection-error" role="alert">{error}</p>}
      {!status ? <p className="connection-loading"><LoaderCircle className="spin" size={17}/>正在读取本机接入状态…</p> : !profile ? <>
        <fieldset className="connection-scope"><legend>哪些工作记到看板</legend>
          <label><input type="radio" name="scope" checked={scope === 'work'} onChange={() => setScope('work')}/><span><strong>明确交办的工作</strong><small>普通问答、未确认的想法，以及你说“不记录”的内容不建档。</small></span></label>
          <label><input type="radio" name="scope" checked={scope === 'project'} onChange={() => setScope('project')}/><span><strong>仅记录一个项目</strong><small>接入只允许写入你选择的项目。</small></span></label>
          {scope === 'project' && <select aria-label="选择记录项目" value={projectId} onChange={e => setProjectId(e.target.value)}><option value="">请选择项目</option>{projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}</select>}
        </fieldset>
        <p className="connection-footnote">{host === 'mcp' ? '通用接入提供读写工具。是否自动关联工作取决于宿主；不包含原生会话检查。' : `${labels[host]} 将安装本地接入工具、使用约定和会话检查。宿主要求的信任确认仍在宿主内完成。`}</p>
        <button className="primary-button" onClick={() => void perform('prepare', { host, scope, projectId })} disabled={busy || scope === 'project' && !projectId}>{busy ? <LoaderCircle className="spin" size={16}/> : <Plug size={16}/>}准备接入</button>
      </> : <>
        <div className="connection-status"><span className={`connection-state-dot ${profile.enabled && !profile.scopeInvalid && profile.verification.readback ? 'is-ready' : ''}`}/><strong>{!profile.enabled ? '已停用' : profile.scopeInvalid ? '需要重新选择项目' : profile.verification.readback ? '工具读写已验证' : profile.installation === 'prepared' ? '接入包已准备' : '等待宿主确认与验证'}</strong><span>{profile.scope === 'project' ? `仅记录：${projects.find(p => p.id === profile.projectId)?.title || '原项目已不可用'}` : '记录明确交办的工作'}</span></div>
        {(editingScope || profile.scopeInvalid) && <fieldset className="connection-scope connection-scope-edit"><legend>修改记录范围</legend>
          <label><input type="radio" name="edit-scope" checked={scope === 'work'} onChange={() => setScope('work')}/><span><strong>明确交办的工作</strong><small>普通问答和你说“不记录”的内容不建档。</small></span></label>
          <label><input type="radio" name="edit-scope" checked={scope === 'project'} onChange={() => setScope('project')}/><span><strong>仅记录一个项目</strong></span></label>
          {scope === 'project' && <select aria-label="重新选择记录项目" value={projectId} onChange={e => setProjectId(e.target.value)}><option value="">请选择项目</option>{projects.map(project => <option key={project.id} value={project.id}>{project.title}</option>)}</select>}
          <button className="primary-button compact" disabled={busy || scope === 'project' && !projectId} onClick={() => { void perform('configure', { profileId: profile.id, scope, projectId }).then(() => setEditingScope(false)); }}>保存记录范围</button>
        </fieldset>}
        {profile.enabled ? <>
          <ol className="connection-steps">
            <li><span className="connection-step-index">1</span><div><h3>在 {labels[host]} 中启用</h3><p>{profile.message || (host === 'mcp' ? '在宿主的 MCP 导入入口选择下方配置文件。' : '点击安装后，接入包会添加到本机宿主；已有账号与其他配置保留。')}</p>
              {host !== 'mcp' && <button className="primary-button compact" disabled={busy || !hostInfo?.available} onClick={() => void perform('install', { profileId: profile.id })}>{busy ? <LoaderCircle className="spin" size={14}/> : <Plug size={14}/>} {profile.installation === 'prepared' ? `安装到 ${labels[host]}` : '重新安装接入'}</button>}
              {host !== 'mcp' && !hostInfo?.available && <p className="connection-note">本机尚未找到 {labels[host]} 命令行。安装宿主后可回来继续。</p>}
              {host === 'codex' && profile.viewUrl && <a className="connection-link" href={profile.viewUrl}>在 Codex 查看接入包 <ExternalLink size={13}/></a>}
              {host === 'codex' && <p className="connection-note">安装后，在 Codex 的 /hooks 中核对并信任 JarviSync，再重新打开对话。</p>}
            </div></li>
            <li><span className="connection-step-index">2</span><div><h3>由 Agent 验证读写</h3><p>在重新打开的对话中发送下面这句话。验证记录单独保存。</p><div className="connection-prompt"><p>{verifyPrompt}</p><button className="icon-button" aria-label="复制验证文字" onClick={() => void copyPrompt()}>{copied ? <Check size={16}/> : <Copy size={16}/>}</button></div><div className="connection-checks">{[['读取',profile.verification.read],['写入',profile.verification.write],['读回',profile.verification.readback]].map(([label,done]) => <span key={String(label)} className={done ? 'is-complete' : ''}>{done ? <Check size={13}/> : <span className="check-empty"/>}{label}</span>)}</div></div></li>
            <li><span className="connection-step-index">3</span><div><h3>从平常的工作开始</h3><p>另开对话，正常交办一项工作，再回看板确认它是否关联了正确项目。仅通过上面的读写验证，还不能证明自动接入已经生效。</p><small>{profile.hooksObserved ? '已收到宿主会话入口；普通任务的自动关联仍以实际记录为准。' : '尚未收到原生会话入口。'}{profile.lastSeen && ` 最近连接：${new Date(profile.lastSeen).toLocaleString('zh-CN')}`}</small></div></li>
          </ol>
          <details className="connection-details"><summary>查看本机接入位置</summary><p>{host === 'mcp' ? profile.mcpConfigPath : profile.pluginRoot}</p><p>该接入只连接当前本机看板。云端 Agent 无法直接使用本机地址。</p></details>
        </> : <p className="connection-footnote">已停止此接入的读写。重新启用即可恢复，已有项目与成果仍保留。</p>}
        <footer className="connection-footer"><button className="quiet-button" disabled={busy} onClick={() => void perform('enable', { profileId: profile.id, enabled: !profile.enabled })}>{profile.enabled ? '停用此接入' : '重新启用'}</button><button className="quiet-button" disabled={busy} onClick={() => { setScope(profile.scope); setProjectId(profile.projectId || activeProjectId || projects[0]?.id || ''); setEditingScope(value => !value); }}>修改记录范围</button><button className="quiet-button" disabled={busy} onClick={() => { void api<Status>().then(setStatus).catch(e => setError(e.message)); }}><RefreshCw size={14}/>刷新验证结果</button></footer>
      </>}
    </section>
  </div>;
}
