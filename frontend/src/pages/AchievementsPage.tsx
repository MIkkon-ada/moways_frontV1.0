import { useEffect, useState } from 'react'
import { createAchievement, deleteAchievement, fetchAchievements } from '../api/achievements'
import { useProject } from '../context/ProjectContext'
import type { AchievementItem } from '../types'

const TYPE_COLORS: Record<string, { bg: string; color: string; letter: string; letterBg: string }> = {
  '方案': { bg: 'linear-gradient(135deg,#2563EB,#3B82F6)', color: '#1D4ED8', letter: 'W', letterBg: '#DBEAFE' },
  '模板': { bg: 'linear-gradient(135deg,#D97706,#F59E0B)', color: '#92400E', letter: 'P', letterBg: '#FEF3C7' },
  'SOP':  { bg: 'linear-gradient(135deg,#059669,#10B981)', color: '#065F46', letter: 'X', letterBg: '#D1FAE5' },
  'Prompt': { bg: 'linear-gradient(135deg,#7C3AED,#A78BFA)', color: '#5B21B6', letter: 'P', letterBg: '#EDE9FE' },
  'Agent': { bg: 'linear-gradient(135deg,#9D174D,#EC4899)', color: '#9D174D', letter: 'AI', letterBg: '#FCE7F3' },
  '文档': { bg: 'linear-gradient(135deg,#0369A1,#0EA5E9)', color: '#0369A1', letter: 'D', letterBg: '#E0F2FE' },
}

function getTypeStyle(type?: string) {
  return TYPE_COLORS[type ?? ''] ?? { bg: 'linear-gradient(135deg,#6B7280,#9CA3AF)', color: '#374151', letter: 'F', letterBg: '#F3F4F6' }
}

