import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getPending, confirmSubmission, rejectSubmission, transferCoordinator, escalateCeo } from '../api/confirmations'
import { deleteUpdate, fetchMyUpdates } from '../api/updates'
import { fetchSubtasksByAssignee, type SubTaskWithParent } from '../api/subtasks'
import { fetchTasks } from '../api/tasks'
import { useProject } from '../context/ProjectContext'
import type { ConfirmationItem, TaskItem } from '../types'
import { fmtFull, fmtShort } from '../utils/time'
import * as SS from '../domain/submissionStatus'
import { getConfirmationContext } from '../domain/confirmationFlow'

type WriteMode = 'task_new' | 'subtask_update' | 'subtask_new'

function fmtTime(s?: string | null) { return fmtFull(s) }

function renderVal(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  if (Array.isArray(v)) {
    if (v.length === 0) return '—'
    return v.map((item) => {
      if (typeof item === 'object' && item !== null) {
        const o = item as Record<string, unknown>
        return String(o.name ?? o.description ?? '')
      }
      return String(item)
    }).filter(Boolean).join('、')
  }
  if (typeof v === 'number') return v < 1 ? `${Math.round(v * 100)}%` : String(v)
  return String(v)
}

const STATUS_DOT: Record<string, string> = {
  '进行中': '#3B82F6', '已完成': '#10B981', '延期': '#EF4444', '暂缓': '#F59E0B', '未开始': '#94A3B8',
}

const ISSUE_STYLE: Record<string, { bg: string; text: string }> = {
  '风险':   { bg: '#FEE2E2', text: '#991B1B' },
  '待协调': { bg: '#DBEAFE', text: '#1D4ED8' },
  '需决策': { bg: '#EDE9FE', text: '#5B21B6' },
  '问题':   { bg: '#FEF3C7', text: '#92400E' },
}

const ISSUE_PRIORITY: Record<string, number> = { '需决策': 4, '风险': 3, '待协调': 2, '问题': 1 }

function deduplicateIssues(issues: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Map<string, Record<string, unknown>>()
  for (const issue of issues) {
    const desc = String(issue.description || '').trim()
    if (!desc) continue
    const existing = seen.get(desc)
    if (!existing) {
      seen.set(desc, issue)
    } else {
      const ep = ISSUE_PRIORITY[String(existing.issue_type || '问题')] ?? 1
      const np = ISSUE_PRIORITY[String(issue.issue_type || '问题')] ?? 1
      if (np > ep) seen.set(desc, issue)
    }
  }
  return Array.from(seen.values())
}

