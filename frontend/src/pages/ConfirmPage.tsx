import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getPending, confirmSubmission, rejectSubmission, transferCoordinator, escalateCeo } from '../api/confirmations'
import { deleteUpdate, fetchMyUpdates } from '../api/updates'
import { useProject } from '../context/ProjectContext'
import type { ConfirmationItem } from '../types'
import { fmtFull, fmtShort } from '../utils/time'
import * as SS from '../domain/submissionStatus'

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
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${cls}`}>
      {label}
    </span>
  )
}

function ConfBadge({ val }: { val?: number | null }) {
  if (!val) return <span className="text-slate-400 text-xs font-bold">-</span>
  const pct = val < 1 ? Math.round(val * 100) : Math.round(val)
  const color = pct >= 85 ? '#059669' : pct >= 70 ? '#D97706' : '#DC2626'
  return <span style={{ color, fontWeight: 700, fontSize: 12 }}>{pct}%</span>
}

function Ava({ name }: { name: string }) {
  const COLORS = ['#3B82F6', '#8B5CF6', '#10B981', '#F59E0B', '#EF4444', '#06B6D4']
  const c = COLORS[(name.charCodeAt(0) || 0) % COLORS.length]
  return (
    <div className="w-5 h-5 rounded-full flex items-center justify-center text-white flex-shrink-0" style={{ background: c, fontSize: 10, fontWeight: 700 }}>
      {name.slice(0, 1)}
    </div>
  )
}

export function ConfirmPage() {
  const navigate = useNavigate()
  const { currentProjectId, currentUser, projects, currentCapabilities } = useProject()
  const [items, setItems] = useState<ConfirmationItem[]>([])
  const [selected, setSelected] = useState<ConfirmationItem | null>(null)
  const [loading, setLoading] = useState(false)
  const [acting, setActing] = useState(false)
  const [pendingAction, setPendingAction] = useState<'reject' | 'supplement' | 'forward' | 'ceo' | null>(null)
  const [actionNote, setActionNote] = useState('')

  // Backend-authoritative: can this user act as a reviewer in this project?
  const isReviewer = !!(
    currentCapabilities?.canConfirm ||
    currentCapabilities?.canCoordinate ||
    currentCapabilities?.canCeoDecide
  )
  // 默认视图：审核者看全部（审核队列），普通成员看自己的
  const [viewMode, setViewMode] = useState<'mine' | 'all'>('mine')
  useEffect(() => {
    if (isReviewer) setViewMode('all')
  }, [isReviewer])

  // Filters
  const [filterStatus, setFilterStatus] = useState('')
  const [filterProject, setFilterProject] = useState('')
  const [filterSubmitter, setFilterSubmitter] = useState('')
  const [search, setSearch] = useState('')

  // 入库去向 toggles
  const [writeToTasks, setWriteToTasks] = useState(true)
  const [writeToIssues, setWriteToIssues] = useState(true)
  const [writeToAchievements, setWriteToAchievements] = useState(false)

  // Inline edit for 专项 / 状态建议
  const [editProject, setEditProject] = useState('')
  const [editStatus, setEditStatus] = useState('进行中')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setSelected(null)
    setItems([])

    if (viewMode === 'mine') {
      fetchMyUpdates()
        .then((d) => {
          if (!cancelled) {
            const mapped = d as unknown as ConfirmationItem[]
            setItems(mapped)
            if (mapped.length > 0) pickItem(mapped[0])
          }
        })
        .catch(() => {})
        .finally(() => { if (!cancelled) setLoading(false) })
    } else {
      // 不传 project_id：让后端返回用户有权审核的全部提交，前端用专项下拉二次筛选
      getPending(null)
        .then((d) => {
          if (!cancelled) {
            setItems(d)
            if (d.length > 0) pickItem(d[0])
          }
        })
        .catch(() => {})
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

  function pickItem(item: ConfirmationItem) {
    setSelected(item)
    const r = getAIResult(item)
    setEditProject(String(r?.special_project || item.special_project || ''))
    setEditStatus(String(r?.status_suggestion || '进行中'))
    setPendingAction(null)
    setActionNote('')
  }

  async function handleConfirm() {
    if (!selected || !currentUser) return
    setActing(true)
    try {
      const base = getAIResult(selected) || {}
      const taskBase = (base.task as Record<string, unknown>) || {}

      // 语音更新的 AI 结果没有 task.key_task，用 related_task 补填
      const keyTask = String(taskBase.key_task || base.related_task || base.summary || '')
      const keyAchievement = String(
        taskBase.key_achievement ||
        (Array.isArray(base.completed_items)
          ? (base.completed_items as string[]).join('；')
          : (base.completed_items || ''))
      )

      // 把 UI 上的修改和入库开关打包进 human_result
      const humanResult: Record<string, unknown> = {
        ...base,
        special_project: editProject,
        task: {
          ...taskBase,
          key_task: keyTask,
          key_achievement: keyAchievement,
          special_project: editProject,
          status: editStatus,
          write_task: writeToTasks,
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

      await confirmSubmission(selected.id, currentUser.name, humanResult)
      const updated = { ...selected, confirm_status: SS.S_CONFIRMED }
      setItems((prev) => prev.map((i) => i.id === selected.id ? updated : i))
      setSelected(updated)
    } finally { setActing(false) }
  }

  const pending = items.length
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
  const selectedResult = selected ? getAIResult(selected) : null

  const dfields: { key: string; label: string; colorFn?: (v: string) => string }[] = [
    { key: 'completed_items', label: '完成事项' },
    { key: 'achievements', label: '成果', colorFn: () => '#047857' },
    { key: 'issues', label: '问题', colorFn: () => '#92400E' },
    { key: 'next_steps', label: '下周计划' },
    { key: 'need_coordination', label: '需协调人' },
  ]

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header */}
      <header className="h-16 flex items-center px-6 gap-3 flex-shrink-0 bg-white border-b" style={{ borderColor: '#E9EFF6' }}>
        <div className="flex-1">
          <h1 className="text-base font-bold text-slate-800">AI 确认中心</h1>
          <p className="text-xs text-slate-400 mt-0.5">对AI提取结果进行确认、修改、退回与写入入库</p>
        </div>
        {/* 视角切换 */}
        <div className="flex rounded-lg border overflow-hidden" style={{ borderColor: '#E9EFF6' }}>
          <button
            onClick={() => setViewMode('mine')}
            className={`px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer ${viewMode === 'mine' ? 'bg-blue-600 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}
          >
            我的提交
          </button>
          {isReviewer && (
            <button
              onClick={() => setViewMode('all')}
              className={`px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer ${viewMode === 'all' ? 'bg-blue-600 text-white' : 'bg-white text-slate-500 hover:bg-slate-50'}`}
            >
              审核队列
            </button>
          )}
        </div>
        <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className="text-sm border border-slate-200 rounded-lg px-3 py-1.5 bg-white text-slate-600 cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-400/30">
          <option value="">全部状态</option>
          <option value={SS.S_NEW}>待确认</option>
          <option value={SS.S_CONFIRMED}>已入库</option>
          <option value={SS.S_RETURNED}>已退回</option>
        </select>
        <select value={filterProject} onChange={(e) => setFilterProject(e.target.value)} className="text-sm border border-slate-200 rounded-lg px-3 py-1.5 bg-white text-slate-600 cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-400/30">
          <option value="">全部专项</option>
          {allProjects.map((p) => <option key={p}>{p}</option>)}
        </select>
        <select value={filterSubmitter} onChange={(e) => setFilterSubmitter(e.target.value)} className="text-sm border border-slate-200 rounded-lg px-3 py-1.5 bg-white text-slate-600 cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-400/30">
          <option value="">全部提交人</option>
          {allSubmitters.map((s) => <option key={s}>{s}</option>)}
        </select>
        <div className="relative">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" style={{ width: 13, height: 13 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
          <input value={search} onChange={(e) => setSearch(e.target.value)} type="text" placeholder="搜索任务、提交人…" className="pl-8 pr-3 py-1.5 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/30 w-44" />
        </div>
      </header>

      <div className="flex-1 overflow-hidden flex flex-col p-6 gap-4" style={{ background: '#F1F5F9' }}>
        {/* Top: Queue + Detail */}
        <div className="flex gap-5 flex-1 overflow-hidden min-h-0">

          {/* Queue */}
          <div className="bg-white rounded-2xl border flex flex-col overflow-hidden" style={{ width: '56%', borderColor: '#E9EFF6', boxShadow: '0 1px 4px rgba(15,23,42,0.06)' }}>
            <div className="flex items-center justify-between px-5 py-3.5 border-b flex-shrink-0" style={{ borderColor: '#E9EFF6' }}>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-bold text-slate-800">待确认队列</h2>
                <span className="w-5 h-5 rounded-full bg-orange-100 text-orange-600 text-xs font-bold flex items-center justify-center">{pending}</span>
              </div>
              <span className="text-xs text-slate-400">点击行查看详情</span>
            </div>
            <div className="overflow-auto flex-1">
              {loading ? (
                <div className="py-12 text-center text-slate-400 text-sm">加载中…</div>
              ) : (
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-white z-10">
                    <tr className="border-b" style={{ borderColor: '#E9EFF6' }}>
                      {['来源', '提交人', '关联专项', 'AI建议摘要', '置信度', '时间', '状态'].map((h) => (
                        <th key={h} className="text-left text-slate-400 font-semibold py-2.5 px-3">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleItems.map((item) => {
                      const isSelected = selected?.id === item.id
                      const r = getAIResult(item)
                      const summary = String(r?.summary || item.title || '').slice(0, 28)
                      const suggestion = String(r?.status_suggestion || '').slice(0, 18)
                      return (
                        <tr
                          key={item.id}
                          onClick={() => pickItem(item)}
                          className="cursor-pointer border-b transition-colors hover:bg-sky-50"
                          style={{ borderColor: '#F8FAFC', background: isSelected ? '#E0F2FE' : undefined, borderLeft: isSelected ? '2px solid #0369A1' : '2px solid transparent' }}
                        >
                          <td className="py-3 px-3"><SourceBadge type={item.source_type} /></td>
                          <td className="py-3 px-3">
                            <div className="flex items-center gap-1.5">
                              <Ava name={item.submitter} />
                              {item.submitter}
                            </div>
                          </td>
                          <td className="py-3 px-3 text-slate-600">{String(item.special_project || '-')}</td>
                          <td className="py-3 px-3 text-slate-600" style={{ maxWidth: 160 }}>
                            <p className="truncate">{summary || '-'}</p>
                            {suggestion && <p className="text-slate-400 mt-0.5 truncate">建议：{suggestion}</p>}
                          </td>
                          <td className="py-3 px-3"><ConfBadge val={item.confidence} /></td>
                          <td className="py-3 px-3 text-slate-400">{fmtShort(item.created_at)}</td>
                          <td className="py-3 px-3"><StatusBadge status={item.confirm_status} /></td>
                        </tr>
                      )
                    })}
                    {visibleItems.length === 0 && !loading && (
                      <tr><td colSpan={7} className="py-12 text-center text-slate-400">暂无记录</td></tr>
                    )}
                  </tbody>
                </table>
              )}
            </div>
            <div className="flex items-center justify-between px-5 py-3 border-t flex-shrink-0" style={{ borderColor: '#E9EFF6' }}>
              <span className="text-xs text-slate-400">共 {visibleItems.length} 条</span>
              <div className="flex items-center gap-1">
                <button className="w-7 h-7 rounded-lg flex items-center justify-center text-slate-400 hover:bg-slate-100 disabled:opacity-30" disabled>
                  <svg style={{ width: 12, height: 12 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" /></svg>
                </button>
                <button className="w-7 h-7 rounded-lg text-white text-xs font-bold" style={{ background: '#0369A1' }}>1</button>
                <button className="w-7 h-7 rounded-lg text-slate-500 text-xs hover:bg-slate-100">
                  <svg style={{ width: 12, height: 12, margin: 'auto' }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" /></svg>
                </button>
              </div>
              <span className="text-xs text-slate-400">10 条/页</span>
            </div>
          </div>

          {/* Detail */}
          <div className="bg-white rounded-2xl border flex flex-col overflow-hidden flex-1" style={{ borderColor: '#E9EFF6', boxShadow: '0 1px 4px rgba(15,23,42,0.06)' }}>
            <div className="flex items-center justify-between px-5 py-3.5 border-b flex-shrink-0" style={{ borderColor: '#E9EFF6' }}>
              <h2 className="text-sm font-bold text-slate-800">当前记录详情</h2>
              {selected && (
                <div className="flex items-center gap-1.5 text-xs text-slate-400">
                  <span>来源：{selected.source_type || '语音更新'}</span>
                  <span>|</span>
                  <span>提交时间：{fmtTime(selected.created_at)}</span>
                </div>
              )}
            </div>

            {selected ? (
              <>
                <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">

                  {/* AI 识别结果 */}
                  <div>
                    <div className="flex items-center gap-2 mb-3">
                      <div className="w-5 h-5 rounded-md flex items-center justify-center flex-shrink-0" style={{ background: 'linear-gradient(135deg,#6366F1,#0EA5E9)' }}>
                        <svg style={{ width: 10, height: 10, color: 'white' }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>
                      </div>
                      <span className="text-xs font-bold text-slate-700">AI 识别结果</span>
                    </div>
                    <div className="rounded-xl p-3 space-y-0" style={{ background: '#F8FAFC', border: '1px solid #E9EFF6' }}>

                      {/* 专项 - with inline select */}
                      <div className="flex items-center py-2 border-b border-slate-100 text-xs">
                        <span className="w-20 flex-shrink-0 text-slate-500 font-semibold">专项</span>
                        <span className="flex-1 font-semibold" style={{ color: '#0369A1' }}>{editProject || String(selectedResult?.special_project || '-')}</span>
                        <select
                          value={editProject}
                          onChange={(e) => setEditProject(e.target.value)}
                          className="text-xs border border-slate-200 rounded-lg px-2 py-1 bg-white text-slate-600 cursor-pointer focus:outline-none"
                          style={{ fontSize: 11 }}
                        >
                          {projects.map((p) => <option key={p.id}>{p.name}</option>)}
                          {!projects.find((p) => p.name === editProject) && editProject && <option>{editProject}</option>}
                        </select>
                      </div>

                      {/* 任务 */}
                      {selectedResult?.related_task ? (
                        <div className="flex items-center py-2 border-b border-slate-100 text-xs">
                          <span className="w-20 flex-shrink-0 text-slate-500 font-semibold">任务</span>
                          <span className="flex-1 text-slate-700">{String(selectedResult.related_task)}</span>
                        </div>
                      ) : null}

                      {/* Dynamic fields */}
                      {dfields.map(({ key, label, colorFn }) => {
                        const v = selectedResult?.[key]
                        const display = renderVal(v)
                        if (display === '—') return null
                        return (
                          <div key={key} className="flex items-start py-2 border-b border-slate-100 last:border-b-0 text-xs">
                            <span className="w-20 flex-shrink-0 text-slate-500 font-semibold pt-0.5">{label}</span>
                            <span className="flex-1 leading-relaxed" style={colorFn ? { color: colorFn(display), fontWeight: 500 } : { color: '#475569' }}>{display}</span>
                          </div>
                        )
                      })}

                      {/* 状态建议 - with inline select */}
                      <div className="flex items-center py-2 text-xs">
                        <span className="w-20 flex-shrink-0 text-slate-500 font-semibold">状态建议</span>
                        <span className="flex-1 flex items-center gap-1.5">
                          <span className="w-1.5 h-1.5 rounded-full" style={{ background: STATUS_DOT[editStatus] ?? '#94A3B8' }} />
                          <span className="font-medium" style={{ color: STATUS_DOT[editStatus] ?? '#94A3B8' }}>{editStatus}</span>
                        </span>
                        <select
                          value={editStatus}
                          onChange={(e) => setEditStatus(e.target.value)}
                          className="text-xs border border-slate-200 rounded-lg px-2 py-1 bg-white text-slate-600 cursor-pointer focus:outline-none"
                          style={{ fontSize: 11 }}
                        >
                          {['未开始', '进行中', '已完成', '延期', '暂缓'].map((s) => <option key={s}>{s}</option>)}
                        </select>
                      </div>

                    </div>
                  </div>

                  {/* 入库去向 */}
                  <div>
                    <div className="flex items-center gap-1.5 mb-3">
                      <span className="text-xs font-bold text-slate-700">入库去向</span>
                      <svg style={{ width: 13, height: 13, color: '#94A3B8' }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    </div>
                    <div className="space-y-2.5">
                      {/* 工作推进表 */}
                      <div className="flex items-start gap-3 p-3 rounded-xl border-2 transition-colors cursor-pointer" style={{ borderColor: writeToTasks ? '#0369A1' : '#E9EFF6', background: writeToTasks ? '#F0F9FF' : 'white' }} onClick={() => setWriteToTasks(!writeToTasks)}>
                        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: '#EFF6FF' }}>
                          <svg style={{ width: 14, height: 14, color: '#2563EB' }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-bold text-slate-700">写入工作推进表</p>
                          <p className="text-xs text-slate-400 mt-0.5">作为任务进展写入工作推进表</p>
                        </div>
                        <ToggleSwitch on={writeToTasks} />
                      </div>
                      {/* 问题库 */}
                      <div className="flex items-start gap-3 p-3 rounded-xl border-2 transition-colors cursor-pointer" style={{ borderColor: writeToIssues ? '#0369A1' : '#E9EFF6', background: writeToIssues ? '#F0F9FF' : 'white' }} onClick={() => setWriteToIssues(!writeToIssues)}>
                        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: '#FFF7ED' }}>
                          <svg style={{ width: 14, height: 14, color: '#D97706' }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-bold text-slate-700">写入问题库</p>
                          <p className="text-xs text-slate-400 mt-0.5">提取的问题与风险写入问题库</p>
                        </div>
                        <ToggleSwitch on={writeToIssues} />
                      </div>
                      {/* 成果库 */}
                      <div className="flex items-start gap-3 p-3 rounded-xl border-2 transition-colors cursor-pointer" style={{ borderColor: writeToAchievements ? '#0369A1' : '#E9EFF6', background: writeToAchievements ? '#F0F9FF' : 'white' }} onClick={() => setWriteToAchievements(!writeToAchievements)}>
                        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: '#EDE9FE' }}>
                          <svg style={{ width: 14, height: 14, color: '#7C3AED' }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" /></svg>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-bold text-slate-700">写入成果库</p>
                          <p className="text-xs text-slate-400 mt-0.5">结果与产出写入成果库</p>
                        </div>
                        <ToggleSwitch on={writeToAchievements} />
                      </div>
                    </div>
                  </div>

                  <p className="text-xs text-slate-400">负责人可直接修改部分字段后入库</p>
                </div>

                {/* Actions */}
                <div className="px-5 py-4 border-t flex-shrink-0" style={{ borderColor: '#E9EFF6' }}>
                  {SS.normalize(selected.confirm_status) !== SS.S_NEW ? (
                    <div className="py-2.5 text-center text-sm font-semibold text-slate-400">
                      {SS.CONFIRMED_AND_STORED.has(SS.normalize(selected.confirm_status))
                        ? '✓ 已写入工作推进表 / 成果库'
                        : SS.WAITING_COORDINATOR_FEEDBACK.has(SS.normalize(selected.confirm_status))
                          ? '↗ 已转交统筹人处理'
                          : SS.WAITING_CEO_DECISION.has(SS.normalize(selected.confirm_status))
                            ? '↑ 已上报CEO，等待决策'
                            : '✗ 已退回，等待重新提交'}
                    </div>
                  ) : viewMode === 'mine' && selected.submitter === currentUser?.name ? (
                    /* 我的提交视角：只有撤销 */
                    <div className="space-y-2">
                      <p className="text-xs text-slate-400">等待负责人审核，撤销后可重新编辑提交</p>
                      <button
                        onClick={async () => {
                          if (!confirm('确认撤销该提交？原文将保存为草稿，跳转到提交页重新编辑。')) return
                          setActing(true)
                          try {
                            // 保存原文到草稿，跳转后可继续编辑
                            const transcriptText = (selected as any).transcript_text as string | undefined
                            if (transcriptText) {
                              localStorage.setItem('bw_voice_draft', JSON.stringify({ text: transcriptText, provider: 'deepseek' }))
                            }
                            await deleteUpdate(selected.id)
                            // 跳转到语音更新页，草稿会自动加载
                            navigate(`/project/${currentProjectId}/submit`)
                          } catch { /* ignore */ } finally { setActing(false) }
                        }}
                        disabled={acting}
                        className="w-full py-2.5 rounded-xl border-2 text-sm font-semibold transition-all hover:bg-red-50 disabled:opacity-50 cursor-pointer"
                        style={{ borderColor: '#FECACA', color: '#DC2626' }}
                      >
                        {acting ? '处理中…' : '撤销并重新编辑'}
                      </button>
                    </div>
                  ) : pendingAction ? (
                    /* 审核者：填写备注后确认操作 */
                    <div className="space-y-2">
                      <p className="text-xs font-semibold text-slate-500">
                        {pendingAction === 'reject' ? '退回原因（必填）' :
                         pendingAction === 'supplement' ? '补充说明（可选）' :
                         pendingAction === 'forward' ? '转交说明（可选）' : '请CEO判断的原因（可选）'}
                      </p>
                      <textarea
                        value={actionNote}
                        onChange={(e) => setActionNote(e.target.value)}
                        placeholder={
                          pendingAction === 'reject' ? '请描述退回原因…' :
                          pendingAction === 'supplement' ? '请说明需补充的内容…' :
                          pendingAction === 'forward' ? '请说明转交统筹人的原因…' : '请说明需要CEO判断的事项…'
                        }
                        className="w-full text-xs border border-slate-200 rounded-lg p-2 focus:outline-none focus:ring-2 resize-none"
                        style={{ height: 60 }}
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={async () => {
                            if (!selected || !currentUser) return
                            setActing(true)
                            try {
                              let newStatus = SS.S_RETURNED
                              if (pendingAction === 'reject') {
                                await rejectSubmission(selected.id, actionNote, currentUser.name)
                              } else if (pendingAction === 'supplement') {
                                await rejectSubmission(selected.id, `[待补充] ${actionNote}`, currentUser.name)
                              } else if (pendingAction === 'forward') {
                                await transferCoordinator(selected.id, actionNote, currentUser.name)
                                newStatus = SS.S_WAITING_COORDINATOR
                              } else if (pendingAction === 'ceo') {
                                await escalateCeo(selected.id, actionNote, currentUser.name)
                                newStatus = SS.S_WAITING_CEO
                              }
                              const updated = { ...selected, confirm_status: newStatus }
                              setItems((prev) => prev.map((i) => i.id === selected.id ? updated : i))
                              setSelected(updated)
                              setPendingAction(null); setActionNote('')
                            } finally { setActing(false) }
                          }}
                          disabled={acting || (pendingAction === 'reject' && !actionNote.trim())}
                          className="flex-1 py-2 rounded-xl text-white text-xs font-bold disabled:opacity-50 cursor-pointer"
                          style={{ background: pendingAction === 'reject' ? '#DC2626' : pendingAction === 'forward' ? '#7C3AED' : pendingAction === 'ceo' ? '#0369A1' : '#D97706' }}
                        >
                          {acting ? '处理中…' :
                           pendingAction === 'reject' ? '确认退回' :
                           pendingAction === 'forward' ? '确认转交' :
                           pendingAction === 'ceo' ? '确认上报' : '确认标记'}
                        </button>
                        <button onClick={() => { setPendingAction(null); setActionNote('') }} className="flex-1 py-2 rounded-xl border border-slate-200 text-slate-600 text-xs font-semibold hover:bg-slate-50 cursor-pointer">
                          取消
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* 审核者：操作按钮组 */
                    <div className="grid grid-cols-2 gap-2">
                      <button onClick={handleConfirm} disabled={acting} className="col-span-2 py-2.5 rounded-xl text-white text-sm font-bold hover:opacity-90 disabled:opacity-50 transition-all cursor-pointer" style={{ background: 'linear-gradient(135deg,#0369A1,#0EA5E9)', boxShadow: '0 2px 8px rgba(3,105,161,0.3)' }}>
                        确认写入
                      </button>
                      <button onClick={() => setPendingAction('reject')} className="py-2 rounded-xl border-2 border-slate-200 text-slate-600 text-xs font-semibold hover:bg-slate-50 transition-colors cursor-pointer">
                        退回修改
                      </button>
                      <button onClick={() => setPendingAction('supplement')} className="py-2 rounded-xl border-2 border-amber-200 text-amber-600 text-xs font-semibold hover:bg-amber-50 transition-colors cursor-pointer">
                        标记待补充
                      </button>
                      <button onClick={() => setPendingAction('forward')} className="py-2 rounded-xl border-2 text-xs font-semibold hover:bg-purple-50 transition-colors cursor-pointer" style={{ borderColor: '#DDD6FE', color: '#7C3AED' }}>
                        转交统筹人
                      </button>
                      <button onClick={() => setPendingAction('ceo')} className="py-2 rounded-xl border-2 text-xs font-semibold hover:bg-blue-50 transition-colors cursor-pointer" style={{ borderColor: '#BFDBFE', color: '#1D4ED8' }}>
                        请CEO判断
                      </button>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">← 点击左侧列表查看详情</div>
            )}
          </div>
        </div>

        {/* Bottom: Operation Log */}
        <div className="bg-white rounded-2xl border flex-shrink-0" style={{ borderColor: '#E9EFF6', boxShadow: '0 1px 4px rgba(15,23,42,0.06)' }}>
          <div className="flex items-center justify-between px-5 py-3.5 border-b" style={{ borderColor: '#E9EFF6' }}>
            <h2 className="text-sm font-bold text-slate-800">操作日志</h2>
            <span className="text-xs text-slate-400">最近操作记录</span>
          </div>
          {opLogs.length === 0 ? (
            <div className="py-5 text-center text-xs text-slate-400">暂无操作记录</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b" style={{ borderColor: '#E9EFF6' }}>
                    {['提交人', '操作', '对象', '时间', '结果'].map((h) => (
                      <th key={h} className="text-left text-slate-400 font-semibold py-2.5 px-5">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {opLogs.map((item) => {
                    const r = getAIResult(item)
                    const summary = String(r?.summary || item.title || '').slice(0, 30)
                    const isDone = SS.CONFIRMED_AND_STORED.has(SS.normalize(item.confirm_status))
                    return (
                      <tr key={item.id} className="border-b hover:bg-slate-50 transition-colors" style={{ borderColor: '#F8FAFC' }}>
                        <td className="py-2.5 px-5">
                          <div className="flex items-center gap-1.5">
                            <Ava name={item.submitter} />
                            {item.submitter}
                          </div>
                        </td>
                        <td className="py-2.5 px-5 text-slate-600">{isDone ? '确认写入' : '退回修改'}</td>
                        <td className="py-2.5 px-5 text-slate-500 max-w-xs truncate">{summary || '-'}</td>
                        <td className="py-2.5 px-5 text-slate-400">{fmtShort(item.updated_at || item.created_at)}</td>
                        <td className="py-2.5 px-5">
                          <span className={`font-medium ${isDone ? 'text-emerald-600' : 'text-amber-600'}`}>
                            {isDone ? '已写入工作推进表/成果库' : '已退回，待重新提交'}
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
      </div>
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
