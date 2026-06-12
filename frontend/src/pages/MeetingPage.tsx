import { useEffect, useRef, useState } from 'react'
import { fmtFull } from '../utils/time'
import {
  fetchMeetings,
  patchMeetingStatus,
  analyzeMeeting,
  transcribeAudio,
  createMeeting,
  type MeetingAnalyzeResult,
} from '../api/meetings'
import { getProjectMembers } from '../api/projects'
import { apiPost } from '../api/client'
import { useProject } from '../context/ProjectContext'
import type { MeetingItem, ProjectMember } from '../types'

const TYPE_LABEL: Record<string, string> = {
  weekly:  '周会',
  monthly: '月会',
  review:  '评审会',
  special: '专项会',
  discuss: '讨论会',
}
function typeLabel(raw?: string) { return TYPE_LABEL[raw ?? ''] ?? raw ?? '-' }

const TYPE_STYLE: Record<string, string> = {
  '周会':   'bg-blue-100 text-blue-700',
  '月会':   'bg-blue-100 text-blue-700',
  '评审会': 'bg-purple-100 text-purple-700',
  '专项会': 'bg-emerald-100 text-emerald-700',
  '讨论会': 'bg-orange-100 text-orange-700',
}

type PublishStatus = 'draft' | 'published' | 'returned'
const STATUS_CONFIG: Record<PublishStatus, { cls: string; label: string }> = {
  draft:     { cls: 'bg-amber-100 text-amber-700',     label: '已生成（待校对）' },
  published: { cls: 'bg-emerald-100 text-emerald-700', label: '已发布' },
  returned:  { cls: 'bg-red-100 text-red-700',         label: '已退回' },
}
function getStatus(m: MeetingItem): PublishStatus {
  const s = m.publish_status as string | undefined
  if (s === 'published' || s === 'returned') return s
  return 'draft'
}

function detectSpeakers(text: string): string[] {
  const set = new Set<string>()
  const re = /说话人\s*(\d+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) set.add(`说话人${m[1]}`)
  return [...set].sort((a, b) => +a.replace('说话人', '') - +b.replace('说话人', ''))
}

const ROLE_LABEL: Record<string, string> = {
  owner: '项目负责人', coordinator: '统筹人', member: '协同成员',
  process_guard: '过程保障', project_ceo: '专项CEO',
}

// ── 推送到工作推进表弹窗 ────────────────────────────────────────

type Report = {
  member: string
  role?: string
  completed_items?: string[]
  vs_last_plan?: string
  issues?: string[]
  requests?: string[]
  leader_feedback?: { positive?: string[]; improve?: string[]; reminder?: string[] }
  next_steps?: { task: string; deadline?: string }[]
}

