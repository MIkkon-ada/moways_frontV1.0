import { useEffect, useState } from 'react'
import { fmtDate } from '../utils/time'
import { fetchIssues, deleteIssue } from '../api/issues'
import { useProject } from '../context/ProjectContext'
import type { IssueItem } from '../types'

const PRI_STYLE: Record<string, string> = {
  '高': 'bg-red-100 text-red-700',
  '中': 'bg-amber-100 text-amber-700',
  '低': 'bg-emerald-100 text-emerald-700',
}

const STATUS_STYLE: Record<string, { badge: string; dot: string }> = {
  '待处理': { badge: 'bg-amber-100 text-amber-700', dot: '#F59E0B' },
  '处理中': { badge: 'bg-blue-100 text-blue-700', dot: '#3B82F6' },
  '已解决': { badge: 'bg-emerald-100 text-emerald-700', dot: '#10B981' },
  '已关闭': { badge: 'bg-slate-100 text-slate-500', dot: '#94A3B8' },
  '已决策': { badge: 'bg-purple-100 text-purple-600', dot: '#7C3AED' },
}

const TYPE_STYLE: Record<string, string> = {
  '技术问题': 'bg-blue-50 text-blue-700 border-blue-200',
  '需求/产品': 'bg-purple-50 text-purple-700 border-purple-200',
  '前瞻风险': 'bg-red-50 text-red-700 border-red-200',
  '架构设计': 'bg-emerald-50 text-emerald-700 border-emerald-200',
  '数据问题': 'bg-orange-50 text-orange-700 border-orange-200',
}

