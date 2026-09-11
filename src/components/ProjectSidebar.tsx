import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type MouseEvent, type ReactNode } from 'react';
import {
  ChevronDown, ChevronLeft, ChevronRight, ChevronUp, FolderPen, FolderPlus,
  Archive, ArchiveRestore, GripVertical, MoreHorizontal, Square, Trash2, X,
} from 'lucide-react';
import type { Project, ProjectGroup, WorkNode } from '../types';
import { ProjectNumber } from './ProjectNumber';
import { ProjectStatus } from './ProjectStatus';
import { projectStatus } from '../project-status';

const PROJECT_DRAG_TYPE = 'application/x-jarvisync-project-id';

interface ProjectSidebarProps {
  projects: Project[];
  nodes: WorkNode[];
  groups: ProjectGroup[];
  activeProjectId: string | null;
  busy: boolean;
  open: boolean;
  onClose: () => void;
  onToggle: () => void;
  onSelect: (id: string) => void;
  onOpenProject: () => void;
  onCreateGroup: (title: string) => Promise<boolean>;
  onRenameGroup: (id: string, title: string) => Promise<boolean>;
  onRemoveGroup: (id: string) => Promise<boolean>;
  onMoveProject: (id: string, groupId: string | null, beforeId?: string | null) => Promise<boolean>;
  onRemoveProject: (id: string) => void;
  onArchiveProject: (id: string, archived: boolean) => Promise<boolean>;
  onForceStopProject: (id: string) => void;
}

interface ProjectEntry { project: Project; originalIndex: number }
interface ProjectSection { id: string | null; title: string; projects: Project[]; group?: ProjectGroup }
interface DropTarget { groupId: string | null; beforeId: string | null }

function projectSort(a: ProjectEntry, b: ProjectEntry) {
  const aOrder = typeof a.project.order === 'number' && Number.isFinite(a.project.order) ? a.project.order : a.originalIndex;
  const bOrder = typeof b.project.order === 'number' && Number.isFinite(b.project.order) ? b.project.order : b.originalIndex;
  return aOrder - bOrder || a.originalIndex - b.originalIndex;
}

function projectDate(value: string) {
  const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (isoDate) return `${isoDate[1]}/${isoDate[2]}/${isoDate[3]}`;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '日期未知';
  return `${parsed.getFullYear()}/${String(parsed.getMonth() + 1).padStart(2, '0')}/${String(parsed.getDate()).padStart(2, '0')}`;
}

function exactTime(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value || '未知';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(parsed);
}

function closeMenu(element: HTMLElement) {
  const popover = element.closest('[popover]') as HTMLElement | null;
  if (popover?.matches(':popover-open')) popover.hidePopover();
}

function positionMenu(trigger: HTMLElement, panel: HTMLElement) {
  const triggerBounds = trigger.getBoundingClientRect();
  const panelBounds = panel.getBoundingClientRect();
  const viewportGap = 8;
  const left = Math.min(Math.max(viewportGap, triggerBounds.right - panelBounds.width), window.innerWidth - panelBounds.width - viewportGap);
  const roomBelow = window.innerHeight - triggerBounds.bottom - viewportGap;
  const top = roomBelow >= panelBounds.height ? triggerBounds.bottom + 3 : Math.max(viewportGap, triggerBounds.top - panelBounds.height - 3);
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

function SidebarMenu({ label, className = '', children }: { label: string; className?: string; children: ReactNode }) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  function toggleMenu() {
    const trigger = triggerRef.current;
    const panel = panelRef.current;
    if (!trigger || !panel) return;
    if (panel.matches(':popover-open')) {
      panel.hidePopover();
      return;
    }
    panel.showPopover();
    positionMenu(trigger, panel);
  }

  return (
    <div className={`project-menu ${className}`}>
      <button className="project-menu-trigger" type="button" ref={triggerRef} onClick={toggleMenu} aria-label={label} aria-haspopup="dialog" aria-expanded={open}>
        <MoreHorizontal size={16} />
      </button>
      <div className="project-menu-popover" ref={panelRef} popover="auto" role="dialog" aria-label={label} onToggle={(event) => setOpen(event.currentTarget.matches(':popover-open'))}>
        {children}
      </div>
    </div>
  );
}