function PushToTasksModal({
  projectId,
  reportsJson,
  actionItemsJson,
  members,
  onClose,
  onDone,
}: {
  projectId: number
  reportsJson: string
  actionItemsJson: string
  members: ProjectMember[]
  onClose: () => void
  onDone: () => void
}) {
  const [speakerMap, setSpeakerMap] = useState<Record<string, string>>({})
  const [customNames, setCustomNames] = useState<Record<string, string>>({})
  const [pushing, setPushing] = useState(false)
  const [error, setError] = useState('')

  let reports: Report[] = []
  try { reports = JSON.parse(reportsJson) } catch { /* ignore */ }
  let actionItems: { member?: string; task: string; deadline?: string }[] = []
  try { actionItems = JSON.parse(actionItemsJson) } catch { /* ignore */ }

  // 收集所有出现的发言人/成员标签
  const speakerSet = new Set<string>()
  reports.forEach(r => { if (r.member) speakerSet.add(r.member) })
  actionItems.forEach(a => { if (a.member) speakerSet.add(a.member) })
  const speakers = [...speakerSet]

  // 唯一成员名列表（去重）
  const uniqueMembers = [...new Map(members.map(m => [m.person_name_snapshot, m])).values()]

  async function handlePush() {
    setPushing(true)
    setError('')

    // 解析映射
    const resolve = (label: string) => {
      if (label in customNames) return customNames[label] || label
      return speakerMap[label] || label
    }

    // 从 next_steps 和 action_items 整合任务
    const tasks: { key_task: string; owner: string; plan_time: string }[] = []

    reports.forEach(r => {
      const owner = resolve(r.member)
      ;(r.next_steps || []).forEach(ns => {
        if (ns.task) tasks.push({ key_task: ns.task, owner, plan_time: ns.deadline || '' })
      })
    })
    actionItems.forEach(a => {
      const owner = resolve(a.member || '')
      if (a.task) tasks.push({ key_task: a.task, owner, plan_time: a.deadline || '' })
    })

    if (tasks.length === 0) { setError('没有可推送的任务'); setPushing(false); return }

    try {
      await Promise.all(tasks.map(t =>
        apiPost('/api/tasks', {
          project_id: projectId,
          key_task: t.key_task,
          owner: t.owner,
          plan_time: t.plan_time,
          status: '未开始',
          source_type: '会议提取',
        })
      ))
      onDone()
    } catch (e: unknown) {
      setError(`推送失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setPushing(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center" style={{ background: 'rgba(15,23,42,0.6)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-white rounded-2xl shadow-2xl flex flex-col overflow-hidden" style={{ width: 600, maxHeight: '85vh' }}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: '#E9EFF6' }}>
          <div>
            <div className="text-sm font-bold text-slate-800">推送到工作推进表</div>
            <div className="text-xs text-slate-400 mt-0.5">将发言人映射到项目成员，生成对应的工作任务</div>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-slate-100 text-slate-400">
            <svg style={{ width: 14, height: 14 }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* 发言人映射 */}
          {speakers.length > 0 && (
            <div>
              <div className="text-xs font-bold text-slate-700 mb-3">发言人身份映射</div>
              <div className="space-y-2">
                {speakers.map(speaker => (
                  <div key={speaker} className="grid items-center gap-3" style={{ gridTemplateColumns: '110px 1fr' }}>
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 text-xs font-bold flex-shrink-0">
                        {speaker.replace('说话人', '') || speaker.slice(0, 1)}
                      </div>
                      <span className="text-xs font-semibold text-slate-600 truncate">{speaker}</span>
                    </div>
                    <div className="flex flex-col gap-1">
                      <select
                        className="w-full border border-slate-200 rounded-lg px-2.5 py-1.5 text-sm text-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-300"
                        value={speaker in customNames ? '__custom__' : (speakerMap[speaker] ?? '')}
                        onChange={e => {
                          const val = e.target.value
                          if (val === '__custom__') {
                            setCustomNames(c => ({ ...c, [speaker]: speakerMap[speaker] ?? '' }))
                          } else {
                            setCustomNames(c => { const n = { ...c }; delete n[speaker]; return n })
                            setSpeakerMap(m => ({ ...m, [speaker]: val }))
                          }
                        }}
                      >
                        <option value="">— 保持原标签 —</option>
                        {uniqueMembers.length > 0 && (
                          <optgroup label="── 本项目成员 ──">
                            {uniqueMembers.map(m => (
                              <option key={m.id} value={m.person_name_snapshot}>
                                {m.person_name_snapshot}（{ROLE_LABEL[m.role] ?? m.role}）
                              </option>
                            ))}
                          </optgroup>
                        )}
                        <option value="__custom__">— 手动填写 —</option>
                      </select>
                      {speaker in customNames && (
                        <input autoFocus type="text"
                          className="w-full border border-blue-300 rounded-lg px-2.5 py-1.5 text-sm text-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-400"
                          placeholder="输入姓名（如：吴总）"
                          value={customNames[speaker]}
                          onChange={e => {
                            const v = e.target.value
                            setCustomNames(c => ({ ...c, [speaker]: v }))
                            setSpeakerMap(m => ({ ...m, [speaker]: v }))
                          }}
                        />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 即将创建的任务预览 */}
          <div>
            <div className="text-xs font-bold text-slate-700 mb-2">即将创建的任务</div>
            <div className="border border-slate-200 rounded-xl overflow-hidden">
              {(() => {
                const resolve = (label: string) => {
                  if (label in customNames) return customNames[label] || label
                  return speakerMap[label] || label
                }
                const tasks: { key_task: string; owner: string; deadline: string }[] = []
                reports.forEach(r => {
                  const owner = resolve(r.member)
                  ;(r.next_steps || []).forEach(ns => {
                    if (ns.task) tasks.push({ key_task: ns.task, owner, deadline: ns.deadline || '' })
                  })
                })
                actionItems.forEach(a => {
                  const owner = resolve(a.member || '')
                  if (a.task) tasks.push({ key_task: a.task, owner, deadline: a.deadline || '' })
                })

                if (tasks.length === 0) {
                  return <div className="px-4 py-6 text-xs text-slate-400 text-center">没有可推送的任务（AI 未提取到下一步计划或行动清单）</div>
                }
                return tasks.map((t, i) => (
                  <div key={i} className="flex items-start gap-3 px-4 py-2.5 border-b last:border-0 text-xs" style={{ borderColor: '#F1F5F9' }}>
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-400 mt-1.5 flex-shrink-0" />
                    <span className="flex-1 text-slate-700">{t.key_task}</span>
                    <span className="text-slate-500 font-medium whitespace-nowrap">{t.owner || '—'}</span>
                    {t.deadline && <span className="text-slate-400 whitespace-nowrap">{t.deadline}</span>}
                  </div>
                ))
              })()}
            </div>
          </div>

          {error && <ErrorBar msg={error} />}
        </div>

        <div className="flex items-center justify-between px-6 py-4 border-t" style={{ borderColor: '#E9EFF6' }}>
          <button onClick={onClose} className="text-sm text-slate-500 hover:text-slate-700">取消</button>
          <button
            onClick={handlePush}
            disabled={pushing}
            className="px-6 py-2.5 rounded-xl text-white text-sm font-bold hover:opacity-90 disabled:opacity-50"
            style={{ background: 'linear-gradient(135deg,#059669,#10B981)' }}
          >
            {pushing ? '推送中…' : '确认推送到工作推进表'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── 新建会议弹窗 ───────────────────────────────────────────────

type ModalStep = 'input' | 'analyzing' | 'review'
type InputTab  = 'text' | 'audio'

type ReviewForm = {
  title: string; meeting_type: string; meeting_date: string
  host: string; participants: string; summary: string
  reports_json: string; task_list_json: string
  decision_items_json: string; risk_items_json: string
  transcript_text: string
}

function NewMeetingModal({
  projectId, onClose, onCreated,
}: {
  projectId: number
  onClose: () => void
  onCreated: (m: MeetingItem) => void
}) {
  const [tab, setTab]               = useState<InputTab>('text')
  const [step, setStep]             = useState<ModalStep>('input')
  const [pastedText, setPastedText] = useState('')
  const [audioFile, setAudioFile]   = useState<File | null>(null)
  const [statusMsg, setStatusMsg]   = useState('')
  const [error, setError]           = useState('')
  const [saving, setSaving]         = useState(false)
  const [showPushModal, setShowPushModal] = useState(false)
  const [members, setMembers]       = useState<ProjectMember[]>([])
  const fileRef = useRef<HTMLInputElement>(null)

  const [form, setForm] = useState<ReviewForm>({
    title: '', meeting_type: '', meeting_date: '', host: '',
    participants: '', summary: '',
    reports_json: '[]', task_list_json: '[]',
    decision_items_json: '[]', risk_items_json: '[]',
    transcript_text: '',
  })

  useEffect(() => {
    getProjectMembers(projectId).then(setMembers).catch(() => {})
  }, [projectId])

  function setField(key: keyof ReviewForm, val: string) {
    setForm(f => ({ ...f, [key]: val }))
  }

  async function handleAnalyze() {
    setError('')
    let text = ''

    if (tab === 'audio') {
      if (!audioFile) { setError('请先选择音频文件'); return }
      setStep('analyzing')
      setStatusMsg('正在转录音频…')
      try {
        text = (await transcribeAudio(audioFile)).text
      } catch (e: unknown) {
        setError(`转录失败：${e instanceof Error ? e.message : String(e)}`)
        setStep('input'); return
      }
    } else {
      if (!pastedText.trim()) { setError('请粘贴会议文字内容'); return }
      text = pastedText
    }

    setStep('analyzing')
    setStatusMsg('AI 正在分析会议内容…')
    try {
      const result: MeetingAnalyzeResult = await analyzeMeeting(text, projectId)
      setForm({
        title:               result.title,
        meeting_type:        result.meeting_type,
        meeting_date:        result.meeting_date,
        host:                result.host,
        participants:        result.participants,
        summary:             result.summary,
        reports_json:        result.reports_json ?? '[]',
        task_list_json:      result.task_list_json,
        decision_items_json: result.decision_items_json,
        risk_items_json:     result.risk_items_json,
        transcript_text:     text,
      })
      setStep('review')
    } catch (e: unknown) {
      setError(`AI 分析失败：${e instanceof Error ? e.message : String(e)}`)
      setStep('input')
    }
  }

  async function handleSave() {
    setSaving(true); setError('')
    try {
      const item = await createMeeting({ project_id: projectId, ...form })
      onCreated(item)
    } catch (e: unknown) {
      setError(`保存失败：${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false) }
  }

  const STEPS = [
    { key: 'input' as ModalStep,     label: '输入内容' },
    { key: 'analyzing' as ModalStep, label: 'AI 分析' },
    { key: 'review' as ModalStep,    label: '确认保存' },
  ]
  const currentIdx = STEPS.findIndex(s => s.key === step)

  return (
    <>
    <div className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(15,23,42,0.5)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="bg-white rounded-2xl shadow-2xl flex flex-col overflow-hidden" style={{ width: 700, maxHeight: '92vh' }}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: '#E9EFF6' }}>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: 'linear-gradient(135deg,#6366F1,#0EA5E9)' }}>
              <svg style={{ width: 15, height: 15, color: 'white' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <div>
              <div className="text-sm font-bold text-slate-800">新建会议纪要</div>
              <div className="text-xs text-slate-400">
                {step === 'input' ? '选择输入方式' : step === 'analyzing' ? statusMsg : '确认并保存会议纪要'}
              </div>
            </div>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-slate-100 text-slate-400">
            <svg style={{ width: 14, height: 14 }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Steps */}
        <div className="flex items-center gap-1 px-6 py-3 border-b" style={{ borderColor: '#F1F5F9', background: '#FAFBFC' }}>
          {STEPS.map((s, i) => {
            const done = currentIdx > i; const active = currentIdx === i
            return (
              <div key={s.key} className="flex items-center gap-1">
                {i > 0 && <div className="w-8 h-px mx-1" style={{ background: done ? '#0EA5E9' : '#E2E8F0' }} />}
                <div className="flex items-center gap-1.5">
                  <div className="w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
                    style={{ background: done ? '#0EA5E9' : active ? '#EFF6FF' : '#F1F5F9', color: done ? 'white' : active ? '#0369A1' : '#94A3B8', border: active ? '1.5px solid #0EA5E9' : '1.5px solid transparent' }}>
                    {done ? '✓' : i + 1}
                  </div>
                  <span className="text-xs font-medium" style={{ color: active ? '#0369A1' : '#94A3B8' }}>{s.label}</span>
                </div>
              </div>
            )
          })}
        </div>

        <div className="flex-1 overflow-y-auto">
          {/* ── 输入 ── */}
          {step === 'input' && (
            <div className="p-6 space-y-4">
              <div className="flex gap-1 p-1 rounded-xl" style={{ background: '#F1F5F9' }}>
                {(['text', 'audio'] as InputTab[]).map(t => (
                  <button key={t} onClick={() => setTab(t)}
                    className="flex-1 py-2 rounded-lg text-sm font-semibold transition-all"
                    style={{ background: tab === t ? 'white' : 'transparent', color: tab === t ? '#0369A1' : '#64748B', boxShadow: tab === t ? '0 1px 3px rgba(0,0,0,0.08)' : 'none' }}>
                    {t === 'text' ? '📝 粘贴文字' : '🎙 上传录音'}
                  </button>
                ))}
              </div>
              {tab === 'text' ? (
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-2">粘贴会议记录文字</label>
                  <textarea className="w-full border border-slate-200 rounded-xl p-3 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-300 resize-none" rows={12}
                    placeholder={"粘贴会议记录、逐字稿或整理后的文字…\n\n如包含「说话人1」「说话人2」等标注，AI 会按人头分别提取汇报内容。\n人员映射可在分析结果出来后再进行。"}
                    value={pastedText} onChange={e => setPastedText(e.target.value)} />
                  <div className="text-xs text-slate-400 mt-1 text-right">{pastedText.length} 字</div>
                </div>
              ) : (
                <div>
                  <label className="block text-xs font-semibold text-slate-600 mb-2">上传会议录音文件</label>
                  <div className="border-2 border-dashed rounded-xl p-8 flex flex-col items-center gap-3 cursor-pointer transition-colors"
                    style={{ borderColor: audioFile ? '#0EA5E9' : '#E2E8F0', background: audioFile ? '#F0F9FF' : '#FAFBFC' }}
                    onClick={() => fileRef.current?.click()}>
                    <div className="w-12 h-12 rounded-full flex items-center justify-center" style={{ background: audioFile ? '#DBEAFE' : '#F1F5F9' }}>
                      <svg style={{ width: 22, height: 22, color: audioFile ? '#0369A1' : '#94A3B8' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                      </svg>
                    </div>
                    {audioFile ? (
                      <div className="text-center">
                        <div className="text-sm font-semibold text-slate-700">{audioFile.name}</div>
                        <div className="text-xs text-slate-400 mt-0.5">{(audioFile.size / 1024 / 1024).toFixed(1)} MB · 点击重新选择</div>
                      </div>
                    ) : (
                      <div className="text-center">
                        <div className="text-sm font-semibold text-slate-600">点击选择音频文件</div>
                        <div className="text-xs text-slate-400 mt-1">支持 MP3、WAV、M4A、WEBM 等格式</div>
                      </div>
                    )}
                  </div>
                  <input ref={fileRef} type="file" accept="audio/*,.mp3,.wav,.m4a,.webm,.flac,.aac,.ogg" className="hidden"
                    onChange={e => setAudioFile(e.target.files?.[0] ?? null)} />
                </div>
              )}
              {error && <ErrorBar msg={error} />}
            </div>
          )}

          {/* ── 分析中 ── */}
          {step === 'analyzing' && (
            <div className="p-12 flex flex-col items-center gap-5">
              <div className="w-16 h-16 rounded-2xl flex items-center justify-center" style={{ background: 'linear-gradient(135deg,#EFF6FF,#DBEAFE)' }}>
                <svg className="animate-spin" style={{ width: 28, height: 28, color: '#0369A1' }} fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              </div>
              <div className="text-center">
                <div className="text-base font-bold text-slate-700">{statusMsg}</div>
                <div className="text-sm text-slate-400 mt-1">请稍候，这可能需要 20–40 秒</div>
              </div>
            </div>
          )}

          {/* ── 确认结果 ── */}
          {step === 'review' && (
            <div className="p-6 space-y-5">
              {/* 基本信息 */}
              <div>
                <SectionTitle>基本信息</SectionTitle>
                <div className="grid grid-cols-2 gap-3 mt-2">
                  <Field label="会议标题" value={form.title} onChange={v => setField('title', v)} />
                  <div>
                    <label className="block text-xs font-semibold text-slate-500 mb-1">会议类型</label>
                    <select className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-300"
                      value={form.meeting_type} onChange={e => setField('meeting_type', e.target.value)}>
                      <option value="">请选择</option>
                      <option value="weekly">周会</option><option value="monthly">月会</option>
                      <option value="review">评审会</option><option value="special">专项会</option>
                      <option value="discuss">讨论会</option>
                    </select>
                  </div>
                  <Field label="会议日期" value={form.meeting_date} onChange={v => setField('meeting_date', v)} placeholder="YYYY-MM-DD" />
                  <Field label="主持人" value={form.host} onChange={v => setField('host', v)} />
                  <div className="col-span-2">
                    <Field label="参会人" value={form.participants} onChange={v => setField('participants', v)} placeholder="多人用逗号分隔" />
                  </div>
                </div>
              </div>

              {/* 摘要 */}
              <div>
                <SectionTitle>会议摘要</SectionTitle>
                <textarea className="w-full mt-2 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-300 resize-none" rows={3}
                  value={form.summary} onChange={e => setField('summary', e.target.value)} />
              </div>

              {/* 按人头汇报 */}
              <ReportsSection reportsJson={form.reports_json} />

              {/* 决策事项 */}
              <JsonListSection label="决策事项" value={form.decision_items_json} onChange={v => setField('decision_items_json', v)} dotColor="#3B82F6" />

              {/* 行动清单 */}
              <JsonListSection label="行动清单" value={form.task_list_json} onChange={v => setField('task_list_json', v)} dotColor="#10B981" />

              {error && <ErrorBar msg={error} />}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t" style={{ borderColor: '#E9EFF6' }}>
          {step === 'review' ? (
            <>
              <button onClick={() => setStep('input')} className="text-sm text-slate-500 hover:text-slate-700 font-medium">← 重新输入</button>
              <div className="flex gap-2">
                {/* 推送到工作推进表 */}
                <button
                  onClick={() => setShowPushModal(true)}
                  className="px-4 py-2.5 rounded-xl border-2 border-emerald-200 text-emerald-700 text-sm font-semibold hover:bg-emerald-50 flex items-center gap-2"
                >
                  <svg style={{ width: 14, height: 14 }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                  </svg>
                  推送到工作推进表
                </button>
                <button onClick={handleSave} disabled={saving}
                  className="px-6 py-2.5 rounded-xl text-white text-sm font-bold hover:opacity-90 disabled:opacity-50"
                  style={{ background: 'linear-gradient(135deg,#0369A1,#0EA5E9)' }}>
                  {saving ? '保存中…' : '保存草稿'}
                </button>
              </div>
            </>
          ) : step === 'input' ? (
            <>
              <button onClick={onClose} className="text-sm text-slate-500 hover:text-slate-700 font-medium">取消</button>
              <button onClick={handleAnalyze}
                className="px-6 py-2.5 rounded-xl text-white text-sm font-bold hover:opacity-90"
                style={{ background: 'linear-gradient(135deg,#0369A1,#0EA5E9)' }}>
                AI 分析 →
              </button>
            </>
          ) : <div />}
        </div>
      </div>
    </div>

    {showPushModal && (
      <PushToTasksModal
        projectId={projectId}
        reportsJson={form.reports_json}
        actionItemsJson={form.task_list_json}
        members={members}
        onClose={() => setShowPushModal(false)}
        onDone={() => { setShowPushModal(false); handleSave() }}
      />
    )}
    </>
  )
}

// ── 小组件 ─────────────────────────────────────────────────────

type ReportData = {
  member: string; role?: string
  completed_items?: string[]; vs_last_plan?: string
  issues?: string[]; requests?: string[]
  leader_feedback?: { positive?: string[]; improve?: string[]; reminder?: string[] }
  next_steps?: { task: string; deadline?: string }[]
}

const VS_STYLE: Record<string, { bg: string; text: string }> = {
  '完成':     { bg: '#D1FAE5', text: '#065F46' },
  '部分完成': { bg: '#FEF3C7', text: '#92400E' },
  '未完成':   { bg: '#FEE2E2', text: '#991B1B' },
  '未提及':   { bg: '#F1F5F9', text: '#64748B' },
}

function ReportsSection({ reportsJson }: { reportsJson: string }) {
  let reports: ReportData[] = []
  try { reports = JSON.parse(reportsJson) } catch { return null }
  if (!Array.isArray(reports) || reports.length === 0) return null

  return (
    <div>
      <SectionTitle>各成员汇报详情（AI 提取）</SectionTitle>
      <div className="mt-2 space-y-3">
        {reports.map((r, i) => {
          const vs = r.vs_last_plan ?? ''
          const vsStyle = VS_STYLE[vs] ?? VS_STYLE['未提及']
          const fb = r.leader_feedback ?? {}
          return (
            <div key={i} className="border rounded-xl overflow-hidden" style={{ borderColor: '#E2E8F0' }}>
              <div className="flex items-center justify-between px-4 py-2.5" style={{ background: '#F8FAFC' }}>
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-full bg-blue-100 flex items-center justify-center text-blue-700 text-xs font-bold">
                    {(r.member || '?').slice(0, 1)}
                  </div>
                  <span className="text-sm font-bold text-slate-700">{r.member || `成员${i + 1}`}</span>
                  {r.role && <span className="text-xs text-slate-400">{r.role}</span>}
                </div>
                {vs && <span className="text-xs font-semibold px-2 py-0.5 rounded-full" style={{ background: vsStyle.bg, color: vsStyle.text }}>上次计划：{vs}</span>}
              </div>
              <div className="px-4 py-3 space-y-3">
                <ReportList label="本期完成" items={r.completed_items} color="#10B981" />
                <ReportList label="问题/卡点" items={r.issues} color="#F59E0B" />
                <ReportList label="请求协助/决策" items={r.requests} color="#3B82F6" />
                {(fb.positive?.length || fb.improve?.length || fb.reminder?.length) ? (
                  <div>
                    <div className="text-xs font-semibold text-slate-500 mb-1.5">领导反馈</div>
                    <div className="space-y-1.5 pl-2 border-l-2" style={{ borderColor: '#8B5CF6' }}>
                      {fb.positive?.map((t, j) => <div key={j} className="flex items-start gap-1.5 text-xs text-emerald-700"><span className="mt-0.5">✓</span><span>{t}</span></div>)}
                      {fb.improve?.map((t, j)  => <div key={j} className="flex items-start gap-1.5 text-xs text-amber-700"><span className="mt-0.5">△</span><span>{t}</span></div>)}
                      {fb.reminder?.map((t, j)  => <div key={j} className="flex items-start gap-1.5 text-xs text-red-600 font-medium"><span className="mt-0.5">!</span><span>{t}</span></div>)}
                    </div>
                  </div>
                ) : null}
                {r.next_steps && r.next_steps.length > 0 && (
                  <div>
                    <div className="text-xs font-semibold text-slate-500 mb-1.5">下一步计划</div>
                    <div className="space-y-1">
                      {r.next_steps.map((ns, j) => (
                        <div key={j} className="flex items-start gap-2 text-xs text-slate-600">
                          <span className="w-1.5 h-1.5 rounded-full bg-blue-400 mt-1.5 flex-shrink-0" />
                          <span>{ns.task}</span>
                          {ns.deadline && <span className="ml-auto text-slate-400 whitespace-nowrap">{ns.deadline}</span>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function ReportList({ label, items, color }: { label: string; items?: string[]; color: string }) {
  if (!items?.length) return null
  return (
    <div>
      <div className="text-xs font-semibold text-slate-500 mb-1">{label}</div>
      <div className="space-y-1">
        {items.map((t, i) => (
          <div key={i} className="flex items-start gap-2 text-xs text-slate-600">
            <span className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0" style={{ background: color }} />
            <span>{t}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <div className="w-0.5 h-3.5 rounded-full" style={{ background: '#0369A1' }} />
      <span className="text-xs font-bold text-slate-700">{children}</span>
    </div>
  )
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div>
      <label className="block text-xs font-semibold text-slate-500 mb-1">{label}</label>
      <input type="text" className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-300"
        value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} />
    </div>
  )
}

function JsonListSection({ label, value, onChange, dotColor }: { label: string; value: string; onChange: (v: string) => void; dotColor: string }) {
  let items: unknown[] = []
  try { items = JSON.parse(value) } catch { /* ignore */ }
  return (
    <div>
      <SectionTitle>{label}</SectionTitle>
      <div className="mt-2">
        {Array.isArray(items) && items.length > 0 ? (
          <div className="border border-slate-200 rounded-lg overflow-hidden mb-1">
            {items.map((item, i) => (
              <div key={i} className="flex items-start gap-2 px-3 py-2 border-b last:border-0 text-xs text-slate-600" style={{ borderColor: '#F1F5F9' }}>
                <span className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0" style={{ background: dotColor }} />
                {typeof item === 'string' ? item : typeof item === 'object' && item !== null ? Object.values(item).filter(Boolean).join(' · ') : JSON.stringify(item)}
              </div>
            ))}
          </div>
        ) : (
          <div className="border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-400 mb-1">AI 未提取到相关内容</div>
        )}
        <textarea className="w-full border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-400 focus:outline-none focus:ring-1 focus:ring-blue-200 resize-none font-mono" rows={2}
          value={value} onChange={e => onChange(e.target.value)} placeholder="JSON 原始数据（可直接修改）" />
      </div>
    </div>
  )
}

function ErrorBar({ msg }: { msg: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm text-red-600" style={{ background: '#FEF2F2' }}>
      <svg style={{ width: 14, height: 14, flexShrink: 0 }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      {msg}
    </div>
  )
}

// ── 主页面 ─────────────────────────────────────────────────────

export function MeetingPage() {
  const { currentProjectId } = useProject()
  const [meetings, setMeetings]     = useState<MeetingItem[]>([])
  const [selected, setSelected]     = useState<MeetingItem | null>(null)
  const [loading, setLoading]       = useState(false)
  const [actionLoading, setActionLoading] = useState(false)
  const [typeFilter, setTypeFilter] = useState('')
  const [returnNote, setReturnNote] = useState('')
  const [showReturnInput, setShowReturnInput] = useState(false)
  const [showNewModal, setShowNewModal]       = useState(false)

  useEffect(() => {
    if (!currentProjectId) return
    let cancelled = false
    setLoading(true)
    fetchMeetings(currentProjectId)
      .then(d => { if (!cancelled) { setMeetings(d); if (d.length > 0) setSelected(d[0]) } })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [currentProjectId])

  async function handleStatusChange(status: PublishStatus) {
    if (!selected) return
    setActionLoading(true)
    try {
      const updated = await patchMeetingStatus(selected.id, status)
      setMeetings(prev => prev.map(m => m.id === updated.id ? updated : m))
      setSelected(updated)
      if (status !== 'returned') setShowReturnInput(false)
      setReturnNote('')
    } catch { alert('操作失败，请重试') }
    finally { setActionLoading(false) }
  }

  function handleCreated(m: MeetingItem) {
    setMeetings(prev => [m, ...prev])
    setSelected(m)
    setShowNewModal(false)
  }

  const typeOptions = [...new Set(meetings.map(m => typeLabel(m.meeting_type)).filter(l => l !== '-'))]
  const filtered    = typeFilter ? meetings.filter(m => typeLabel(m.meeting_type) === typeFilter) : meetings
  const selStatus   = selected ? getStatus(selected) : 'draft'
  const statusCfg   = STATUS_CONFIG[selStatus]

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <header className="h-16 flex items-center px-6 gap-4 flex-shrink-0 bg-white border-b" style={{ borderColor: '#E9EFF6' }}>
        <div className="flex-1">
          <h1 className="text-base font-bold text-slate-800">会议纪要</h1>
          <p className="text-xs text-slate-400 mt-0.5">上传录音或粘贴文字，AI 自动生成纪要，可一键推送任务到工作推进表</p>
        </div>
        <div className="flex items-center gap-2">
          <select className="text-sm border border-slate-200 rounded-lg px-3 py-1.5 bg-white text-slate-600 cursor-pointer focus:outline-none"
            value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
            <option value="">全部类型</option>
            {typeOptions.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <button onClick={() => setShowNewModal(true)}
            className="cursor-pointer flex items-center gap-2 px-4 py-2 rounded-lg text-white text-sm font-semibold transition-all hover:opacity-90"
            style={{ background: 'linear-gradient(135deg,#0369A1,#0EA5E9)', boxShadow: '0 2px 8px rgba(3,105,161,0.25)' }}>
            <svg style={{ width: 14, height: 14 }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4v16m8-8H4" />
            </svg>
            新建会议纪要
          </button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto p-6" style={{ background: '#F1F5F9' }}>
        {loading && <div className="text-center text-slate-400 py-8 text-sm">加载中…</div>}

        {selected && (
          <div className="grid grid-cols-5 gap-5 mb-5">
            <div className="bg-white rounded-2xl border p-5 col-span-2 overflow-y-auto" style={{ maxHeight: 560, borderColor: '#E9EFF6', boxShadow: '0 1px 4px rgba(15,23,42,0.06)' }}>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-md flex items-center justify-center" style={{ background: 'linear-gradient(135deg,#6366F1,#0EA5E9)' }}>
                    <svg style={{ width: 12, height: 12, color: 'white' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                  </div>
                  <h2 className="text-sm font-bold text-slate-800">会议纪要正文</h2>
                </div>
                <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${statusCfg.cls}`}>{statusCfg.label}</span>
              </div>
              <div className="space-y-4">
                <MeetingSection title="会议基本信息">
                  <InfoRow label="会议名称" value={selected.title ?? '-'} />
                  <InfoRow label="日期"     value={selected.meeting_date ?? '-'} />
                  <InfoRow label="主持人"   value={selected.host ?? '-'} />
                  <InfoRow label="参会人"   value={selected.participants ?? '-'} />
                  <InfoRow label="会议类型" value={typeLabel(selected.meeting_type)} />
                </MeetingSection>
                {selected.summary && <MeetingSection title="会议摘要"><p className="text-xs text-slate-600 leading-relaxed">{selected.summary}</p></MeetingSection>}
                {selected.task_list_json && <MeetingSection title="行动清单">{renderJsonList(selected.task_list_json, '#94A3B8')}</MeetingSection>}
                {selected.decision_items_json && <MeetingSection title="决策事项">{renderJsonList(selected.decision_items_json, '#3B82F6')}</MeetingSection>}
              </div>
            </div>

            <div className="col-span-3 flex flex-col gap-4">
              <div className="bg-white rounded-2xl border p-5" style={{ borderColor: '#E9EFF6', boxShadow: '0 1px 4px rgba(15,23,42,0.06)' }}>
                <h2 className="text-sm font-bold text-slate-800 mb-4">相关信息</h2>
                <div className="space-y-2 text-xs">
                  <InfoRow label="关联专项" value={selected.related_special_project ?? '-'} />
                  <InfoRow label="创建时间" value={fmtFull(selected.created_at)} />
                </div>
              </div>
              <div className="bg-white rounded-2xl border p-5" style={{ borderColor: '#E9EFF6', boxShadow: '0 1px 4px rgba(15,23,42,0.06)' }}>
                <h2 className="text-sm font-bold text-slate-800 mb-4">操作</h2>
                {selStatus === 'published' ? (
                  <div className="flex items-center gap-2 text-sm text-emerald-600 font-semibold py-2">
                    <svg style={{ width: 16, height: 16 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" /></svg>
                    已发布
                    <button className="ml-auto text-xs text-slate-400 hover:text-slate-600 border border-slate-200 rounded px-2 py-1" onClick={() => handleStatusChange('returned')} disabled={actionLoading}>撤回</button>
                  </div>
                ) : selStatus === 'returned' ? (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-sm text-red-500 font-semibold">
                      <svg style={{ width: 16, height: 16 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                      已退回修改
                    </div>
                    <button className="w-full py-2.5 rounded-xl text-white text-sm font-bold hover:opacity-90 disabled:opacity-50" style={{ background: 'linear-gradient(135deg,#0369A1,#0EA5E9)' }} onClick={() => handleStatusChange('published')} disabled={actionLoading}>{actionLoading ? '处理中…' : '重新发布'}</button>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <div className="flex gap-3">
                      <button className="cursor-pointer flex-1 py-2.5 rounded-xl text-white text-sm font-bold hover:opacity-90 disabled:opacity-50" style={{ background: 'linear-gradient(135deg,#0369A1,#0EA5E9)' }} onClick={() => handleStatusChange('published')} disabled={actionLoading}>{actionLoading ? '处理中…' : '校对并发布'}</button>
                      <button className="cursor-pointer flex-1 py-2.5 rounded-xl border-2 border-slate-200 text-slate-600 text-sm font-semibold hover:bg-slate-50 disabled:opacity-50" onClick={() => setShowReturnInput(v => !v)} disabled={actionLoading}>退回修改</button>
                    </div>
                    {showReturnInput && (
                      <div className="space-y-2">
                        <textarea className="w-full border border-slate-200 rounded-lg p-2.5 text-xs text-slate-700 focus:outline-none focus:ring-1 focus:ring-blue-300 resize-none" rows={3} placeholder="填写退回原因（可选）" value={returnNote} onChange={e => setReturnNote(e.target.value)} />
                        <div className="flex gap-2 justify-end">
                          <button className="text-xs text-slate-400 hover:text-slate-600 px-3 py-1.5 rounded border border-slate-200" onClick={() => { setShowReturnInput(false); setReturnNote('') }}>取消</button>
                          <button className="text-xs text-white px-3 py-1.5 rounded font-semibold" style={{ background: '#EF4444' }} onClick={() => handleStatusChange('returned')} disabled={actionLoading}>确认退回</button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        <div className="bg-white rounded-2xl border p-5" style={{ borderColor: '#E9EFF6', boxShadow: '0 1px 4px rgba(15,23,42,0.06)' }}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-bold text-slate-800">会议记录列表</h2>
            <span className="text-xs text-slate-400">共 {filtered.length} 条</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b" style={{ borderColor: '#E9EFF6' }}>
                  {['会议名称', '类型', '日期', '关联专项', '纪要状态', '操作'].map(h => (
                    <th key={h} className="text-left text-slate-400 font-semibold pb-2.5 pr-4">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(m => {
                  const st = getStatus(m); const sc = STATUS_CONFIG[st]
                  const isSel = selected?.id === m.id
                  return (
                    <tr key={m.id} className="cursor-pointer border-b hover:bg-slate-50 transition-colors" style={{ borderColor: '#F8FAFC', background: isSel ? '#EFF6FF' : 'white' }}>
                      <td className="py-3 pr-4 font-semibold text-slate-700">{m.title ?? '-'}</td>
                      <td className="py-3 pr-4"><span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-semibold ${TYPE_STYLE[typeLabel(m.meeting_type)] ?? 'bg-slate-100 text-slate-600'}`}>{typeLabel(m.meeting_type)}</span></td>
                      <td className="py-3 pr-4 text-slate-500">{m.meeting_date ?? '-'}</td>
                      <td className="py-3 pr-4 text-slate-500">{m.related_special_project ?? '-'}</td>
                      <td className="py-3 pr-4"><span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${sc.cls}`}>{sc.label}</span></td>
                      <td className="py-3">
                        <div className="flex items-center gap-2">
                          <button className="text-blue-500 hover:text-blue-700 font-medium" onClick={() => { setSelected(m); setShowReturnInput(false) }}>查看</button>
                          <span className="text-slate-200">|</span>
                          <button className="text-slate-400 hover:text-slate-600 font-medium">编辑</button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
                {filtered.length === 0 && !loading && (
                  <tr><td colSpan={6} className="py-12 text-center text-slate-400">暂无会议记录，点击「新建会议纪要」开始</td></tr>
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
      </main>

      {showNewModal && currentProjectId && (
        <NewMeetingModal projectId={currentProjectId} onClose={() => setShowNewModal(false)} onCreated={handleCreated} />
      )}
    </div>
  )
}

function renderJsonList(json: string, dotColor: string) {
  try {
    const items = JSON.parse(json)
    if (!Array.isArray(items) || !items.length) return null
    return <>{items.map((t: unknown, i: number) => (
      <div key={i} className="flex items-start gap-2 text-xs text-slate-600 mb-1">
        <span className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0" style={{ background: dotColor }} />
        {typeof t === 'string' ? t : typeof t === 'object' && t !== null ? Object.values(t).filter(Boolean).join(' · ') : JSON.stringify(t)}
      </div>
    ))}</>
  } catch { return null }
}

function MeetingSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="py-4 border-b border-slate-50">
      <div className="flex items-center gap-2 mb-2.5">
        <div className="w-0.5 h-3.5 rounded-full" style={{ background: '#0369A1' }} />
        <h3 className="text-xs font-bold text-slate-800">{title}</h3>
      </div>
      {children}
    </div>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 mb-1.5 text-xs">
      <span className="w-16 flex-shrink-0 text-slate-500 font-semibold">{label}</span>
      <span className="text-slate-800">{value}</span>
    </div>
  )
}
