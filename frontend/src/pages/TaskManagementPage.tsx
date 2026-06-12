import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { exportTasksToExcel } from '../utils/exportTasksExcel'
import { createTask, deleteTask, fetchTaskLogs, fetchTaskUpdates, fetchTasks, updateTask } from '../api/tasks'
import type { TaskLog, TaskPayload, TaskUpdate } from '../api/tasks'
import { fetchSubTasks, createSubTask, patchSubTaskStatus, deleteSubTask } from '../api/subtasks'
import { apiGet } from '../api/client'
import { useProject } from '../context/ProjectContext'
import type { TaskItem, SubTaskItem, Person } from '../types'

const NOT_STARTED = new Set(['未开始', 'not_started', 'notstarted'])
const IN_PROGRESS  = new Set(['推进中', '进行中', 'in_progress'])
const COMPLETED    = new Set(['已完成', '完成', 'completed'])
const DELAYED      = new Set(['延期', '已延期', 'delayed'])
const PAUSED       = new Set(['暂停', '暂缓', '已暂停', 'paused'])

function norm(s?: string | null) { return String(s ?? '').trim().toLowerCase().replace(/\s+/g, '_') }
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
  const [subTaskFormOpen, setSubTaskFormOpen] = useState(false)
  const [peopleList, setPeopleList]   = useState<Person[]>([])
  // inline sub-task expand in table
  const [taskSubMap, setTaskSubMap]     = useState<Record<number, SubTaskItem[]>>({})
  const [expandedTasks, setExpandedTasks] = useState<Set<number>>(new Set())
  const [searchParams] = useSearchParams()
  const [search, setSearch]           = useState('')
  const [filterStatus, setFilterStatus] = useState(() => searchParams.get('status') ?? '')
  const [filterProject, setFilterProject] = useState('')  // 专项名，空=全部
  const [filterOwner, setFilterOwner] = useState('')
  // viewProjectId：null=全部任务，非null=特定项目
  const [viewProjectId, setViewProjectId] = useState<number | null>(null)

  // 侧边栏切换项目时重置为全部
  useEffect(() => {
    setViewProjectId(null)
    setFilterProject('')
  }, [currentProjectId])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetchTasks(viewProjectId)
      .then((d) => { if (!cancelled) setTasks(Array.isArray(d) ? d : []) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [viewProjectId])

  // 专项下拉选项来自全部可见项目，而非已加载任务
  const projectOptions = projects.map((p) => p.name)
  const ownerNames = [...new Set(
    tasks.flatMap((t) => (t.owner ?? '').split(/[,，、]/).map((s) => s.trim()).filter(Boolean))
  )]

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
      if (filterOwner && !(t.owner ?? '').split(/[,，、]/).map((s) => s.trim()).includes(filterOwner)) return false
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
    fetchTaskLogs(task.id).then(setTaskLogs).catch(() => {})
    fetchTaskUpdates(task.id).then(setTaskUpdates).catch(() => {})
    fetchSubTasks(task.id).then(setSubTasks).catch(() => {})
    apiGet<Person[]>('/api/people').then((p) => setPeopleList(p.filter((x) => x.is_active !== false))).catch(() => {})
  }

  function toggleInlineSubTasks(e: React.MouseEvent, taskId: number) {
    e.stopPropagation()
    setExpandedTasks((prev) => {
      const next = new Set(prev)
      if (next.has(taskId)) { next.delete(taskId); return next }
      next.add(taskId)
      if (!(taskId in taskSubMap)) {
        fetchSubTasks(taskId)
          .then((subs) => setTaskSubMap((p) => ({ ...p, [taskId]: subs })))
          .catch(() => setTaskSubMap((p) => ({ ...p, [taskId]: [] })))
      }
      return next
    })
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
    if (!confirm(`确认删除任务「${task.key_task}」？`)) return
    deleteTask(task.id).then(() => {
      setTasks((prev) => prev.filter((t) => t.id !== task.id))
      if (selectedTask?.id === task.id) setSelectedTask(null)
      setChecked((prev) => { const n = new Set(prev); n.delete(task.id); return n })
    }).catch(() => alert('删除失败'))
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
    if (!confirm(`确认删除选中的 ${checked.size} 条任务？关联问题也会一并删除，此操作不可恢复。`)) return
    const ids = [...checked]
    await Promise.all(ids.map((id) => deleteTask(id).catch(() => {})))
    setChecked(new Set())
    if (selectedTask && ids.includes(selectedTask.id)) setSelectedTask(null)
    const pid = viewProjectId ?? currentProjectId
    fetchTasks(pid).then((d) => setTasks(Array.isArray(d) ? d : []))
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
      fetchTasks(pid).then((d) => setTasks(Array.isArray(d) ? d : []))
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
      {subTaskFormOpen && selectedTask && (
        <SubTaskFormModal
          taskId={selectedTask.id}
          people={peopleList}
          onSave={(st) => { setSubTasks((p) => [...p, st]); setSubTaskFormOpen(false) }}
          onClose={() => setSubTaskFormOpen(false)}
        />
      )}

      {/* Top Bar */}
      <header className="h-16 flex items-center px-6 gap-3 flex-shrink-0 bg-white border-b" style={{ borderColor: '#E9EFF6' }}>
        <div className="flex-1">
          <h1 className="text-base font-bold text-slate-800">工作推进表</h1>
          <p className="text-xs text-slate-400 mt-0.5">以任务为主数据，承接专项推进、成果关联与问题跟踪</p>
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
            <span className="text-xs text-slate-500 font-medium">负责人</span>
            <select
              value={filterOwner}
              onChange={(e) => setFilterOwner(e.target.value)}
              className="text-sm border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white text-slate-600 cursor-pointer focus:outline-none"
            >
              <option value="">全部负责人</option>
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
          <button onClick={handleExport} className="cursor-pointer flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-200 text-slate-600 text-sm font-semibold hover:bg-slate-50 transition-colors">
            <svg style={{ width: 14, height: 14 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
            导出表格
          </button>
          <button onClick={() => { setFormTask(null); setFormOpen(true) }} className="cursor-pointer flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-white text-sm font-semibold hover:opacity-90" style={{ background: 'linear-gradient(135deg,#0369A1,#0EA5E9)', boxShadow: '0 2px 8px rgba(3,105,161,0.25)' }}>
            <svg style={{ width: 14, height: 14 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" /></svg>
            新增任务
          </button>
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
            { label: '延期',   filterVal: '延期',   val: tasks.filter(isOverdueTask).length, bg: '#FEF2F2', border: '#FECACA', color: '#DC2626', iconBg: '#FEE2E2',
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
        {checkedCount > 0 && (
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
              指派负责人
            </button>
            <button className="cursor-pointer flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-slate-800 px-2.5 py-1.5 rounded-lg hover:bg-slate-100">
              <svg style={{ width: 12, height: 12 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
              批量延期
            </button>
            <div className="ml-auto flex items-center gap-2">
              {(currentUser?.is_tech_admin || currentProjectRoles.includes('owner')) && (
                <button onClick={handleBulkDelete} className="cursor-pointer flex items-center gap-1.5 text-xs font-semibold text-red-500 hover:text-red-700 px-2.5 py-1.5 rounded-lg hover:bg-red-50">
                  <svg style={{ width: 12, height: 12 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                  批量删除
                </button>
              )}
              <button onClick={() => { setChecked(new Set()); setLoading(true); fetchTasks(currentProjectId!).then(setTasks).finally(() => setLoading(false)) }} className="cursor-pointer flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-600 font-medium">
                <svg style={{ width: 12, height: 12 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                刷新
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Table + Detail Panel */}
      <div className="flex-1 overflow-hidden flex" style={{ background: '#F1F5F9' }}>

        {/* Table */}
        <div className="flex-1 flex flex-col overflow-hidden bg-white">
          {loading ? (
            <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">加载中…</div>
          ) : (
            <div className="flex-1 overflow-auto">
              <table style={{ minWidth: 980, width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <th className="py-2.5 px-4 border-b" style={{ background: '#E8EDF5', borderColor: '#C7D2E8', position: 'sticky', top: 0, zIndex: 10, width: 36 }}>
                      <input type="checkbox" checked={allChecked} onChange={toggleAll} style={{ width: 15, height: 15, accentColor: '#0369A1', cursor: 'pointer', background: '#E8EDF5' }} />
                    </th>
                    {['专项', '关键任务', '关键成果', '提交人', '计划时间段', '当前状态', '问题', '操作'].map((h) => (
                      <th key={h} className="py-2.5 pr-3 text-left text-xs font-semibold border-b" style={{ color: '#475569', background: '#E8EDF5', borderColor: '#C7D2E8', position: 'sticky', top: 0, zIndex: 10 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="text-xs">
                  {groupedRows.map(({ key, tasks: groupTasks }) =>
                    groupTasks.flatMap((task, i) => {
                      const isFirst    = i === 0
                      const isLast     = i === groupTasks.length - 1
                      const isSelected = selectedTask?.id === task.id
                      const isDelayed  = DELAYED.has(norm(task.status)) || (
                        !COMPLETED.has(norm(task.status)) && !PAUSED.has(norm(task.status)) && isPlanOverdue(task.plan_time)
                      )
                      const badge      = getBadge(task.status)
                      const projCol    = projectColor(projectOptions, task.special_project)
                      const expanded   = expandedTasks.has(task.id)
                      const rowBg      = isSelected ? '#E0F2FE' : expanded ? '#F5F7FF' : 'white'
                      const inlineSubs = taskSubMap[task.id] ?? null
                      // group bottom border goes on the last rendered row of the last task
                      const isGroupEnd = isLast && !expanded
                      const rowBorder  = isGroupEnd ? '2px solid #CBD5E1' : '1px solid #E2E8F0'

                      const taskRow = (
                        <tr
                          key={task.id}
                          onClick={(e) => toggleInlineSubTasks(e, task.id)}
                          className="cursor-pointer transition-colors"
                          style={{ background: rowBg, borderBottom: rowBorder }}
                        >
                          <td className="py-2 px-4" onClick={(e) => toggleCheck(task.id, e)}>
                            <input type="checkbox" checked={checked.has(task.id)} onChange={() => {}} style={{ width: 15, height: 15, accentColor: '#0369A1', cursor: 'pointer' }} />
                          </td>

                          {/* 专项：仅首行渲染，rowSpan 覆盖整组（含子任务行） */}
                          {isFirst && (
                            <td
                              rowSpan={groupRowSpan(groupTasks)}
                              className="pr-3"
                              style={{
                                verticalAlign: 'middle',
                                paddingLeft: 0,
                                background: '#EEF2FF',
                                borderLeft: `4px solid ${projCol}`,
                                borderRight: '2px solid #C7D2E8',
                                borderBottom: '2px solid #CBD5E1',
                              }}
                            >
                              <span className="inline-flex items-center gap-1.5 pl-2">
                                <span className="font-semibold text-slate-700 text-xs leading-snug">{key || '-'}</span>
                              </span>
                            </td>
                          )}

                          <td className="py-2 pr-3 font-medium text-slate-700" style={{ maxWidth: 180 }}>
                            <div className="flex items-start gap-1.5">
                              <button
                                onClick={(e) => toggleInlineSubTasks(e, task.id)}
                                className="flex-shrink-0 flex items-center justify-center rounded hover:bg-indigo-50 transition-colors"
                                style={{ width: 16, height: 16, marginTop: 2, color: expanded ? '#6366F1' : '#94A3B8' }}
                                title={expanded ? '收起子任务' : '展开子任务'}
                              >
                                <svg viewBox="0 0 12 12" fill="currentColor" style={{ width: 10, height: 10, transition: 'transform 0.15s', transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>
                                  <path d="M4 2l4 4-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
                                </svg>
                              </button>
                              <div>
                                <div style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', lineHeight: 1.45 } as React.CSSProperties}>
                                  {task.key_task || '-'}
                                </div>
                                {inlineSubs !== null && inlineSubs.length > 0 && (
                                  <span style={{ fontSize: 10, color: '#818CF8', marginTop: 2, display: 'block' }}>{inlineSubs.length} 个子任务</span>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className="py-2 pr-3" style={{ maxWidth: 130 }}><ResultBadge text={task.key_achievement} /></td>
                          <td className="py-2 pr-3" style={{ minWidth: 80 }}>
                            <OwnerCell name={task.submitter || task.owner} />
                          </td>
                          <td className="py-2 pr-3 font-medium" style={{ color: isDelayed ? '#EF4444' : '#475569', fontWeight: isDelayed ? 700 : 500 }}>{task.plan_time || '-'}</td>
                          <td className="py-2 pr-3">
                            <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold ${badge.cls}`}>
                              <span className="w-1.5 h-1.5 rounded-full" style={{ background: badge.dot }} />
                              {badge.label}
                            </span>
                          </td>
                          <td className="py-2 pr-3">
                            {task.problem_note
                              ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-orange-100 text-orange-700">
                                  <span className="w-1.5 h-1.5 rounded-full bg-orange-500 flex-shrink-0" />
                                  待协调
                                </span>
                              : <span className="text-slate-300">—</span>
                            }
                          </td>
                          <td className="py-2 pr-3">
                            <div className="flex items-center gap-2">
                              <button className="text-blue-500 hover:text-blue-700 font-semibold" onClick={(e) => { e.stopPropagation(); openDetail(task) }}>查看</button>
                              {(currentUser?.is_tech_admin || currentProjectRoles.includes('owner')) && (
                                <button className="text-red-400 hover:text-red-600 font-semibold" onClick={(e) => { e.stopPropagation(); handleDelete(task) }}>删除</button>
                              )}
                            </div>
                          </td>
                        </tr>
                      )

                      // sub-task rows (rendered only when expanded)
                      const subRows = expanded ? (
                        inlineSubs === null
                          ? [<tr key={`st-loading-${task.id}`} style={{ background: '#F0F3FF', borderBottom: '1px dashed #E0E7FF' }}>
                              <td /><td colSpan={7} className="py-1.5 pl-8 text-slate-400" style={{ fontSize: 10 }}>加载中…</td>
                            </tr>]
                          : inlineSubs.length === 0
                            ? []
                            : inlineSubs.map((st, si) => {
                                const isLastSub = si === inlineSubs.length - 1
                                const subBadge  = getBadge(st.status)
                                const subBorder = isLast && isLastSub ? '2px solid #CBD5E1' : isLastSub ? '1px solid #E0E7FF' : '1px dashed #E0E7FF'
                                return (
                                  <tr key={`st-${st.id}`} style={{ background: '#F0F3FF', borderBottom: subBorder }}>
                                    <td className="py-1.5 px-4"><span style={{ display: 'inline-block', width: 15, height: 15 }} /></td>
                                    <td className="py-1.5 pr-3 text-slate-600" style={{ maxWidth: 180, borderLeft: '2px solid #A5B4FC' }}>
                                      <div style={{ paddingLeft: 12 }}>
                                        <span style={{ fontSize: 11, lineHeight: 1.4 }}>{st.title}</span>
                                      </div>
                                    </td>
                                    <td className="py-1.5 pr-3 text-slate-400" style={{ fontSize: 10 }}>{st.completion_criteria || '—'}</td>
                                    <td className="py-1.5 pr-3">
                                      <div className="flex items-center gap-1">
                                        <Avatar name={st.assignee} size={18} />
                                        <span className="text-slate-600 ml-1" style={{ fontSize: 11 }}>{st.assignee}</span>
                                      </div>
                                    </td>
                                    <td className="py-1.5 pr-3 text-slate-500" style={{ fontSize: 11 }}>{st.plan_time || '—'}</td>
                                    <td className="py-1.5 pr-3">
                                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-semibold ${subBadge.cls}`} style={{ fontSize: 10 }}>
                                        <span className="w-1 h-1 rounded-full" style={{ background: subBadge.dot }} />
                                        {subBadge.label}
                                      </span>
                                    </td>
                                    <td />
                                    <td className="py-1.5 pr-3">
                                      {(currentUser?.is_tech_admin || (() => {
                                        const tp = projects.find((p) => p.id === (task as any).project_id || p.name === task.special_project)
                                        return tp?.user_roles?.includes('owner')
                                      })()) && (
                                        <button
                                          className="text-red-400 hover:text-red-600 font-semibold"
                                          style={{ fontSize: 10 }}
                                          onClick={(e) => {
                                            e.stopPropagation()
                                            deleteSubTask(st.id).then(() => setTaskSubMap((p) => ({ ...p, [task.id]: (p[task.id] ?? []).filter((x) => x.id !== st.id) }))).catch(() => {})
                                          }}
                                        >删除</button>
                                      )}
                                    </td>
                                  </tr>
                                )
                              })
                      ) : []

                      return [taskRow, ...subRows]
                    })
                  )}
                  {filtered.length === 0 && (
                    <tr><td colSpan={9} className="py-12 text-center text-slate-400 text-sm">暂无数据</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          <div className="flex items-center justify-between px-6 py-3 bg-white border-t flex-shrink-0" style={{ borderColor: '#E9EFF6' }}>
            <span className="text-xs text-slate-400">共 {filtered.length} 条</span>
            <div className="flex items-center gap-1">
              <button className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-400 hover:bg-slate-100 disabled:opacity-30" disabled>
                <svg style={{ width: 12, height: 12 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" /></svg>
              </button>
              <button className="w-7 h-7 rounded-lg text-white text-xs font-bold" style={{ background: '#0369A1' }}>1</button>
              <button className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-400 hover:bg-slate-100 disabled:opacity-30" disabled>
                <svg style={{ width: 12, height: 12 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" /></svg>
              </button>
            </div>
            <select className="text-xs border border-slate-200 rounded-lg px-2 py-1 bg-white text-slate-500 cursor-pointer focus:outline-none">
              <option>20 条/页</option><option>50 条/页</option>
            </select>
          </div>
        </div>

        {/* Detail Panel */}
        {selectedTask && (() => {
          const taskProject = projects.find((p) => p.id === (selectedTask as any).project_id || p.name === selectedTask.special_project)
          const taskRoles = taskProject?.user_roles ?? []
          const canOwn = !!(currentUser?.is_tech_admin || taskRoles.includes('owner'))
          return (
          <div className="flex flex-col overflow-hidden" style={{ width: 340, flexShrink: 0, borderLeft: '1px solid #E9EFF6', background: '#fff' }}>
            <div className="flex items-center justify-between px-4 py-3 border-b flex-shrink-0" style={{ borderColor: '#E9EFF6' }}>
              <h2 className="text-sm font-bold text-slate-800">任务详情</h2>
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
                    { label: '专项',   value: selectedTask.special_project, highlight: true },
                    { label: '关键任务', value: selectedTask.key_task },
                    { label: '负责人', value: selectedTask.owner },
                    { label: '统筹人', value: selectedTask.coordinator },
                    { label: '协同人', value: selectedTask.collaborators },
                    { label: '计划时间', value: selectedTask.plan_time },
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
                  {canOwn && (
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
                      return (
                        <div key={st.id} className="p-2.5 rounded-xl" style={{ background: '#F8FAFC', border: '1px solid #E9EFF6' }}>
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-xs font-semibold text-slate-700 leading-snug flex-1">{st.title}</p>
                            {canOwn && (
                              <button
                                onClick={() => { if (confirm(`确认删除子任务「${st.title}」？`)) deleteSubTask(st.id).then(() => setSubTasks((p) => p.filter((x) => x.id !== st.id))).catch(() => alert('删除失败')) }}
                                className="text-red-300 hover:text-red-500 flex-shrink-0"
                              >
                                <svg style={{ width: 12, height: 12 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
                              </button>
                            )}
                          </div>
                          <div className="flex items-center gap-2 mt-1.5">
                            <div className="flex items-center gap-1">
                              <span style={{ marginLeft: 0 }}><Avatar name={st.assignee} size={18} /></span>
                              <span className="text-xs text-slate-500 ml-1">{st.assignee}</span>
                            </div>
                            {st.plan_time && <span className="text-xs text-slate-400">{st.plan_time}</span>}
                          </div>
                          <div className="flex items-center gap-2 mt-1.5">
                            {canEditSt ? (
                              <select
                                value={st.status}
                                onChange={(e) => patchSubTaskStatus(st.id, e.target.value).then((updated) => setSubTasks((p) => p.map((x) => x.id === st.id ? updated : x))).catch(() => alert('更新失败'))}
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
              </div>

            </div>

            <div className="px-4 py-3 border-t flex gap-2 flex-shrink-0" style={{ borderColor: '#E9EFF6' }}>
              <button onClick={() => { setFormTask(selectedTask); setFormOpen(true) }} className="flex-1 py-2 rounded-lg text-white text-xs font-bold hover:opacity-90" style={{ background: 'linear-gradient(135deg,#0369A1,#0EA5E9)' }}>编辑任务</button>
              <button className="flex-1 py-2 rounded-lg border border-slate-200 text-slate-600 text-xs font-semibold hover:bg-slate-50">更新进展</button>
            </div>
          </div>
          )
        })()}
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

// ─── 新增/编辑任务弹窗 ────────────────────────────────────────────────────────

const YEARS  = [2025, 2026, 2027, 2028]
const MONTHS = [1,2,3,4,5,6,7,8,9,10,11,12]
const STATUS_OPTIONS = ['未开始','进行中','已完成','延期','暂缓']

function parsePlanTime(val: string) {
  // 支持 "2026年5月~2026年8月" 或 "2026年5月" 或 "2026-06" 或 "5-6月"
  const rangeMatch = val.match(/(\d{4})年(\d{1,2})月[~\-～至到](\d{4})年(\d{1,2})月/)
  if (rangeMatch) return { sy: +rangeMatch[1], sm: +rangeMatch[2], ey: +rangeMatch[3], em: +rangeMatch[4] }
  const singleMatch = val.match(/(\d{4})年(\d{1,2})月/)
  if (singleMatch) return { sy: +singleMatch[1], sm: +singleMatch[2], ey: +singleMatch[1], em: +singleMatch[2] }
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
          <h2 className="text-base font-bold text-slate-800">{task ? '编辑任务' : '新增任务'}</h2>
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

          {/* 两列：负责人 + 状态 */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>负责人</label>
              <input className={inputCls} value={form.owner} onChange={e => setForm(f => ({ ...f, owner: e.target.value }))} placeholder="姓名" />
            </div>
            <div>
              <label className={labelCls}>当前状态</label>
              <select className={inputCls} value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                {STATUS_OPTIONS.map(s => <option key={s}>{s}</option>)}
              </select>
            </div>
          </div>

          {/* 协同成员 */}
          <div>
            <label className={labelCls}>协同成员</label>
            <input className={inputCls} value={form.collaborators} onChange={e => setForm(f => ({ ...f, collaborators: e.target.value }))} placeholder="多人用逗号分隔" />
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