export function ProjectSidebar({
  projects, nodes, groups, activeProjectId, busy, open, onClose, onToggle, onSelect,
  onOpenProject, onCreateGroup, onRenameGroup, onRemoveGroup, onMoveProject, onRemoveProject, onArchiveProject, onForceStopProject,
}: ProjectSidebarProps) {
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [groupTitle, setGroupTitle] = useState('');
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupTitle, setEditingGroupTitle] = useState('');
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [localBusy, setLocalBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const operationRef = useRef(false);
  const draggedIdRef = useRef<string | null>(null);
  const dropTargetRef = useRef<DropTarget | null>(null);
  const effectiveBusy = busy || localBusy;
  const active = projects.find((project) => project.id === activeProjectId);
  const archivedProjects = useMemo(() => projects.filter(project => project.archived), [projects]);
  const statuses = useMemo(() => new Map(projects.map(project => [project.id, projectStatus(project, nodes)])), [projects, nodes]);
  const runningProjects = useMemo(() => new Set(nodes.filter(node => node.executions?.some(run => run.endedAt === undefined)).map(node => node.projectId)), [nodes]);

  useEffect(() => { if (active?.archived) setArchiveOpen(true); }, [active?.id, active?.archived]);

  function selectFromCard(event: MouseEvent<HTMLElement>, projectId: string) {
    const target = event.target;
    if (draggedIdRef.current || (target instanceof Element && target.closest('button, input, select, textarea, label, a, [contenteditable="true"], .project-menu-popover'))) return;
    onSelect(projectId);
  }

  const sections = useMemo<ProjectSection[]>(() => {
    const knownGroupIds = new Set(groups.map((group) => group.id));
    const entries = projects.filter(project => !project.archived).map((project, originalIndex) => ({ project, originalIndex }));
    const projectsFor = (groupId: string | null) => entries
      .filter(({ project }) => {
        const actualGroupId = project.groupId && knownGroupIds.has(project.groupId) ? project.groupId : null;
        return actualGroupId === groupId;
      })
      .sort(projectSort)
      .map(({ project }) => project);
    return [
      { id: null, title: '未分组', projects: projectsFor(null) },
      ...groups.map((group) => ({ id: group.id, title: group.title, group, projects: projectsFor(group.id) })),
    ];
  }, [groups, projects]);

  async function runAction(action: () => Promise<boolean>, failureText: string) {
    if (effectiveBusy || operationRef.current) return false;
    operationRef.current = true;
    setLocalBusy(true);
    setActionError('');
    try {
      const succeeded = await action();
      if (!succeeded) setActionError(failureText);
      return succeeded;
    } catch (error) {
      console.error(error);
      setActionError(failureText);
      return false;
    } finally {
      operationRef.current = false;
      setLocalBusy(false);
    }
  }

  async function submitGroup(event: FormEvent) {
    event.preventDefault();
    const nextTitle = groupTitle.trim();
    if (!nextTitle || effectiveBusy) return;
    if (await runAction(() => onCreateGroup(nextTitle), '分组未创建，请重试。')) {
      setGroupTitle('');
      setCreatingGroup(false);
    }
  }

  async function submitGroupRename(event: FormEvent, groupId: string) {
    event.preventDefault();
    const nextTitle = editingGroupTitle.trim();
    if (!nextTitle || effectiveBusy) return;
    if (await runAction(() => onRenameGroup(groupId, nextTitle), '分组名称未保存，请重试。')) {
      setEditingGroupId(null);
      setEditingGroupTitle('');
    }
  }

  function toggleGroup(groupId: string) {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId); else next.add(groupId);
      return next;
    });
  }

  function canAcceptDrag(event: DragEvent) {
    return !effectiveBusy && Boolean(draggedIdRef.current) && Array.from(event.dataTransfer.types).includes(PROJECT_DRAG_TYPE);
  }

  function startDrag(event: DragEvent<HTMLButtonElement>, projectId: string) {
    if (effectiveBusy) { event.preventDefault(); return; }
    draggedIdRef.current = projectId;
    setDraggedId(projectId);
    dropTargetRef.current = null;
    setDropTarget(null);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData(PROJECT_DRAG_TYPE, projectId);
  }

  function endDrag() {
    draggedIdRef.current = null;
    dropTargetRef.current = null;
    setDraggedId(null);
    setDropTarget(null);
  }

  function markDropTarget(target: DropTarget) {
    dropTargetRef.current = target;
    setDropTarget(target);
  }

  function markSectionEnd(event: DragEvent, groupId: string | null) {
    if (!canAcceptDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    markDropTarget({ groupId, beforeId: null });
  }

  function markProjectDrop(event: DragEvent<HTMLElement>, groupId: string | null, sectionProjects: Project[], index: number) {
    if (!canAcceptDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    const bounds = event.currentTarget.getBoundingClientRect();
    const after = event.clientY > bounds.top + bounds.height / 2;
    markDropTarget({ groupId, beforeId: after ? sectionProjects[index + 1]?.id ?? null : sectionProjects[index].id });
  }

  async function dropProject(event: DragEvent, groupId: string | null, beforeId: string | null) {
    const accepted = canAcceptDrag(event);
    if (!accepted) return;
    event.preventDefault();
    event.stopPropagation();
    const projectId = event.dataTransfer.getData(PROJECT_DRAG_TYPE);
    const resolvedTarget = dropTargetRef.current?.groupId === groupId ? dropTargetRef.current : { groupId, beforeId };
    draggedIdRef.current = null;
    dropTargetRef.current = null;
    setDraggedId(null);
    setDropTarget(null);
    if (!projects.some((project) => project.id === projectId) || projectId === resolvedTarget.beforeId) return;
    await runAction(() => onMoveProject(projectId, resolvedTarget.groupId, resolvedTarget.beforeId), '项目位置未保存，请重试。');
  }

  async function moveByMenu(project: Project, section: ProjectSection, direction: 'up' | 'down') {
    const index = section.projects.findIndex((item) => item.id === project.id);
    const beforeId = direction === 'up' ? section.projects[index - 1]?.id : section.projects[index + 2]?.id ?? null;
    if (index < 0 || (direction === 'up' && index === 0) || (direction === 'down' && index === section.projects.length - 1)) return;
    await runAction(() => onMoveProject(project.id, section.id, beforeId), '项目位置未保存，请重试。');
  }

  return (
    <>
      <aside className={`project-sidebar ${open ? 'is-open' : ''}`} aria-label="项目侧栏" aria-hidden={!open} inert={!open}>
        <div className="sidebar-brand">
          <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>
          <div><strong>JarviSync</strong><span>项目画布</span></div>
        </div>

        <div className="sidebar-heading project-sidebar-heading">
          <span>项目目录</span>
          <div className="sidebar-heading-actions">
            <button className="icon-button" type="button" onClick={() => setCreatingGroup((value) => !value)} aria-label={creatingGroup ? '取消新建分组' : '新建分组'} title="新建分组" disabled={effectiveBusy}>
              {creatingGroup ? <X size={16} /> : <FolderPlus size={16} />}
            </button>
          </div>
        </div>

        {creatingGroup && (
          <form className="quick-create group-quick-create" onSubmit={submitGroup}>
            <label htmlFor="new-project-group">分组名称</label>
            <div>
              <input id="new-project-group" value={groupTitle} onChange={(event) => setGroupTitle(event.target.value)} placeholder="例如：正在进行" autoFocus maxLength={60} disabled={effectiveBusy} />
              <button type="submit" disabled={!groupTitle.trim() || effectiveBusy} aria-label="创建分组"><FolderPlus size={16} /></button>
            </div>
          </form>
        )}

        {actionError && <p className="sidebar-action-error" role="alert">{actionError}</p>}

        <nav className={`project-list ${draggedId ? 'is-dragging' : ''}`} aria-label="项目列表">
          {sections.map((section) => {
            const collapsible = Boolean(section.group);
            const collapsed = section.group ? collapsedGroups.has(section.group.id) : false;
            const sectionDropEnd = dropTarget?.groupId === section.id && dropTarget.beforeId === null;
            return (
              <section className={`project-group ${sectionDropEnd ? 'is-drop-end' : ''}`} key={section.id ?? 'ungrouped'} aria-labelledby={`project-group-${section.id ?? 'ungrouped'}`} onDragOver={(event) => markSectionEnd(event, section.id)} onDrop={(event) => void dropProject(event, section.id, dropTarget?.beforeId ?? null)}>
                <div className="project-group-heading">
                  <button className="project-group-toggle" type="button" onClick={() => section.group && toggleGroup(section.group.id)} aria-expanded={collapsible ? !collapsed : true} aria-controls={`project-group-list-${section.id ?? 'ungrouped'}`} disabled={!collapsible}>
                    {collapsible ? (collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />) : <span className="group-rule" aria-hidden="true" />}
                    <span id={`project-group-${section.id ?? 'ungrouped'}`}>{section.title}</span><small>{section.projects.length}</small>
                  </button>
                  {section.group && (
                    <SidebarMenu className="group-menu" label={`管理分组“${section.title}”`}>
                        <button type="button" disabled={effectiveBusy} onClick={(event) => { setEditingGroupId(section.group!.id); setEditingGroupTitle(section.group!.title); closeMenu(event.currentTarget); }}><FolderPen size={14} /> 重命名分组</button>
                        <button className="danger-menu-action" type="button" disabled={effectiveBusy} onClick={(event) => { closeMenu(event.currentTarget); void runAction(() => onRemoveGroup(section.group!.id), '分组未删除，请重试。'); }}><Trash2 size={14} /> 删除分组，项目移至未分组</button>
                    </SidebarMenu>
                  )}
                </div>

                {section.group && editingGroupId === section.group.id && (
                  <form className="group-rename" onSubmit={(event) => void submitGroupRename(event, section.group!.id)}>
                    <label className="sr-only" htmlFor={`rename-project-group-${section.group.id}`}>新的分组名称</label>
                    <input id={`rename-project-group-${section.group.id}`} value={editingGroupTitle} onChange={(event) => setEditingGroupTitle(event.target.value)} maxLength={60} autoFocus disabled={effectiveBusy} />
                    <button type="submit" disabled={!editingGroupTitle.trim() || effectiveBusy}>保存</button>
                    <button type="button" onClick={() => setEditingGroupId(null)}>取消</button>
                  </form>
                )}

                {!collapsed && (
                  <div className="project-group-list" id={`project-group-list-${section.id ?? 'ungrouped'}`}>
                    {section.projects.map((project, index) => {
                      const beforeDrop = dropTarget?.groupId === section.id && dropTarget.beforeId === project.id;
                      return (
                        <article className={`project-item ${project.id === activeProjectId ? 'is-active' : ''} ${project.id === draggedId ? 'is-dragging' : ''} ${beforeDrop ? 'is-drop-before' : ''}`} key={project.id} onClick={event => selectFromCard(event, project.id)} onDragOver={(event) => markProjectDrop(event, section.id, section.projects, index)} onDrop={(event) => void dropProject(event, section.id, dropTarget?.groupId === section.id ? dropTarget.beforeId : project.id)}>
                          <button className="project-drag-handle" type="button" draggable={!effectiveBusy} onDragStart={(event) => startDrag(event, project.id)} onDragEnd={endDrag} disabled={effectiveBusy} aria-label={`拖动项目“${project.title}”调整位置`} title="拖动排序或移入分组"><GripVertical size={15} /></button>
                          <div className="project-content">
                            <button type="button" className="project-select" onClick={() => onSelect(project.id)} aria-current={project.id === activeProjectId ? 'page' : undefined}>
                              <span className="project-label"><strong title={project.title}>{project.title}</strong></span>
                              {project.demo && <span className="demo-tag">示例</span>}
                            </button>
                            <div className="project-meta">
                              <ProjectNumber value={project.projectNumber} active={project.id === activeProjectId} />
                              <ProjectStatus status={statuses.get(project.id)!} />
                              <time dateTime={project.createdAt} title={`创建：${exactTime(project.createdAt)}；更新：${exactTime(project.updatedAt)}`}>创建 {projectDate(project.createdAt)}</time>
                            </div>
                          </div>
                          <SidebarMenu label={`项目“${project.title}”更多操作`}>
                              <button type="button" disabled={effectiveBusy || index === 0} onClick={(event) => { closeMenu(event.currentTarget); void moveByMenu(project, section, 'up'); }}><ChevronUp size={14} /> 上移</button>
                              <button type="button" disabled={effectiveBusy || index === section.projects.length - 1} onClick={(event) => { closeMenu(event.currentTarget); void moveByMenu(project, section, 'down'); }}><ChevronDown size={14} /> 下移</button>
                              <label htmlFor={`move-project-${project.id}`}>移动到分组</label>
                              <select id={`move-project-${project.id}`} value={section.id ?? ''} disabled={effectiveBusy} onChange={(event) => { const targetGroupId = event.target.value || null; closeMenu(event.currentTarget); if (targetGroupId !== section.id) void runAction(() => onMoveProject(project.id, targetGroupId, null), '项目位置未保存，请重试。'); }}>
                                <option value="">未分组</option>
                                {groups.map((group) => <option value={group.id} key={group.id}>{group.title}</option>)}
                              </select>
                              <button type="button" disabled={effectiveBusy || runningProjects.has(project.id)} onClick={(event) => { closeMenu(event.currentTarget); void runAction(() => onArchiveProject(project.id, true), '项目未归档，请核对提示后重试。'); }}><Archive size={14} /> 归档项目</button>
                              <button className="danger-menu-action project-delete-action" type="button" disabled={effectiveBusy || runningProjects.has(project.id)} onClick={(event) => { closeMenu(event.currentTarget); onRemoveProject(project.id); }}><Trash2 size={14} /> 删除项目</button>
                              {runningProjects.has(project.id) && <>
                                <button className="danger-menu-action" type="button" disabled={effectiveBusy} onClick={event => { closeMenu(event.currentTarget); onForceStopProject(project.id); }}><Square size={14} /> 强制结束任务…</button>
                                <p className="project-menu-hint">可手动结束执行，再归档或删除。</p>
                              </>}
                          </SidebarMenu>
                        </article>
                      );
                    })}
                    {section.projects.length === 0 && <p className="project-group-empty">拖动项目到这里</p>}
                    <div className="project-drop-end" aria-hidden="true" />
                  </div>
                )}
              </section>
            );
          })}
          <section className="project-archive-section" aria-label="已归档项目">
            <div className="project-group-heading">
              <button className="project-group-toggle" type="button" aria-expanded={archiveOpen} aria-controls="archived-project-list" onClick={() => setArchiveOpen(value => !value)}>
                {archiveOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<Archive size={13} /><span>已归档</span><small>{archivedProjects.length}</small>
              </button>
            </div>
            {archiveOpen && <div id="archived-project-list" className="project-group-list">
              {archivedProjects.map(project => <article className={`project-item is-archived-project ${project.id === activeProjectId ? 'is-active' : ''}`} key={project.id} onClick={event => selectFromCard(event, project.id)}>
                <span className="project-archive-spacer" aria-hidden="true"><Archive size={13} /></span>
                <div className="project-content">
                  <button type="button" className="project-select" onClick={() => onSelect(project.id)} aria-current={project.id === activeProjectId ? 'page' : undefined}>
                    <span className="project-label"><strong title={project.title}>{project.title}</strong></span>
                  </button>
                  <div className="project-meta">
                    <ProjectNumber value={project.projectNumber} active={project.id === activeProjectId} />
                    <ProjectStatus status={statuses.get(project.id)!} />
                    <time dateTime={project.createdAt} title={`创建：${exactTime(project.createdAt)}；更新：${exactTime(project.updatedAt)}`}>创建 {projectDate(project.createdAt)}</time>
                  </div>
                </div>
                <SidebarMenu label={`项目“${project.title}”更多操作`}>
                  <button type="button" disabled={effectiveBusy} onClick={event => { closeMenu(event.currentTarget); void runAction(() => onArchiveProject(project.id, false), '项目未恢复，请重试。'); }}><ArchiveRestore size={14} /> 恢复项目</button>
                  <button className="danger-menu-action project-delete-action" type="button" disabled={effectiveBusy || runningProjects.has(project.id)} onClick={event => { closeMenu(event.currentTarget); onRemoveProject(project.id); }}><Trash2 size={14} /> 删除项目</button>
                </SidebarMenu>
              </article>)}
              {!archivedProjects.length && <p className="project-archive-empty">归档的项目会保留在这里。</p>}
            </div>}
          </section>
        </nav>

        {active && (
          <section className="project-summary" aria-labelledby="project-summary-title">
            <div className="sidebar-heading"><span id="project-summary-title">项目说明</span></div>
            <p className={active.summary.trim() ? 'project-summary-copy' : 'project-summary-copy is-empty'}>{active.summary.trim() || '还没有项目说明。'}</p>
            <button className="project-overview-button" type="button" onClick={onOpenProject}>项目说明与要求</button>
          </section>
        )}
      </aside>
      {!open && <div className="sidebar-rail" aria-hidden="true" />}
      <button className="sidebar-toggle-fixed" type="button" onClick={onToggle} aria-label={open ? '收起项目侧栏' : '展开项目侧栏'} title={open ? '收起项目侧栏' : '展开项目侧栏'}>
        {open ? <ChevronLeft size={18} /> : <ChevronRight size={18} />}
      </button>
      {open && <button className="sidebar-scrim mobile-only" type="button" onClick={onClose} aria-label="关闭项目侧栏" />}
    </>
  );
}