function SourceBadge({ type }: { type?: string }) {
  if (!type || type === '语音更新') return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-semibold" style={{ background: '#EFF6FF', border: '1px solid #BFDBFE', color: '#1D4ED8' }}>
      <svg style={{ width: 10, height: 10 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
      {type || '语音更新'}
    </span>
  )
  if (type === '会议纪要') return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-semibold" style={{ background: '#F0FDF4', border: '1px solid #BBF7D0', color: '#15803D' }}>
      <svg style={{ width: 10, height: 10 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
      会议纪要
    </span>
  )
  return <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-semibold bg-slate-100 text-slate-600">{type}</span>
}

function StatusBadge({ status }: { status?: string }) {
  const norm = SS.normalize(status)
  const cls = SS.STATUS_BADGE_CLASS[norm] ?? 'bg-slate-100 text-slate-600'
  const label = SS.DISPLAY_LABEL[norm] ?? (status ?? '-')
  return <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${cls}`}>{label}</span>
}

function ConfBadge({ val }: { val?: number | null }) {
  if (!val) return <span className="text-slate-400 text-xs">-</span>
  const pct = val < 1 ? Math.round(val * 100) : Math.round(val)
  const color = pct >= 85 ? '#059669' : pct >= 70 ? '#D97706' : '#DC2626'
  return <span style={{ color, fontWeight: 700, fontSize: 11 }}>{pct}%</span>
}

function Ava({ name }: { name: string }) {
  const COLORS = ['#3B82F6', '#8B5CF6', '#10B981', '#F59E0B', '#EF4444', '#06B6D4']
  const c = COLORS[(name.charCodeAt(0) || 0) % COLORS.length]
  return (
    <div className="w-6 h-6 rounded-full flex items-center justify-center text-white flex-shrink-0" style={{ background: c, fontSize: 11, fontWeight: 700 }}>
      {name.slice(0, 1)}
    </div>
  )
}

function ToggleSwitch({ on }: { on: boolean }) {
  return (
    <div className="relative flex-shrink-0" style={{ width: 36, height: 20 }}>
      <div className="absolute inset-0 rounded-full transition-colors" style={{ background: on ? '#0369A1' : '#E2E8F0' }} />
      <div className="absolute rounded-full bg-white transition-transform" style={{ width: 14, height: 14, top: 3, left: 3, boxShadow: '0 1px 3px rgba(0,0,0,0.2)', transform: on ? 'translateX(16px)' : 'translateX(0)' }} />
    </div>
  )
}

export function ConfirmPage() {
  const navigate = useNavigate()
  const { currentProjectId, currentUser, projects, currentCapabilities } = useProject()
  const [items, setItems] = useState<ConfirmationItem[]>([])
  const [selected, setSelected] = useState<ConfirmationItem | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [acting, setActing] = useState(false)
  const [pendingAction, setPendingAction] = useState<'reject' | 'supplement' | 'forward' | 'ceo' | null>(null)
  const [actionNote, setActionNote] = useState('')
  const [opLogsOpen, setOpLogsOpen] = useState(false)

  const isReviewer = !!(
    currentCapabilities?.canConfirm ||
    currentCapabilities?.canCoordinate ||
    currentCapabilities?.canCeoDecide
  )
  const [viewMode, setViewMode] = useState<'mine' | 'all'>('mine')
  useEffect(() => {
    if (isReviewer) setViewMode('all')
  }, [isReviewer])

  const [filterStatus, setFilterStatus] = useState(SS.S_NEW)
  const [filterProject, setFilterProject] = useState('')
  const [filterSubmitter, setFilterSubmitter] = useState('')
  const [search, setSearch] = useState('')

  const [writeMode, setWriteMode] = useState<WriteMode>('task_new')
  const [targetSubtaskId, setTargetSubtaskId] = useState<number | null>(null)
  const [targetTaskId, setTargetTaskId] = useState<number | null>(null)
  const [newSubtaskTitle, setNewSubtaskTitle] = useState('')
  const [writeToIssues, setWriteToIssues] = useState(true)
  const [writeToAchievements, setWriteToAchievements] = useState(false)

  const [pendingItemTypes, setPendingItemTypes] = useState<Record<number, string>>({})
  const [pendingItemHelpers, setPendingItemHelpers] = useState<Record<number, string>>({})
  const [pendingItemNotes, setPendingItemNotes] = useState<Record<number, string>>({})

  const [cardEditMode, setCardEditMode] = useState<Record<number, boolean>>({})
  const [cardProjOverride, setCardProjOverride] = useState<Record<number, string>>({})
  const [cardKeyTaskOverride, setCardKeyTaskOverride] = useState<Record<number, number | null>>({})
  const [cardSubtaskOverride, setCardSubtaskOverride] = useState<Record<number, number | null>>({})

  const [projectTasks, setProjectTasks] = useState<TaskItem[]>([])
  const [submitterSubtasks, setSubmitterSubtasks] = useState<SubTaskWithParent[]>([])
  const [suggestTaskSelections, setSuggestTaskSelections] = useState<Record<number, number | null>>({})

  const [editProject, setEditProject] = useState('')
  const [editStatus, setEditStatus] = useState('进行中')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadError(null)
    setSelected(null)
    setItems([])
    if (viewMode === 'mine') {
      fetchMyUpdates()
        .then((d) => {
          if (!cancelled) {
            const mapped = d as unknown as ConfirmationItem[]
            setItems(mapped)
            const firstPending = mapped.find(i => SS.normalize(i.confirm_status) === SS.S_NEW || SS.normalize(i.confirm_status) === SS.S_PENDING_OWNER) || mapped[0]
            if (firstPending) pickItem(firstPending)
          }
        })
        .catch(() => { if (!cancelled) setLoadError('记录加载失败，请刷新重试') })
        .finally(() => { if (!cancelled) setLoading(false) })
    } else {
      getPending(null, 'all')
        .then((d) => {
          if (!cancelled) {
            setItems(d)
            const firstPending = d.find(i => SS.normalize(i.confirm_status) === SS.S_NEW || SS.normalize(i.confirm_status) === SS.S_PENDING_OWNER) || d[0]
            if (firstPending) pickItem(firstPending)
          }
        })
        .catch(() => { if (!cancelled) setLoadError('记录加载失败，请刷新重试') })
        .finally(() => { if (!cancelled) setLoading(false) })
    }
    return () => { cancelled = true }
  }, [currentProjectId, viewMode])

  function getAIResult(item: ConfirmationItem): Record<string, unknown> | null {
    try {
      const raw = (item as Record<string, unknown>).ai_result_json
      return raw ? JSON.parse(raw as string) : null
    } catch { return null }
  }

  function getHumanResult(item: ConfirmationItem): Record<string, unknown> | null {
    try {
      const raw = (item as Record<string, unknown>).human_result_json
      return raw ? JSON.parse(raw as string) : null
    } catch { return null }
  }

  function pickItem(item: ConfirmationItem) {
    setSelected(item)
    const r = getAIResult(item)
    const aiProject = String(r?.special_project || item.special_project || '')
    const matched = projects.find((p) => p.name === aiProject)
    const fallback = projects.find((p) => p.id === currentProjectId)?.name ?? (projects[0]?.name ?? '')
    setEditProject(matched ? aiProject : fallback)
    setEditStatus(String(r?.status_suggestion || '进行中'))
    setPendingAction(null)
    setActionNote('')
    setSuggestTaskSelections({})
    setNewSubtaskTitle(String(r?.related_task || ''))

    const h = getHumanResult(item)
    const hTaskId = h?.selected_task_id ? Number(h.selected_task_id) : null
    const hSubtaskId = h?.selected_subtask_id ? Number(h.selected_subtask_id) : null
    if (hSubtaskId) {
      setWriteMode('subtask_update'); setTargetSubtaskId(hSubtaskId); setTargetTaskId(null)
    } else if (hTaskId) {
      setWriteMode('subtask_new'); setTargetTaskId(hTaskId); setTargetSubtaskId(null)
    } else {
      setWriteMode('task_new'); setTargetSubtaskId(null); setTargetTaskId(null)
    }

    const submitter = item.submitter
    const pid = currentProjectId
    if (submitter) fetchSubtasksByAssignee(submitter, pid).then(setSubmitterSubtasks).catch(() => setSubmitterSubtasks([]))
    if (pid) fetchTasks(pid).then(setProjectTasks).catch(() => setProjectTasks([]))
    setPendingItemTypes({})
    setPendingItemHelpers({})
    setPendingItemNotes({})
    setCardEditMode({})
    setCardProjOverride({})
    setCardKeyTaskOverride({})
    setCardSubtaskOverride({})
  }

  async function handleConfirm() {
    if (!selected || !currentUser) return
    setActing(true)
    try {
      const base = getHumanResult(selected) || getAIResult(selected) || {}
      const taskBase = (base.task as Record<string, unknown>) || {}
      const keyTask = String(taskBase.key_task || base.related_task || base.summary || '')
      const keyAchievement = String(
        taskBase.key_achievement ||
        (Array.isArray(base.completed_items)
          ? (base.completed_items as string[]).join('；')
          : (base.completed_items || ''))
      )
      const patchedTaskReports = Array.isArray(base.task_reports)
        ? (base.task_reports as Record<string, unknown>[]).map((r, i) => {
            if (r.result_type === 'suggest_new_subtask') {
              return { ...r, parent_task_id: suggestTaskSelections[i] ?? r.parent_task_id ?? null }
            }
            return r
          })
        : base.task_reports
      const humanResult: Record<string, unknown> = {
        ...base,
        special_project: editProject,
        write_task_reports_achievements: writeToAchievements,
        write_task_reports_issues: writeToIssues,
        task_reports: patchedTaskReports,
        task: {
          ...taskBase,
          key_task: writeMode === 'subtask_new' ? newSubtaskTitle : keyTask,
          key_achievement: keyAchievement,
          special_project: editProject,
          status: editStatus,
          write_task: hasTaskReports ? false : (writeMode === 'task_new'),
          write_mode: hasTaskReports ? 'task_reports' : writeMode,
          target_subtask_id: targetSubtaskId,
          target_task_id: targetTaskId,
        },
        achievements: ((base.achievements as unknown[]) || []).map((a) => ({
          ...(a as Record<string, unknown>),
          write_achievement: writeToAchievements,
        })),
        issues: ((base.issues as unknown[]) || []).map((i) => ({
          ...(i as Record<string, unknown>),
          write_issue: writeToIssues,
        })),
      }
      // pending_items: reviewer classifies each item; transform back to confirmations.py format
      if (hasPendingItems) {
        const classified = effectivePendingItems.map((item, idx) => {
          const type = pendingItemTypes[idx] !== undefined
            ? pendingItemTypes[idx]
            : String(item.issue_type || '问题')
          return {
            description: String(item.description || ''),
            issue_type: type,
            priority: String(item.priority || '中'),
            need_coordination: pendingItemHelpers[idx]
              ? [pendingItemHelpers[idx]]
              : (Array.isArray(item.need_coordination) ? item.need_coordination as string[] : []),
            ...(item.related_task_title ? { key_task_title: String(item.related_task_title) } : {}),
            ...(pendingItemNotes[idx] ? { decision_note: pendingItemNotes[idx] } : {}),
            write_issue: writeToIssues,
          }
        })
        if (hasTaskReports) {
          humanResult.key_task_issues = classified
          humanResult.task_reports = (humanResult.task_reports as Record<string, unknown>[]).map(r => ({
            ...r,
            subtask_issues: [],
          }))
        } else {
          humanResult.issues = classified
          humanResult.key_task_issues = []
        }
      }

      await confirmSubmission(selected.id, currentUser.name, humanResult)
      const updated = { ...selected, confirm_status: SS.S_CONFIRMED }
      setItems((prev) => prev.map((i) => i.id === selected.id ? updated : i))
      setSelected(updated)
    } finally { setActing(false) }
  }

  const pendingCount = items.filter(i => SS.normalize(i.confirm_status) === SS.S_NEW || SS.normalize(i.confirm_status) === SS.S_PENDING_OWNER).length
  const allProjects = [...new Set(items.map((i) => String(i.special_project || '')).filter(Boolean))]
  const allSubmitters = [...new Set(items.map((i) => i.submitter).filter(Boolean))]

  const visibleItems = items.filter((item) => {
    if (filterStatus && SS.normalize(item.confirm_status) !== filterStatus) return false
    if (filterProject && item.special_project !== filterProject) return false
    if (filterSubmitter && item.submitter !== filterSubmitter) return false
    if (search) {
      const q = search.toLowerCase()
      const r = getAIResult(item)
      const summary = String(r?.summary || r?.special_project || item.title || '')
      if (!item.submitter.toLowerCase().includes(q) &&
          !String(item.special_project || '').toLowerCase().includes(q) &&
          !summary.toLowerCase().includes(q)) return false
    }
    return true
  })

  const opLogs = items.filter((i) => SS.normalize(i.confirm_status) !== SS.S_NEW).slice(0, 5)
  const selectedResult = selected ? (getHumanResult(selected) || getAIResult(selected)) : null
  const hasTaskReports = Array.isArray(selectedResult?.task_reports) && (selectedResult!.task_reports as unknown[]).length > 0
  const hasPendingSuggests = hasTaskReports && (selectedResult!.task_reports as Record<string, unknown>[]).some(
    (r, i) => r.result_type === 'suggest_new_subtask' && !suggestTaskSelections[i] && !r.parent_task_id
  )
  const confirmationContext = getConfirmationContext({
    ...(selectedResult || {}),
    source_type: selected?.source_type,
    submitter: selected?.submitter,
    special_project: selectedResult?.special_project || selected?.special_project,
    related_task: selectedResult?.related_task || selected?.related_task,
  })

  const isSubmitterView = viewMode === 'mine' && selected?.submitter === currentUser?.name
  const isProcessed = selected && SS.normalize(selected.confirm_status) !== SS.S_NEW
  const isConfirmed = selected ? SS.CONFIRMED_AND_STORED.has(SS.normalize(selected.confirm_status)) : false
  const isReturned = selected ? SS.normalize(selected.confirm_status) === SS.S_RETURNED : false

  const confirmedWrites: string[] = []
  if (isConfirmed && selectedResult) {
    confirmedWrites.push('工作推进表')
    const hasWriteAch = selectedResult.write_task_reports_achievements === true ||
      (Array.isArray(selectedResult.achievements) && (selectedResult.achievements as Record<string, unknown>[]).some(a => (a as Record<string, unknown>).write_achievement === true))
    if (hasWriteAch) confirmedWrites.push('成果库')
    const hasWriteIss = selectedResult.write_task_reports_issues === true ||
      (Array.isArray(selectedResult.issues) && (selectedResult.issues as Record<string, unknown>[]).some(i => (i as Record<string, unknown>).write_issue === true))
    if (hasWriteIss) confirmedWrites.push('问题库')
  }

  const taskReports = hasTaskReports ? (selectedResult!.task_reports as Record<string, unknown>[]) : []
  const progressReports = taskReports.filter((r) => r.result_type !== 'suggest_new_subtask')
  const suggestReports = taskReports.filter((r) => r.result_type === 'suggest_new_subtask')
  const globalAchievements = Array.isArray(selectedResult?.achievements)
    ? (selectedResult!.achievements as Record<string, unknown>[]) : []
  const globalIssues = Array.isArray(selectedResult?.issues)
    ? (selectedResult!.issues as Record<string, unknown>[]) : []
  const keyTaskIssues = Array.isArray(selectedResult?.key_task_issues)
    ? (selectedResult!.key_task_issues as Record<string, unknown>[]) : []

  // Collect subtask-level issues from task_reports so they flow to the issues block only
  const subtaskIssuesList: Record<string, unknown>[] = []
  if (hasTaskReports) {
    for (const r of taskReports) {
      const sis = r.subtask_issues
      if (Array.isArray(sis)) {
        for (const si of sis as unknown[]) {
          if (typeof si === 'object' && si !== null) {
            subtaskIssuesList.push(si as Record<string, unknown>)
          } else if (typeof si === 'string' && (si as string).trim()) {
            subtaskIssuesList.push({ description: si, issue_type: '问题' })
          }
        }
      }
    }
  }
  const dedupedIssues = deduplicateIssues([...globalIssues, ...keyTaskIssues, ...subtaskIssuesList])
  const hasPendingItems = Array.isArray(selectedResult?.pending_items) && (selectedResult!.pending_items as unknown[]).length > 0
  const effectivePendingItems: Record<string, unknown>[] = hasPendingItems
    ? (selectedResult!.pending_items as Record<string, unknown>[])
    : dedupedIssues

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <header className="h-14 flex items-center px-5 gap-2.5 flex-shrink-0 bg-white border-b" style={{ borderColor: '#E9EFF6' }}>
        <div className="flex-1">
          <h1 className="text-sm font-bold text-slate-800">AI 确认中心</h1>
        </div>
        <div className="flex rounded-lg border overflow-hidden" style={{ borderColor: '#E9EFF6' }}>
          <button onClick={() => setViewMode('mine')} className={`px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer ${viewMode === 'mine' ? 'bg-blue-600 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}>
            我的提交
          </button>
          {isReviewer && (
            <button onClick={() => setViewMode('all')} className={`px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer flex items-center gap-1 ${viewMode === 'all' ? 'bg-blue-600 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}>
              审核队列
              {pendingCount > 0 && <span className={`px-1.5 py-0.5 rounded-full text-xs font-bold ${viewMode === 'all' ? 'bg-white/20 text-white' : 'bg-orange-100 text-orange-600'}`}>{pendingCount}</span>}
            </button>
          )}
        </div>
        <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className="text-xs border border-slate-200 rounded-lg px-2 py-1.5 bg-white text-slate-600 cursor-pointer focus:outline-none">
          <option value="">全部状态</option>
          <option value={SS.S_NEW}>待确认</option>
          <option value={SS.S_CONFIRMED}>已入库</option>
          <option value={SS.S_RETURNED}>已退回</option>
        </select>
        <select value={filterProject} onChange={(e) => setFilterProject(e.target.value)} className="text-xs border border-slate-200 rounded-lg px-2 py-1.5 bg-white text-slate-600 cursor-pointer focus:outline-none">
          <option value="">全部专项</option>
          {allProjects.map((p) => <option key={p}>{p}</option>)}
        </select>
        <select value={filterSubmitter} onChange={(e) => setFilterSubmitter(e.target.value)} className="text-xs border border-slate-200 rounded-lg px-2 py-1.5 bg-white text-slate-600 cursor-pointer focus:outline-none">
          <option value="">全部提交人</option>
          {allSubmitters.map((s) => <option key={s}>{s}</option>)}
        </select>
        <div className="relative">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" style={{ width: 12, height: 12 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
          <input value={search} onChange={(e) => setSearch(e.target.value)} type="text" placeholder="搜索…" className="pl-7 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none w-32" />
        </div>
      </header>

      <div className="flex-1 overflow-hidden flex flex-col p-4 gap-3" style={{ background: '#F1F5F9' }}>
        <div className="flex gap-3 flex-1 overflow-hidden min-h-0">

          {/* Left: compact list */}
          <div className="w-72 flex-shrink-0 flex flex-col bg-white rounded-2xl border overflow-hidden" style={{ borderColor: '#E9EFF6', boxShadow: '0 1px 4px rgba(15,23,42,0.06)' }}>
            <div className="px-4 py-2.5 border-b flex-shrink-0 flex items-center justify-between" style={{ borderColor: '#E9EFF6' }}>
              <span className="text-xs font-bold text-slate-700">
                {filterStatus === SS.S_NEW ? '待确认记录' : '全部记录'}
              </span>
              <span className="text-xs text-slate-400">{visibleItems.length} 条</span>
            </div>
            <div className="overflow-y-auto flex-1">
              {loading ? (
                <div className="py-10 text-center text-xs text-slate-400">加载中…</div>
              ) : visibleItems.length === 0 ? (
                <div className="py-10 text-center text-xs">
                  {loadError ? <span className="text-red-400">{loadError}</span> : <span className="text-slate-400">暂无记录</span>}
                </div>
              ) : visibleItems.map((item) => {
                const isSelected = selected?.id === item.id
                const r = getHumanResult(item) || getAIResult(item)
                const summary = String(r?.summary || item.title || '').slice(0, 36)
                return (
                  <div
                    key={item.id}
                    onClick={() => pickItem(item)}
                    className="cursor-pointer px-3 py-2.5 transition-colors hover:bg-sky-50 border-b"
                    style={{
                      borderColor: '#F8FAFC',
                      borderLeft: `3px solid ${isSelected ? '#0369A1' : 'transparent'}`,
                      background: isSelected ? '#EFF6FF' : undefined,
                      minHeight: 72,
                    }}
                  >
                    <div className="flex items-center justify-between gap-1 mb-1">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <Ava name={item.submitter} />
                        <SourceBadge type={item.source_type} />
                      </div>
                      <StatusBadge status={item.confirm_status} />
                    </div>
                    <p className="text-xs text-slate-600 leading-relaxed pl-7 truncate">{summary || '—'}</p>
                    <div className="flex items-center justify-between pl-7 mt-1">
                      <span className="text-xs text-slate-400">{fmtShort(item.created_at)}</span>
                      <ConfBadge val={item.confidence} />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Right: detail panel */}
          <div className="flex-1 flex flex-col bg-white rounded-2xl border overflow-hidden" style={{ borderColor: '#E9EFF6', boxShadow: '0 1px 4px rgba(15,23,42,0.06)' }}>
            {selected ? (
              <>
                {/* Detail header */}
                <div className="px-5 py-3 border-b flex-shrink-0" style={{ borderColor: '#E9EFF6' }}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-bold text-slate-800">记录详情</span>
                    <StatusBadge status={selected.confirm_status} />
                  </div>
                  <div className="flex items-center gap-2.5 text-xs text-slate-500 flex-wrap">
                    <SourceBadge type={selected.source_type} />
                    <span className="font-medium text-slate-700">{selected.submitter}</span>
                    <span className="text-slate-300">|</span>
                    <span>{fmtTime(selected.created_at)}</span>
                  </div>
                </div>

                {/* Scrollable body */}
                <div className="flex-1 overflow-y-auto min-h-0 px-4 py-3 space-y-3">

                  {/* 已入库 read-only banner */}
                  {isConfirmed && (
                    <div className="flex items-center gap-2 px-3 py-2 rounded-lg" style={{ background: '#F0FDF4', border: '1px solid #BBF7D0' }}>
                      <span className="text-xs font-bold text-emerald-700">✓ 已入库</span>
                      <span className="flex-1" />
                      <span className="text-xs text-emerald-600">已写入：{confirmedWrites.join(' / ') || '工作推进表'}</span>
                    </div>
                  )}
                  {isReturned && (
                    <div className="flex items-start gap-2 px-3 py-2 rounded-lg" style={{ background: '#FEF2F2', border: '1px solid #FECACA' }}>
                      <span className="text-xs font-bold text-red-600 flex-shrink-0">✗ 已退回</span>
                      {((selected as Record<string, unknown>).confirm_notes || (selected as Record<string, unknown>).action_note) ? (
                        <span className="text-xs text-slate-600 flex-1 leading-relaxed">
                          {String((selected as Record<string, unknown>).confirm_notes || (selected as Record<string, unknown>).action_note)}
                        </span>
                      ) : null}
                    </div>
                  )}

                  {/* ── 任务卡片（每张含三层归属树 + 内容 + 占位操作区）── */}
                  {hasTaskReports ? (
                    <section className="space-y-3">
                      <p className="text-xs font-bold text-slate-400 tracking-wider">任务卡片</p>
                      {taskReports.map((r, gIdx) => {
                        const isSuggest = r.result_type === 'suggest_new_subtask'
                        const isNew = r.result_type === 'new_task'
                        const inEdit = !!cardEditMode[gIdx]
                        const cardIsReview = SS.normalize(selected.confirm_status) === SS.S_NEW && !isSubmitterView

                        const dispProj = cardProjOverride[gIdx] ?? editProject
                        const dispKT = (() => {
                          const oid = cardKeyTaskOverride[gIdx]
                          if (oid != null) return projectTasks.find(t => t.id === oid)?.key_task ?? ''
                          return String(r.parent_key_task || '')
                        })()
                        const dispST = (() => {
                          const oid = cardSubtaskOverride[gIdx]
                          if (oid != null) return submitterSubtasks.find(s => s.id === oid)?.title ?? ''
                          if (isSuggest) return `待创建：${String(r.title || '')}`
                          if (isNew) return ''
                          return String(r.matched_subtask_title || '')
                        })()

                        const nexts = Array.isArray(r.next_steps) ? (r.next_steps as unknown[]).map(String).filter(Boolean) : []
                        const completedText = r.completed ? String(r.completed) : null
                        const borderColor = isSuggest ? '#FDE68A' : isNew ? '#DDD6FE' : '#E2E8F0'
                        const headerBg   = isSuggest ? '#FFFBEB' : isNew ? '#F5F3FF' : '#F8FAFC'
                        const IconF = <div className="w-4 h-4 rounded flex items-center justify-center flex-shrink-0" style={{ background: '#DBEAFE' }}><svg style={{ width: 8, height: 8, color: '#2563EB' }} fill="currentColor" viewBox="0 0 20 20"><path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" /></svg></div>
                        const IconT = <div className="w-4 h-4 rounded flex items-center justify-center flex-shrink-0" style={{ background: '#EDE9FE' }}><svg style={{ width: 8, height: 8, color: '#7C3AED' }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg></div>
                        const VL = <div className="flex-shrink-0" style={{ width: 1, height: 14, background: '#E2E8F0', marginRight: 7 }} />
                        const HL = <div className="flex-shrink-0" style={{ width: 10, height: 1, background: '#E2E8F0' }} />
                        return (
                          <div key={gIdx} className="rounded-xl border overflow-hidden" style={{ borderColor }}>
                            <div className="flex items-center gap-2 px-3 py-2.5" style={{ background: headerBg }}>
                              <span style={{ fontSize: 13 }}>{isSuggest ? '💡' : isNew ? '🆕' : '📋'}</span>
                              <span className="flex-1 text-xs font-semibold text-slate-800 truncate">
                                {isSuggest ? `建议新增：${String(r.title || '')}` : String(r.matched_subtask_title || r.title || '未匹配子任务')}
                              </span>
                              {!isSuggest && !!r.status_update && <span className="flex-shrink-0 text-xs px-1.5 py-0.5 rounded-full" style={{ background: '#DBEAFE', color: '#1D4ED8', fontSize: 10 }}>{String(r.status_update)}</span>}
                              <button onClick={() => setCardEditMode(p => ({ ...p, [gIdx]: !p[gIdx] }))} className="flex-shrink-0 px-2 py-0.5 rounded border cursor-pointer hover:bg-slate-100" style={{ borderColor: '#CBD5E1', color: '#64748B', fontSize: 10, background: 'white' }}>修改归属</button>
                            </div>
                            <div className="px-3 py-2.5 border-b border-slate-100" style={{ background: inEdit ? '#FAFAFA' : 'white' }}>
                              {inEdit ? (
                                <div className="space-y-2">
                                  <div className="flex items-center gap-1.5">{IconF}<select value={cardProjOverride[gIdx] ?? editProject} onChange={e => { setCardProjOverride(p => ({ ...p, [gIdx]: e.target.value })); setCardKeyTaskOverride(p => ({ ...p, [gIdx]: null })); setCardSubtaskOverride(p => ({ ...p, [gIdx]: null })) }} className="flex-1 text-xs border border-slate-200 rounded px-2 py-0.5 bg-white focus:outline-none">{projects.map(p => <option key={p.id}>{p.name}</option>)}</select></div>
                                  <div className="flex items-center gap-1.5 pl-2">{VL}{HL}{IconT}<select value={cardKeyTaskOverride[gIdx] ?? ''} onChange={e => { setCardKeyTaskOverride(p => ({ ...p, [gIdx]: e.target.value ? Number(e.target.value) : null })); setCardSubtaskOverride(p => ({ ...p, [gIdx]: null })) }} className="flex-1 text-xs border border-slate-200 rounded px-2 py-0.5 bg-white focus:outline-none"><option value="">— 选择关键任务 —</option>{projectTasks.map(t => <option key={t.id} value={t.id}>{t.key_task}</option>)}</select></div>
                                  {!isSuggest && !isNew && <div className="flex items-center gap-1.5 pl-4">{VL}{HL}<div className="w-2.5 h-2.5 rounded-full border-2 flex-shrink-0" style={{ borderColor: '#CBD5E1', background: 'white' }} /><select value={cardSubtaskOverride[gIdx] ?? ''} onChange={e => setCardSubtaskOverride(p => ({ ...p, [gIdx]: e.target.value ? Number(e.target.value) : null }))} className="flex-1 text-xs border border-slate-200 rounded px-2 py-0.5 bg-white focus:outline-none"><option value="">— 选择子任务 —</option>{submitterSubtasks.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</select></div>}
                                  <div className="flex justify-end gap-1.5 pt-0.5">
                                    <button onClick={() => setCardEditMode(p => ({ ...p, [gIdx]: false }))} className="px-2.5 py-1 rounded-lg cursor-pointer text-white" style={{ background: '#0369A1', fontSize: 10 }}>完成</button>
                                    <button onClick={() => { setCardEditMode(p => ({ ...p, [gIdx]: false })); setCardProjOverride(p => { const n = { ...p }; delete n[gIdx]; return n }); setCardKeyTaskOverride(p => { const n = { ...p }; delete n[gIdx]; return n }); setCardSubtaskOverride(p => { const n = { ...p }; delete n[gIdx]; return n }) }} className="px-2.5 py-1 rounded-lg border cursor-pointer" style={{ borderColor: '#E2E8F0', color: '#64748B', fontSize: 10 }}>取消</button>
                                  </div>
                                </div>
                              ) : (
                                <div className="space-y-1 text-xs">
                                  <div className="flex items-center gap-1.5">{IconF}<span className="font-semibold text-slate-700 truncate">{dispProj || '—'}</span></div>
                                  <div className="flex items-center gap-1.5 pl-3">{VL}{HL}{IconT}{dispKT ? <span className="text-slate-600 truncate">{dispKT}</span> : <span className="italic" style={{ color: '#F59E0B' }}>未关联关键任务</span>}</div>
                                  {!isNew && <div className="flex items-center gap-1.5 pl-6">{VL}{HL}<div className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ border: `2px solid ${isSuggest ? '#F59E0B' : '#CBD5E1'}`, background: isSuggest ? '#FEF3C7' : 'white' }} />{dispST ? <span className="truncate" style={{ color: isSuggest ? '#D97706' : '#64748B' }}>{dispST}</span> : <span className="italic text-slate-400">待匹配子任务</span>}</div>}
                                </div>
                              )}
                            </div>
                            <div className="divide-y divide-slate-100 bg-white">
                              {completedText && <div className="flex items-start gap-2 px-3 py-2 text-xs"><span className="w-14 flex-shrink-0 text-slate-400 pt-0.5">完成了什么</span><span className="flex-1 text-slate-700 leading-relaxed">{completedText}</span></div>}
                              {isSuggest && !!r.assignee && <div className="flex items-center gap-2 px-3 py-2 text-xs"><span className="w-14 flex-shrink-0 text-slate-400">建议负责人</span><span className="text-slate-700">{String(r.assignee)}</span></div>}
                              {nexts.length > 0 && <div className="flex items-start gap-2 px-3 py-2 text-xs"><span className="w-14 flex-shrink-0 text-slate-400 pt-0.5">{isSuggest ? '建议理由' : '下周计划'}</span><ul className="flex-1 text-slate-700 leading-relaxed space-y-0.5">{nexts.map((n, ni) => <li key={ni} className="flex gap-1"><span style={{ color: '#CBD5E1' }}>·</span>{n}</li>)}</ul></div>}
                            </div>
                            {cardIsReview && (
                              <div className="flex gap-1.5 px-3 py-2 border-t border-slate-100" style={{ background: '#FAFAFA' }}>
                                <button disabled className="flex-1 py-1.5 rounded-lg text-white font-semibold cursor-not-allowed opacity-40" style={{ background: '#0369A1', fontSize: 10 }}>确认此卡入库</button>
                                <button disabled className="flex-1 py-1.5 rounded-lg border font-semibold cursor-not-allowed opacity-40" style={{ borderColor: '#FECACA', color: '#DC2626', fontSize: 10 }}>退回此卡</button>
                                <button disabled className="flex-1 py-1.5 rounded-lg border font-semibold cursor-not-allowed opacity-40" style={{ borderColor: '#DDD6FE', color: '#7C3AED', fontSize: 10 }}>转交统筹人</button>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </section>
                  ) : selectedResult ? (
                    <section className="space-y-2">
                      <p className="text-xs font-bold text-slate-400 tracking-wider">任务卡片</p>
                      <div className="rounded-xl border overflow-hidden" style={{ borderColor: '#E2E8F0' }}>
                        <div className="flex items-center gap-2 px-3 py-2.5" style={{ background: '#F8FAFC' }}>
                          <span style={{ fontSize: 13 }}>📋</span>
                          <span className="flex-1 text-xs font-semibold text-slate-800 truncate">{String(confirmationContext.keyTaskName || (selected as Record<string,unknown>).related_task || '工作汇报')}</span>
                          <button onClick={() => setCardEditMode(p => ({ ...p, [-1]: !p[-1] }))} className="flex-shrink-0 px-2 py-0.5 rounded border cursor-pointer hover:bg-slate-100" style={{ borderColor: '#CBD5E1', color: '#64748B', fontSize: 10, background: 'white' }}>修改归属</button>
                        </div>
                        {(() => {
                          const inEdit = !!cardEditMode[-1]
                          const IconF2 = <div className="w-4 h-4 rounded flex items-center justify-center flex-shrink-0" style={{ background: '#DBEAFE' }}><svg style={{ width: 8, height: 8, color: '#2563EB' }} fill="currentColor" viewBox="0 0 20 20"><path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" /></svg></div>
                          const IconT2 = <div className="w-4 h-4 rounded flex items-center justify-center flex-shrink-0" style={{ background: '#EDE9FE' }}><svg style={{ width: 8, height: 8, color: '#7C3AED' }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg></div>
                          const VL2 = <div className="flex-shrink-0" style={{ width: 1, height: 14, background: '#E2E8F0', marginRight: 7 }} />
                          const HL2 = <div className="flex-shrink-0" style={{ width: 10, height: 1, background: '#E2E8F0' }} />
                          const dispKT2 = (() => { const oid = cardKeyTaskOverride[-1]; return oid != null ? projectTasks.find(t => t.id === oid)?.key_task ?? '' : (confirmationContext.keyTaskName || '') })()
                          const dispST2 = (() => { const oid = cardSubtaskOverride[-1]; return oid != null ? submitterSubtasks.find(s => s.id === oid)?.title ?? '' : (confirmationContext.subtaskNames[0] || '') })()
                          return (
                            <div className="px-3 py-2.5 border-b border-slate-100" style={{ background: inEdit ? '#FAFAFA' : 'white' }}>
                              {inEdit ? (
                                <div className="space-y-2">
                                  <div className="flex items-center gap-1.5">{IconF2}<select value={cardProjOverride[-1] ?? editProject} onChange={e => setCardProjOverride(p => ({ ...p, [-1]: e.target.value }))} className="flex-1 text-xs border border-slate-200 rounded px-2 py-0.5 bg-white focus:outline-none">{projects.map(p => <option key={p.id}>{p.name}</option>)}</select></div>
                                  <div className="flex items-center gap-1.5 pl-2">{VL2}{HL2}{IconT2}<select value={cardKeyTaskOverride[-1] ?? ''} onChange={e => { setCardKeyTaskOverride(p => ({ ...p, [-1]: e.target.value ? Number(e.target.value) : null })); setCardSubtaskOverride(p => ({ ...p, [-1]: null })) }} className="flex-1 text-xs border border-slate-200 rounded px-2 py-0.5 bg-white focus:outline-none"><option value="">— 选择关键任务 —</option>{projectTasks.map(t => <option key={t.id} value={t.id}>{t.key_task}</option>)}</select></div>
                                  <div className="flex items-center gap-1.5 pl-4">{VL2}{HL2}<div className="w-2.5 h-2.5 rounded-full border-2 flex-shrink-0" style={{ borderColor: '#CBD5E1', background: 'white' }} /><select value={cardSubtaskOverride[-1] ?? ''} onChange={e => setCardSubtaskOverride(p => ({ ...p, [-1]: e.target.value ? Number(e.target.value) : null }))} className="flex-1 text-xs border border-slate-200 rounded px-2 py-0.5 bg-white focus:outline-none"><option value="">— 选择子任务 —</option>{submitterSubtasks.map(s => <option key={s.id} value={s.id}>{s.title}</option>)}</select></div>
                                  <div className="flex justify-end gap-1.5 pt-0.5">
                                    <button onClick={() => setCardEditMode(p => ({ ...p, [-1]: false }))} className="px-2.5 py-1 rounded-lg cursor-pointer text-white" style={{ background: '#0369A1', fontSize: 10 }}>完成</button>
                                    <button onClick={() => { setCardEditMode(p => ({ ...p, [-1]: false })); setCardProjOverride(p => { const n = { ...p }; delete n[-1]; return n }); setCardKeyTaskOverride(p => { const n = { ...p }; delete n[-1]; return n }); setCardSubtaskOverride(p => { const n = { ...p }; delete n[-1]; return n }) }} className="px-2.5 py-1 rounded-lg border cursor-pointer" style={{ borderColor: '#E2E8F0', color: '#64748B', fontSize: 10 }}>取消</button>
                                  </div>
                                </div>
                              ) : (
                                <div className="space-y-1 text-xs">
                                  <div className="flex items-center gap-1.5">{IconF2}<span className="font-semibold text-slate-700 truncate">{(cardProjOverride[-1] ?? editProject) || '—'}</span></div>
                                  <div className="flex items-center gap-1.5 pl-3">{VL2}{HL2}{IconT2}{dispKT2 ? <span className="text-slate-600 truncate">{dispKT2}</span> : <span className="italic" style={{ color: '#F59E0B' }}>未关联关键任务</span>}</div>
                                  {confirmationContext.subtaskNames.length > 0 && <div className="flex items-center gap-1.5 pl-6">{VL2}{HL2}<div className="w-2.5 h-2.5 rounded-full border-2 flex-shrink-0" style={{ borderColor: '#CBD5E1', background: 'white' }} /><span className="text-slate-500 truncate">{dispST2 || confirmationContext.subtaskNames.join('、')}</span></div>}
                                </div>
                              )}
                            </div>
                          )
                        })()}
                        <div className="divide-y divide-slate-100 bg-white">
                          {[{ key: 'completed_items', label: '完成事项' }, { key: 'next_steps', label: '下周计划' }, { key: 'need_coordination', label: '需协调人' }].map(({ key, label }) => {
                            const display = renderVal(selectedResult[key])
                            if (display === '—') return null
                            return <div key={key} className="flex items-start gap-2 px-3 py-2 text-xs"><span className="w-14 flex-shrink-0 text-slate-400 pt-0.5">{label}</span><span className="flex-1 text-slate-700 leading-relaxed">{display}</span></div>
                          })}
                          <div className="flex items-center px-3 py-2 text-xs">
                            <span className="w-14 flex-shrink-0 text-slate-400">状态建议</span>
                            <span className="flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full" style={{ background: STATUS_DOT[editStatus] ?? '#94A3B8' }} /><span className="font-medium" style={{ color: STATUS_DOT[editStatus] ?? '#94A3B8' }}>{editStatus}</span></span>
                          </div>
                        </div>
                        {SS.normalize(selected.confirm_status) === SS.S_NEW && !isSubmitterView && (
                          <div className="flex gap-1.5 px-3 py-2 border-t border-slate-100" style={{ background: '#FAFAFA' }}>
                            <button disabled className="flex-1 py-1.5 rounded-lg text-white font-semibold cursor-not-allowed opacity-40" style={{ background: '#0369A1', fontSize: 10 }}>确认此卡入库</button>
                            <button disabled className="flex-1 py-1.5 rounded-lg border font-semibold cursor-not-allowed opacity-40" style={{ borderColor: '#FECACA', color: '#DC2626', fontSize: 10 }}>退回此卡</button>
                            <button disabled className="flex-1 py-1.5 rounded-lg border font-semibold cursor-not-allowed opacity-40" style={{ borderColor: '#DDD6FE', color: '#7C3AED', fontSize: 10 }}>转交统筹人</button>
                          </div>
                        )}
                      </div>
                    </section>
                  ) : null}

                  {/* Block 2: 成果 */}
                  {globalAchievements.length > 0 && (
                    <section className="space-y-2">
                      <p className="text-xs font-bold text-slate-400 tracking-wider">成果</p>
                      <div className="rounded-xl border bg-white overflow-hidden" style={{ borderColor: '#E9EFF6' }}>
                        {globalAchievements.map((a, idx) => {
                          const name = String(a.name || '')
                          const version = String(a.version || '')
                          const fileLink = String(a.file_link || '')
                          return (
                            <div key={idx} className="flex items-start gap-2 px-3 py-2.5 border-b border-slate-100 last:border-b-0 text-xs">
                              <span className="mt-1 w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: '#059669' }} />
                              <div className="flex-1 min-w-0">
                                <p className="text-slate-800 font-semibold">{name || '未命名成果'}</p>
                                <div className="flex items-center gap-2 mt-0.5">
                                  {version && <span className="text-slate-400">v{version}</span>}
                                  {fileLink
                                    ? <span className="text-slate-500 truncate">{fileLink}</span>
                                    : <span className="italic text-slate-400">成果地址待提交人补录</span>}
                                </div>
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </section>
                  )}

                  {/* Old format: 成果 */}
                  {!hasTaskReports && selectedResult && renderVal(selectedResult.achievements) !== '—' && globalAchievements.length === 0 && (
                    <section className="space-y-2">
                      <p className="text-xs font-bold text-slate-400 tracking-wider">成果</p>
                      <div className="rounded-xl border bg-white px-3 py-2.5 text-xs text-slate-700" style={{ borderColor: '#E9EFF6' }}>
                        {renderVal(selectedResult.achievements)}
                      </div>
                    </section>
                  )}

                  {/* Block 3: 需处理事项（reviewer assigns type） */}
                  {effectivePendingItems.length > 0 && (
                    <section className="space-y-2">
                      <p className="text-xs font-bold text-slate-400 tracking-wider">需处理事项</p>
                      <div className="rounded-xl border bg-white overflow-hidden" style={{ borderColor: '#E9EFF6' }}>
                        {effectivePendingItems.map((item, idx) => {
                          const desc = String(item.description || '')
                          const priority = String(item.priority || '')
                          const relatedTask = String(item.related_task_title || '')
                          const relatedSubtask = String(item.related_subtask_title || '')
                          const selectedType = pendingItemTypes[idx] !== undefined
                            ? pendingItemTypes[idx]
                            : String(item.issue_type || '问题')
                          const style = ISSUE_STYLE[selectedType] || ISSUE_STYLE['问题']
                          const isReviewMode = SS.normalize(selected?.confirm_status || '') === SS.S_NEW && !isSubmitterView
                          return (
                            <div key={idx} className="border-b border-slate-100 last:border-b-0">
                              <div className="flex items-start gap-2 px-3 py-2.5 text-xs">
                                <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 mt-1.5" style={{ background: '#F59E0B' }} />
                                <div className="flex-1 min-w-0 space-y-1">
                                  <p className="text-slate-700 leading-relaxed">{desc || '-'}</p>
                                  {(relatedTask || relatedSubtask) && (
                                    <p style={{ fontSize: 10, color: '#94A3B8' }}>
                                      {relatedTask && <span>关键任务：{relatedTask}</span>}
                                      {relatedTask && relatedSubtask && <span className="mx-1">·</span>}
                                      {relatedSubtask && <span>子任务：{relatedSubtask}</span>}
                                    </p>
                                  )}
                                  {isReviewMode ? (
                                    <div className="flex items-center gap-1.5 flex-wrap">
                                      <select
                                        value={selectedType}
                                        onChange={(e) => setPendingItemTypes(prev => ({ ...prev, [idx]: e.target.value }))}
                                        className="border rounded px-1.5 py-0.5 focus:outline-none"
                                        style={{ fontSize: 10, borderColor: style.bg, background: style.bg, color: style.text }}
                                      >
                                        <option value="问题">问题</option>
                                        <option value="风险">风险</option>
                                        <option value="待协调">待协调</option>
                                        <option value="需决策">需决策</option>
                                      </select>
                                      {selectedType === '待协调' && (
                                        <input
                                          type="text"
                                          value={pendingItemHelpers[idx] ?? ''}
                                          onChange={(e) => setPendingItemHelpers(prev => ({ ...prev, [idx]: e.target.value }))}
                                          placeholder="待协调人"
                                          className="border border-slate-200 rounded px-1.5 py-0.5 focus:outline-none"
                                          style={{ fontSize: 10, minWidth: 80 }}
                                        />
                                      )}
                                      {selectedType === '需决策' && (
                                        <input
                                          type="text"
                                          value={pendingItemNotes[idx] ?? ''}
                                          onChange={(e) => setPendingItemNotes(prev => ({ ...prev, [idx]: e.target.value }))}
                                          placeholder="决策说明（可选）"
                                          className="border border-slate-200 rounded px-1.5 py-0.5 focus:outline-none"
                                          style={{ fontSize: 10, minWidth: 100 }}
                                        />
                                      )}
                                    </div>
                                  ) : (
                                    <span className="inline-flex px-1.5 py-0.5 rounded font-semibold" style={{ fontSize: 10, background: style.bg, color: style.text }}>
                                      {selectedType}
                                    </span>
                                  )}
                                </div>
                                {priority && (
                                  <span className="font-semibold flex-shrink-0" style={{ fontSize: 10, color: priority === '高' ? '#DC2626' : '#94A3B8' }}>{priority}</span>
                                )}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </section>
                  )}

                  {/* Old format: 问题 */}
                  {!hasTaskReports && selectedResult && renderVal(selectedResult.issues) !== '—' && globalIssues.length === 0 && (
                    <section className="space-y-2">
                      <p className="text-xs font-bold text-slate-400 tracking-wider">问题</p>
                      <div className="rounded-xl border bg-white px-3 py-2.5 text-xs" style={{ borderColor: '#E9EFF6', color: '#92400E' }}>
                        {renderVal(selectedResult.issues)}
                      </div>
                    </section>
                  )}


                </div>

                {/* Footer */}
                <div className="px-5 py-3 border-t flex-shrink-0" style={{ borderColor: '#E9EFF6' }}>
                  {isProcessed ? (
                    <div className="py-1.5">
                      {isConfirmed ? (
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-emerald-600">✓ 已入库</span>
                          <span className="flex-1" />
                          <span className="text-xs text-slate-400">已写入：{confirmedWrites.join(' / ') || '工作推进表'}</span>
                        </div>
                      ) : isReturned ? (
                        <div className="text-xs font-semibold text-red-500">✗ 已退回，等待重新提交</div>
                      ) : SS.WAITING_COORDINATOR_FEEDBACK.has(SS.normalize(selected.confirm_status)) ? (
                        <div className="text-xs font-semibold text-purple-600">↗ 已转交统筹人处理</div>
                      ) : SS.WAITING_CEO_DECISION.has(SS.normalize(selected.confirm_status)) ? (
                        <div className="text-xs font-semibold text-blue-600">↑ 已上报CEO，等待决策</div>
                      ) : (
                        <div className="text-xs text-slate-400">{SS.DISPLAY_LABEL[SS.normalize(selected.confirm_status)] ?? selected.confirm_status}</div>
                      )}
                    </div>
                  ) : isSubmitterView ? (
                    <div className="space-y-1.5">
                      <p className="text-xs text-slate-400">等待负责人审核，撤销后可重新编辑提交</p>
                      <button
                        onClick={async () => {
                          if (!confirm('确认撤销该提交？原文将保存为草稿，跳转到提交页重新编辑。')) return
                          setActing(true)
                          try {
                            const transcriptText = (selected as Record<string, unknown>).transcript_text as string | undefined
                            if (transcriptText) {
                              localStorage.setItem('bw_voice_draft', JSON.stringify({ text: transcriptText, provider: 'deepseek' }))
                            }
                            await deleteUpdate(selected.id)
                            navigate(`/project/${currentProjectId}/submit`)
                          } catch { /* ignore */ } finally { setActing(false) }
                        }}
                        disabled={acting}
                        className="w-full py-2 rounded-xl border-2 text-xs font-semibold hover:bg-red-50 disabled:opacity-50 cursor-pointer"
                        style={{ borderColor: '#FECACA', color: '#DC2626' }}
                      >
                        {acting ? '处理中…' : '撤销并重新编辑'}
                      </button>
                    </div>
                  ) : (
                    <div className="py-1 text-center text-xs text-slate-400">请在任务卡片中逐卡确认</div>
                  )}
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">← 点击左侧列表查看详情</div>
            )}
          </div>
        </div>

        {/* Operation log — collapsible */}
        <div className="bg-white rounded-2xl border flex-shrink-0" style={{ borderColor: '#E9EFF6', boxShadow: '0 1px 4px rgba(15,23,42,0.06)' }}>
          <button
            onClick={() => setOpLogsOpen(!opLogsOpen)}
            className="w-full flex items-center justify-between px-5 py-3 hover:bg-slate-50 transition-colors rounded-2xl"
          >
            <div className="flex items-center gap-2">
              <span className="text-xs font-bold text-slate-700">操作日志</span>
              {opLogs.length > 0 && (
                <span className="px-1.5 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-500">{opLogs.length}</span>
              )}
            </div>
            <svg
              style={{ width: 14, height: 14, color: '#94A3B8', transition: 'transform 0.2s', transform: opLogsOpen ? 'rotate(180deg)' : undefined }}
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {opLogsOpen && (
            <div className="border-t" style={{ borderColor: '#E9EFF6' }}>
              {opLogs.length === 0 ? (
                <div className="py-4 text-center text-xs text-slate-400">暂无操作记录</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b" style={{ borderColor: '#E9EFF6' }}>
                        {['提交人', '操作', '对象', '时间', '结果'].map((h) => (
                          <th key={h} className="text-left text-slate-400 font-semibold py-2.5 px-4">{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {opLogs.map((item) => {
                        const r = getAIResult(item)
                        const summary = String(r?.summary || item.title || '').slice(0, 30)
                        const isDone = SS.CONFIRMED_AND_STORED.has(SS.normalize(item.confirm_status))
                        return (
                          <tr key={item.id} className="border-b hover:bg-slate-50" style={{ borderColor: '#F8FAFC' }}>
                            <td className="py-2.5 px-4">
                              <div className="flex items-center gap-1.5">
                                <Ava name={item.submitter} />
                                {item.submitter}
                              </div>
                            </td>
                            <td className="py-2.5 px-4 text-slate-600">{isDone ? '确认写入' : '退回修改'}</td>
                            <td className="py-2.5 px-4 text-slate-500 max-w-xs truncate">{summary || '-'}</td>
                            <td className="py-2.5 px-4 text-slate-400">{fmtShort((item as Record<string, unknown>).updated_at as string || item.created_at)}</td>
                            <td className="py-2.5 px-4">
                              <span className={`font-medium ${isDone ? 'text-emerald-600' : 'text-amber-600'}`}>
                                {isDone ? '已写入' : '已退回'}
                              </span>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
