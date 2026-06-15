import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { exportTasksToExcel } from '../utils/exportTasksExcel'
import { createTask, deleteTask, fetchTaskLogs, fetchTaskUpdates, fetchTasks, updateTask, extractTasksFromOutline, batchCreateTasks, restoreTask } from '../api/tasks'
import type { TaskLog, TaskPayload, TaskUpdate, TaskDraft } from '../api/tasks'
import { fetchSubTasks, createSubTask, patchSubTaskStatus, deleteSubTask, restoreSubTask } from '../api/subtasks'
import { createUpdate } from '../api/updates'
import { apiGet } from '../api/client'
import { useProject } from '../context/ProjectContext'
import type { TaskItem, SubTaskItem, Person, Project } from '../types'

const NOT_STARTED = new Set(['未开始', 'not_started', 'notstarted'])
const IN_PROGRESS  = new Set(['推进中', '进行中', 'in_progress'])
const COMPLETED    = new Set(['已完成', '完成', 'completed'])
const DELAYED      = new Set(['延期', '已延期', 'delayed'])
const PAUSED       = new Set(['暂停', '暂缓', '已暂停', 'paused'])

function norm(s?: string | null) { return String(s ?? '').trim().toLowerCase().replace(/\s+/g, '_') }
function shortDate(s?: string | null) {
  if (!s) return '-'
  if (s.includes('T')) return s.replace('T', ' ').slice(0, 16)
  return s.replace(/(\d{4})年(\d{1,2})月/g, '$1/$2')
}
function count(tasks: TaskItem[], set: Set<string>) { return tasks.filter((t) => set.has(norm(t.status))).length }
// 判断是否为「延期/过期」任务（与 Dashboard 后端逻辑一致：状态为延期 OR 计划时间已过期且未完成）
function isOverdueTask(t: TaskItem) {
  return DELAYED.has(norm(t.status)) || (
    !COMPLETED.has(norm(t.status)) && !PAUSED.has(norm(t.status)) && isPlanOverdue(t.plan_time ?? '')
  )
}

const STATUS_BADGE: Record<string, { cls: string; dot: string; label: string }> = {
  '进行中': { cls: 'bg-blue-100 text-blue-700',    dot: '#3B82F6', label: '进行中' },
  '推进中': { cls: 'bg-blue-100 text-blue-700',    dot: '#3B82F6', label: '进行中' },
  '已完成': { cls: 'bg-emerald-100 text-emerald-700', dot: '#10B981', label: '已完成' },
  '延期':   { cls: 'bg-red-100 text-red-700',      dot: '#EF4444', label: '延期' },
  '暂停':   { cls: 'bg-amber-100 text-amber-700',  dot: '#F59E0B', label: '暂缓' },
  '暂缓':   { cls: 'bg-amber-100 text-amber-700',  dot: '#F59E0B', label: '暂缓' },
  '未开始': { cls: 'bg-slate-100 text-slate-600',  dot: '#94A3B8', label: '未启动' },
}

function getBadge(status?: string) {
  return STATUS_BADGE[status ?? ''] ?? { cls: 'bg-slate-100 text-slate-600', dot: '#94A3B8', label: status ?? '-' }
}

const PROJECT_COLORS = ['#2563EB', '#059669', '#F59E0B', '#8B5CF6', '#0891B2', '#6366F1', '#EC4899']
function projectColor(names: string[], name?: string) {
  const idx = names.indexOf(name ?? '') % PROJECT_COLORS.length
  return PROJECT_COLORS[Math.max(0, idx)]
}
function projectForTask(projects: Project[], task?: TaskItem | null) {
  if (!task) return null
  return projects.find((p) => p.id === (task as any).project_id || p.name === task.special_project) ?? null
}
function projectPeopleText(value?: string[] | string | null) {
  if (Array.isArray(value)) return value.filter(Boolean).join('、') || '—'
  return value?.trim() || '—'
}
function canManageTrashForRoles(isTechAdmin?: boolean, roles: string[] = []) {
  return !!(isTechAdmin || roles.includes('owner'))
}
function subTaskProgress(subs?: SubTaskItem[] | null) {
  if (!subs?.length) return { done: 0, total: 0, label: '0/0' }
  const done = subs.filter((s) => COMPLETED.has(norm(s.status))).length
  return { done, total: subs.length, label: `${done}/${subs.length}` }
}

function initials(name?: string) { return (name ?? '?').slice(0, 1) }

const AVATAR_COLORS = ['#2563EB', '#059669', '#8B5CF6', '#0891B2', '#D97706', '#F59E0B', '#EC4899', '#6366F1']
function avatarColor(name: string) {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}

function Avatar({ name, size = 24 }: { name: string; size?: number }) {
  return (
    <span
      style={{
        width: size, height: size, borderRadius: '50%', border: '2px solid #fff',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        fontSize: size * 0.42, fontWeight: 700, color: '#fff', flexShrink: 0,
        background: avatarColor(name), marginLeft: -6,
      }}
    >
      {initials(name)}
    </span>
  )
}

function AvatarSingle({ name }: { name: string }) {
  return (
    <div className="flex items-center gap-1">
      <span style={{ marginLeft: 0 }}><Avatar name={name} /></span>
      <span className="text-slate-600 ml-1">{name}</span>
    </div>
  )
}

function CollabAvatars({ raw }: { raw?: string }) {
  const names = (raw ?? '').split(/[,，、]/).map((s) => s.trim()).filter(Boolean)
  if (!names.length) return <span className="text-slate-300">—</span>
  const show = names.slice(0, 3)
  const extra = names.length - show.length
  return (
    <div className="flex items-center">
      {show.map((n) => <Avatar key={n} name={n} />)}
      {extra > 0 && (
        <span style={{ width: 24, height: 24, borderRadius: '50%', border: '2px solid #fff', background: '#D97706', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700, color: '#fff', flexShrink: 0, marginLeft: -6 }}>
          +{extra}
        </span>
      )}
    </div>
  )
}

function ResultBadge({ text }: { text?: string }) {
  if (!text) return <span className="text-slate-300">—</span>
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-semibold"
      style={{ background: '#EFF6FF', color: '#1D4ED8' }}
    >
      {text.slice(0, 14)}{text.length > 14 ? '…' : ''}
    </span>
  )
}