export function AchievementsPage() {
  const { projects, currentUser } = useProject()
  const [items, setItems] = useState<AchievementItem[]>([])
  const [selected, setSelected] = useState<AchievementItem | null>(null)
  const [loading, setLoading] = useState(false)
  const [filterType, setFilterType] = useState('')
  const [filterProjectId, setFilterProjectId] = useState<number | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [createSaving, setCreateSaving] = useState(false)
  const [createError, setCreateError] = useState('')
  const [createForm, setCreateForm] = useState({
    name: '',
    achievement_type: '方案',
    special_project: '',
    owner: '',
    version: 'V0.1',
    file_link: '',
    scenario: '',
    reuse_tag: '',
  })

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetchAchievements(filterProjectId)
      .then((d) => { if (!cancelled) { setItems(d); if (d.length > 0) setSelected(d[0]) } })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [filterProjectId])

  const filtered = items.filter((i) => {
    if (filterType && i.achievement_type !== filterType) return false
    return true
  })

  const currentProject = projects.find((p) => p.id === filterProjectId) ?? projects[0] ?? null

  async function handleCreateAchievement() {
    if (!createForm.name.trim()) {
      setCreateError('请先填写成果名称')
      return
    }
    setCreateSaving(true)
    setCreateError('')
    try {
      const created = await createAchievement({
        project_id: currentProject?.id ?? filterProjectId ?? null,
        name: createForm.name.trim(),
        achievement_type: createForm.achievement_type.trim() || '方案',
        special_project: createForm.special_project.trim() || currentProject?.name || '',
        owner: createForm.owner.trim(),
        version: createForm.version.trim() || 'V0.1',
        file_link: createForm.file_link.trim(),
        scenario: createForm.scenario.trim(),
        reuse_tag: createForm.reuse_tag.trim(),
        source_type: '人工录入',
      })
      setItems((prev) => [created, ...prev])
      setSelected(created)
      setCreateOpen(false)
      setCreateForm({
        name: '',
        achievement_type: '方案',
        special_project: currentProject?.name ?? '',
        owner: '',
        version: 'V0.1',
        file_link: '',
        scenario: '',
        reuse_tag: '',
      })
    } catch (err: any) {
      setCreateError(err?.message || '创建失败，请稍后重试')
    } finally {
      setCreateSaving(false)
    }
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <header className="h-16 flex items-center px-6 gap-3 flex-shrink-0 bg-white border-b" style={{ borderColor: '#E9EFF6' }}>
        <div className="flex-1">
          <h1 className="text-base font-bold text-slate-800">成果库</h1>
          <p className="text-xs text-slate-400 mt-0.5">沉淀方案、模板、SOP、Prompt、Agent 等可复用资产</p>
        </div>
        <select
          value={filterProjectId ?? ''}
          onChange={(e) => setFilterProjectId(e.target.value === '' ? null : Number(e.target.value))}
          className="text-sm border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white text-slate-600 cursor-pointer focus:outline-none"
        >
          <option value="">全部专项</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={filterType} onChange={(e) => setFilterType(e.target.value)} className="text-sm border border-slate-200 rounded-lg px-2.5 py-1.5 bg-white text-slate-600 cursor-pointer focus:outline-none">
          <option value="">全部类型</option>
          {['方案', '模板', 'SOP', 'Prompt', 'Agent', '文档'].map((t) => <option key={t}>{t}</option>)}
        </select>
        <button
          type="button"
          onClick={() => {
            setCreateError('')
            setCreateForm((prev) => ({
              ...prev,
              special_project: currentProject?.name || prev.special_project,
            }))
            setCreateOpen(true)
          }}
          className="cursor-pointer flex items-center gap-2 px-4 py-2 rounded-lg text-white text-sm font-semibold hover:opacity-90"
          style={{ background: 'linear-gradient(135deg,#0369A1,#0EA5E9)', boxShadow: '0 2px 8px rgba(3,105,161,0.25)' }}
        >
          <svg style={{ width: 14, height: 14 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" /></svg>
          上传成果
        </button>
      </header>

      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(15,23,42,0.45)' }}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl mx-4 overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: '#E9EFF6' }}>
              <div>
                <h3 className="text-base font-bold text-slate-800">上传成果</h3>
                <p className="text-xs text-slate-400 mt-0.5">这里先登记成果信息和文件链接，不直接上传二进制文件</p>
              </div>
              <button
                type="button"
                onClick={() => { if (!createSaving) setCreateOpen(false) }}
                className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400"
              >
                <svg style={{ width: 16, height: 16 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="px-6 py-5 space-y-4">
              {createError && (
                <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {createError}
                </div>
              )}
              <div className="grid grid-cols-2 gap-4">
                <label className="space-y-1.5">
                  <span className="text-xs font-semibold text-slate-600">成果名称</span>
                  <input
                    value={createForm.name}
                    onChange={(e) => setCreateForm((prev) => ({ ...prev, name: e.target.value }))}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-sky-400"
                    placeholder="例如：知识资产AI化方案"
                  />
                </label>
                <label className="space-y-1.5">
                  <span className="text-xs font-semibold text-slate-600">成果类型</span>
                  <select
                    value={createForm.achievement_type}
                    onChange={(e) => setCreateForm((prev) => ({ ...prev, achievement_type: e.target.value }))}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-sky-400 bg-white"
                  >
                    {['方案', '模板', 'SOP', 'Prompt', 'Agent', '文档'].map((t) => <option key={t}>{t}</option>)}
                  </select>
                </label>
                <label className="space-y-1.5">
                  <span className="text-xs font-semibold text-slate-600">所属专项</span>
                  <input
                    value={createForm.special_project}
                    onChange={(e) => setCreateForm((prev) => ({ ...prev, special_project: e.target.value }))}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-sky-400"
                    placeholder="默认带出当前项目"
                  />
                </label>
                <label className="space-y-1.5">
                  <span className="text-xs font-semibold text-slate-600">负责人</span>
                  <input
                    value={createForm.owner}
                    onChange={(e) => setCreateForm((prev) => ({ ...prev, owner: e.target.value }))}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-sky-400"
                    placeholder="可留空"
                  />
                </label>
                <label className="space-y-1.5">
                  <span className="text-xs font-semibold text-slate-600">版本</span>
                  <input
                    value={createForm.version}
                    onChange={(e) => setCreateForm((prev) => ({ ...prev, version: e.target.value }))}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-sky-400"
                    placeholder="V0.1"
                  />
                </label>
                <label className="space-y-1.5">
                  <span className="text-xs font-semibold text-slate-600">复用标签</span>
                  <input
                    value={createForm.reuse_tag}
                    onChange={(e) => setCreateForm((prev) => ({ ...prev, reuse_tag: e.target.value }))}
                    className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-sky-400"
                    placeholder="例如：内测、自动化、AI"
                  />
                </label>
              </div>
              <label className="space-y-1.5 block">
                <span className="text-xs font-semibold text-slate-600">文件链接 / 存储地址</span>
                <input
                  value={createForm.file_link}
                  onChange={(e) => setCreateForm((prev) => ({ ...prev, file_link: e.target.value }))}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-sky-400"
                  placeholder="可填网盘链接、在线文档地址或本地路径"
                />
              </label>
              <label className="space-y-1.5 block">
                <span className="text-xs font-semibold text-slate-600">使用场景</span>
                <textarea
                  value={createForm.scenario}
                  onChange={(e) => setCreateForm((prev) => ({ ...prev, scenario: e.target.value }))}
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-sky-400 resize-none"
                  rows={3}
                  placeholder="例如：专项内复用、内部演示、制度落地"
                />
              </label>
            </div>
            <div className="px-6 py-4 border-t flex items-center justify-between gap-3" style={{ borderColor: '#E9EFF6' }}>
              <span className="text-xs text-slate-400">* 这里只登记成果信息，文件本体由文件链接承载。</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setCreateOpen(false)}
                  disabled={createSaving}
                  className="px-4 py-2 rounded-lg border border-slate-200 text-slate-600 text-sm font-semibold hover:bg-slate-50 disabled:opacity-50"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handleCreateAchievement}
                  disabled={createSaving}
                  className="px-4 py-2 rounded-lg text-white text-sm font-semibold hover:opacity-90 disabled:opacity-50"
                  style={{ background: 'linear-gradient(135deg,#0369A1,#0EA5E9)' }}
                >
                  {createSaving ? '保存中...' : '确认上传'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Stats */}
      <div className="bg-white border-b px-6 py-4 flex-shrink-0" style={{ borderColor: '#E9EFF6' }}>
        <div className="grid grid-cols-4 gap-4">
          {[
            { label: '成果总数', val: items.length, icon: '📦', color: '#0369A1', bg: 'linear-gradient(135deg,#0369A1,#0EA5E9)' },
            { label: '本月新增', val: 0, icon: '📈', color: '#059669', bg: 'linear-gradient(135deg,#059669,#34D399)' },
            { label: '可复用成果', val: items.filter((i) => i.reuse_tag).length, icon: '🔄', color: '#7C3AED', bg: 'linear-gradient(135deg,#7C3AED,#A78BFA)' },
            { label: '待优化成果', val: 0, icon: '⚠️', color: '#D97706', bg: 'linear-gradient(135deg,#D97706,#FBBF24)' },
          ].map(({ label, val, icon, color, bg }) => (
            <div key={label} className="rounded-xl border p-4 flex items-center gap-4" style={{ borderColor: '#E9EFF6', boxShadow: '0 1px 4px rgba(15,23,42,0.06)', background: 'white' }}>
              <div className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 text-white text-2xl" style={{ background: bg }}>
                {icon}
              </div>
              <div>
                <p className="text-xs text-slate-500 font-medium">{label}</p>
                <p className="text-3xl font-bold leading-none mt-1" style={{ color }}>{val}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-hidden flex" style={{ background: '#F1F5F9' }}>
        {/* Card Grid */}
        <div className="flex-1 overflow-y-auto p-6">
          {loading ? (
            <div className="text-center text-slate-400 py-8 text-sm">加载中…</div>
          ) : (
            <>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-bold text-slate-800">成果列表 <span className="text-slate-400 font-normal">（共 {filtered.length} 项）</span></h2>
              </div>
              <div className="grid grid-cols-4 gap-3">
                {filtered.map((item) => {
                  const ts = getTypeStyle(item.achievement_type)
                  const isSelected = selected?.id === item.id
                  return (
                    <div
                      key={item.id}
                      onClick={() => setSelected(item)}
                      className="bg-white rounded-xl cursor-pointer transition-all"
                      style={{
                        border: `1.5px solid ${isSelected ? '#0369A1' : '#E9EFF6'}`,
                        padding: 14,
                        boxShadow: isSelected ? '0 0 0 3px rgba(3,105,161,0.12)' : '0 1px 3px rgba(15,23,42,0.05)',
                        background: isSelected ? '#F0F9FF' : 'white',
                      }}
                    >
                      <div className="flex items-start justify-between mb-3">
                        <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 text-white text-sm font-bold" style={{ background: ts.bg }}>
                          {ts.letter}
                        </div>
                        <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-bold" style={{ background: ts.letterBg, color: ts.color }}>
                          {item.achievement_type ?? '文件'}
                        </span>
                      </div>
                      <p className="text-sm font-bold text-slate-800 leading-snug mb-1">{item.name ?? '-'}</p>
                      <p className="text-xs text-slate-400 mb-2.5">{item.special_project ?? ''}</p>
                      <div className="space-y-1 mb-3 text-xs text-slate-500">
                        <div className="flex items-center gap-1.5">
                          <svg style={{ width: 11, height: 11, flexShrink: 0 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
                          {item.owner ?? '-'} · {item.version ?? 'v1.0'}
                        </div>
                        <div className="flex items-center gap-1.5">
                          <svg style={{ width: 11, height: 11, flexShrink: 0 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                          {item.created_at?.slice(0, 10) ?? '-'}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 pt-2.5 border-t border-slate-100">
                        <button className="flex-1 text-xs font-semibold text-blue-600 hover:text-blue-800 py-1.5 rounded-lg hover:bg-blue-50 transition-colors" onClick={(e) => e.stopPropagation()}>查看</button>
                        <button className="flex-1 text-xs font-semibold text-slate-500 hover:text-slate-700 py-1.5 rounded-lg hover:bg-slate-100 transition-colors" onClick={(e) => e.stopPropagation()}>关联</button>
                        <button className="flex-1 text-xs font-semibold text-slate-500 hover:text-slate-700 py-1.5 rounded-lg hover:bg-slate-100 transition-colors flex items-center justify-center gap-1" onClick={(e) => e.stopPropagation()}>
                          <svg style={{ width: 11, height: 11 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                          下载
                        </button>
                        {currentUser?.is_tech_admin && (
                          <button
                            className="flex-1 text-xs font-semibold text-red-400 hover:text-red-600 py-1.5 rounded-lg hover:bg-red-50 transition-colors"
                            onClick={(e) => {
                              e.stopPropagation()
                              if (!confirm(`确认删除「${item.name}」？`)) return
                              deleteAchievement(item.id).then(() => {
                                setItems((prev) => prev.filter((a) => a.id !== item.id))
                                if (selected?.id === item.id) setSelected(null)
                              }).catch(() => alert('删除失败'))
                            }}
                          >删除</button>
                        )}
                      </div>
                    </div>
                  )
                })}
                {filtered.length === 0 && (
                  <div className="col-span-4 py-12 text-center text-slate-400 text-sm">暂无成果数据</div>
                )}
              </div>
              {filtered.length > 0 && (
                <div className="flex items-center justify-between mt-4">
                  <span className="text-xs text-slate-400">共 {filtered.length} 条</span>
                  <button className="w-7 h-7 rounded-lg text-white text-xs font-bold" style={{ background: '#0369A1' }}>1</button>
                  <select className="text-xs border border-slate-200 rounded-lg px-2 py-1 bg-white text-slate-500 cursor-pointer focus:outline-none">
                    <option>10 条/页</option>
                  </select>
                </div>
              )}
            </>
          )}
        </div>

        {/* Detail Panel */}
        {selected && (
          <div style={{ width: 300, flexShrink: 0, borderLeft: '1px solid #E9EFF6', background: '#fff', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            <div className="flex items-center justify-between px-4 py-3.5 border-b flex-shrink-0" style={{ borderColor: '#E9EFF6' }}>
              <h2 className="text-sm font-bold text-slate-800">成果详情</h2>
              <button onClick={() => setSelected(null)} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors">
                <svg style={{ width: 14, height: 14 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
              <div className="flex items-start gap-3">
                <div className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 text-white font-bold" style={{ background: getTypeStyle(selected.achievement_type).bg }}>
                  {getTypeStyle(selected.achievement_type).letter}
                </div>
                <div>
                  <p className="text-sm font-bold text-slate-800 leading-snug">{selected.name ?? '-'}</p>
                  <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                    <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-bold" style={{ background: getTypeStyle(selected.achievement_type).letterBg, color: getTypeStyle(selected.achievement_type).color }}>
                      {selected.achievement_type ?? '文件'}
                    </span>
                  </div>
                </div>
              </div>

              {[
                { label: '负责人', value: selected.owner },
                { label: '所属专项', value: selected.special_project },
                { label: '版本', value: selected.version ?? 'v1.0' },
                { label: '状态', value: selected.status ?? '进行中' },
                { label: '使用场景', value: selected.scenario },
                { label: '创建时间', value: selected.created_at?.slice(0, 10) },
              ].map(({ label, value }) => value ? (
                <div key={label} className="flex gap-2 text-xs py-1.5 border-b border-slate-50">
                  <span className="w-16 flex-shrink-0 text-slate-500 font-semibold">{label}</span>
                  <span className="text-slate-800">{value}</span>
                </div>
              ) : null)}
            </div>
            <div className="px-4 py-3 border-t flex gap-2 flex-shrink-0" style={{ borderColor: '#E9EFF6' }}>
              <button className="flex-1 py-2 rounded-lg text-white text-xs font-bold hover:opacity-90" style={{ background: 'linear-gradient(135deg,#0369A1,#0EA5E9)' }}>
                下载文件
              </button>
              <button className="flex-1 py-2 rounded-lg border border-slate-200 text-slate-600 text-xs font-semibold hover:bg-slate-50">
                关联任务
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
