import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Archive,
  Columns3,
  Download,
  FileText,
  GitBranch,
  List,
  LoaderCircle,
  LayoutGrid,
  Moon,
  Plug,
  RefreshCw,
  Sun,
  X,
} from 'lucide-react';
import { ApiError, applyHumanChange, getBoard, submitHumanInputWithAttachments } from './client';
import { Inspector } from './components/Inspector';
import { NodeCanvas } from './components/NodeCanvas';
import { NodeList } from './components/NodeList';
import { ProjectSidebar } from './components/ProjectSidebar';
import { DeleteProjectDialog } from './components/DeleteProjectDialog';
import { AgentConnection } from './components/AgentConnection';
import { DesktopWindowControls } from './components/DesktopWindowControls';
import { ProjectNumber } from './components/ProjectNumber';
import { ProjectStatus } from './components/ProjectStatus';
import { projectStatus } from './project-status';
import { filterNodeIds, overviewFor, type SummaryFilter } from './collaboration-view';
import type { Board, HumanChange, HumanInputKind, WorkNode } from './types';
import { layoutNodes } from './layout';
import { initialBoardView, orderedListNodes, preferredProject, type BoardView, type ListOrder } from './view-preferences';

type Theme = 'light' | 'dark';
type Notice = { message: string; kind: 'success' | 'attention' };