function OwnerCell({ name }: { name?: string }) {
  if (!name) return <span className="text-slate-300">—</span>
  const names = name.split(/[,，、]/).map((s) => s.trim()).filter(Boolean)
  if (names.length === 1) {
    return (
      <div className="flex items-center gap-1.5">
        <Avatar name={names[0]} size={22} />
        <span className="text-slate-600 text-xs">{names[0]}</span>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-1">
      <div className="flex" style={{ marginLeft: 6 }}>
        {names.slice(0, 3).map((n) => <Avatar key={n} name={n} size={22} />)}
        {names.length > 3 && (
          <span style={{ width: 22, height: 22, borderRadius: '50%', border: '2px solid #fff', background: '#94A3B8', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, fontWeight: 700, color: '#fff', marginLeft: -6 }}>
            +{names.length - 3}
          </span>
        )}
      </div>
      <span className="text-slate-500 text-xs ml-1">{names.slice(0, 2).join('、')}{names.length > 2 ? '…' : ''}</span>
    </div>
  )
}

export function TaskManagementPage() {
  const { currentProjectId, projects, currentUser, currentProjectRoles } = useProject()
  const [tasks, setTasks]             = useState<TaskItem[]>([])
  const [loading, setLoading]         = useState(false)
  const [selectedTask, setSelectedTask] = useState<TaskItem | null>(null)
  const [formOpen, setFormOpen]       = useState(false)
  const [formTask, setFormTask]       = useState<TaskItem | null>(null)  // null = 新增
  const [checked, setChecked]         = useState<Set<number>>(new Set())
  const [taskLogs, setTaskLogs]       = useState<TaskLog[]>([])
  const [taskUpdates, setTaskUpdates] = useState<TaskUpdate[]>([])
  const [subTasks, setSubTasks]       = useState<SubTaskItem[]>([])
  const [trashedSubTasks, setTrashedSubTasks] = useState<SubTaskItem[]>([])
  const [subTaskFormOpen, setSubTaskFormOpen] = useState(false)
  const [peopleList, setPeopleList]   = useState<Person[]>([])
  // inline sub-task expand in table
  const [taskSubMap, setTaskSubMap]     = useState<Record<number, SubTaskItem[]>>({})
  const [expandedTasks, setExpandedTasks] = useState<Set<number>>(new Set())
  const [importOpen, setImportOpen] = useState(false)
  const [searchParams] = useSearchParams()
  const [search, setSearch]           = useState('')
  const [filterStatus, setFilterStatus] = useState(() => searchParams.get('status') ?? '')
  const [filterProject, setFilterProject] = useState('')  // 专项名，空=全部
  const [filterOwner, setFilterOwner] = useState('')
  const [showDeleted, setShowDeleted] = useState(false)
  // viewProjectId：null=全部任务，非null=特定项目
  const [viewProjectId, setViewProjectId] = useState<number | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const [progressOpen, setProgressOpen] = useState(false)
  const [progressText, setProgressText] = useState('')
  const [progressSubmitState, setProgressSubmitState] = useState<'idle' | 'submitting' | 'done'>('idle')
  // 专项下拉选项来自全部可见项目，而非已加载任务
  const projectOptions = projects.map((p) => p.name)
  const ownerNames = [...new Set(projects.flatMap((p) => p.owners ?? []))]
  const focusedProject = projects.find((p) => p.id === (viewProjectId ?? currentProjectId)) ?? projects[0] ?? null
  const trashProject = projects.find((p) => p.id === (viewProjectId ?? currentProjectId)) ?? null
  const scopeProjectRoles = trashProject?.user_roles ?? currentProjectRoles
  const canManageTrash = canManageTrashForRoles(currentUser?.is_tech_admin, scopeProjectRoles)


  // 侧边栏切换项目时重置为全部
  useEffect(() => {
    setViewProjectId(null)
    setFilterProject('')
  }, [currentProjectId])

  useEffect(() => {
    setSelectedTask(null)
    setExpandedTasks(new Set())
    setChecked(new Set())
    setTaskLogs([])
    setTaskUpdates([])
    setSubTasks([])
    setTrashedSubTasks([])
  }, [viewProjectId])

  useEffect(() => {
    if (showDeleted && !canManageTrash) {
      setShowDeleted(false)
    }
  }, [showDeleted, canManageTrash])

  useEffect(() => {
    let cancelled = false
    if (showDeleted && !canManageTrash) {
      setShowDeleted(false)
      return () => { cancelled = true }
    }
    setLoading(true)
    const pid = showDeleted ? (viewProjectId ?? currentProjectId) : viewProjectId
    fetchTasks(pid, showDeleted)
      .then((d) => { if (!cancelled) setTasks(Array.isArray(d) ? d : []) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [viewProjectId, currentProjectId, showDeleted, canManageTrash])

  // 专项下拉选项来自全部可见项目，而非已加载任务

  function loadTasks(nextDeleted = showDeleted) {
    const effectiveDeleted = nextDeleted && canManageTrash
    const pid = effectiveDeleted ? (viewProjectId ?? currentProjectId) : viewProjectId
    return fetchTasks(pid, effectiveDeleted)
      .then((d) => setTasks(Array.isArray(d) ? d : []))
      .catch(() => {})
  }

  function loadTaskSubTaskBuckets(taskId: number) {
    return Promise.all([
      fetchSubTasks(taskId, false).catch(() => [] as SubTaskItem[]),
      fetchSubTasks(taskId, true).catch(() => [] as SubTaskItem[]),
    ]).then(([active, deleted]) => {
      setSubTasks(active)
      setTrashedSubTasks(deleted)
      return { active, deleted }
    })
  }

  function handleProjectFilter(name: string) {
    setFilterProject(name)
    if (!name) {
      setViewProjectId(null)
    } else {
      const proj = projects.find((p) => p.name === name)
      if (proj) setViewProjectId(proj.id)
    }
  }

  const filtered = tasks
    .filter((t) => {
      if (search && !t.key_task?.includes(search) && !t.special_project?.includes(search)) return false
      if (filterStatus) {
        const isDelayedFilter = norm(filterStatus) === '延期' || norm(filterStatus) === '已延期'
        if (isDelayedFilter) {
          if (!isOverdueTask(t)) return false
        } else {
          if (norm(t.status) !== norm(filterStatus)) return false
        }
      }
      if (filterProject && t.special_project !== filterProject) return false
      if (filterOwner && !(projectForTask(projects, t)?.owners ?? []).includes(filterOwner)) return false
      return true
    })
    .sort((a, b) => {
      const bottomGroup = (s?: string) => NOT_STARTED.has(norm(s)) || COMPLETED.has(norm(s))
      const ag = bottomGroup(a.status) ? 1 : 0
      const bg = bottomGroup(b.status) ? 1 : 0
      if (ag !== bg) return ag - bg
      const at = a.updated_at ?? a.created_at ?? ''
      const bt = b.updated_at ?? b.created_at ?? ''
      return bt.localeCompare(at)
    })

  function openDetail(task: TaskItem) {
    setSelectedTask(task)
    setTaskLogs([])
    setTaskUpdates([])
    setSubTasks([])
    setTrashedSubTasks([])
    setProgressOpen(false)
    setProgressText('')
    setProgressSubmitState('idle')
    fetchTaskLogs(task.id).then(setTaskLogs).catch(() => {})
    fetchTaskUpdates(task.id).then(setTaskUpdates).catch(() => {})
    loadTaskSubTaskBuckets(task.id).catch(() => {})
    apiGet<Person[]>('/api/people').then((p) => setPeopleList(p.filter((x) => x.is_active !== false))).catch(() => {})
  }

  async function handleProgressSubmit() {
    if (!progressText.trim() || !currentUser || !selectedTask) return
    const projectId = (selectedTask as any).project_id ?? currentProjectId
    if (!projectId) return
    setProgressSubmitState('submitting')
    try {
      await createUpdate({
        project_id: projectId,
        source_type: '任务进展',
        title: `${selectedTask.key_task} 进展更新`,
        transcript_text: progressText.trim(),
        submitter: currentUser.name,
      })
      setProgressSubmitState('done')
      setTimeout(() => {
        setProgressOpen(false)
        setProgressText('')
        setProgressSubmitState('idle')
      }, 1500)
    } catch {
      setProgressSubmitState('idle')
      alert('提交失败，请重试')
    }
  }

  function toggleInlineSubTasks(e: React.MouseEvent, taskId: number) {
    e.stopPropagation()
    if (showDeleted) return
    setExpandedTasks((prev) => {
      const next = new Set(prev)
      if (next.has(taskId)) { next.delete(taskId); return next }
      next.add(taskId)
      if (!(taskId in taskSubMap)) {
        fetchSubTasks(taskId, false)
          .then((subs) => setTaskSubMap((p) => ({ ...p, [taskId]: subs })))
          .catch(() => setTaskSubMap((p) => ({ ...p, [taskId]: [] })))
      }
      return next
    })
  }

  function handleRestoreSubTask(st: SubTaskItem) {
    if (!confirm(`确认恢复子任务「${st.title}」？恢复后会重新计算关键任务状态。`)) return
    restoreSubTask(st.id).then(() => {
      if (selectedTask) {
        loadTaskSubTaskBuckets(selectedTask.id).catch(() => {})
        refreshParentTask(selectedTask.id)
      }
    }).catch(() => alert('恢复失败'))
  }

  // 子任务变更后由后端汇总关键任务状态，前端只刷新最新事实。
  function refreshParentTask(taskId: number) {
    const effectiveDeleted = showDeleted && canManageTrash
    const pid = effectiveDeleted ? (viewProjectId ?? currentProjectId) : viewProjectId
    fetchTasks(pid, effectiveDeleted).then((rows) => {
      const safeRows = Array.isArray(rows) ? rows : []
      setTasks(safeRows)
      const fresh = safeRows.find((t) => t.id === taskId)
      if (fresh) setSelectedTask((prev) => prev?.id === taskId ? fresh : prev)
    }).catch(() => {})
  }

  function maybePromptCloseKeyTask(taskId: number, nextSubs: SubTaskItem[]) {
    const parentTask = tasks.find((t) => t.id === taskId)
    if (!parentTask || COMPLETED.has(norm(parentTask.status))) return
    if (!nextSubs.length || !nextSubs.every((s) => COMPLETED.has(norm(s.status)))) return
    const taskProject = projectForTask(projects, parentTask)
    const canClose = !!(currentUser?.is_tech_admin || taskProject?.user_roles?.includes('owner'))
    if (!canClose) {
      alert('该关键任务下的子任务已全部完成，请项目负责人确认是否关闭关键任务。')
      return
    }
    if (!confirm(`关键任务「${parentTask.key_task}」下的子任务已全部完成，是否现在关闭该关键任务？`)) return
    updateTask(parentTask.id, {
      project_id: (parentTask as any).project_id,
      special_project: parentTask.special_project,
      key_task: parentTask.key_task,
      key_achievement: parentTask.key_achievement,
      completion_standard: parentTask.completion_standard,
      coordinator: parentTask.coordinator,
      owner: parentTask.owner,
      collaborators: parentTask.collaborators,
      plan_time: parentTask.plan_time,
      status: '已完成',
      problem_note: parentTask.problem_note,
    })
      .then((updated) => {
        setTasks((prev) => prev.map((t) => t.id === updated.id ? updated : t))
        setSelectedTask((prev) => prev?.id === updated.id ? updated : prev)
      })
      .catch(() => alert('关闭关键任务失败，请稍后重试'))
  }

  function toggleGroupCollapse(key: string) {
    setCollapsedGroups((prev) => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n })
  }

  function groupRowSpan(groupTasks: TaskItem[]) {
    return groupTasks.reduce((sum, t) => {
      const subs = taskSubMap[t.id]
      // undefined = still loading (1 skeleton row); array = loaded (0..n rows)
      const extra = expandedTasks.has(t.id) ? (subs === undefined ? 1 : subs.length) : 0
      return sum + 1 + extra
    }, 0)
  }

  function toggleCheck(id: number, e: React.MouseEvent) {
    e.stopPropagation()
    setChecked((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  function toggleAll(e: React.ChangeEvent<HTMLInputElement>) {
    setChecked(e.target.checked ? new Set(filtered.map((t) => t.id)) : new Set())
  }
  function clearChecked() { setChecked(new Set()) }

  function handleDelete(task: TaskItem) {
    if (!confirm(`确认删除关键任务「${task.key_task}」？其下子任务会一并删除，此操作暂不能在页面内恢复。`)) return
    deleteTask(task.id).then(() => {
      loadTasks(false)
      if (selectedTask?.id === task.id) setSelectedTask(null)
      setChecked((prev) => { const n = new Set(prev); n.delete(task.id); return n })
      setTaskSubMap((prev) => {
        const next = { ...prev }
        delete next[task.id]
        return next
      })
      setTrashedSubTasks([])
    }).catch(() => alert('删除失败'))
  }

  function handleRestoreTask(task: TaskItem) {
    if (!confirm(`确认恢复关键任务「${task.key_task}」？系统会同时恢复这次随关键任务一起删除的子任务。`)) return
    restoreTask(task.id).then((restored) => {
      setShowDeleted(false)
      setSelectedTask(restored)
      loadTasks(false)
      loadTaskSubTaskBuckets(restored.id).catch(() => {})
      setTaskSubMap((prev) => {
        const next = { ...prev }
        delete next[task.id]
        return next
      })
    }).catch(() => alert('恢复失败'))
  }

  // 按专项分组（保持首次出现的顺序），用于 rowspan 合并
  const groupedRows = useMemo(() => {
    const order: string[] = []
    const map = new Map<string, typeof filtered>()
    for (const t of filtered) {
      const key = t.special_project || '（未分类）'
      if (!map.has(key)) { map.set(key, []); order.push(key) }
      map.get(key)!.push(t)
    }
    return order.map((key) => ({ key, tasks: map.get(key)! }))
  }, [filtered])

  const allChecked = filtered.length > 0 && filtered.every((t) => checked.has(t.id))
  const checkedCount = checked.size

  async function handleBulkDelete() {
    if (checked.size === 0) return
    if (!confirm(`确认删除选中的 ${checked.size} 条关键任务？它们会进入回收站，子任务也会一起进入回收站。`)) return
    const ids = [...checked]
    await Promise.all(ids.map((id) => deleteTask(id).catch(() => {})))
    setChecked(new Set())
    if (selectedTask && ids.includes(selectedTask.id)) setSelectedTask(null)
    loadTasks(false)
  }

  function handleExport() {
    const proj = projects.find((p) => p.id === (viewProjectId ?? currentProjectId))
    const title = proj ? `${proj.name} 工作推进表` : '工作推进表'
    exportTasksToExcel(filtered, title)
  }

  function handleFormSave(payload: TaskPayload) {
    const pid = viewProjectId ?? currentProjectId
    const finalPayload = { ...payload, project_id: pid }
    const req = formTask
      ? updateTask(formTask.id, finalPayload)
      : createTask(finalPayload)
    req.then(() => {
      setFormOpen(false)
      setFormTask(null)
      loadTasks(false)
    }).catch(() => alert('保存失败，请重试'))
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {formOpen && (
        <TaskFormModal
          task={formTask}
          projects={projects.map((p) => p.name)}
          onSave={handleFormSave}
          onClose={() => { setFormOpen(false); setFormTask(null) }}
        />
      )}
      {importOpen && currentProjectId && (
        <OutlineImportModal
          defaultProjectId={currentProjectId}
          projects={projects}
          onCreated={(newTasks) => {
            setTasks((prev) => [...prev, ...newTasks])
            setImportOpen(false)
          }}
          onClose={() => setImportOpen(false)}
        />
      )}
      {subTaskFormOpen && selectedTask && (
        <SubTaskFormModal
          taskId={selectedTask.id}
          people={peopleList}
          onSave={(st) => {
            const next = [...subTasks, st]
            setSubTasks(next)
            setSubTaskFormOpen(false)
            setTaskSubMap((p) => ({ ...p, [st.task_id]: [...(p[st.task_id] ?? []), st] }))
            refreshParentTask(st.task_id)
          }}
          onClose={() => setSubTaskFormOpen(false)}
        />
      )}

      {/* Top Bar */}
      <header className="h-16 flex items-center px-6 gap-3 flex-shrink-0 bg-white border-b" style={{ borderColor: '#E9EFF6' }}>
        <div className="flex-1">
          <h1 className="text-base font-bold text-slate-800">项目管理</h1>
          <p className="text-xs text-slate-400 mt-0.5">项目概览与关键任务树</p>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-slate-500 font-medium">专项</span>
            <select
              value={filterProject}
              onChange={(e) => handleProjectFilter(e.target.value)}
              className="text-sm border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white text-slate-600 cursor-pointer focus:outline-none"
            >
              <option value="">全部专项</option>
              {projectOptions.map((o) => <option key={o}>{o}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-slate-500 font-medium">专项负责人</span>
            <select
              value={filterOwner}
              onChange={(e) => setFilterOwner(e.target.value)}
              className="text-sm border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white text-slate-600 cursor-pointer focus:outline-none"
            >
              <option value="">全部专项负责人</option>
              {ownerNames.map((o) => <option key={o}>{o}</option>)}
            </select>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-slate-500 font-medium">状态</span>
            <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className="text-sm border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white text-slate-600 cursor-pointer focus:outline-none">
              <option value="">全部状态</option>
              <option>进行中</option><option>已完成</option><option>延期</option><option>暂缓</option><option>未开始</option>
            </select>
          </div>
          <div className="relative">
            <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" style={{ width: 13, height: 13 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索关键任务…" className="pl-8 pr-3 py-1.5 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none w-40" />
          </div>
        </div>

        <div className="flex items-center gap-2 ml-1">
          <div className="inline-flex items-center rounded-lg border border-slate-200 bg-slate-50 p-0.5">
            <button
              onClick={() => { setSelectedTask(null); setExpandedTasks(new Set()); setChecked(new Set()); setShowDeleted(false) }}
              className={`px-3 py-1.5 text-sm font-semibold rounded-md transition-colors ${!showDeleted ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
            >
              在办
            </button>
            {canManageTrash && (
              <button
                onClick={() => { setSelectedTask(null); setExpandedTasks(new Set()); setChecked(new Set()); setShowDeleted(true) }}
                className={`px-3 py-1.5 text-sm font-semibold rounded-md transition-colors ${showDeleted ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
              >
                回收站
              </button>
            )}
          </div>
          <select
            defaultValue=""
            onChange={(e) => {
              const action = e.target.value
              if (!action) return
              if (action === 'export') handleExport()
              if (action === 'import') setImportOpen(true)
              if (action === 'create') { setFormTask(null); setFormOpen(true) }
              e.currentTarget.value = ''
            }}
            className="cursor-pointer min-w-[220px] px-4 py-2 rounded-lg border border-slate-200 bg-white text-slate-700 text-sm font-semibold focus:outline-none hover:bg-slate-50"
          >
            <option value="" disabled>操作</option>
            <option value="export">导出表格</option>
            {!showDeleted && (currentUser?.is_tech_admin || currentProjectRoles.includes('owner') || currentProjectRoles.includes('coordinator')) && currentProjectId && (
              <option value="import">从大纲导入</option>
            )}
            {!showDeleted && <option value="create">新增关键任务</option>}
          </select>
        </div>
      </header>

      {/* Sub-header: stat chips + batch bar */}
      <div className="bg-white border-b px-6 py-3 space-y-2.5 flex-shrink-0" style={{ borderColor: '#E9EFF6' }}>
        {/* Status chips */}
        <div className="flex items-center gap-3">
          {[
            { label: '未启动', filterVal: '未开始', val: count(tasks, NOT_STARTED), bg: '#F8FAFC', border: '#E2E8F0', color: '#64748B', iconBg: '#E2E8F0',
              icon: <svg style={{ width: 15, height: 15 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" strokeWidth="2" /><path strokeLinecap="round" strokeWidth="2" d="M12 8v4" /><circle cx="12" cy="16" r="0.5" fill="currentColor" /></svg> },
            { label: '进行中', filterVal: '进行中', val: count(tasks, IN_PROGRESS),  bg: '#EFF6FF', border: '#BFDBFE', color: '#2563EB', iconBg: '#DBEAFE',
              icon: <svg style={{ width: 15, height: 15 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg> },
            { label: '已完成', filterVal: '已完成', val: count(tasks, COMPLETED),    bg: '#F0FDF4', border: '#BBF7D0', color: '#059669', iconBg: '#D1FAE5',
              icon: <svg style={{ width: 15, height: 15 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg> },
            { label: '延期',   filterVal: '延期',   val: count(tasks, DELAYED), bg: '#FEF2F2', border: '#FECACA', color: '#DC2626', iconBg: '#FEE2E2',
              icon: <svg style={{ width: 15, height: 15 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg> },
            { label: '暂缓',   filterVal: '暂缓',   val: count(tasks, PAUSED),       bg: '#FFFBEB', border: '#FDE68A', color: '#D97706', iconBg: '#FEF3C7',
              icon: <svg style={{ width: 15, height: 15 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg> },
          ].map(({ label, filterVal, val, bg, border, color, iconBg, icon }) => {
            const isActive = norm(filterStatus) === norm(filterVal)
            return (
              <div
                key={label}
                onClick={() => setFilterStatus(isActive ? '' : filterVal)}
                className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl cursor-pointer transition-all hover:scale-[1.03]"
                style={{
                  background: bg,
                  border: `${isActive ? '2px' : '1.5px'} solid ${isActive ? color : border}`,
                  boxShadow: isActive ? `0 0 0 3px ${color}22` : undefined,
                }}
              >
                <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: iconBg, color }}>
                  {icon}
                </div>
                <div>
                  <p className="text-xs font-medium leading-none" style={{ color }}>{label}</p>
                  <p className="text-xl font-bold leading-none mt-0.5" style={{ color }}>{val}</p>
                </div>
              </div>
            )
          })}
        </div>

        {/* Batch bar */}
        {!showDeleted && checkedCount > 0 && (
          <div className="flex items-center gap-3">
            <span className="text-xs font-semibold text-blue-600 bg-blue-50 px-2.5 py-1 rounded-lg">已选择 {checkedCount} 项</span>
            <button onClick={clearChecked} className="cursor-pointer text-xs text-slate-500 hover:text-slate-700 font-medium">清除选择</button>
            <div className="w-px h-4 bg-slate-200" />
            <button className="cursor-pointer flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-slate-800 px-2.5 py-1.5 rounded-lg hover:bg-slate-100">
              <svg style={{ width: 12, height: 12 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
              批量更新状态
            </button>
            <button className="cursor-pointer flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-slate-800 px-2.5 py-1.5 rounded-lg hover:bg-slate-100">
              <svg style={{ width: 12, height: 12 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
              指派专项负责人
            </button>
            <button className="cursor-pointer flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-slate-800 px-2.5 py-1.5 rounded-lg hover:bg-slate-100">
              <svg style={{ width: 12, height: 12 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
              批量延期
            </button>
            <div className="ml-auto flex items-center gap-2">
              {canManageTrash && (
                <button onClick={handleBulkDelete} className="cursor-pointer flex items-center gap-1.5 text-xs font-semibold text-red-500 hover:text-red-700 px-2.5 py-1.5 rounded-lg hover:bg-red-50">
                  <svg style={{ width: 12, height: 12 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                  批量删除
                </button>
              )}
              <button onClick={() => { setChecked(new Set()); setLoading(true); loadTasks().finally(() => setLoading(false)) }} className="cursor-pointer flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-600 font-medium">
                <svg style={{ width: 12, height: 12 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                刷新
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Project Board */}
      <div className="flex-1 overflow-hidden relative" style={{ background: '#F1F5F9' }}>
        <div
          className="h-full overflow-auto"
          style={{
            background: '#F1F5F9',
            padding: '16px 20px 20px',
            paddingRight: selectedTask ? 404 : 20,
          }}
        >
          {loading ? (
            <div className="h-full flex items-center justify-center text-slate-400 text-sm">加载中...</div>
          ) : filtered.length === 0 ? (
            <div className="h-full flex items-center justify-center">
              <div className="text-center text-slate-400">
                <div className="text-sm font-semibold">暂无数据</div>
                <div className="text-xs mt-1">当前筛选条件下没有关键任务</div>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {groupedRows.map(({ key, tasks: groupTasks }) => {
                const groupProject = projects.find((p) => p.name === key) ?? focusedProject
                const groupColor = projectColor(projectOptions, key)
                const groupDone = count(groupTasks, COMPLETED)
                const groupProgress = groupTasks.length ? Math.round(groupDone / groupTasks.length * 100) : 0
                const groupInProgress = count(groupTasks, IN_PROGRESS)
                const groupDelayed = count(groupTasks, DELAYED)
                const groupPaused = count(groupTasks, PAUSED)
                const groupStatus = groupDelayed > 0 ? '延期' : groupInProgress > 0 ? '进行中' : groupDone === groupTasks.length ? '已完成' : '未启动'
                const groupBadge = getBadge(groupStatus)
                const groupLead = projectPeopleText(groupProject?.coordinator ?? groupProject?.owners?.[0])
                const collapsed = collapsedGroups.has(key)

                return (
                  <section
                    key={key}
                    className="rounded-2xl border bg-white shadow-[0_2px_12px_rgba(15,23,42,0.05)] overflow-hidden"
                    style={{ borderColor: '#E2E8F0' }}
                  >
                    <button
                      type="button"
                      onClick={() => toggleGroupCollapse(key)}
                      className="w-full text-left px-4 md:px-5 py-4 flex items-center gap-4 hover:bg-slate-50/80 transition-colors"
                    >
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <span
                          className="w-9 h-9 rounded-xl flex items-center justify-center border shrink-0"
                          style={{ borderColor: `${groupColor}30`, background: `${groupColor}12`, color: groupColor }}
                        >
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="w-5 h-5">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 7a2 2 0 012-2h4l2 2h10a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
                          </svg>
                        </span>
                        <h2 className="text-lg md:text-xl font-bold text-slate-800 truncate">{key || '未分组项目'}</h2>
                      </div>
                      <div className="hidden lg:flex items-center justify-center gap-4 shrink-0">
                        <span className={`inline-flex items-center gap-2 px-5 py-2 rounded-full text-sm font-bold shadow-[0_8px_24px_rgba(15,23,42,0.06)] ${groupBadge.cls}`}>
                          <span className="w-2 h-2 rounded-full" style={{ background: groupBadge.dot }} />
                          {groupBadge.label}
                        </span>
                        <span className="inline-flex items-center justify-center min-w-[86px] px-5 py-2 rounded-full text-sm font-bold text-slate-700 bg-slate-50 shadow-[0_8px_24px_rgba(15,23,42,0.05)]">
                          {groupProgress}%
                        </span>
                        <span className="inline-flex items-center gap-2 px-5 py-2 rounded-full text-sm font-bold text-amber-700 bg-amber-50 shadow-[0_8px_24px_rgba(180,83,9,0.08)]">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="w-4 h-4">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11.48 3.5a.6.6 0 011.04 0l2.34 4.74 5.23.76a.6.6 0 01.33 1.02l-3.78 3.69.89 5.2a.6.6 0 01-.87.63L12 17.08l-4.68 2.46a.6.6 0 01-.87-.63l.89-5.2-3.78-3.69A.6.6 0 013.9 9l5.23-.76 2.35-4.74z" />
                          </svg>
                          {groupTasks.length} 个关键任务
                        </span>
                        <span className="inline-flex items-center gap-2 px-5 py-2 rounded-full text-sm font-bold text-slate-600 bg-violet-50 shadow-[0_8px_24px_rgba(109,40,217,0.08)]">
                          <Avatar name={groupLead || ' '} size={22} />
                          统筹：{groupLead || '-'}
                        </span>
                      </div>
                      <svg
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        className="w-5 h-5 text-slate-400 shrink-0 transition-transform"
                        style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 9l6 6 6-6" />
                      </svg>
                    </button>

                    {!collapsed && (
                      <div className="px-3 md:px-5 pb-4">
                        <div className="rounded-2xl border bg-slate-50/70 overflow-hidden" style={{ borderColor: '#E9EFF6' }}>
                          <div className="flex items-center gap-3 px-3 md:px-4 py-2 border-b select-none" style={{ borderColor: '#E5EEF7', background: '#F8FAFC' }}>
                            {!showDeleted && <div className="w-5 shrink-0" />}
                            <div className="w-5 shrink-0" />
                            <div className="flex-1 min-w-0 text-xs font-semibold text-slate-400">关键任务</div>
                            <div className="grid shrink-0 gap-3 text-xs font-semibold text-slate-400" style={{ gridTemplateColumns: '140px 110px 100px 78px 68px 76px' }}>
                              <div>负责人</div>
                              <div>计划时间</div>
                              <div>状态</div>
                              <div>子任务</div>
                              <div className="text-center">风险</div>
                              <div className="text-right">操作</div>
                            </div>
                          </div>
                          {groupTasks.map((task, i) => {
                            const taskProject = projectForTask(projects, task)
                            const badge = getBadge(task.status)
                            const taskExpanded = expandedTasks.has(task.id)
                            const inlineSubs = showDeleted ? [] : (taskSubMap[task.id] ?? null)
                            const canExpand = !showDeleted
                            const rowDeleted = !!task.is_deleted
                            const subProgress = subTaskProgress(inlineSubs)
                            const taskOwner = projectPeopleText(taskProject?.owners ?? task.owner)
                            const rowBg = rowDeleted ? '#FFF7ED' : isOverdueTask(task) ? '#FFF1F2' : taskExpanded ? '#EFF6FF' : 'white'
                            const taskTags = (task.completion_standard ?? '').trim()

                            return (
                              <div
                                key={task.id}
                                className="border-b last:border-b-0"
                                style={{ borderColor: '#E5EEF7', background: rowBg }}
                              >
                                <div
                                  className="px-3 md:px-4 py-4 cursor-pointer"
                                  onClick={() => openDetail(task)}
                                >
                                  <div className="flex items-center gap-3">
                                    {!showDeleted && (
                                      <button
                                        type="button"
                                        onClick={(e) => toggleCheck(task.id, e)}
                                        className="w-5 h-5 rounded-md border flex items-center justify-center shrink-0"
                                        style={{
                                          borderColor: checked.has(task.id) ? '#3B82F6' : '#CBD5E1',
                                          background: checked.has(task.id) ? '#3B82F6' : '#fff',
                                          color: '#fff',
                                        }}
                                      >
                                        {checked.has(task.id) && (
                                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="w-3.5 h-3.5">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M5 13l4 4L19 7" />
                                          </svg>
                                        )}
                                      </button>
                                    )}
                                    {canExpand ? (
                                      <button
                                        type="button"
                                        onClick={(e) => toggleInlineSubTasks(e, task.id)}
                                        className="w-5 h-5 rounded-md flex items-center justify-center shrink-0 text-slate-400 hover:text-slate-600"
                                      >
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="w-4 h-4 transition-transform" style={{ transform: taskExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>
                                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
                                        </svg>
                                      </button>
                                    ) : (
                                      <span className="w-5 h-5 shrink-0" />
                                    )}
                                    <div className="min-w-0 flex-1">
                                      <div className="flex items-center gap-2 flex-wrap">
                                        <span className="text-xs font-bold rounded-lg px-2.5 py-1" style={{ background: '#EEF2FF', color: '#6D28D9' }}>{i + 1}</span>
                                        <h3 className="text-base md:text-lg font-bold text-slate-800 truncate">{task.key_task || '-'}</h3>
                                        {rowDeleted && (
                                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold" style={{ background: '#FFEDD5', color: '#C2410C' }}>
                                            已删除
                                          </span>
                                        )}
                                      </div>
                                    </div>

                                    <div className="grid shrink-0 items-center gap-3" style={{ gridTemplateColumns: '140px 110px 100px 78px 68px 76px' }}>
                                      <div className="min-w-0">
                                        <OwnerCell name={taskOwner} />
                                      </div>
                                      <div className="text-sm text-slate-600">{shortDate(task.plan_time)}</div>
                                      <div>
                                        <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold ${badge.cls}`} style={{ whiteSpace: 'nowrap' }}>
                                          <span className="w-1.5 h-1.5 rounded-full" style={{ background: badge.dot }} />
                                          {badge.label}
                                        </span>
                                      </div>
                                      <div className="text-sm font-bold text-blue-600">{subProgress.label}</div>
                                      <div className="text-center">
                                        {isOverdueTask(task) ? (
                                          <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-red-50 text-red-500">
                                            <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                                              <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                                            </svg>
                                          </span>
                                        ) : (
                                          <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-emerald-50 text-emerald-500">
                                            <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
                                              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                                            </svg>
                                          </span>
                                        )}
                                      </div>
                                      <div className="text-right">
                                        <button
                                          type="button"
                                          onClick={(e) => { e.stopPropagation(); openDetail(task) }}
                                          className="inline-flex items-center gap-1.5 text-blue-600 font-semibold hover:text-blue-700"
                                        >
                                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="w-4 h-4">
                                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0zm7.5 0s-3.5 7-10.5 7S1.5 12 1.5 12 5 5 12 5s10.5 7 10.5 7z" />
                                          </svg>
                                          查看
                                        </button>
                                      </div>
                                    </div>
                                  </div>

                                </div>

                                {canExpand && taskExpanded && (
                                  <div>
                                    {inlineSubs === null ? (
                                      <div className="px-10 py-3 text-sm text-slate-400 border-t" style={{ borderColor: '#E5EEF7' }}>子任务加载中...</div>
                                    ) : inlineSubs.length === 0 ? (
                                      <div className="px-10 py-3 text-sm text-slate-400 border-t" style={{ borderColor: '#E5EEF7' }}>暂无子任务</div>
                                    ) : inlineSubs.map((st, subIdx) => {
                                      const stBadge = getBadge(st.status)
                                      const canDeleteSub = canManageTrashForRoles(currentUser?.is_tech_admin, taskProject?.user_roles ?? [])
                                      return (
                                        <div
                                          key={st.id}
                                          className="flex items-center gap-3 px-3 md:px-4 py-3 border-t hover:bg-blue-50/40 transition-colors cursor-pointer"
                                          style={{ borderColor: '#E5EEF7', borderLeft: `4px solid ${groupColor}` }}
                                          onClick={() => openDetail(task)}
                                        >
                                          {!showDeleted && <div className="w-5 shrink-0" />}
                                          <div className="flex items-center gap-2 flex-1 min-w-0">
                                            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: groupColor }} />
                                            <span className="text-xs font-bold shrink-0" style={{ color: groupColor, minWidth: 28 }}>{i + 1}.{subIdx + 1}</span>
                                            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold shrink-0" style={{ background: '#EDE9FE', color: '#7C3AED' }}>子任务</span>
                                            <span className="text-sm font-medium text-slate-700 truncate">{st.title}</span>
                                          </div>
                                          <div className="grid shrink-0 items-center gap-3" style={{ gridTemplateColumns: '140px 110px 100px 78px 68px 76px' }}>
                                            <OwnerCell name={st.assignee} />
                                            <div className="text-sm text-slate-600">{shortDate(st.plan_time)}</div>
                                            <div>
                                              <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold ${stBadge.cls}`} style={{ whiteSpace: 'nowrap' }}>
                                                <span className="w-1.5 h-1.5 rounded-full" style={{ background: stBadge.dot }} />
                                                {stBadge.label}
                                              </span>
                                            </div>
                                            <div />
                                            <div />
                            <div className="text-right" onClick={(e) => e.stopPropagation()}>
                                              {canDeleteSub && !showDeleted && (
                                                <button
                                                  type="button"
                                                  onClick={(e) => {
                                                    e.stopPropagation()
                                                    if (!confirm(`确认删除子任务「${st.title}」？`)) return
                                                    deleteSubTask(st.id).then(() => {
                                                      setTaskSubMap((prev) => ({ ...prev, [task.id]: (prev[task.id] ?? []).filter((s) => s.id !== st.id) }))
                                                      refreshParentTask(task.id)
                                                    }).catch(() => alert('删除失败'))
                                                  }}
                                                  className="inline-flex items-center gap-1 text-xs font-semibold text-red-500 hover:text-red-700"
                                                >
                                                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" className="w-3.5 h-3.5">
                                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                                                  </svg>
                                                  删除
                                                </button>
                                              )}
                                            </div>
                                          </div>
                                        </div>
                                      )
                                    })}
                                  </div>
                                )}
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    )}
                  </section>
                )
              })}
            </div>
          )}
        </div>

        {/* Detail Panel */}
        {selectedTask && (() => {
          const taskProject = projectForTask(projects, selectedTask)
          const taskRoles = taskProject?.user_roles ?? []
          const isDeletedTask = !!selectedTask.is_deleted
          const canOwn = !!(currentUser?.is_tech_admin || taskRoles.includes('owner') || taskRoles.includes('coordinator'))
          const canTrashTask = canManageTrashForRoles(currentUser?.is_tech_admin, taskRoles)
          const canSubmitSubTask = !!(currentUser?.is_tech_admin || taskRoles.length > 0) && !isDeletedTask
          const detailProgress = subTaskProgress(subTasks)
          return (
          <div className="fixed top-16 right-0 bottom-0 z-30 flex flex-col overflow-hidden shadow-2xl" style={{ width: 380, borderLeft: '1px solid #E9EFF6', background: '#fff' }}>
            <div className="flex items-center justify-between px-4 py-3 border-b flex-shrink-0" style={{ borderColor: '#E9EFF6' }}>
              <h2 className="text-sm font-bold text-slate-800">关键任务详情</h2>
              <button onClick={() => setSelectedTask(null)} className="p-1 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors">
                <svg style={{ width: 16, height: 16 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">

              {/* 基本信息 */}
              <div>
                <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">基本信息</h3>
                <div className="rounded-xl p-3 space-y-0.5" style={{ background: '#F8FAFC', border: '1px solid #E9EFF6' }}>
                  {[
                    { label: '专项',   value: taskProject?.name ?? selectedTask.special_project, highlight: true },
                    { label: '关键任务', value: selectedTask.key_task },
                    { label: '专项负责人', value: projectPeopleText(taskProject?.owners ?? selectedTask.owner) },
                    { label: '专项统筹', value: projectPeopleText(taskProject?.coordinator ?? selectedTask.coordinator) },
                    { label: '专项协同', value: projectPeopleText(taskProject?.collaborators ?? selectedTask.collaborators) },
                    { label: '计划时间', value: selectedTask.plan_time },
                    { label: '删除状态', value: isDeletedTask ? `已删除 · ${selectedTask.deleted_by || '系统'}` : undefined },
                    { label: '删除时间', value: isDeletedTask ? shortDate(selectedTask.deleted_at) : undefined },
                    { label: '删除原因', value: isDeletedTask ? (selectedTask.delete_reason || '—') : undefined },
                    { label: '子任务进度', value: detailProgress.label },
                    { label: '确认入库', value: selectedTask.confirmed_by ? `由 ${selectedTask.confirmed_by} 入库` : undefined },
                    { label: '修改次数', value: (selectedTask.edit_count ?? 0) > 0 ? `已编辑 ${selectedTask.edit_count} 次` : undefined },
                  ].map(({ label, value, highlight }) => value ? (
                    <div key={label} className="flex items-start gap-2 py-1.5 border-b border-slate-100 text-xs last:border-b-0">
                      <span className="w-16 flex-shrink-0 text-slate-500 font-semibold">{label}</span>
                      <span className="flex-1" style={{ color: highlight ? '#0369A1' : '#1E293B', fontWeight: highlight ? 600 : 400, lineHeight: 1.5 }}>{value}</span>
                    </div>
                  ) : null)}
                  <div className="flex items-center gap-2 py-1.5 text-xs">
                    <span className="w-16 flex-shrink-0 text-slate-500 font-semibold">当前状态</span>
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-semibold ${getBadge(selectedTask.status).cls}`}>
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: getBadge(selectedTask.status).dot }} />
                      {getBadge(selectedTask.status).label}
                    </span>
                  </div>
                </div>
              </div>

              {/* 完成标准 高亮块 */}
              {selectedTask.completion_standard && (
                <div>
                  <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">完成标准</h3>
                  <div className="rounded-xl p-3" style={{ background: 'linear-gradient(135deg,#EFF6FF,#EEF2FF)', border: '1px solid #A5B4FC' }}>
                    <div className="flex items-start gap-2">
                      <div className="w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0 mt-0.5" style={{ background: '#6366F1' }}>
                        <svg style={{ width: 11, height: 11, color: 'white' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 21v-4m0 0V5a2 2 0 012-2h6.5l1 1H21l-3 6 3 6h-8.5l-1-1H5a2 2 0 00-2 2zm9-13.5V9" />
                        </svg>
                      </div>
                      <p className="text-xs leading-relaxed flex-1" style={{ color: '#3730A3', lineHeight: 1.6 }}>{selectedTask.completion_standard}</p>
                    </div>
                  </div>
                </div>
              )}

              {/* 问题与协调 */}
              {selectedTask.problem_note && (
                <div>
                  <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">问题与协调</h3>
                  <p className="text-xs text-slate-600 leading-relaxed p-3 rounded-xl" style={{ background: '#FFF7ED', border: '1px solid #FED7AA' }}>{selectedTask.problem_note}</p>
                </div>
              )}

              {/* 关键成果 */}
              {selectedTask.key_achievement && (
                <div>
                  <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">关键成果</h3>
                  <div className="flex items-center justify-between p-2.5 rounded-lg cursor-pointer hover:bg-slate-50" style={{ border: '1px solid #E9EFF6' }}>
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-md flex items-center justify-center" style={{ background: '#EFF6FF' }}>
                        <svg style={{ width: 11, height: 11, color: '#2563EB' }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                      </div>
                      <span className="text-xs font-medium text-blue-600">{selectedTask.key_achievement}</span>
                    </div>
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${getBadge(selectedTask.status).cls}`} style={{ fontSize: 10 }}>
                      {getBadge(selectedTask.status).label}
                    </span>
                  </div>
                </div>
              )}

              {/* 任务时间线 */}
              {taskLogs.length > 0 && (
                <div>
                  <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">任务时间线</h3>
                  <div className="pl-1">
                    {taskLogs.map((log, i) => {
                      const isLast = i === taskLogs.length - 1
                      const isActive = isLast
                      return (
                        <div key={i} className="flex items-start gap-3 pb-4 relative">
                          {!isLast && (
                            <div style={{ position: 'absolute', left: 7, top: 18, width: 1.5, height: 'calc(100% - 8px)', background: '#E9EFF6' }} />
                          )}
                          <div style={{
                            width: 16, height: 16, borderRadius: '50%', flexShrink: 0, marginTop: 1,
                            border: `2px solid ${isActive ? '#0369A1' : '#059669'}`,
                            background: isActive ? '#0369A1' : '#059669',
                          }} />
                          <div>
                            <p className="text-xs font-semibold" style={{ color: isActive ? '#0369A1' : '#334155' }}>{log.action}</p>
                            <p className="text-xs text-slate-400 mt-0.5">{log.operator} · {log.created_at}</p>
                            {log.note && <p className="text-xs text-slate-500 mt-0.5 leading-snug">{log.note}</p>}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* 最新更新记录 */}
              {taskUpdates.length > 0 && (
                <div>
                  <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">最新更新记录</h3>
                  <div className="space-y-2.5">
                    {taskUpdates.map((u) => (
                      <div key={u.id} className="p-2.5 rounded-lg" style={{ background: '#F8FAFC', border: '1px solid #E9EFF6' }}>
                        <div className="flex items-center justify-between mb-1">
                          <div className="flex items-center gap-1.5">
                            <span style={{ marginLeft: 0 }}><Avatar name={u.submitter} size={22} /></span>
                            <span className="text-xs font-semibold text-slate-700 ml-1">{u.submitter}</span>
                          </div>
                          <span className="text-xs text-slate-400">{u.created_at}</span>
                        </div>
                        <p className="text-xs text-slate-500 leading-snug mt-1">{u.transcript_text || '—'}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* ── 子任务 ── */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider">
                    子任务
                    {subTasks.length > 0 && (
                      <span className="ml-1.5 px-1.5 py-0.5 rounded-full text-xs font-bold" style={{ background: '#DBEAFE', color: '#1D4ED8' }}>{subTasks.length}</span>
                    )}
                  </h3>
                  {canSubmitSubTask && (
                    <button
                      onClick={() => setSubTaskFormOpen(true)}
                      className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold text-white hover:opacity-90"
                      style={{ background: 'linear-gradient(135deg,#6366F1,#818CF8)' }}
                    >
                      <svg style={{ width: 11, height: 11 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M12 4v16m8-8H4" /></svg>
                      添加
                    </button>
                  )}
                </div>
                {subTasks.length === 0 ? (
                  <p className="text-xs text-slate-400 py-3 text-center rounded-xl" style={{ border: '1.5px dashed #E2E8F0' }}>暂无子任务</p>
                ) : (
                  <div className="space-y-2">
                    {subTasks.map((st) => {
                      const stBadge = getBadge(st.status)
                      const isMyTask = currentUser?.name === st.assignee
                      const canEditSt = canOwn || isMyTask
                      const isNotStarted = norm(st.status) === norm('未开始')
                      return (
                        <div key={st.id} className="p-2.5 rounded-xl" style={{ background: isNotStarted ? '#F8FAFC' : '#F0FDF4', border: `1px solid ${isNotStarted ? '#E9EFF6' : '#BBF7D0'}` }}>
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-xs font-semibold text-slate-700 leading-snug flex-1">{st.title}</p>
                            <div className="flex items-center gap-1.5 flex-shrink-0">
                              {canOwn && isNotStarted && (
                                <button
                                  onClick={() =>
                                    patchSubTaskStatus(st.id, '进行中')
                                      .then((updated) => {
                                        const next = subTasks.map((x) => x.id === st.id ? updated : x)
                                        setSubTasks(next)
                                        refreshParentTask(st.task_id)
                                        maybePromptCloseKeyTask(st.task_id, next)
                                      })
                                      .catch(() => alert('下发失败，请重试'))
                                  }
                                  className="flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold text-white hover:opacity-90"
                                  style={{ background: 'linear-gradient(135deg,#0369A1,#0EA5E9)' }}
                                >
                                  <svg style={{ width: 10, height: 10 }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"/>
                                  </svg>
                                  下发
                                </button>
                              )}
                              {canTrashTask && (
                                <button
                                  onClick={() => { if (confirm(`确认删除子任务「${st.title}」？此操作暂不能在页面内恢复。`)) deleteSubTask(st.id).then(() => {
                                    if (selectedTask) {
                                      loadTaskSubTaskBuckets(selectedTask.id).catch(() => {})
                                      refreshParentTask(selectedTask.id)
                                    }
                                  }).catch(() => alert('删除失败')) }}
                                  className="text-red-300 hover:text-red-500"
                                >
                                  <svg style={{ width: 12, height: 12 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
                                </button>
                              )}
                            </div>
                          </div>
                          <div className="flex items-center gap-2 mt-1.5">
                            <div className="flex items-center gap-1">
                              <span style={{ marginLeft: 0 }}><Avatar name={st.assignee} size={18} /></span>
                              <span className="text-xs text-slate-500 ml-1">{st.assignee}</span>
                            </div>
                            {st.plan_time && <span className="text-xs text-slate-400">{shortDate(st.plan_time)}</span>}
                          </div>
                          <div className="flex items-center gap-2 mt-1.5">
                            {canEditSt ? (
                              <select
                                value={st.status}
                                onChange={(e) => {
                                  const newStatus = e.target.value
                                  patchSubTaskStatus(st.id, newStatus)
                                    .then((updated) => {
                                      const next = subTasks.map((x) => x.id === st.id ? updated : x)
                                      setSubTasks(next)
                                      refreshParentTask(st.task_id)
                                      maybePromptCloseKeyTask(st.task_id, next)
                                    })
                                    .catch(() => alert('更新失败'))
                                }}
                                className="text-xs border rounded-full px-2 py-0.5 font-semibold cursor-pointer focus:outline-none"
                                style={{ background: stBadge.cls.includes('blue') ? '#EFF6FF' : stBadge.cls.includes('emerald') ? '#F0FDF4' : stBadge.cls.includes('red') ? '#FEF2F2' : stBadge.cls.includes('amber') ? '#FFFBEB' : '#F8FAFC', color: stBadge.dot, border: `1px solid ${stBadge.dot}40` }}
                              >
                                {['未开始','进行中','已完成','延期','暂缓'].map((s) => <option key={s}>{s}</option>)}
                              </select>
                            ) : (
                              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${stBadge.cls}`}>
                                <span className="w-1.5 h-1.5 rounded-full" style={{ background: stBadge.dot }} />
                                {stBadge.label}
                              </span>
                            )}
                            {st.completion_criteria && (
                              <span className="text-xs text-indigo-500 truncate" title={st.completion_criteria}>📌 {st.completion_criteria.slice(0, 20)}{st.completion_criteria.length > 20 ? '…' : ''}</span>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}

                {canTrashTask && trashedSubTasks.length > 0 && (
                  <div className="mt-4 pt-4 border-t" style={{ borderColor: '#E9EFF6' }}>
                    <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">
                      回收站子任务
                      <span className="ml-1.5 px-1.5 py-0.5 rounded-full text-xs font-bold" style={{ background: '#FFEDD5', color: '#C2410C' }}>{trashedSubTasks.length}</span>
                    </h4>
                    <div className="space-y-2">
                      {trashedSubTasks.map((st) => {
                        const stBadge = getBadge(st.status)
                        return (
                          <div key={`trash-${st.id}`} className="p-2.5 rounded-xl" style={{ background: '#FFF7ED', border: '1px solid #FDBA74' }}>
                            <div className="flex items-start justify-between gap-2">
                              <p className="text-xs font-semibold text-orange-900 leading-snug flex-1">{st.title}</p>
                              {!isDeletedTask ? (
                                <button
                                  onClick={() => handleRestoreSubTask(st)}
                                  className="text-xs font-semibold text-orange-700 hover:text-orange-900"
                                >
                                  恢复
                                </button>
                              ) : (
                                <span className="text-[11px] font-semibold text-orange-600">随关键任务恢复</span>
                              )}
                            </div>
                            <div className="flex items-center gap-2 mt-1.5">
                              <div className="flex items-center gap-1">
                                <span style={{ marginLeft: 0 }}><Avatar name={st.assignee} size={18} /></span>
                                <span className="text-xs text-slate-500 ml-1">{st.assignee}</span>
                              </div>
                              {st.plan_time && <span className="text-xs text-slate-400">{shortDate(st.plan_time)}</span>}
                              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${stBadge.cls}`} style={{ marginLeft: 'auto' }}>
                                <span className="w-1.5 h-1.5 rounded-full" style={{ background: stBadge.dot }} />
                                {stBadge.label}
                              </span>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}
              </div>

            </div>

            {isDeletedTask && canTrashTask ? (
              <div className="px-4 py-3 border-t flex gap-2 flex-shrink-0" style={{ borderColor: '#E9EFF6' }}>
                <button
                  onClick={() => handleRestoreTask(selectedTask)}
                  className="flex-1 py-2 rounded-lg text-white text-xs font-bold hover:opacity-90"
                  style={{ background: 'linear-gradient(135deg,#C2410C,#FB923C)' }}
                >
                  恢复关键任务
                </button>
                <button
                  onClick={() => setSelectedTask(null)}
                  className="px-3 py-2 rounded-lg border border-slate-200 text-slate-600 text-xs font-semibold hover:bg-slate-50"
                >
                  关闭
                </button>
              </div>
            ) : isDeletedTask ? (
              <div className="px-4 py-3 border-t flex-shrink-0" style={{ borderColor: '#E9EFF6' }}>
                <p className="text-xs text-slate-400 text-center py-2">你当前没有恢复权限</p>
              </div>
            ) : progressOpen ? (
              <div className="px-4 py-3 border-t flex-shrink-0" style={{ borderColor: '#E9EFF6' }}>
                {progressSubmitState === 'done' ? (
                  <p className="text-center text-xs text-emerald-600 font-semibold py-2">✓ 已提交，等待负责人审核</p>
                ) : (
                  <>
                    <textarea
                      className="w-full rounded-lg border border-slate-200 text-xs p-2 resize-none focus:outline-none focus:border-sky-400"
                      rows={3}
                      placeholder="请输入本次进展说明…"
                      value={progressText}
                      onChange={(e) => setProgressText(e.target.value)}
                      disabled={progressSubmitState === 'submitting'}
                    />
                    <div className="flex gap-2 mt-2">
                      <button
                        onClick={handleProgressSubmit}
                        disabled={!progressText.trim() || progressSubmitState === 'submitting'}
                        className="flex-1 py-1.5 rounded-lg text-white text-xs font-bold disabled:opacity-50"
                        style={{ background: 'linear-gradient(135deg,#0369A1,#0EA5E9)' }}
                      >
                        {progressSubmitState === 'submitting' ? '提交中…' : '提交'}
                      </button>
                      <button
                        onClick={() => { setProgressOpen(false); setProgressText(''); setProgressSubmitState('idle') }}
                        className="flex-1 py-1.5 rounded-lg border border-slate-200 text-slate-600 text-xs font-semibold hover:bg-slate-50"
                      >
                        取消
                      </button>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <div className="px-4 py-3 border-t flex gap-2 flex-shrink-0" style={{ borderColor: '#E9EFF6' }}>
                <button onClick={() => { setFormTask(selectedTask); setFormOpen(true) }} className="flex-1 py-2 rounded-lg text-white text-xs font-bold hover:opacity-90" style={{ background: 'linear-gradient(135deg,#0369A1,#0EA5E9)' }}>编辑关键任务</button>
                <button onClick={() => setProgressOpen(true)} className="flex-1 py-2 rounded-lg border border-slate-200 text-slate-600 text-xs font-semibold hover:bg-slate-50">更新进展</button>
                {canTrashTask && (
                  <button
                    onClick={() => handleDelete(selectedTask)}
                    className="px-3 py-2 rounded-lg border text-xs font-semibold hover:bg-red-50"
                    style={{ borderColor: '#FECACA', color: '#EF4444' }}
                    title="删除关键任务及其子任务"
                  >
                    删除
                  </button>
                )}
              </div>
            )}
          </div>
          )
        })()}
      </div>
    </div>
  )
}

// ─── 大纲导入弹窗 ────────────────────────────────────────────────────────────

function OutlineImportModal({ defaultProjectId, projects, onCreated, onClose }: {
  defaultProjectId: number
  projects: { id: number; name: string }[]
  onCreated: (tasks: TaskItem[]) => void
  onClose: () => void
}) {
  const [step, setStep] = useState<'input' | 'preview'>('input')
  const [selectedProjectId, setSelectedProjectId] = useState<number>(defaultProjectId)
  const [aiSuggestion, setAiSuggestion] = useState<{ name: string; guess: string; confidence: number } | null>(null)
  const [outlineText, setOutlineText] = useState('')
  const [extracting, setExtracting] = useState(false)
  const [drafts, setDrafts] = useState<TaskDraft[]>([])
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')
  const [provider, setProvider] = useState<string | null>(null)
  const [providerLabel, setProviderLabel] = useState('')
  const [noEngine, setNoEngine] = useState(false)

  useEffect(() => {
    apiGet<{ provider: string; display_name: string }[]>('/api/llm-config/available').then((list) => {
      if (list.length === 0) { setNoEngine(true); return }
      setProvider(list[0].provider)
      setProviderLabel(list[0].display_name)
    }).catch(() => setNoEngine(true))
  }, [])

  async function handleExtract() {
    if (!outlineText.trim() || !provider) return
    setExtracting(true)
    setError('')
    setAiSuggestion(null)
    try {
      const res = await extractTasksFromOutline({
        text: outlineText.trim(),
        llm_provider: provider,
        project_names: projects.map((p) => p.name),
      })
      if (!res.tasks.length) { setError('AI 未能从文本中提取到任务，请补充更多细节后重试'); return }
      setDrafts(res.tasks)
      if (res.suggested_project) {
        const matched = projects.find((p) => p.name === res.suggested_project)
        if (matched) {
          setSelectedProjectId(matched.id)
          setAiSuggestion({ name: res.suggested_project, guess: res.project_guess, confidence: res.confidence })
        }
      }
      setStep('preview')
    } catch (e: any) {
      setError(e?.message || 'AI 提取失败，请检查 API Key 配置')
    } finally {
      setExtracting(false)
    }
  }

  async function handleCreate() {
    const valid = drafts.filter((d) => d.key_task.trim())
    if (!valid.length) return
    setCreating(true)
    try {
      const created = await batchCreateTasks({ project_id: selectedProjectId, tasks: valid })
      onCreated(created)
    } catch {
      alert('批量创建失败，请重试')
    } finally {
      setCreating(false)
    }
  }

  function updateDraft(i: number, field: keyof TaskDraft, val: string) {
    setDrafts((prev) => prev.map((d, idx) => idx === i ? { ...d, [field]: val } : d))
  }

  function removeDraft(i: number) {
    setDrafts((prev) => prev.filter((_, idx) => idx !== i))
  }

  const inputCls = 'w-full border border-slate-200 rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:border-blue-400'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(15,23,42,0.45)' }}>
      <div className="bg-white rounded-2xl shadow-2xl flex flex-col" style={{ width: 720, maxWidth: '95vw', maxHeight: '90vh' }}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b flex-shrink-0" style={{ borderColor: '#E9EFF6' }}>
          <div>
            <div className="flex items-center gap-3">
              <h2 className="text-base font-bold text-slate-800">从大纲导入关键任务</h2>
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-slate-400">导入至</span>
                <select
                  value={selectedProjectId}
                  onChange={(e) => { setSelectedProjectId(Number(e.target.value)); setAiSuggestion(null) }}
                  className="text-xs border border-indigo-200 rounded-lg px-2 py-1 bg-indigo-50 text-indigo-700 font-semibold focus:outline-none focus:border-indigo-400 cursor-pointer"
                >
                  {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                {aiSuggestion && (
                  <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: aiSuggestion.confidence >= 0.9 ? '#F0FDF4' : '#FFFBEB', color: aiSuggestion.confidence >= 0.9 ? '#15803D' : '#B45309', border: `1px solid ${aiSuggestion.confidence >= 0.9 ? '#BBF7D0' : '#FDE68A'}` }}>
                    ✦ AI推断 · {aiSuggestion.confidence >= 0.9 ? '高置信' : '中置信'}
                  </span>
                )}
              </div>
            </div>
            <p className="text-xs text-slate-400 mt-0.5">
              {step === 'input' ? '粘贴项目大纲、计划文档或任务列表，AI 自动提取' : `已提取 ${drafts.length} 条任务草稿，可逐行编辑后确认创建`}
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400">
            <svg style={{ width: 16, height: 16 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {step === 'input' ? (
            <div className="space-y-3">
              {noEngine ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-4 text-sm text-amber-700">
                  <p className="font-semibold mb-1">尚未配置 AI 引擎</p>
                  <p>请前往<strong>系统设置 → 模型配置</strong>填写至少一个 API Key 并启用，再回来使用此功能。</p>
                </div>
              ) : (
                <>
                  {providerLabel && (
                    <p className="text-xs text-slate-400">将使用 <span className="font-semibold text-slate-600">{providerLabel}</span> 提取任务</p>
                  )}
                  <textarea
                    className="w-full border border-slate-200 rounded-xl px-4 py-3 text-sm resize-none focus:outline-none focus:border-blue-400"
                    rows={12}
                    placeholder={"示例：\n1. 知识库AI化 — 负责人：张三，6月底前完成，预期产出：知识问答原型\n2. 顾问作业智能辅助 — 李四负责，Q3完成\n3. 交付流程标准化 …\n\n支持任意格式：Word 粘贴、会议纪要、脑图文字、随手记录均可"}
                    value={outlineText}
                    onChange={(e) => setOutlineText(e.target.value)}
                    disabled={extracting}
                  />
                  {error && <p className="text-xs text-red-500">{error}</p>}
                </>
              )}
            </div>
          ) : (
            <div className="space-y-2">
              {drafts.map((d, i) => (
                <div key={i} className="border border-slate-200 rounded-xl p-3 space-y-2" style={{ background: '#FAFBFD' }}>
                  <div className="flex items-start gap-2">
                    <span className="text-xs font-bold text-slate-400 mt-2 w-5 flex-shrink-0">#{i + 1}</span>
                    <div className="flex-1 grid grid-cols-2 gap-2">
                      <div className="col-span-2">
                        <label className="block text-xs font-semibold text-slate-500 mb-1">关键任务 *</label>
                        <input className={inputCls} value={d.key_task} onChange={(e) => updateDraft(i, 'key_task', e.target.value)} placeholder="任务名称" />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-500 mb-1">负责人</label>
                        <input className={inputCls} value={d.owner} onChange={(e) => updateDraft(i, 'owner', e.target.value)} placeholder="姓名" />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-500 mb-1">统筹人</label>
                        <input className={inputCls} value={d.coordinator} onChange={(e) => updateDraft(i, 'coordinator', e.target.value)} placeholder="姓名" />
                      </div>
                      <div className="col-span-2">
                        <label className="block text-xs font-semibold text-slate-500 mb-1">协作人</label>
                        <input className={inputCls} value={d.collaborators} onChange={(e) => updateDraft(i, 'collaborators', e.target.value)} placeholder="多人用逗号分隔" />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-500 mb-1">计划时间</label>
                        <input className={inputCls} value={d.plan_time} onChange={(e) => updateDraft(i, 'plan_time', e.target.value)} placeholder="2026-06 或 2026-06~2026-09" />
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-500 mb-1">状态</label>
                        <select className={inputCls} value={d.status} onChange={(e) => updateDraft(i, 'status', e.target.value)}>
                          {STATUS_OPTIONS.map((s) => <option key={s}>{s}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="block text-xs font-semibold text-slate-500 mb-1">期望成果</label>
                        <input className={inputCls} value={d.key_achievement} onChange={(e) => updateDraft(i, 'key_achievement', e.target.value)} placeholder="主要产出物" />
                      </div>
                      <div className="col-span-2">
                        <label className="block text-xs font-semibold text-slate-500 mb-1">完成标准</label>
                        <input className={inputCls} value={d.completion_standard} onChange={(e) => updateDraft(i, 'completion_standard', e.target.value)} placeholder="何为完成" />
                      </div>
                    </div>
                    <button onClick={() => removeDraft(i)} className="mt-1.5 p-1 rounded hover:bg-red-50 text-slate-300 hover:text-red-400 flex-shrink-0">
                      <svg style={{ width: 14, height: 14 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                  </div>
                </div>
              ))}
              {drafts.length === 0 && <p className="text-sm text-slate-400 text-center py-6">所有草稿已删除</p>}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t flex items-center justify-between flex-shrink-0" style={{ borderColor: '#E9EFF6' }}>
          {step === 'preview' ? (
            <>
              <button onClick={() => setStep('input')} className="px-4 py-2 rounded-lg border border-slate-200 text-slate-600 text-sm font-semibold hover:bg-slate-50">返回修改</button>
              <button
                onClick={handleCreate}
                disabled={creating || drafts.length === 0}
                className="px-5 py-2 rounded-lg text-white text-sm font-bold disabled:opacity-50"
                style={{ background: 'linear-gradient(135deg,#0369A1,#0EA5E9)' }}
              >
                {creating ? '创建中…' : `确认创建 ${drafts.length} 条任务`}
              </button>
            </>
          ) : (
            <>
              <button onClick={onClose} className="px-4 py-2 rounded-lg border border-slate-200 text-slate-600 text-sm font-semibold hover:bg-slate-50">取消</button>
              {!noEngine && (
                <button
                  onClick={handleExtract}
                  disabled={!outlineText.trim() || extracting || !provider}
                  className="px-5 py-2 rounded-lg text-white text-sm font-bold disabled:opacity-50"
                  style={{ background: 'linear-gradient(135deg,#0369A1,#0EA5E9)' }}
                >
                  {extracting ? 'AI 提取中…' : 'AI 提取任务'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── 新增子任务弹窗 ───────────────────────────────────────────────────────────

function SubTaskFormModal({ taskId, people, onSave, onClose }: {
  taskId: number
  people: Person[]
  onSave: (st: SubTaskItem) => void
  onClose: () => void
}) {
  const [title, setTitle]             = useState('')
  const [assignee, setAssignee]       = useState(people[0]?.name ?? '')
  const [planTime, setPlanTime]       = useState('')
  const [status, setStatus]           = useState('未开始')
  const [criteria, setCriteria]       = useState('')
  const [notes, setNotes]             = useState('')
  const [saving, setSaving]           = useState(false)
  const [sy, setSy] = useState(new Date().getFullYear())
  const [sm, setSm] = useState(new Date().getMonth() + 1)
  const [ey, setEy] = useState(new Date().getFullYear())
  const [em, setEm] = useState(new Date().getMonth() + 1)
  const [useRange, setUseRange] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim() || !assignee) return
    const pt = useRange ? formatPlanTime(sy, sm, ey, em) : planTime
    setSaving(true)
    try {
      const created = await createSubTask(taskId, { title, assignee, plan_time: pt, status, completion_criteria: criteria, notes })
      onSave(created)
    } catch {
      alert('创建失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  const inputCls = "w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-400"
  const selectCls = "border border-slate-200 rounded-lg px-2 py-1.5 text-sm bg-white focus:outline-none focus:border-indigo-400 cursor-pointer"
  const labelCls = "block text-xs font-semibold text-slate-500 mb-1"

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(15,23,42,0.4)' }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full overflow-hidden" style={{ maxWidth: 480, maxHeight: '90vh' }}>
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: '#E9EFF6' }}>
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: 'linear-gradient(135deg,#6366F1,#818CF8)' }}>
              <svg style={{ width: 13, height: 13, color: 'white' }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
            </div>
            <h2 className="text-sm font-bold text-slate-800">添加子任务</h2>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400">
            <svg style={{ width: 15, height: 15 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="overflow-y-auto px-5 py-4 space-y-4" style={{ maxHeight: 'calc(90vh - 120px)' }}>
          <div>
            <label className={labelCls}>任务说明 *</label>
            <input required className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="描述具体要做什么" />
          </div>

          <div>
            <label className={labelCls}>指定提交人 *</label>
            <select required className={inputCls} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
              <option value="">请选择提交人</option>
              {people.map((p) => <option key={p.id} value={p.name}>{p.name}{p.department ? ` · ${p.department}` : ''}</option>)}
            </select>
          </div>

          <div>
            <label className={labelCls}>计划时间</label>
            <div className="flex items-center gap-2 mb-1.5">
              <label className="flex items-center gap-1.5 cursor-pointer text-xs text-slate-500">
                <input type="checkbox" checked={useRange} onChange={(e) => setUseRange(e.target.checked)} className="w-3.5 h-3.5 accent-indigo-500" />
                时间段模式
              </label>
            </div>
            {useRange ? (
              <div className="flex items-center gap-1.5 flex-wrap text-xs text-slate-500">
                <span>从</span>
                <select className={selectCls} value={sy} onChange={(e) => setSy(+e.target.value)}>{YEARS.map((y) => <option key={y}>{y}</option>)}</select>
                <span>年</span>
                <select className={selectCls} value={sm} onChange={(e) => setSm(+e.target.value)}>{MONTHS.map((m) => <option key={m} value={m}>{m}</option>)}</select>
                <span>月 至</span>
                <select className={selectCls} value={ey} onChange={(e) => setEy(+e.target.value)}>{YEARS.map((y) => <option key={y}>{y}</option>)}</select>
                <span>年</span>
                <select className={selectCls} value={em} onChange={(e) => setEm(+e.target.value)}>{MONTHS.map((m) => <option key={m} value={m}>{m}</option>)}</select>
                <span>月</span>
              </div>
            ) : (
              <input className={inputCls} value={planTime} onChange={(e) => setPlanTime(e.target.value)} placeholder="如：2026年6月" />
            )}
          </div>

          <div>
            <label className={labelCls}>当前状态</label>
            <select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value)}>
              {['未开始','进行中','已完成','延期','暂缓'].map((s) => <option key={s}>{s}</option>)}
            </select>
          </div>

          <div>
            <label className={labelCls}>完成标准（可选）</label>
            <textarea className={inputCls} rows={2} value={criteria} onChange={(e) => setCriteria(e.target.value)} placeholder="如何判断该子任务完成" />
          </div>

          <div>
            <label className={labelCls}>备注（可选）</label>
            <textarea className={inputCls} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="其他说明" />
          </div>
        </form>

        <div className="px-5 py-4 border-t flex justify-end gap-3 flex-shrink-0" style={{ borderColor: '#E9EFF6' }}>
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl border border-slate-200 text-slate-600 text-sm font-semibold hover:bg-slate-50">取消</button>
          <button onClick={handleSubmit as any} disabled={saving} className="px-5 py-2 rounded-xl text-white text-sm font-bold hover:opacity-90 disabled:opacity-50" style={{ background: 'linear-gradient(135deg,#6366F1,#818CF8)' }}>
            {saving ? '创建中…' : '创建子任务'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── 新增/编辑关键任务弹窗 ────────────────────────────────────────────────────

const YEARS  = [2025, 2026, 2027, 2028]
const MONTHS = [1,2,3,4,5,6,7,8,9,10,11,12]
const STATUS_OPTIONS = ['未开始','进行中','已完成','延期','暂缓']

function parsePlanTime(val: string) {
  // 支持 "2026年5月~2026年8月" 或 "2026年5月" 或 "2026-06" 或 "5-6月"
  const rangeMatch = val.match(/(\d{4})年(\d{1,2})月[~\-～至到](\d{4})年(\d{1,2})月/)
  if (rangeMatch) return { sy: +rangeMatch[1], sm: +rangeMatch[2], ey: +rangeMatch[3], em: +rangeMatch[4] }
  const singleMatch = val.match(/(\d{4})年(\d{1,2})月/)
  if (singleMatch) return { sy: +singleMatch[1], sm: +singleMatch[2], ey: +singleMatch[1], em: +singleMatch[2] }
  const isoRangeMatch = val.match(/(\d{4})-(\d{2})[~\-～至到](\d{4})-(\d{2})/)
  if (isoRangeMatch) return { sy: +isoRangeMatch[1], sm: +isoRangeMatch[2], ey: +isoRangeMatch[3], em: +isoRangeMatch[4] }
  const isoMatch = val.match(/(\d{4})-(\d{2})/)
  if (isoMatch) return { sy: +isoMatch[1], sm: +isoMatch[2], ey: +isoMatch[1], em: +isoMatch[2] }
  return { sy: 2026, sm: new Date().getMonth() + 1, ey: 2026, em: new Date().getMonth() + 1 }
}

function isPlanOverdue(planTime: string): boolean {
  if (!planTime) return false
  const { ey, em } = parsePlanTime(planTime)
  const now = new Date()
  // ey*12+em < 当前年*12+当前月（注意 getMonth() 从 0 开始）
  return ey * 12 + em < now.getFullYear() * 12 + (now.getMonth() + 1)
}

function formatPlanTime(sy: number, sm: number, ey: number, em: number) {
  if (sy === ey && sm === em) return `${sy}年${sm}月`
  return `${sy}年${sm}月~${ey}年${em}月`
}

function TaskFormModal({ task, projects, onSave, onClose }: {
  task: TaskItem | null
  projects: string[]
  onSave: (p: TaskPayload) => void
  onClose: () => void
}) {
  const parsed = parsePlanTime(task?.plan_time ?? '')
  const [form, setForm] = useState<TaskPayload>({
    special_project: task?.special_project ?? (projects[0] ?? ''),
    key_task:        task?.key_task ?? '',
    key_achievement: task?.key_achievement ?? '',
    completion_standard: task?.completion_standard ?? '',
    owner:           task?.owner ?? '',
    collaborators:   task?.collaborators ?? '',
    plan_time:       task?.plan_time ?? '',
    status:          task?.status ?? '未开始',
    problem_note:    task?.problem_note ?? '',
  })
  const [sy, setSy] = useState(parsed.sy)
  const [sm, setSm] = useState(parsed.sm)
  const [ey, setEy] = useState(parsed.ey)
  const [em, setEm] = useState(parsed.em)

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    onSave({ ...form, plan_time: formatPlanTime(sy, sm, ey, em) })
  }

  const inputCls = "w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
  const selectCls = "border border-slate-200 rounded-lg px-2 py-1.5 text-sm bg-white focus:outline-none focus:border-blue-400 cursor-pointer"
  const labelCls = "block text-xs font-semibold text-slate-500 mb-1"

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(15,23,42,0.4)' }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full overflow-hidden" style={{ maxWidth: 640, maxHeight: '90vh' }}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: '#E9EFF6' }}>
          <h2 className="text-base font-bold text-slate-800">{task ? '编辑关键任务' : '新增关键任务'}</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400">
            <svg style={{ width: 16, height: 16 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="overflow-y-auto px-6 py-5 space-y-4" style={{ maxHeight: 'calc(90vh - 130px)' }}>
          {/* 专项 */}
          <div>
            <label className={labelCls}>专项 *</label>
            <select className={inputCls} value={form.special_project} onChange={e => setForm(f => ({ ...f, special_project: e.target.value }))}>
              {projects.map(p => <option key={p}>{p}</option>)}
            </select>
          </div>

          {/* 关键任务 */}
          <div>
            <label className={labelCls}>关键任务 *</label>
            <input required className={inputCls} value={form.key_task} onChange={e => setForm(f => ({ ...f, key_task: e.target.value }))} placeholder="描述本任务的核心工作内容" />
          </div>

          {/* 关键成果 */}
          <div>
            <label className={labelCls}>关键成果</label>
            <input className={inputCls} value={form.key_achievement} onChange={e => setForm(f => ({ ...f, key_achievement: e.target.value }))} placeholder="如：方案、SOP、报告..." />
          </div>

          {/* 完成标准 */}
          <div>
            <label className={labelCls}>完成标准</label>
            <textarea className={inputCls} rows={2} value={form.completion_standard} onChange={e => setForm(f => ({ ...f, completion_standard: e.target.value }))} placeholder="如何判断该任务已完成" />
          </div>

          {/* 计划完成时间 */}
          <div>
            <label className={labelCls}>计划时间段</label>
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-xs text-slate-500">从</span>
              <select className={selectCls} value={sy} onChange={e => setSy(+e.target.value)}>
                {YEARS.map(y => <option key={y}>{y}</option>)}
              </select>
              <span className="text-xs text-slate-500">年</span>
              <select className={selectCls} value={sm} onChange={e => setSm(+e.target.value)}>
                {MONTHS.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
              <span className="text-xs text-slate-500">月 &nbsp; 至</span>
              <select className={selectCls} value={ey} onChange={e => setEy(+e.target.value)}>
                {YEARS.map(y => <option key={y}>{y}</option>)}
              </select>
              <span className="text-xs text-slate-500">年</span>
              <select className={selectCls} value={em} onChange={e => setEm(+e.target.value)}>
                {MONTHS.map(m => <option key={m} value={m}>{m}</option>)}
              </select>
              <span className="text-xs text-slate-500">月</span>
            </div>
            <p className="text-xs text-slate-400 mt-1">预览：{formatPlanTime(sy, sm, ey, em)}</p>
          </div>

          <div>
            <label className={labelCls}>当前状态</label>
            <select className={inputCls} value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
              {STATUS_OPTIONS.map(s => <option key={s}>{s}</option>)}
            </select>
            <p className="text-xs text-slate-400 mt-1">已完成状态由子任务完成情况汇总，直接保存已完成会由后端校验。</p>
          </div>

          {/* 问题与协调 */}
          <div>
            <label className={labelCls}>问题与协调</label>
            <textarea className={inputCls} rows={2} value={form.problem_note} onChange={e => setForm(f => ({ ...f, problem_note: e.target.value }))} placeholder="当前存在的阻碍或需协调的事项" />
          </div>
        </form>

        {/* Footer */}
        <div className="px-6 py-4 border-t flex justify-end gap-3 flex-shrink-0" style={{ borderColor: '#E9EFF6' }}>
          <button type="button" onClick={onClose} className="px-5 py-2 rounded-xl border border-slate-200 text-slate-600 text-sm font-semibold hover:bg-slate-50">取消</button>
          <button type="submit" form="" onClick={handleSubmit as any} className="px-5 py-2 rounded-xl text-white text-sm font-bold hover:opacity-90" style={{ background: 'linear-gradient(135deg,#0369A1,#0EA5E9)' }}>
            {task ? '保存修改' : '创建任务'}
          </button>
        </div>
      </div>
    </div>
  )
}