export function IssuesPage() {
  const { currentProjectId, currentUser, currentProjectRoles } = useProject()
  const [issues, setIssues] = useState<IssueItem[]>([])
  const [selected, setSelected] = useState<IssueItem | null>(null)
  const [loading, setLoading] = useState(false)
  const [filterStatus, setFilterStatus] = useState('')
  const [filterPriority, setFilterPriority] = useState('')
  const [checked, setChecked] = useState<Set<number>>(new Set())

  const canDelete = currentUser?.is_tech_admin || currentProjectRoles.includes('owner')
  const isCEO = !!(currentUser?.is_ceo || currentProjectRoles.includes('project_ceo'))

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetchIssues()  // 不传 project_id，拉取全部专项的问题
      .then((d) => { if (!cancelled) { setIssues(d); if (d.length > 0) setSelected(d[0]) } })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])  // 全局视图，不随项目切换重新加载

  const filtered = issues.filter((i) => {
    if (filterStatus && i.status !== filterStatus) return false
    if (filterPriority && i.priority !== filterPriority) return false
    return true
  })

  const allChecked = filtered.length > 0 && filtered.every((i) => checked.has(i.id))

  function toggleAll() {
    if (allChecked) setChecked(new Set())
    else setChecked(new Set(filtered.map((i) => i.id)))
  }

  function toggleOne(id: number, e: React.MouseEvent) {
    e.stopPropagation()
    setChecked((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  function reload() {
    fetchIssues().then((d) => setIssues(d)).catch(() => {})
  }

  async function handleDelete(issue: IssueItem, e: React.MouseEvent) {
    e.stopPropagation()
    if (!confirm(`确认删除该问题？`)) return
    await deleteIssue(issue.id).catch(() => {})
    if (selected?.id === issue.id) setSelected(null)
    reload()
  }

  async function handleBulkDelete() {
    if (checked.size === 0) return
    if (!confirm(`确认删除选中的 ${checked.size} 条问题？此操作不可恢复。`)) return
    const ids = [...checked]
    await Promise.all(ids.map((id) => deleteIssue(id).catch(() => {})))
    setChecked(new Set())
    if (selected && ids.includes(selected.id)) setSelected(null)
    reload()
  }

  const waiting = issues.filter((i) => i.status === '待处理').length
  const processing = issues.filter((i) => i.status === '处理中').length
  const resolved = issues.filter((i) => i.status === '已解决').length
  const decisions = issues.filter((i) => i.need_decision_by).length

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <header className="h-16 flex items-center px-6 gap-3 flex-shrink-0 bg-white border-b" style={{ borderColor: '#E9EFF6' }}>
        <div className="flex-1">
          <h1 className="text-base font-bold text-slate-800">问题与决策</h1>
          <p className="text-xs text-slate-400 mt-0.5">跟踪项目卡点、风险、待办事项与待决策事项</p>
        </div>
        <div className="flex items-center gap-2">
          <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} className="text-sm border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white text-slate-600 cursor-pointer focus:outline-none">
            <option value="">全部状态</option><option>待处理</option><option>处理中</option><option>已解决</option><option>已关闭</option>
          </select>
          <select value={filterPriority} onChange={(e) => setFilterPriority(e.target.value)} className="text-sm border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white text-slate-600 cursor-pointer focus:outline-none">
            <option value="">全部优先级</option><option>高</option><option>中</option><option>低</option>
          </select>
        </div>
        <button className="cursor-pointer flex items-center gap-2 px-4 py-2 rounded-lg text-white text-sm font-semibold hover:opacity-90" style={{ background: 'linear-gradient(135deg,#0369A1,#0EA5E9)', boxShadow: '0 2px 8px rgba(3,105,161,0.25)' }}>
          <svg style={{ width: 14, height: 14 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" /></svg>
          新增问题
        </button>
      </header>

      <div className="flex-1 overflow-hidden flex" style={{ background: '#F1F5F9' }}>
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* Stat cards */}
          <div className="grid grid-cols-4 gap-4">
            {[
              { label: '待处理问题', val: waiting, color: '#D97706', bg: 'linear-gradient(135deg,#D97706,#FBBF24)' },
              { label: '处理中', val: processing, color: '#2563EB', bg: 'linear-gradient(135deg,#2563EB,#60A5FA)', accent: '#2563EB' },
              { label: '已解决', val: resolved, color: '#059669', bg: 'linear-gradient(135deg,#059669,#34D399)', accent: '#059669' },
              { label: '需决策事项', val: decisions, color: '#7C3AED', bg: 'linear-gradient(135deg,#7C3AED,#A78BFA)', accent: '#7C3AED' },
            ].map(({ label, val, color, bg, accent }) => (
              <div key={label} className="bg-white rounded-2xl border p-4 flex items-center gap-4" style={{ borderColor: '#E9EFF6', boxShadow: '0 1px 4px rgba(15,23,42,0.06)', borderLeft: accent ? `3px solid ${accent}` : undefined }}>
                <div className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 text-white" style={{ background: bg }}>
                  <svg style={{ width: 22, height: 22 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                </div>
                <div>
                  <p className="text-xs text-slate-500 font-medium">{label}</p>
                  <p className="text-3xl font-bold leading-none mt-1" style={{ color }}>{val}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Issue table */}
          <div className="bg-white rounded-2xl border p-5" style={{ borderColor: '#E9EFF6', boxShadow: '0 1px 4px rgba(15,23,42,0.06)' }}>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <h2 className="text-sm font-bold text-slate-800">问题清单</h2>
                <span className="text-xs text-slate-400">共 {filtered.length} 条</span>
              </div>
              {checked.size > 0 && (
                <div className="flex items-center gap-3">
                  <span className="text-xs font-semibold text-blue-600 bg-blue-50 px-2.5 py-1 rounded-lg">已选 {checked.size} 项</span>
                  <button onClick={() => setChecked(new Set())} className="text-xs text-slate-500 hover:text-slate-700 font-medium cursor-pointer">清除</button>
                  {canDelete && (
                    <button onClick={handleBulkDelete} className="cursor-pointer flex items-center gap-1.5 text-xs font-semibold text-red-500 hover:text-red-700 px-2.5 py-1.5 rounded-lg hover:bg-red-50">
                      <svg style={{ width: 12, height: 12 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                      批量删除
                    </button>
                  )}
                </div>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs" style={{ minWidth: 900, borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ background: '#E8EDF5', borderBottom: '1px solid #C7D2E8' }}>
                    <th className="py-2.5 px-3" style={{ width: 36 }}>
                      <input type="checkbox" checked={allChecked} onChange={toggleAll} style={{ width: 15, height: 15, accentColor: '#0369A1', cursor: 'pointer' }} />
                    </th>
                    {['问题描述', '问题类型', '关联专项', '负责人', '协助人', '优先级', '状态', '预计解决', '需决策人', '操作'].map((h) => (
                      <th key={h} className="text-left font-semibold pb-2.5 pr-3 py-2.5" style={{ color: '#475569' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr><td colSpan={11} className="py-12 text-center text-slate-400">加载中…</td></tr>
                  ) : filtered.map((issue) => {
                    const isSelected = selected?.id === issue.id
                    const statusStyle = STATUS_STYLE[issue.status ?? ''] ?? { badge: 'bg-slate-100 text-slate-600', dot: '#94A3B8' }
                    return (
                      <tr
                        key={issue.id}
                        onClick={() => setSelected(issue)}
                        className="cursor-pointer transition-colors"
                        style={{ borderBottom: '1px solid #E2E8F0', background: isSelected ? '#EFF6FF' : 'white' }}
                      >
                        <td className="py-3 px-3" onClick={(e) => toggleOne(issue.id, e)}>
                          <input type="checkbox" checked={checked.has(issue.id)} onChange={() => {}} style={{ width: 15, height: 15, accentColor: '#0369A1', cursor: 'pointer' }} />
                        </td>
                        <td className="py-3 pr-3" style={{ maxWidth: 220 }}>
                          <p className="font-semibold text-slate-800 leading-snug">{issue.description ?? '-'}</p>
                          <p className="text-slate-400 mt-0.5">ISSUE-{issue.id}</p>
                        </td>
                        <td className="py-3 pr-3">
                          <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-semibold border ${TYPE_STYLE[issue.issue_type ?? ''] ?? 'bg-slate-50 text-slate-600 border-slate-200'}`}>
                            {issue.issue_type ?? '-'}
                          </span>
                        </td>
                        <td className="py-3 pr-3 text-slate-600">{(issue as any).special_project ?? '-'}</td>
                        <td className="py-3 pr-3 text-slate-700 font-medium">{issue.owner ?? '-'}</td>
                        <td className="py-3 pr-3 text-slate-500">{issue.helper ?? '-'}</td>
                        <td className="py-3 pr-3">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold ${PRI_STYLE[issue.priority ?? ''] ?? 'bg-slate-100 text-slate-600'}`}>
                            {issue.priority ?? '-'}
                          </span>
                        </td>
                        <td className="py-3 pr-3">
                          <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold ${statusStyle.badge}`}>
                            <span className="w-1.5 h-1.5 rounded-full" style={{ background: statusStyle.dot }}></span>
                            {issue.status ?? '-'}
                          </span>
                        </td>
                        <td className="py-3 pr-3 text-slate-600 font-medium">{issue.expected_resolve_time ?? '-'}</td>
                        <td className="py-3 pr-3 text-slate-700">{issue.need_decision_by ?? '-'}</td>
                        <td className="py-3">
                          <div className="flex items-center gap-2">
                            <button className="text-blue-500 hover:text-blue-700 font-semibold" onClick={(e) => e.stopPropagation()}>查看</button>
                            {canDelete && (
                              <>
                                <span className="text-slate-200">|</span>
                                <button className="text-red-400 hover:text-red-600 font-semibold" onClick={(e) => handleDelete(issue, e)}>删除</button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                  {!loading && filtered.length === 0 && (
                    <tr><td colSpan={11} className="py-12 text-center text-slate-400">暂无问题数据</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between mt-4 pt-4 border-t" style={{ borderColor: '#E9EFF6' }}>
              <span className="text-xs text-slate-400">共 {filtered.length} 条</span>
              <button className="w-7 h-7 rounded-lg text-white text-xs font-bold" style={{ background: '#0369A1' }}>1</button>
              <span className="text-xs text-slate-400">10 条/页</span>
            </div>
          </div>
        </div>

        {/* Right panel */}
        {selected && (
          <div style={{ width: 300, flexShrink: 0, background: '#fff', borderLeft: '1px solid #E9EFF6', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div className="px-4 pt-4 pb-3 border-b flex-shrink-0" style={{ borderColor: '#E9EFF6' }}>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-bold text-slate-800">问题详情</h2>
                <button onClick={() => setSelected(null)} className="p-1 rounded-lg hover:bg-slate-100 text-slate-400">
                  <svg style={{ width: 14, height: 14 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
              <p className="text-xs font-semibold text-slate-700 leading-snug">{selected.description ?? '-'}</p>
              <div className="flex items-center gap-2 mt-2">
                <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold ${PRI_STYLE[selected.priority ?? ''] ?? 'bg-slate-100 text-slate-600'}`}>{selected.priority ?? '-'}</span>
                <span className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold ${STATUS_STYLE[selected.status ?? '']?.badge ?? 'bg-slate-100 text-slate-600'}`}>
                  {selected.status ?? '-'}
                </span>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-4">
              <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">问题追踪</h3>
              <div className="space-y-3">
                {[
                  { label: '负责人', value: selected.owner },
                  { label: '协助人', value: selected.helper },
                  { label: '问题类型', value: selected.issue_type },
                  { label: '需决策人', value: selected.need_decision_by },
                  { label: '预计解决', value: selected.expected_resolve_time },
                  { label: '创建时间', value: fmtDate(selected.created_at) },
                ].filter((r) => r.value).map(({ label, value }) => (
                  <div key={label} className="flex gap-2 text-xs py-1.5 border-b border-slate-50">
                    <span className="w-16 flex-shrink-0 text-slate-500 font-semibold">{label}</span>
                    <span className="text-slate-800">{value}</span>
                  </div>
                ))}
              </div>
              {selected.resolution && (
                <div className="mt-4">
                  <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">处理结论</h3>
                  <p className="text-xs text-slate-600 leading-relaxed p-3 rounded-xl" style={{ background: '#F0FDF4', border: '1px solid #BBF7D0' }}>{selected.resolution}</p>
                </div>
              )}
            </div>
            <div className="px-4 py-3 border-t flex gap-2 flex-shrink-0" style={{ borderColor: '#E9EFF6' }}>
              {isCEO && (
                <button className="flex-1 py-2 rounded-lg text-white text-xs font-bold hover:opacity-90" style={{ background: 'linear-gradient(135deg,#7C3AED,#A78BFA)' }}>决策批复</button>
              )}
              <button className="flex-1 py-2 rounded-lg border border-slate-200 text-slate-600 text-xs font-semibold hover:bg-slate-50">标记解决</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