function readPreference(key: string) {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function initialTheme(): Theme {
  const stored = readPreference('jarvisync.theme');
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function App() {
  const [board, setBoard] = useState<Board | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [notice, updateNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [humanDraftDirty, setHumanDraftDirty] = useState(false);
  const [removingProjectId, setRemovingProjectId] = useState<string | null>(null);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [removeProjectError, setRemoveProjectError] = useState('');
  const [view, setView] = useState<BoardView>(() => initialBoardView(readPreference('nodeboard.view'), window.innerWidth > 0 && window.matchMedia('(max-width: 760px)').matches));
  const [listOrder, setListOrder] = useState<ListOrder>(() => readPreference('nodeboard.listOrder') === 'updated' ? 'updated' : 'dependency');
  const [layoutFitRevision, setLayoutFitRevision] = useState(0);
  const [showArchived, setShowArchived] = useState(false);
  const [summaryFilter, setSummaryFilter] = useState<SummaryFilter | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth === 0 || !window.matchMedia('(max-width: 760px)').matches);
  const [theme, setTheme] = useState<Theme>(() => {
    const value = initialTheme();
    document.documentElement.dataset.theme = value;
    return value;
  });
  const busyRef = useRef(false);
  const refreshingRef = useRef(false);
  const revisionRef = useRef(0);
  const boardRef = useRef<Board | null>(null);
  const humanDraftDirtyRef = useRef(false);

  function setNotice(message: string | null, kind: Notice['kind'] = 'attention') {
    updateNotice(message === null ? null : { message, kind });
  }

  useEffect(() => {
    if (notice?.kind !== 'success') return;
    const timer = window.setTimeout(() => {
      updateNotice((current) => current === notice ? null : current);
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  boardRef.current = board;

  const projects = useMemo(() => board?.projects.filter((project) => !project.archived) ?? [], [board]);
  const activeProject = board?.projects.find((project) => project.id === activeProjectId) ?? null;
  const allProjectNodes = useMemo(
    () => board?.nodes.filter((node) => node.projectId === activeProjectId) ?? [],
    [board, activeProjectId],
  );
  const activeOverview = useMemo(
    () => board && activeProject ? overviewFor(board, activeProject.id) : null,
    [board, activeProject],
  );
  const visibleNodes = useMemo(() => {
    const archivedFiltered = allProjectNodes.filter((node) => showArchived || !node.archived);
    if (!board || !activeProject || activeProject.archived || !summaryFilter) return archivedFiltered;
    const includedIds = filterNodeIds(board, activeProject, summaryFilter);
    return archivedFiltered.filter((node) => includedIds.has(node.id));
  }, [allProjectNodes, activeProject, board, showArchived, summaryFilter]);
  const visibleNodeIds = useMemo(() => new Set(visibleNodes.map((node) => node.id)), [visibleNodes]);
  const visibleEdges = useMemo(
    () => board?.edges.filter((edge) => edge.projectId === activeProjectId && visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)) ?? [],
    [board, activeProjectId, visibleNodeIds],
  );
  const listNodes = useMemo(() => orderedListNodes(visibleNodes, visibleEdges, listOrder), [visibleNodes, visibleEdges, listOrder]);
  const selectedNode = allProjectNodes.find((node) => node.id === selectedNodeId) ?? null;
  const projectHumanInputs = useMemo(
    () => board?.humanInputs?.filter((input) => input.projectId === activeProjectId) ?? [],
    [board, activeProjectId],
  );

  useEffect(() => {
    if (activeProject?.archived) setSummaryFilter(null);
  }, [activeProject?.id, activeProject?.archived]);

  useEffect(() => {
    // Follow the selected task when a writeback changes its phase. In particular,
    // do not unmount an inspector with an unsaved human draft to preserve a filter.
    if (summaryFilter && selectedNodeId && selectedNode && !visibleNodeIds.has(selectedNodeId)) {
      setSummaryFilter(null);
      if (selectedNode.archived) setShowArchived(true);
    }
  }, [summaryFilter, selectedNodeId, selectedNode, visibleNodeIds]);

  function updateHumanDraftDirty(dirty: boolean) {
    humanDraftDirtyRef.current = dirty;
    setHumanDraftDirty(dirty);
  }

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { window.localStorage.setItem('jarvisync.theme', theme); } catch { /* Theme still applies for this session. */ }
  }, [theme]);

  useEffect(() => {
    if (!humanDraftDirty) return;
    const protectDraft = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', protectDraft);
    return () => window.removeEventListener('beforeunload', protectDraft);
  }, [humanDraftDirty]);

  useEffect(() => {
    if (!board) return;
    try {
      if (activeProjectId) window.localStorage.setItem('nodeboard.project', activeProjectId);
      else window.localStorage.removeItem('nodeboard.project');
      if (selectedNodeId) window.localStorage.setItem('nodeboard.node', selectedNodeId);
      else window.localStorage.removeItem('nodeboard.node');
    } catch { /* UI preference storage can be unavailable without affecting board data. */ }
  }, [board, activeProjectId, selectedNodeId]);

  useEffect(() => {
    if (!board || busy) return;
    const refresh = () => {
      if (document.visibilityState === 'visible') void load(undefined, true, true);
    };
    const timer = window.setInterval(refresh, 15_000);
    window.addEventListener('focus', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [board?.revision, activeProjectId, selectedNodeId, busy]);

  async function load(signal?: AbortSignal, preserveSelection = false, quiet = false) {
    if (refreshingRef.current || busyRef.current) return;
    refreshingRef.current = true;
    if (!quiet) setLoading(true);
    if (!quiet) setLoadError(null);
    try {
      const next = await getBoard(signal);
      const currentProjectInNext = preserveSelection && activeProjectId
        ? next.projects.find((project) => project.id === activeProjectId)
        : null;
      if (humanDraftDirtyRef.current && preserveSelection && activeProjectId && currentProjectInNext?.archived && !boardRef.current?.projects.find(project => project.id === activeProjectId)?.archived) {
        revisionRef.current = next.revision;
        setConflict(false);
        setNotice('当前项目已被 Agent 归档。补充仍属于原项目，可继续保存；清空后刷新查看归档记录。');
        return;
      }
      if (humanDraftDirtyRef.current && preserveSelection && activeProjectId && !currentProjectInNext) {
        setNotice('当前项目已不存在，无法继续保存。请先复制正文并保留原始文件，再清空补充并刷新。');
        return;
      }
      boardRef.current = next;
      setBoard(next);
      revisionRef.current = next.revision;
      setConflict(false);

      const preferredProjectId = preserveSelection ? activeProjectId : readPreference('nodeboard.project');
      const currentProject = next.projects.find(project => project.id === preferredProjectId) ?? preferredProject(next.projects, null);
      const projectChanged = currentProject?.id !== activeProjectId;
      if (!preserveSelection || !activeProjectId || projectChanged) {
        setActiveProjectId(currentProject?.id ?? null);
        setSummaryFilter(null);
      }

      if (!preserveSelection || projectChanged) {
        const preferredNodeId = preserveSelection && projectChanged ? null : readPreference('nodeboard.node');
        const restoredNode = next.nodes.find((node) => node.projectId === currentProject?.id && node.id === preferredNodeId) ?? null;
        setSelectedNodeId(restoredNode?.id ?? null);
        setSelectedEdgeId(null);
        setInspectorOpen(Boolean(restoredNode));
        updateHumanDraftDirty(false);
        if (restoredNode?.archived) setShowArchived(true);
      } else if (selectedNodeId) {
        const freshNode = next.nodes.find((node) => node.projectId === currentProject?.id && node.id === selectedNodeId);
        if (!freshNode && !humanDraftDirtyRef.current) {
          setSelectedNodeId(null);
          setInspectorOpen(false);
        } else if (freshNode?.archived) {
          setShowArchived(true);
        }
      }

      if (preserveSelection && !quiet) {
        setNotice(humanDraftDirtyRef.current ? '已刷新本地数据。未提交的人工补充仍在。' : '已刷新本地数据。', 'success');
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (!quiet) {
        const message = error instanceof Error ? error.message : '无法读取项目数据。';
        setLoadError(message);
        if (boardRef.current) setNotice(`刷新失败：${message}`);
      }
    } finally {
      refreshingRef.current = false;
      if (!quiet) setLoading(false);
    }
  }

  async function commit(change: HumanChange, files: File[] = []): Promise<Board | null> {
    if (!boardRef.current || busyRef.current || refreshingRef.current || conflict) {
      if (conflict) setNotice('数据版本需要核对。请先刷新；未提交的人工补充会保留。');
      else if (refreshingRef.current) setNotice('正在读取最新数据，请稍候。');
      return null;
    }
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const next = change.type === 'human.input.add' && files.length > 0
        ? await submitHumanInputWithAttachments(revisionRef.current, { ...change, files })
        : await applyHumanChange(revisionRef.current, change);
      revisionRef.current = next.revision;
      boardRef.current = next;
      setBoard(next);
      setConflict(false);
      return next;
    } catch (error) {
      const isConflict = error instanceof ApiError && error.status === 409;
      setConflict(isConflict);
      setNotice(isConflict
        ? '数据已被 Agent 更新。请刷新后再提交；人工补充仍保留。'
        : `保存失败：${error instanceof Error ? error.message : '网络不可用'}。人工补充仍保留。`);
      return null;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function guardNavigation() {
    if (busyRef.current) {
      setNotice('正在保存，请稍候。');
      return false;
    }
    if (humanDraftDirty) {
      setNotice('当前补充尚未提交。请先保存，或清空正文并移除文件。');
      return false;
    }
    if (notice?.message === '当前补充尚未提交。请先保存，或清空正文并移除文件。') setNotice(null);
    return true;
  }

  function chooseView(value: BoardView) {
    setView(value);
    try { window.localStorage.setItem('nodeboard.view', value); } catch { /* Session preference still applies. */ }
  }

  function chooseListOrder(value: ListOrder) {
    setListOrder(value);
    try { window.localStorage.setItem('nodeboard.listOrder', value); } catch { /* Session preference still applies. */ }
  }

  async function moveNode(id: string, position: { x: number; y: number }) {
    const next = await commit({ type: 'node.move', id, position });
    return Boolean(next);
  }

  async function organizeNodes() {
    if (!activeProject || !board) return;
    try {
      const nodes = allProjectNodes.filter(node => !node.archived);
      const positions = layoutNodes(nodes, board.edges.filter(edge => edge.projectId === activeProject.id));
      const next = await commit({ type: 'nodes.layout', projectId: activeProject.id, positions });
      if (next) {
        setSummaryFilter(null);
        setLayoutFitRevision(value => value + 1);
        setNotice('已整理并保存全部未归档节点，可继续拖动微调。', 'success');
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : '暂时无法整理节点。');
    }
  }

  function selectProject(id: string) {
    if (id === activeProjectId) {
      if (window.matchMedia('(max-width: 760px)').matches) setSidebarOpen(false);
      return;
    }
    if (!guardNavigation()) return;
    const project = boardRef.current?.projects.find((item) => item.id === id);
    if (!project) return;
    setActiveProjectId(id);
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setInspectorOpen(false);
    updateHumanDraftDirty(false);
    setShowArchived(false);
    setSummaryFilter(null);
    if (window.matchMedia('(max-width: 760px)').matches) setSidebarOpen(false);
  }

  function openProjectOverview() {
    if (!activeProject || (inspectorOpen && !selectedNodeId)) return;
    if (!guardNavigation()) return;
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    setInspectorOpen(true);
    updateHumanDraftDirty(false);
    if (window.matchMedia('(max-width: 760px)').matches) setSidebarOpen(false);
  }

  function selectNode(id: string) {
    if (id === selectedNodeId && inspectorOpen) return;
    if (!guardNavigation()) return;
    const node = allProjectNodes.find((item) => item.id === id);
    if (!node) return;
    if (!visibleNodeIds.has(id)) setSummaryFilter(null);
    setSelectedNodeId(id);
    setSelectedEdgeId(null);
    setInspectorOpen(true);
    updateHumanDraftDirty(false);
    if (node.archived) setShowArchived(true);
  }

  function closeInspector() {
    if (!guardNavigation()) return;
    setInspectorOpen(false);
    setSelectedNodeId(null);
    updateHumanDraftDirty(false);
  }

  async function createProjectGroup(title: string) {
    const next = await commit({ type: 'project.group.create', title });
    if (next) setNotice('分组已创建，可以把项目拖进来。', 'success');
    return Boolean(next);
  }

  async function renameProjectGroup(id: string, title: string) {
    const next = await commit({ type: 'project.group.rename', id, title });
    if (next) setNotice('分组名称已保存。', 'success');
    return Boolean(next);
  }

  async function removeProjectGroup(id: string) {
    const next = await commit({ type: 'project.group.remove', id });
    if (next) setNotice('分组已移除，组内项目已放回“未分组”。', 'success');
    return Boolean(next);
  }

  async function moveProject(id: string, groupId: string | null, beforeId?: string | null) {
    const next = await commit({ type: 'project.move', id, groupId, beforeId });
    if (next) setNotice('项目位置已保存。', 'success');
    return Boolean(next);
  }

  function requestRemoveProject(id: string) {
    if (id === activeProjectId && !guardNavigation()) return;
    if (busyRef.current || !boardRef.current?.projects.some(project => project.id === id)) return;
    setRemoveProjectError('');
    setRemovingProjectId(id);
  }

  async function archiveProject(id: string, archived: boolean) {
    if (id === activeProjectId && !guardNavigation()) return false;
    const next = await commit({ type: 'project.archive', id, archived });
    if (next) setNotice(archived ? '项目已归档，记录保留，可随时恢复。' : '项目已恢复。', 'success');
    return Boolean(next);
  }

  async function removeProject() {
    const id = removingProjectId;
    if (!id || (id === activeProjectId && !guardNavigation())) return;
    setRemoveProjectError('');
    const next = await commit({ type: 'project.remove', id });
    if (!next) {
      setRemoveProjectError('删除未成功。请取消后刷新核对，再重试。');
      return;
    }
    setRemovingProjectId(null);
    if (id === activeProjectId) {
      setActiveProjectId(preferredProject(next.projects, null)?.id ?? null);
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
      setInspectorOpen(false);
      setShowArchived(false);
      updateHumanDraftDirty(false);
    }
    setNotice('项目已删除。', 'success');
  }

  async function submitHumanInput(kind: HumanInputKind, body: string, files: File[]) {
    if (!activeProject) return false;
    const cleanBody = body.trim();
    if ((!cleanBody && files.length === 0) || cleanBody.length > 4000) {
      setNotice('请填写不超过 4000 个字符的正文，或至少添加一个文件。');
      return false;
    }
    if (files.length > 10 || files.some((file) => file.size > 10 * 1024 * 1024) || files.reduce((total, file) => total + file.size, 0) > 20 * 1024 * 1024) {
      setNotice('附件最多 10 个，单个不超过 10 MiB，总计不超过 20 MiB。');
      return false;
    }

    const next = await commit({
      type: 'human.input.add',
      projectId: activeProject.id,
      ...(selectedNode ? { nodeId: selectedNode.id } : {}),
      kind,
      body: cleanBody,
    }, files);
    if (!next) return false;
    updateHumanDraftDirty(false);
    setNotice('已保存，会出现在 Agent 下次读取上下文。', 'success');
    return true;
  }

  function exportBoard() {
    const blob = new Blob([JSON.stringify(board, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10);
    anchor.href = url;
    anchor.download = `jarvisync-${date}.json`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function toggleArchived() {
    if (showArchived && selectedNode?.archived && !guardNavigation()) return;
    if (showArchived && selectedNode?.archived) {
      setSelectedNodeId(null);
      setInspectorOpen(false);
      updateHumanDraftDirty(false);
    }
    setShowArchived((value) => !value);
  }

  function focusSummary(filter: SummaryFilter) {
    if (!activeProject || !board || !guardNavigation()) return;
    if (summaryFilter === filter) {
      setSummaryFilter(null);
      return;
    }
    const ids = filterNodeIds(board, activeProject, filter);
    setSummaryFilter(filter);
    setSelectedEdgeId(null);
    const firstNode = allProjectNodes.find((node) => ids.has(node.id) && !node.archived);
    if (filter === 'deliveries') {
      setSelectedNodeId(null);
      setInspectorOpen(true);
    } else if (firstNode) {
      setSelectedNodeId(firstNode.id);
      setInspectorOpen(true);
    } else {
      setSelectedNodeId(null);
      setInspectorOpen(filter === 'attention');
    }
  }

  const relatedInputs = selectedNode && board ? board.edges
    .filter((edge) => edge.projectId === activeProjectId && edge.target === selectedNode.id)
    .map((edge) => ({ edge, node: board.nodes.find((node) => node.id === edge.source) }))
    .filter((item): item is { edge: typeof item.edge; node: WorkNode } => Boolean(item.node)) : [];
  const relatedOutputs = selectedNode && board ? board.edges
    .filter((edge) => edge.projectId === activeProjectId && edge.source === selectedNode.id)
    .map((edge) => ({ edge, node: board.nodes.find((node) => node.id === edge.target) }))
    .filter((item): item is { edge: typeof item.edge; node: WorkNode } => Boolean(item.node)) : [];

  if (loading && !board) {
    return <div className="desktop-app"><DesktopWindowControls /><main className="center-state"><LoaderCircle className="spin" size={28} /><p>正在读取本地项目…</p></main></div>;
  }

  if (!board) {
    return (
      <div className="desktop-app">
        <DesktopWindowControls />
        <main className="center-state error-state">
          <AlertTriangle size={28} />
          <h1>无法打开 JarviSync</h1>
          <p>{loadError || '本地服务没有返回数据。'}</p>
          <button className="primary-button" type="button" onClick={() => void load()}>重新读取</button>
        </main>
      </div>
    );
  }

  return (
    <div className="desktop-app">
      <DesktopWindowControls />
      <div className={`app-shell ${sidebarOpen ? 'sidebar-open' : 'sidebar-closed'}`}>
      <ProjectSidebar
        projects={board.projects}
        nodes={board.nodes}
        groups={board.projectGroups ?? []}
        activeProjectId={activeProjectId}
        busy={busy}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onToggle={() => setSidebarOpen((value) => !value)}
        onSelect={selectProject}
        onOpenProject={openProjectOverview}
        onCreateGroup={createProjectGroup}
        onRenameGroup={renameProjectGroup}
        onRemoveGroup={removeProjectGroup}
        onMoveProject={moveProject}
        onRemoveProject={requestRemoveProject}
        onArchiveProject={archiveProject}
      />

      <main className="workspace">
        <header className="topbar">
          <div className="project-identity">
            <span>当前项目</span>
            <div className="project-title-stack">
              <h1>{activeProject?.title ?? '选择一个项目'}</h1>
              {activeProject && <div className="project-title-status"><ProjectNumber value={activeProject.projectNumber} active /><ProjectStatus status={projectStatus(activeProject, board.nodes)} /></div>}
            </div>
            {activeProject?.demo && <b className="demo-banner">示例数据</b>}
          </div>
          <div className="save-state" aria-live="polite">
            {busy ? <><LoaderCircle className="spin" size={15} />保存中</> : conflict ? <><AlertTriangle size={15} />需要核对</> : <><span />已保存</>}
          </div>
          <div className="topbar-tools">
            <button className="agent-connect-button" type="button" onClick={() => setConnectionOpen(true)} aria-label="接入我的 Agent"><Plug size={16}/><span>接入我的 Agent</span></button>
            <button
              className="icon-button"
              type="button"
              onClick={() => setTheme((value) => value === 'light' ? 'dark' : 'light')}
              aria-label={theme === 'light' ? '切换到深色模式' : '切换到浅色模式'}
              title={theme === 'light' ? '切换到深色模式' : '切换到浅色模式'}
            >
              {theme === 'light' ? <Moon size={17} /> : <Sun size={17} />}
            </button>
            <button className="icon-button" type="button" onClick={() => void load(undefined, true)} disabled={loading || busy} aria-label="刷新数据" title={humanDraftDirty ? '刷新数据，保留未提交的人工补充' : '刷新数据'}><RefreshCw className={loading ? 'spin' : ''} size={17} /></button>
            <button className="icon-button" type="button" onClick={exportBoard} aria-label="导出看板记录（不含附件原件）" title="导出看板记录（不含附件原件）"><Download size={17} /></button>
          </div>
        </header>

        {activeProject?.archived && <div className="project-archive-banner">
          <span><Archive size={15} />项目已归档，记录保留。</span>
          <button type="button" className="quiet-button" disabled={busy || loading || conflict} onClick={() => void archiveProject(activeProject.id, false)}>恢复项目</button>
        </div>}
        {notice && (
          <div className={`notice ${notice.kind === 'attention' ? 'is-warning' : ''}`} role="status" aria-live="polite">
            <span>{notice.message}</span>
            {conflict && <button type="button" onClick={() => void load(undefined, true)} disabled={loading}><RefreshCw size={15} />刷新核对</button>}
            {!conflict && <button className="icon-button" type="button" onClick={() => setNotice(null)} aria-label="关闭提示"><X size={15} /></button>}
          </div>
        )}

        <div className={`work-area ${inspectorOpen && activeProject ? 'has-inspector' : ''}`}>
          <section className="board-panel" aria-label="项目节点">
            {activeProject && !activeProject.archived && activeOverview && (
              <div className="collaboration-summary" aria-label="协作摘要">
                <button type="button" className={`summary-filter ${summaryFilter === 'doing' ? 'is-active' : ''}`} onClick={() => focusSummary('doing')}>
                  <span>进行中</span><strong>{activeOverview.doingIds.length}</strong>
                </button>
                <button type="button" className={`summary-filter ${summaryFilter === 'ready' ? 'is-active' : ''}`} onClick={() => focusSummary('ready')}>
                  <span>可接续</span><strong>{activeOverview.readyIds.length}</strong>
                </button>
                <button type="button" className={`summary-filter ${summaryFilter === 'attention' ? 'is-active' : ''}`} onClick={() => focusSummary('attention')}>
                  <span>需要你</span><strong>{activeOverview.attentionNodeIds.length + activeOverview.clarificationInputIds.length}</strong>
                </button>
                <button type="button" className={`summary-filter ${summaryFilter === 'deliveries' ? 'is-active' : ''}`} onClick={() => focusSummary('deliveries')}>
                  <span>成果</span><strong>{activeOverview.deliveries.length}</strong>
                </button>
                {summaryFilter && <button className="summary-clear" type="button" onClick={() => setSummaryFilter(null)}>清除定位</button>}
              </div>
            )}
            <div className="board-toolbar">
              <div className="view-switch" aria-label="视图模式">
                <button type="button" className={view === 'canvas' ? 'is-active' : ''} onClick={() => chooseView('canvas')}><GitBranch size={16} />画布</button>
                <button type="button" className={view === 'list' ? 'is-active' : ''} onClick={() => chooseView('list')}><List size={16} />列表</button>
              </div>
              <div className="toolbar-actions">
                {view === 'list' && <select className="list-order" aria-label="列表排序" value={listOrder} onChange={event => chooseListOrder(event.target.value as ListOrder)}><option value="dependency">依赖顺序</option><option value="updated">最近更新</option></select>}
                {view === 'canvas' && activeProject && !activeProject.archived && <button className="quiet-button" type="button" onClick={() => void organizeNodes()} disabled={busy || loading || conflict || !allProjectNodes.some(node => !node.archived)} title="整理并保存全部未归档节点的位置"><LayoutGrid size={15} />一键整理</button>}
                {allProjectNodes.some((node) => node.archived) && (
                  <button className={`quiet-button ${showArchived ? 'is-active' : ''}`} type="button" onClick={toggleArchived}>
                    <Columns3 size={15} />{showArchived ? '隐藏归档' : '查看归档'}
                  </button>
                )}
                {activeProject && (
                  <button className="quiet-button project-overview-trigger" type="button" onClick={openProjectOverview} disabled={busy} title="打开项目说明与成果"><FileText size={15} aria-hidden="true" />项目概览</button>
                )}
              </div>
            </div>

            {!activeProject ? (
              <div className="empty-board"><div className="empty-glyph"><GitBranch size={24} /></div><h2>从对话开始</h2><p>先接入你的 Agent，再在对话里交办工作。项目、进展与成果会记到这里。</p><button className="primary-button" onClick={() => setConnectionOpen(true)}><Plug size={16}/>接入我的 Agent</button></div>
            ) : visibleNodes.length === 0 ? (
              <div className="empty-board">
                <div className="empty-glyph"><GitBranch size={24} /></div>
                <h2>{showArchived || summaryFilter ? '没有可显示的节点' : '项目画布还是空的'}</h2>
                <p>{showArchived ? '恢复正常节点视图继续查看。' : summaryFilter ? '此定位下暂时没有节点。清除定位查看全部节点，或在右侧查看项目记录。' : '在当前对话说明下一步，执行节点会由 Agent 写入；你也可以先补充项目目标、材料或反馈。'}</p>
                {!showArchived && <button className="primary-button" type="button" onClick={summaryFilter ? () => setSummaryFilter(null) : openProjectOverview}>{summaryFilter ? '清除定位' : '打开项目概览'}</button>}
              </div>
            ) : view === 'canvas' ? (
              <NodeCanvas
                key={activeProjectId}
                board={board}
                nodes={visibleNodes}
                edges={visibleEdges}
                selectedNodeId={selectedNodeId}
                selectedEdgeId={selectedEdgeId}
                moveDisabled={busy || loading || conflict || Boolean(activeProject?.archived)}
                layoutFitRevision={layoutFitRevision}
                onMoveNode={moveNode}
                onSelectNode={selectNode}
                onSelectEdge={setSelectedEdgeId}
              />
            ) : (
              <NodeList board={board} nodes={listNodes} edges={visibleEdges} selectedNodeId={selectedNodeId} onSelectNode={selectNode} />
            )}
          </section>

          {inspectorOpen && activeProject && (
            <Inspector
              key={selectedNode?.id ?? activeProject.id}
              project={activeProject}
              board={board}
              node={selectedNode}
              inputs={relatedInputs}
              outputs={relatedOutputs}
              humanInputs={projectHumanInputs}
              busy={busy}
              onClose={closeInspector}
              onSelectNode={selectNode}
              onSubmitInput={submitHumanInput}
              onDraftChange={updateHumanDraftDirty}
            />
          )}
        </div>
      </main>
      {connectionOpen && <AgentConnection projects={projects} activeProjectId={activeProject?.archived ? null : activeProjectId} onClose={() => setConnectionOpen(false)}/>}
      {removingProjectId && (
        <DeleteProjectDialog
          title={board.projects.find(project => project.id === removingProjectId)?.title ?? '已不存在的项目'}
          nodeCount={board.nodes.filter(node => node.projectId === removingProjectId).length}
          busy={busy}
          error={removeProjectError}
          onCancel={() => setRemovingProjectId(null)}
          onConfirm={() => void removeProject()}
        />
      )}
      </div>
    </div>
  );
}

export default App;
