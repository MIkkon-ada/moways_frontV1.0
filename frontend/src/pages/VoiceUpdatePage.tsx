import { useEffect, useMemo, useRef, useState } from 'react'
import { createUpdate, deleteUpdate, extractOnly, fetchUpdates, fetchVoiceContext, getUpdate } from '../api/updates'
import { createDrafts } from '../api/subtaskDrafts'
import type { ProposedSubTask } from '../api/subtaskDrafts'
import type { KeyTaskIssue, TaskReport, UpdateDetail, UpdateHistoryItem, UserSubtaskContext } from '../api/updates'
import { apiGet, apiUpload } from '../api/client'
import { fetchSubTasks } from '../api/subtasks'
import { fetchTasks } from '../api/tasks'
import type { SubTaskItem, TaskItem } from '../types'
import { useProject } from '../context/ProjectContext'
import { fmtFull, fmtShort } from '../utils/time'
import * as SS from '../domain/submissionStatus'
import { buildVoiceUpdateHumanResult, formatIssueItems } from '../domain/voiceUpdateFlow'

const DRAFT_KEY = 'bw_voice_draft'

type AvailableProvider = { provider: string; display_name: string; model: string }
type InputMode = 'voice' | 'upload' | 'text'

// Web Speech API 类型声明
declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognition
    webkitSpeechRecognition?: new () => SpeechRecognition
  }
}

export function VoiceUpdatePage() {
  const { currentProjectId, currentUser, projects } = useProject()
  const [mode, setMode] = useState<InputMode>('text')
  const [text, setText] = useState('')
  const [interimText] = useState('')   // 保留兼容，MediaRecorder 模式不用
  const [phase, setPhase] = useState<'input' | 'extracting' | 'extracted' | 'submitting' | 'submitted'>('input')
  const [result, setResult] = useState<Record<string, unknown> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [providers, setProviders] = useState<AvailableProvider[]>([])
  const [selectedProvider, setSelectedProvider] = useState<string>('deepseek')
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null)
  const [submittedAt, setSubmittedAt] = useState<string>('')
  const [editValues, setEditValues] = useState<Record<string, unknown> | null>(null)
  const [editingField, setEditingField] = useState<string | null>(null)
  const [history, setHistory] = useState<UpdateHistoryItem[]>([])
  const [detailItem, setDetailItem] = useState<UpdateDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [showTranscript, setShowTranscript] = useState(false)
  const [draftSaved, setDraftSaved] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadFileName, setUploadFileName] = useState('')

  const [proposedSubtasks, setProposedSubtasks] = useState<ProposedSubTask[]>([])
  const [taskReports, setTaskReports] = useState<TaskReport[]>([])
  const [keyTaskIssues, setKeyTaskIssues] = useState<KeyTaskIssue[]>([])
  const [projectTasksForSuggest, setProjectTasksForSuggest] = useState<TaskItem[]>([])
  const [voiceSubtasksContext, setVoiceSubtasksContext] = useState<UserSubtaskContext[]>([])
  // Per-card attribution edit state (report index → card edit)
  type CardEdit = { taskId: number | null; subtaskId: number | null; subtasks: SubTaskItem[]; editorOpen: boolean; modified: boolean }
  const [cardEdits, setCardEdits] = useState<Record<number, CardEdit>>({})

  function updateCardEdit(idx: number, patch: Partial<CardEdit>) {
    setCardEdits(prev => {
      const cur = prev[idx] ?? { taskId: null, subtaskId: null, subtasks: [], editorOpen: false, modified: false }
      return { ...prev, [idx]: { ...cur, ...patch } }
    })
  }

  const [recording, setRecording] = useState(false)
  const [transcribing, setTranscribing] = useState(false)  // 转写中
  const [timer, setTimer] = useState(0)
  const timerRef = useRef<number | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const finalTextRef = useRef('')
  const submitLock = useRef(false)
  const uploadInputRef = useRef<HTMLInputElement>(null)

  type TimelineNode = { icon: string; iconBg: string; title: string; time?: string; sub?: string; active?: boolean; done?: boolean }

  const timelineNodes = useMemo((): TimelineNode[] => {
    if (!detailItem) return []
    const ai = detailItem.ai_result ?? {}
    const confPct = (() => {
      const c = detailItem.confidence ?? (ai.confidence as number | undefined) ?? 0
      return c < 1 ? Math.round((c as number) * 100) : Math.round(c as number)
    })()
    const fmt = (s?: string) => fmtFull(s) !== '-' ? fmtFull(s) : undefined
    const nodes: TimelineNode[] = [
      {
        icon: '📝', iconBg: '#EFF6FF',
        title: '提交进展',
        time: fmt(detailItem.created_at),
        sub: `通过${detailItem.source_type}提交`,
        done: true,
      },
      {
        icon: '🤖', iconBg: '#F5F3FF',
        title: 'AI提取完成',
        time: fmt(detailItem.created_at),
        sub: confPct > 0
          ? `置信度 ${confPct}% · 专项：${String(ai.special_project ?? '—')}`
          : `专项：${String(ai.special_project ?? '—')}`,
        done: true,
      },
    ]
    const st = SS.normalize(detailItem.confirm_status)
    if (st === SS.S_NEW || SS.PENDING_OWNER_REVIEW.has(st)) {
      nodes.push({ icon: '⏳', iconBg: '#FFF7ED', title: '等待负责人审核', sub: '已进入待确认队列', active: true })
    } else if (SS.CONFIRMED_AND_STORED.has(st)) {
      nodes.push({
        icon: '✅', iconBg: '#F0FDF4', title: '负责人确认写入',
        time: fmt(detailItem.confirmed_at),
        sub: detailItem.confirmed_by ? `由 ${detailItem.confirmed_by} 确认，已写入工作推进表` : '已写入工作推进表',
        done: true,
      })
    } else if (SS.RETURNED_TO_SUBMITTER.has(st)) {
      nodes.push({
        icon: '↩️', iconBg: '#FEF2F2', title: '退回修改',
        time: fmt(detailItem.updated_at),
        sub: detailItem.reject_reason ? `原因：${detailItem.reject_reason}` : '需要重新提交',
        done: true,
      })
    } else if (SS.WAITING_COORDINATOR_FEEDBACK.has(st)) {
      nodes.push({
        icon: '↗️', iconBg: '#F5F3FF', title: '转交统筹人处理',
        time: fmt(detailItem.updated_at),
        sub: detailItem.coordinator_note || '已转交统筹人',
        done: true,
      })
    } else if (SS.WAITING_CEO_DECISION.has(st)) {
      nodes.push({
        icon: '🔺', iconBg: '#EFF6FF', title: '上报CEO决策',
        time: fmt(detailItem.updated_at),
        sub: detailItem.ceo_note || '等待CEO决策',
        active: true,
      })
    }
    return nodes
  }, [detailItem])

  useEffect(() => {
    apiGet<AvailableProvider[]>('/api/llm-config/available')
      .then(setProviders)
      .catch(() => setProviders([]))
    try {
      const saved = localStorage.getItem(DRAFT_KEY)
      if (saved) {
        const d = JSON.parse(saved)
        if (d.text) setText(d.text)
        // "rules" 不再作为合法选项，忽略该草稿值
      if (d.provider && d.provider !== 'rules') setSelectedProvider(d.provider)
      }
    } catch { /* ignore */ }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
      mediaRecorderRef.current?.stop()
    }
  }, [])

  useEffect(() => {
    if (currentProjectId && !selectedProjectId) setSelectedProjectId(currentProjectId)
    if (!currentProjectId) return
    let cancelled = false
    fetchUpdates(currentProjectId)
      .then((rows) => { if (!cancelled) setHistory(rows.slice(0, 20)) })
      .catch(() => { if (!cancelled) setError('历史记录加载失败，请刷新重试') })
    return () => { cancelled = true }
  }, [currentProjectId])

  useEffect(() => {
    const pid = selectedProjectId ?? currentProjectId
    if (!pid) return
    fetchTasks(pid).then(setProjectTasksForSuggest).catch(() => setProjectTasksForSuggest([]))
  }, [selectedProjectId, currentProjectId])

  function formatTime(s: number) {
    const m = Math.floor(s / 60)
    const sec = s % 60
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  }

  function resetExtractionState(options: { clearText?: boolean } = {}) {
    setPhase('input')
    if (options.clearText) setText('')
    setResult(null)
    setEditValues(null)
    setEditingField(null)
    setProposedSubtasks([])
    setTaskReports([])
    setKeyTaskIssues([])
    setCardEdits({})
  }

  async function startRecording() {
    setError(null)
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      setError('麦克风权限被拒绝，请在浏览器地址栏左侧点击锁形图标允许麦克风访问')
      return
    }

    audioChunksRef.current = []
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus' : 'audio/webm'

    const mr = new MediaRecorder(stream, { mimeType })
    mr.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data) }
    mr.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop())
      const rawBlob = new Blob(audioChunksRef.current, { type: mimeType })
      setTranscribing(true)
      setError(null)
      try {
        // 转换为 WAV（Dashscope 原生支持）
        const wavBlob = await encodeToWav(rawBlob)
        const fd = new FormData()
        fd.append('file', wavBlob, 'recording.wav')
        const res = await apiUpload<{ text: string }>('/api/transcribe', fd)
        if (res.text && res.text.trim()) {
          setText((prev) => prev ? prev + '\n' + res.text : res.text)
        } else {
          setError('未识别到语音内容，请确认麦克风正常并重新录制')
        }
      } catch (e: unknown) {
        setError(e instanceof Error ? e.message : '转写失败，请检查 Dashscope API Key 是否配置')
      } finally {
        setTranscribing(false)
      }
    }

    mr.start(200)  // 每 200ms 收集一次数据
    mediaRecorderRef.current = mr
    setRecording(true)
    setTimer(0)
    timerRef.current = window.setInterval(() => setTimer((t) => t + 1), 1000)
  }

  function stopRecording() {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    mediaRecorderRef.current?.stop()
    mediaRecorderRef.current = null
    setRecording(false)
  }

  async function handleUploadFile(file: File) {
    setUploading(true)
    setError(null)
    setUploadFileName(file.name)
    try {
      const fd = new FormData()
      fd.append('file', file)
      const res = await apiUpload<{ text: string }>('/api/transcribe', fd)
      setText((prev) => (prev ? prev + '\n' + res.text : res.text))
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '转写失败，请重试')
    } finally {
      setUploading(false)
    }
  }

  // 第一步：纯AI提取，不写数据库
  async function handleExtract() {
    if (submitLock.current) return
    submitLock.current = true
    const content = text.trim()
    if (!content) { submitLock.current = false; setError('请输入或录制内容'); return }
    const projectId = selectedProjectId ?? currentProjectId
    if (!projectId) { submitLock.current = false; setError('请先选择本次更新所属项目'); return }
    setPhase('extracting')
    setError(null)
    setResult(null)

    // 拉取当前用户有权提交进展的子任务候选池（权限敏感：普通成员只看自己的任务）
    let userSubtasks: UserSubtaskContext[] = []
    try {
      const contextSubs = await fetchVoiceContext(projectId)
      // 原文中明确提到标题的子任务排在前面，优先进入LLM候选窗口
      const mentioned = contextSubs.filter(s => content.includes(s.title))
      const rest = contextSubs.filter(s => !content.includes(s.title))
      userSubtasks = [...mentioned, ...rest].slice(0, 60)
      setVoiceSubtasksContext(userSubtasks)
    } catch { /* 获取失败不影响提取 */ }

    try {
      const res = await extractOnly({
        project_id: projectId,
        source_type: mode === 'voice' ? '语音更新' : '文字更新',
        transcript_text: content,
        submitter: currentUser?.name,
        llm_provider: selectedProvider,
        user_subtasks: userSubtasks,
      })
      const suggestion = res.suggestion ?? {}
      setResult(suggestion)
      setEditValues({ ...suggestion })
      setEditingField(null)
      const rawProposed = (suggestion.proposed_subtasks as ProposedSubTask[] | undefined) ?? []
      setProposedSubtasks(rawProposed.filter(s => s.title?.trim()))
      const nextTaskReports = (suggestion.task_reports as TaskReport[] | undefined) ?? []
      setTaskReports(nextTaskReports)
      const initEdits: Record<number, CardEdit> = {}
      nextTaskReports.forEach((r, idx) => {
        if (r.type === 'progress' && r.matched_subtask_id) {
          const sub = userSubtasks.find(s => s.id === r.matched_subtask_id)
          initEdits[idx] = { taskId: sub?.parent_task_id ?? null, subtaskId: r.matched_subtask_id, subtasks: [], editorOpen: false, modified: false }
        }
      })
      setCardEdits(initEdits)
      setKeyTaskIssues((suggestion.key_task_issues as KeyTaskIssue[] | undefined) ?? [])
      setPhase('extracted')
    } catch (e: any) {
      setError(e?.message ?? 'AI提取失败，请重试')
      setPhase('input')
    } finally {
      submitLock.current = false
    }
  }

  // 第二步：用户确认后正式提交给负责人（写数据库，状态=待确认）
  async function handleSubmitFinal() {
    if (submitLock.current) return
    submitLock.current = true
    const projectId = selectedProjectId ?? currentProjectId
    if (!projectId || !currentUser) { submitLock.current = false; setError('请先选择关联专项'); return }

    // 提交前校验：归属已修改但子任务层级未选完（仅 progress 类型需选到子任务）
    const hasIncompleteOwnership = taskReports.some((r, i) => {
      const e = cardEdits[i]
      return r.type === 'progress' && e?.modified && e.taskId && !e.subtaskId
    })
    if (hasIncompleteOwnership) {
      setError('归属不完整：已修改的任务卡请完整选择关键任务和子任务')
      submitLock.current = false
      return
    }

    // 提交前校验：所有 suggest_new_subtask 项必须已选择归属关键任务
    const missingSuggest = taskReports.some((r, i) => {
      if ((r as Record<string, unknown>).type !== 'suggest_new_subtask') return false
      const hasParent = !!(r as Record<string, unknown>).parent_task_id
      return !hasParent && !(cardEdits[i]?.modified && cardEdits[i].taskId)
    })
    if (missingSuggest) {
      setError('请先为建议新增子任务选择归属关键任务')
      submitLock.current = false
      return
    }

    // 将提交人的归属选择注入 task_reports（每张卡独立）
    const patchedTaskReports = taskReports.map((r, i) => {
      const e = cardEdits[i]
      if (!e?.modified) return r
      if (r.type === 'progress') {
        const selectedSub = e.subtaskId ? e.subtasks.find(s => s.id === e.subtaskId) : null
        const selectedTask = e.taskId ? projectTasksForSuggest.find(t => t.id === e.taskId) : null
        if (selectedSub) {
          return {
            ...r,
            matched_subtask_id: selectedSub.id,
            matched_subtask_title: selectedSub.title,
            parent_task_id: selectedTask?.id ?? null,
            parent_key_task: selectedTask?.key_task ?? '',
          }
        }
        return r
      }
      if ((r as Record<string, unknown>).type === 'suggest_new_subtask') {
        const selectedTask = e.taskId ? projectTasksForSuggest.find(t => t.id === e.taskId) : null
        return {
          ...r,
          parent_task_id: selectedTask?.id ?? (r as Record<string, unknown>).parent_task_id ?? null,
          parent_key_task: selectedTask?.key_task ?? (r as Record<string, unknown>).parent_key_task ?? '',
        }
      }
      return r
    })

    const selectedProject = projects.find((p) => p.id === projectId)
    const content = text.trim()
    setPhase('submitting')
    setError(null)
    try {
      // 把第一步已提取的 AI 结果随 human_result 一起发送，后端检测到 pipeline=llm_extract 时跳过重复 LLM 调用
      const mergedHumanResult = buildVoiceUpdateHumanResult({
        result,
        editValues,
        selectedProjectId: projectId,
        selectedProjectName: selectedProject?.name ?? '',
        taskReports: patchedTaskReports,
        keyTaskIssues,
      })
      const { submission } = await createUpdate({
        project_id: projectId,
        source_type: mode === 'voice' ? '语音更新' : '文字更新',
        transcript_text: content,
        submitter: currentUser.name,
        human_result: mergedHumanResult,
      })
      // 从 task_reports 里的 new_task 条目创建草稿子任务
      const newTaskReports = taskReports.filter(r => r.type === 'new_task') as Extract<TaskReport, { type: 'new_task' }>[]
      const draftItems = [
        ...newTaskReports.map(r => ({
          title: r.title,
          assignee: r.assignee || currentUser.name,
          plan_time: r.plan_start && r.plan_end ? `${r.plan_start}~${r.plan_end}` : r.plan_start || '',
          parent_task_id: null as number | null,
        })),
        ...proposedSubtasks.map(s => ({
          title: s.title,
          assignee: s.assignee || currentUser.name,
          plan_time: s.plan_time || '',
          parent_task_id: null as number | null,
        })),
      ].filter(d => d.title.trim())
      if (draftItems.length > 0) {
        createDrafts({
          project_id: projectId,
          source_submission_id: submission?.id ?? null,
          drafts: draftItems,
        }).catch(() => {})
      }
      setPhase('submitted')
      setSubmittedAt(new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(/\//g, '-'))
      localStorage.removeItem(DRAFT_KEY)
      const pid = selectedProjectId ?? currentProjectId
      if (pid) fetchUpdates(pid).then((rows) => setHistory(rows.slice(0, 20))).catch(() => {})
    } catch (e: any) {
      setError(e?.message ?? '提交失败，请重试')
      setPhase('extracted')
    } finally {
      submitLock.current = false
    }
  }

  const suggestion = result as Record<string, unknown> | null

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <header className="h-16 flex items-center px-6 gap-4 flex-shrink-0 bg-white border-b" style={{ borderColor: '#E9EFF6' }}>
        <div className="flex-1">
          <h1 className="text-base font-bold text-slate-800">语音更新</h1>
          <p className="text-xs text-slate-400 mt-0.5">通过录音、上传音频或粘贴文字，快速生成项目进度更新建议</p>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto p-5" style={{ background: '#F1F5F9' }}>
        <div className="grid gap-5 min-h-full" style={{ gridTemplateColumns: '360px minmax(0, 1fr)' }}>

          {/* Left: Input */}
          <div className="flex flex-col gap-4">
            {/* Mode tabs */}
            <div className="bg-white rounded-2xl border p-1.5 flex gap-1" style={{ borderColor: '#E9EFF6', boxShadow: '0 1px 4px rgba(15,23,42,0.06)' }}>
              {([
                { key: 'voice', label: '录音输入', icon: '🎙️' },
                { key: 'upload', label: '上传音频', icon: '📤' },
                { key: 'text', label: '粘贴文字', icon: '📝' },
              ] as { key: InputMode; label: string; icon: string }[]).map(({ key, label, icon }) => (
                <button
                  key={key}
                  onClick={() => setMode(key)}
                  className="flex-1 py-2 rounded-lg text-sm font-semibold transition-all"
                  style={{
                    background: mode === key ? '#0369A1' : 'transparent',
                    color: mode === key ? 'white' : '#64748B',
                    boxShadow: mode === key ? '0 2px 8px rgba(3,105,161,0.3)' : 'none',
                  }}
                >
                  {icon} {label}
                </button>
              ))}
            </div>

            {/* Model selector */}
            <div className="bg-white rounded-2xl border p-4" style={{ borderColor: '#E9EFF6', boxShadow: '0 1px 4px rgba(15,23,42,0.06)' }}>
              <label className="block text-xs font-bold text-slate-500 mb-2">提取模型</label>
              <select
                value={selectedProvider}
                onChange={(e) => setSelectedProvider(e.target.value)}
                className="w-full text-sm border border-slate-200 rounded-xl px-3 py-2 bg-white text-slate-700 cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-400/30"
                disabled={phase === 'extracting'}
              >
                {providers.map((p) => (
                  <option key={p.provider} value={p.provider}>
                    {p.display_name} ({p.model})
                  </option>
                ))}
              </select>
            </div>

            {/* Input card */}
            <div className="bg-white rounded-2xl border p-5 flex flex-col items-center" style={{ borderColor: '#E9EFF6', boxShadow: '0 1px 4px rgba(15,23,42,0.06)' }}>
              <div className="w-full flex items-center justify-between mb-3">
                <h3 className="text-sm font-bold text-slate-700">本次更新内容</h3>
                <span className="text-xs text-slate-400">提交前可编辑</span>
              </div>
              {mode === 'voice' && (
                <div className="w-full flex flex-col items-center">
                  {transcribing && (
                    <div className="w-full mb-4 px-3 py-2 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-700 flex items-center gap-2">
                      <svg className="animate-spin" style={{ width: 14, height: 14 }} fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/></svg>
                      正在转写录音，请稍候…
                    </div>
                  )}
                  {recording && (
                    <div className="flex items-center gap-2 mb-4">
                      <span className="w-2 h-2 rounded-full bg-red-500 flex-shrink-0" style={{ animation: 'pulse 1.5s infinite' }}></span>
                      <span className="text-sm font-semibold text-red-500">正在识别…</span>
                    </div>
                  )}
                  <div className="text-5xl font-bold text-slate-800 tracking-tighter mb-4">{formatTime(timer)}</div>

                  {recording && (
                    <div className="flex items-end gap-1 h-8 mb-4">
                      {Array.from({ length: 24 }, (_, i) => (
                        <div key={i} className="w-0.5 rounded-full bg-sky-400"
                          style={{ height: `${6 + Math.sin(i * 0.8) * 10 + 8}px`, animation: `wave ${0.8 + i * 0.05}s ease-in-out infinite` }}
                        />
                      ))}
                    </div>
                  )}

                  <button
                    onClick={recording ? stopRecording : startRecording}
                    disabled={transcribing}
                    className="w-16 h-16 rounded-full flex items-center justify-center text-white cursor-pointer mb-4 disabled:opacity-40"
                    style={{ background: recording ? '#DC2626' : '#0369A1', boxShadow: recording ? '0 0 0 8px rgba(220,38,38,0.15)' : undefined }}
                  >
                    {recording ? (
                      <svg style={{ width: 24, height: 24 }} fill="currentColor" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
                    ) : (
                      <svg style={{ width: 24, height: 24 }} fill="currentColor" viewBox="0 0 24 24"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" /><path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" /></svg>
                    )}
                  </button>

                  {/* 转写结果预览区 */}
                  <div className="w-full min-h-16 border border-slate-100 rounded-xl p-3 bg-slate-50 text-sm text-slate-700 leading-relaxed">
                    {recording
                      ? <span className="text-slate-400 italic">录音中，停止后将自动转写…</span>
                      : text || <span className="text-slate-300">点击录音按钮开始，停止后自动转为文字</span>
                    }
                  </div>
                  {text && !recording && (
                    <button className="mt-2 text-xs text-slate-400 hover:text-red-500" onClick={() => { setText(''); finalTextRef.current = '' }}>清除</button>
                  )}
                </div>
              )}

              {mode === 'text' && (
                <div className="w-full">
                  <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder="请粘贴或输入本次进展内容，AI将自动提取关键信息…"
                    className="w-full border border-slate-200 rounded-xl p-3 text-sm focus:outline-none focus:ring-2 resize-none"
                    style={{ height: 200 }}
                    maxLength={5000}
                  />
                  <div className="text-right text-xs text-slate-400 mt-1">{text.length}/5000</div>
                </div>
              )}

              {mode === 'upload' && (
                <div className="w-full">
                  <input
                    ref={uploadInputRef}
                    type="file"
                    accept="audio/*,.mp3,.wav,.m4a,.flac,.aac,.ogg,.wma,.amr,.webm,.mp4"
                    className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) handleUploadFile(f) }}
                  />
                  <div
                    className="w-full flex flex-col items-center justify-center border-2 border-dashed rounded-xl cursor-pointer hover:border-blue-400 transition-colors"
                    style={{ height: 140, borderColor: uploading ? '#3B82F6' : '#E2E8F0' }}
                    onClick={() => !uploading && uploadInputRef.current?.click()}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) handleUploadFile(f) }}
                  >
                    {uploading ? (
                      <>
                        <svg className="animate-spin" style={{ width: 32, height: 32, color: '#3B82F6' }} fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                        <p className="text-sm text-blue-500 font-medium mt-2">正在转写「{uploadFileName}」…</p>
                        <p className="text-xs text-slate-400 mt-1">Dashscope Paraformer 识别中，请稍候</p>
                      </>
                    ) : (
                      <>
                        <svg style={{ width: 36, height: 36, color: '#94A3B8' }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" /></svg>
                        <p className="text-sm text-slate-500 font-medium mt-2">点击或拖拽上传音频文件</p>
                        <p className="text-xs text-slate-400 mt-1">支持 MP3、WAV、M4A 等，转写由阿里云完成</p>
                      </>
                    )}
                  </div>
                  {text && (
                    <>
                      <textarea
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        placeholder="转写结果将显示在这里，可手动编辑…"
                        className="w-full mt-3 border border-slate-200 rounded-xl p-3 text-sm focus:outline-none focus:ring-2 resize-none"
                        style={{ height: 120 }}
                        maxLength={5000}
                      />
                      <div className="text-right text-xs text-slate-400 mt-1">{text.length}/5000</div>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Guide questions */}
            <div className="bg-white rounded-2xl border p-4" style={{ borderColor: '#E9EFF6', boxShadow: '0 1px 4px rgba(15,23,42,0.06)' }}>
              <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">请围绕以下问题进行说明</h3>
              <div className="space-y-2.5">
                {['本周完成了什么？', '形成了什么成果？', '当前有什么问题？', '下周做什么，需要协调谁？'].map((q, i) => (
                  <div key={i} className="flex items-start gap-3">
                    <span className="w-5 h-5 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0" style={{ background: '#0369A1' }}>{i + 1}</span>
                    <span className="text-sm text-slate-700">{q}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Right: AI result */}
          <div className="flex flex-col gap-4 min-w-0">

            {/* AI result card */}
            <div className="bg-white rounded-2xl border flex-1 flex flex-col overflow-hidden" style={{ borderColor: '#E9EFF6', boxShadow: '0 1px 4px rgba(15,23,42,0.06)' }}>

              {/* Header */}
              <div className="flex items-center justify-between px-5 py-3.5 border-b flex-shrink-0" style={{ borderColor: '#E9EFF6' }}>
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-md flex items-center justify-center" style={{ background: 'linear-gradient(135deg,#6366F1,#0EA5E9)' }}>
                    <svg style={{ width: 12, height: 12, color: 'white' }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>
                  </div>
                  <h2 className="text-sm font-bold text-slate-800">AI 提取结果预览</h2>
                </div>
                {result && (
                  <div className="flex items-center gap-2 text-xs text-slate-400">
                    {phase === 'submitted' ? (
                      <span className="px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-semibold">已提交，等待负责人确认</span>
                    ) : (
                      <>
                        <span className="px-2 py-0.5 rounded-full bg-blue-100 text-blue-700 font-semibold">步骤2/2：确认并提交</span>
                        <span className="text-slate-200">|</span>
                        <button
                          onClick={() => setEditingField(editingField ? null : 'all')}
                          className="flex items-center gap-0.5 text-blue-500 hover:text-blue-700 font-medium"
                        >
                          <svg style={{ width: 11, height: 11 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>
                          {editingField ? '完成编辑' : '编辑全部'}
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>

              {/* Body */}
              <div className="flex-1 overflow-y-auto p-5">

                {/* Empty state */}
                {!result && !error && phase !== 'extracting' && (
                  <div className="flex flex-col items-center justify-center h-full text-slate-400">
                    <svg style={{ width: 48, height: 48, marginBottom: 12 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>
                    <p className="text-sm font-medium">步骤 1/2：输入内容后点击"AI提取"</p>
                    <p className="text-xs mt-1">AI 提取完成后，再确认提交给负责人</p>
                  </div>
                )}
                {phase === 'extracting' && !result && (
                  <div className="flex flex-col items-center justify-center h-full text-slate-400">
                    <svg className="animate-spin" style={{ width: 40, height: 40, marginBottom: 12, color: '#0369A1' }} fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/></svg>
                    <p className="text-sm font-medium text-blue-600">AI 正在分析提取中…</p>
                  </div>
                )}

                {/* Error */}
                {error && (
                  <div className="flex items-center gap-2 p-3 rounded-lg" style={{ background: '#FEF2F2', border: '1px solid #FECACA' }}>
                    <svg style={{ width: 14, height: 14, color: '#DC2626' }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    <span className="text-xs text-red-700 font-medium">{error}</span>
                  </div>
                )}

                {/* Result */}
                {editValues && (() => {
                  const s = editValues

                  function setField(key: string, val: unknown) {
                    setEditValues((prev) => prev ? { ...prev, [key]: val } : prev)
                  }

                  function arrToText(v: unknown): string {
                    if (!Array.isArray(v)) return String(v ?? '')
                    return v.map((item) => {
                      if (typeof item === 'object' && item !== null) {
                        const o = item as Record<string, unknown>
                        return String(o.name ?? o.description ?? '')
                      }
                      return String(item)
                    }).filter(Boolean).join('\n')
                  }

                  const isEditing = (field: string) => editingField === field || editingField === 'all'

                  function EditIcon({ field }: { field: string }) {
                    const active = isEditing(field)
                    return (
                      <button
                        onClick={() => setEditingField(active && editingField !== 'all' ? null : field)}
                        className="p-1 rounded hover:bg-slate-100 transition-colors flex-shrink-0"
                        title="编辑"
                      >
                        <svg style={{ width: 13, height: 13, color: active ? '#0369A1' : '#CBD5E1' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </button>
                    )
                  }

                  const confidence = typeof s.confidence === 'number' ? s.confidence : 0
                  const confPct = confidence < 1 ? Math.round(confidence * 100) : Math.round(confidence as number)
                  const confColor = confPct >= 80 ? '#059669' : confPct >= 60 ? '#D97706' : '#DC2626'
                  const confLabel = confPct >= 80 ? '可信度高' : confPct >= 60 ? '可信度中' : '可信度低'

                  const STATUS_DOT: Record<string, string> = { '进行中': '#3B82F6', '已完成': '#10B981', '延期': '#EF4444', '暂缓': '#F59E0B', '未开始': '#94A3B8' }
                  const statusColor = STATUS_DOT[s.status_suggestion as string] ?? '#94A3B8'

                  function arrNames(v: unknown): string[] {
                    if (!Array.isArray(v) || v.length === 0) return []
                    return v.map((item) => {
                      if (typeof item === 'object' && item !== null) {
                        const o = item as Record<string, unknown>
                        return String(o.name ?? o.description ?? '')
                      }
                      return String(item)
                    }).filter(Boolean)
                  }

                  const COORD_CHIP_COLORS = ['#EFF6FF:#1D4ED8', '#F5F3FF:#5B21B6', '#F0FDF4:#065F46', '#FFF7ED:#92400E']
                  const selectedProjectName = projects.find((p) => p.id === selectedProjectId)?.name || String(s.special_project ?? '未选择专项')

                  return (
                    <div>
                      {/* Warning / status */}
                      {phase === 'submitted' ? (
                        <div className="flex items-center gap-2 p-3 rounded-lg mb-4" style={{ background: '#F0FDF4', border: '1px solid #BBF7D0' }}>
                          <svg style={{ width: 13, height: 13, color: '#059669', flexShrink: 0 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                          <span className="text-xs text-emerald-700 font-medium">已提交给负责人，等待审核确认写入</span>
                        </div>
                      ) : null}

                      {/* Task Reports – 进展确认卡片 */}
                      {taskReports.length > 0 && (
                        <div className="mb-4 space-y-3">
                          {taskReports.length > 1 && (
                            <div className="flex items-center gap-2">
                              <div className="w-1 h-3.5 rounded-full" style={{ background: '#4338CA' }} />
                              <span className="text-xs font-bold text-indigo-700">AI 任务解析</span>
                              <span className="text-xs text-slate-400">· 共 {taskReports.length} 项</span>
                            </div>
                          )}
                          {taskReports.map((r, i) => {
                            const isSuggest = r.type === 'suggest_new_subtask'
                            const isNew = !isSuggest && r.type === 'new_task'
                            const matched = !isSuggest && !isNew && !!(r as Extract<TaskReport, {type:'progress'}>).matched_subtask_id
                            const statusUpdate = (!isSuggest && !isNew) ? (r as Extract<TaskReport, {type:'progress'}>).status_update : null
                            const STATUS_STYLE: Record<string, {bg:string;color:string}> = {
                              '已完成': {bg:'#D1FAE5', color:'#065F46'},
                              '延期':   {bg:'#FEE2E2', color:'#991B1B'},
                              '进行中': {bg:'#DBEAFE', color:'#1E40AF'},
                              '暂缓':   {bg:'#FEF3C7', color:'#92400E'},
                            }
                            const sStyle = statusUpdate ? (STATUS_STYLE[statusUpdate] ?? {bg:'#F1F5F9', color:'#475569'}) : null
                            const title = isSuggest
                              ? (r as Extract<TaskReport, {type:'suggest_new_subtask'}>).title
                              : isNew
                                ? (r as Extract<TaskReport, {type:'new_task'}>).title
                                : (r as Extract<TaskReport, {type:'progress'}>).matched_subtask_title || '未匹配子任务'
                            const completed = r.completed
                            const achs = r.achievements ?? []
                            const issues = formatIssueItems(r.subtask_issues ?? [])
                            const nexts = r.next_steps ?? []
                            const e = cardEdits[i] ?? { taskId: null, subtaskId: null, subtasks: [] as SubTaskItem[], editorOpen: false, modified: false }
                            const aiParentKeyTask = r.type === 'progress'
                              ? ((r as Extract<TaskReport, {type:'progress'}>).parent_key_task
                                  || voiceSubtasksContext.find(s => s.id === (r as Extract<TaskReport, {type:'progress'}>).matched_subtask_id)?.parent_key_task
                                  || '')
                              : ((r as Record<string,unknown>).parent_key_task as string | undefined) || ''
                            const dispKeyTask = (e.modified && e.taskId)
                              ? (projectTasksForSuggest.find(t => t.id === e.taskId)?.key_task ?? '未关联关键任务')
                              : aiParentKeyTask || '未关联关键任务'
                            const aiSubtaskName = r.type === 'progress'
                              ? ((r as Extract<TaskReport, {type:'progress'}>).matched_subtask_title || '')
                              : ((r as Record<string,unknown>).title as string | undefined) || ''
                            const dispSubtask = (e.modified && e.subtaskId)
                              ? (e.subtasks.find(s => s.id === e.subtaskId)?.title ?? '未关联子任务')
                              : aiSubtaskName || (isSuggest ? '待新增子任务' : '未关联子任务')
                            const needsParent = isSuggest && !((r as Record<string,unknown>).parent_task_id) && !(e.modified && e.taskId)
                            const borderColor = isSuggest ? (needsParent ? '#FCD34D' : '#86EFAC') : isNew ? '#DDD6FE' : matched ? '#BFDBFE' : '#E2E8F0'
                            const headerBg = isSuggest ? '#FFFBEB' : isNew ? '#F5F3FF' : matched ? '#EFF6FF' : '#F8FAFC'
                            return (
                              <div key={i} className="rounded-2xl overflow-hidden" style={{ border: `1px solid ${borderColor}` }}>
                                {/* 卡片标题行：子任务名 + 状态 */}
                                <div className="flex items-center gap-2 px-4 py-3" style={{ background: headerBg }}>
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 flex-wrap">
                                      {isSuggest && <span className="text-[10px] px-1.5 py-px rounded font-bold flex-shrink-0" style={{ background: '#FEF3C7', color: '#92400E' }}>建议新增</span>}
                                      {isNew && <span className="text-[10px] px-1.5 py-px rounded font-bold flex-shrink-0" style={{ background: '#EDE9FE', color: '#5B21B6' }}>新任务</span>}
                                      {!isSuggest && !isNew && matched && <span className="text-[10px] font-bold text-blue-400 flex-shrink-0">✓</span>}
                                      {!isSuggest && !isNew && !matched && <span className="text-[10px] text-slate-400 flex-shrink-0">?</span>}
                                      <span className="text-sm font-bold text-slate-800 leading-snug">{title}</span>
                                    </div>
                                    {isNew && (
                                      <p className="text-xs text-violet-500 mt-0.5">{(r as Extract<TaskReport, {type:'new_task'}>).plan_start} ~ {(r as Extract<TaskReport, {type:'new_task'}>).plan_end}</p>
                                    )}
                                  </div>
                                  {sStyle && statusUpdate && (
                                    <span className="flex-shrink-0 text-xs px-2 py-1 rounded-full font-semibold" style={sStyle}>{statusUpdate}</span>
                                  )}
                                </div>
                                {/* 归属面包屑 + 编辑器（每张卡独立） */}
                                <div style={{ borderTop: `1px solid ${isSuggest ? '#FEF3C7' : '#E9EFF6'}` }}>
                                  <div className="flex items-center gap-1.5 px-3 py-1.5 flex-wrap" style={{ background: isSuggest ? '#FFFBEB' : '#F8FBFF' }}>
                                    <span className="text-[10px] font-semibold text-slate-400">归属</span>
                                    <span className="text-[10px] text-slate-300">·</span>
                                    <span className={`text-[10px] font-semibold ${dispKeyTask === '未关联关键任务' ? 'text-amber-500 italic' : 'text-slate-500'}`}>{dispKeyTask}</span>
                                    {!isSuggest && (
                                      <>
                                        <span className="text-[10px] text-slate-300">›</span>
                                        <span className={`text-[10px] font-semibold ${dispSubtask === '未关联子任务' ? 'text-amber-500 italic' : 'text-slate-500'}`}>{dispSubtask}</span>
                                      </>
                                    )}
                                    {needsParent && !e.editorOpen && <span className="text-[10px] text-amber-600 font-bold ml-0.5">⚠️需选择</span>}
                                    <button
                                      type="button"
                                      onClick={async () => {
                                        const newOpen = !e.editorOpen
                                        updateCardEdit(i, { editorOpen: newOpen })
                                        if (newOpen && e.taskId && e.subtasks.length === 0 && !isSuggest) {
                                          const subs = await fetchSubTasks(e.taskId).catch(() => [] as SubTaskItem[])
                                          updateCardEdit(i, { subtasks: (subs as SubTaskItem[]).filter(s => !s.is_deleted) })
                                        }
                                      }}
                                      className="ml-auto text-[11px] font-semibold hover:opacity-70 flex-shrink-0"
                                      style={{ color: e.editorOpen ? '#64748B' : '#2563EB' }}
                                    >
                                      {e.editorOpen ? '收起' : '修改归属'}
                                    </button>
                                  </div>
                                  {needsParent && (
                                    <div className="px-3 py-2" style={{ background: '#FFFBEB', borderTop: '1px solid #FEF3C7' }}>
                                      <p className="text-[11px] font-semibold text-amber-700">负责人确认前必须选择归属关键任务</p>
                                    </div>
                                  )}
                                  {e.editorOpen && (
                                    <div className="px-3 pb-2.5 pt-1.5 space-y-1.5" style={{ background: '#EFF6FF', borderTop: '1px solid #BFDBFE' }}>
                                      <select
                                        value={e.taskId ?? ''}
                                        onChange={async (ev) => {
                                          const taskId = ev.target.value ? Number(ev.target.value) : null
                                          updateCardEdit(i, { taskId, subtaskId: null, subtasks: [], modified: true })
                                          if (taskId && !isSuggest) {
                                            const subs = await fetchSubTasks(taskId).catch(() => [] as SubTaskItem[])
                                            updateCardEdit(i, { taskId, subtasks: (subs as SubTaskItem[]).filter(s => !s.is_deleted), modified: true })
                                          }
                                        }}
                                        className="w-full text-xs border border-slate-200 rounded-lg px-2 py-1.5 bg-white cursor-pointer focus:outline-none"
                                      >
                                        <option value="">选择关键任务</option>
                                        {projectTasksForSuggest.map((t) => <option key={t.id} value={t.id}>{t.key_task}</option>)}
                                      </select>
                                      {!isSuggest && (
                                        <select
                                          value={e.subtaskId ?? ''}
                                          disabled={!e.taskId}
                                          onChange={(ev) => updateCardEdit(i, { subtaskId: ev.target.value ? Number(ev.target.value) : null, modified: true })}
                                          className="w-full text-xs border border-slate-200 rounded-lg px-2 py-1.5 bg-white cursor-pointer focus:outline-none disabled:opacity-50"
                                        >
                                          <option value="">选择子任务</option>
                                          {e.subtasks.map((sub) => <option key={sub.id} value={sub.id}>{sub.title}</option>)}
                                        </select>
                                      )}
                                      {e.modified && !isSuggest && e.taskId && !e.subtaskId && (
                                        <p className="text-[11px] text-amber-600 font-semibold">⚠️ 请继续选择子任务</p>
                                      )}
                                    </div>
                                  )}
                                </div>
                                {/* 卡片正文 */}
                                <div className="bg-white">
                                  {isSuggest ? (
                                    <>
                                      {/* 建议内容 */}
                                      <div className="px-4 py-3" style={{ borderTop: '1px solid #FEF3C7' }}>
                                        <p className="text-[11px] font-semibold mb-1" style={{ color: '#92400E' }}>建议内容</p>
                                        {completed
                                          ? <p className="text-sm text-slate-700 leading-relaxed">{String(completed)}</p>
                                          : <p className="text-xs text-slate-300 italic">未提及</p>
                                        }
                                      </div>
                                      {/* 建议原因 */}
                                      {issues.length > 0 && (
                                        <div className="px-4 py-3" style={{ borderTop: '1px solid #FEF3C7', background: '#FFFBEB' }}>
                                          <p className="text-[11px] font-semibold mb-1.5" style={{ color: '#92400E' }}>建议原因</p>
                                          <ul className="space-y-1">
                                            {issues.map((iss, ii) => (
                                              <li key={ii} className="text-xs leading-relaxed flex items-start gap-1.5 text-amber-800">
                                                <span className="flex-shrink-0 mt-0.5">·</span>
                                                <span>{iss}</span>
                                              </li>
                                            ))}
                                          </ul>
                                        </div>
                                      )}
                                      {/* 下一步 */}
                                      <div className="px-4 py-3" style={{ borderTop: '1px solid #FEF3C7' }}>
                                        <p className="text-[11px] font-semibold mb-1" style={{ color: '#92400E' }}>下一步</p>
                                        {nexts.length > 0
                                          ? <ul className="space-y-0.5">{nexts.map((n, ni) => (
                                              <li key={ni} className="text-xs text-slate-700 leading-relaxed flex items-start gap-1.5">
                                                <span className="flex-shrink-0 text-amber-300 mt-0.5">·</span>
                                                <span>{String(n)}</span>
                                              </li>
                                            ))}</ul>
                                          : <p className="text-xs text-slate-300 italic">未提及</p>
                                        }
                                      </div>
                                    </>
                                  ) : (
                                    <>
                                      {/* 本次完成 */}
                                      <div className="px-4 py-3" style={{ borderTop: '1px solid #F1F5F9' }}>
                                        <p className="text-[11px] font-semibold text-slate-400 mb-1">本次完成</p>
                                        {completed
                                          ? <p className="text-sm text-slate-700 leading-relaxed">{String(completed)}</p>
                                          : <p className="text-xs text-slate-300 italic">未提及</p>
                                        }
                                      </div>
                                      {/* 成果文件（有时才显示） */}
                                      {achs.length > 0 && (
                                        <div className="px-4 py-3 space-y-2" style={{ borderTop: '1px solid #F1F5F9' }}>
                                          <p className="text-[11px] font-semibold text-slate-400">成果文件</p>
                                          {achs.map((ach, ai) => (
                                            <div key={ai} className="flex items-center gap-2">
                                              <span className="text-xs text-slate-600 flex-shrink-0 max-w-[120px] truncate" title={ach.name}>{ach.name}</span>
                                              <input
                                                type="text"
                                                value={ach.file_link ?? ''}
                                                onChange={(e) => {
                                                  const val = e.target.value
                                                  setTaskReports((prev) => prev.map((rep, ri) => {
                                                    if (ri !== i) return rep
                                                    const newAchs = (rep.achievements ?? []).map((a, xi) =>
                                                      xi === ai ? { ...a, file_link: val } : a
                                                    )
                                                    return { ...rep, achievements: newAchs }
                                                  }))
                                                }}
                                                placeholder="存储地址（飞书/腾讯文档链接，可选）"
                                                className="flex-1 text-xs border border-slate-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-400/30"
                                              />
                                            </div>
                                          ))}
                                        </div>
                                      )}
                                      {/* 问题/风险（有时才显示，红色高亮） */}
                                      {issues.length > 0 && (
                                        <div className="px-4 py-3" style={{ borderTop: '1px solid #FEE2E2', background: '#FFF8F8' }}>
                                          <p className="text-[11px] font-semibold mb-1.5" style={{ color: '#B91C1C' }}>问题 / 风险</p>
                                          <ul className="space-y-1">
                                            {issues.map((iss, ii) => (
                                              <li key={ii} className="text-xs leading-relaxed flex items-start gap-1.5" style={{ color: '#DC2626' }}>
                                                <span className="flex-shrink-0 mt-0.5">·</span>
                                                <span>{iss}</span>
                                              </li>
                                            ))}
                                          </ul>
                                        </div>
                                      )}
                                      {/* 下一步计划 */}
                                      <div className="px-4 py-3" style={{ borderTop: '1px solid #F1F5F9' }}>
                                        <p className="text-[11px] font-semibold text-slate-400 mb-1">下一步计划</p>
                                        {nexts.length > 0
                                          ? <ul className="space-y-0.5">{nexts.map((n, ni) => (
                                              <li key={ni} className="text-xs text-slate-700 leading-relaxed flex items-start gap-1.5">
                                                <span className="flex-shrink-0 text-slate-300 mt-0.5">·</span>
                                                <span>{String(n)}</span>
                                              </li>
                                            ))}</ul>
                                          : <p className="text-xs text-slate-300 italic">未提及</p>
                                        }
                                      </div>
                                    </>
                                  )}
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}

                      {/* Key-task level issues */}
                      {keyTaskIssues.length > 0 && (
                        <div className="mb-4 rounded-2xl overflow-hidden" style={{ border: '1px solid #FED7AA' }}>
                          <div className="flex items-center gap-2 px-4 py-2.5" style={{ background: '#FFF7ED' }}>
                            <span className="text-xs">⚠️</span>
                            <span className="text-xs font-bold text-amber-700">需处理事项</span>
                            <span className="ml-auto text-xs text-amber-400">{keyTaskIssues.length} 条</span>
                          </div>
                          <div className="divide-y bg-white">
                            {keyTaskIssues.map((issue, i) => {
                              const PRIORITY_COLOR: Record<string, string> = { '高': '#DC2626', '中': '#D97706', '低': '#64748B' }
                              const TYPE_BG: Record<string, {bg:string;color:string}> = {
                                '需决策': {bg:'#EFF6FF', color:'#1D4ED8'},
                                '决策': {bg:'#EFF6FF', color:'#1D4ED8'},
                                '待协调': {bg:'#F5F3FF', color:'#5B21B6'},
                                '风险': {bg:'#FEF2F2', color:'#DC2626'},
                                '问题': {bg:'#FFF7ED', color:'#D97706'},
                              }
                              const ts = TYPE_BG[issue.issue_type] ?? {bg:'#F1F5F9', color:'#475569'}
                              const pColor = PRIORITY_COLOR[issue.priority] ?? '#64748B'
                              const meta = [
                                issue.key_task_title,
                                issue.need_coordination?.length > 0 ? `需协调：${issue.need_coordination.join('、')}` : '',
                              ].filter(Boolean).join(' · ')
                              return (
                                <div key={i} className="px-4 py-2.5 flex items-start gap-2.5">
                                  <span className="flex-shrink-0 text-xs px-2 py-0.5 rounded-full font-semibold" style={ts}>{issue.issue_type}</span>
                                  <div className="flex-1 min-w-0">
                                    <p className="text-sm text-slate-800 leading-snug">{issue.description}</p>
                                    {meta && <p className="text-xs text-slate-400 mt-0.5">{meta}</p>}
                                  </div>
                                  {issue.priority && (
                                    <span className="flex-shrink-0 text-xs font-semibold rounded px-1.5 py-0.5" style={{ background: `${pColor}18`, color: pColor }}>{issue.priority}</span>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        </div>
                      )}

                      {/* Field rows */}
                      <div className="space-y-0">

                        {/* 平铺字段：仅在无 task_reports（规则引擎降级）时显示 */}
                        {taskReports.length === 0 && <>

                        {/* 完成事项 */}
                        <div className="flex items-start py-3 border-b" style={{ borderColor: '#F1F5F9' }}>
                          <span className="w-16 flex-shrink-0 text-xs font-semibold text-slate-400 pt-0.5">完成事项</span>
                          {isEditing('completed_items') ? (
                            <textarea autoFocus rows={3} className="flex-1 text-sm border border-blue-300 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-400/30 resize-none"
                              defaultValue={arrToText(s.completed_items)}
                              onBlur={(e) => { setField('completed_items', e.target.value.split('\n').filter(Boolean)); setEditingField(null) }} />
                          ) : (
                            <span className="flex-1 text-sm text-slate-700 leading-relaxed">{arrNames(s.completed_items).join('、') || '—'}</span>
                          )}
                          <EditIcon field="completed_items" />
                        </div>

                        {/* 成果 */}
                        <div className="flex items-start py-3 border-b" style={{ borderColor: '#F1F5F9' }}>
                          <span className="w-16 flex-shrink-0 text-xs font-semibold text-slate-400 pt-0.5">成果</span>
                          {isEditing('achievements') ? (
                            <textarea autoFocus rows={3} className="flex-1 text-sm border border-blue-300 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-400/30 resize-none"
                              defaultValue={arrToText(s.achievements)}
                              onBlur={(e) => { setField('achievements', e.target.value.split('\n').filter(Boolean).map((name) => ({ name }))); setEditingField(null) }} />
                          ) : (
                            <span className="flex-1 text-sm font-semibold leading-relaxed" style={{ color: '#059669' }}>
                              {arrNames(s.achievements).length > 0 ? `↑ ${arrNames(s.achievements).join('、')}` : '—'}
                            </span>
                          )}
                          <EditIcon field="achievements" />
                        </div>

                        {/* 成果链接（有成果时展示） */}
                        {arrNames(s.achievements).length > 0 && (
                          <div className="flex items-start py-3 border-b" style={{ borderColor: '#F1F5F9' }}>
                            <span className="w-16 flex-shrink-0 text-xs font-semibold text-slate-400 pt-0.5">成果链接</span>
                            <div className="flex-1 space-y-1.5">
                              {(s.achievements as Record<string, unknown>[]).map((ach, i) => {
                                const achName = String(ach.name || `成果${i + 1}`)
                                return (
                                  <div key={i} className="space-y-1">
                                    <span className="text-xs font-medium text-slate-600">{achName}</span>
                                    <input
                                      type="url"
                                      value={String(ach.file_link || '')}
                                      onChange={(e) => {
                                        const updated = [...(s.achievements as Record<string, unknown>[])]
                                        updated[i] = { ...updated[i], file_link: e.target.value }
                                        setField('achievements', updated)
                                      }}
                                      placeholder="粘贴文件链接（飞书、腾讯文档等，可选）"
                                      className="w-full text-xs border border-slate-200 rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-blue-400/30"
                                    />
                                  </div>
                                )
                              })}
                              <p className="text-xs text-slate-400">有链接负责人入库时可直接关联，无则留空</p>
                            </div>
                          </div>
                        )}

                        {/* 问题 */}
                        <div className="flex items-start py-3 border-b" style={{ borderColor: '#F1F5F9' }}>
                          <span className="w-16 flex-shrink-0 text-xs font-semibold text-slate-400 pt-0.5">问题</span>
                          {isEditing('issues') ? (
                            <textarea autoFocus rows={3} className="flex-1 text-sm border border-blue-300 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-400/30 resize-none"
                              defaultValue={arrToText(s.issues)}
                              onBlur={(e) => { setField('issues', e.target.value.split('\n').filter(Boolean).map((desc) => ({ issue_type: '问题', description: desc, owner: '', priority: '中', status: '待处理' }))); setEditingField(null) }} />
                          ) : (
                            <span className="flex-1 text-sm leading-relaxed" style={{ color: arrNames(s.issues).length > 0 ? '#DC2626' : '#94A3B8' }}>
                              {arrNames(s.issues).join('、') || '—'}
                            </span>
                          )}
                          <EditIcon field="issues" />
                        </div>

                        {/* 下周计划 */}
                        <div className="flex items-start py-3 border-b" style={{ borderColor: '#F1F5F9' }}>
                          <span className="w-16 flex-shrink-0 text-xs font-semibold text-slate-400 pt-0.5">下周计划</span>
                          {isEditing('next_steps') ? (
                            <textarea autoFocus rows={3} className="flex-1 text-sm border border-blue-300 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-400/30 resize-none"
                              defaultValue={arrToText(s.next_steps)}
                              onBlur={(e) => { setField('next_steps', e.target.value.split('\n').filter(Boolean)); setEditingField(null) }} />
                          ) : (
                            <span className="flex-1 text-sm text-slate-700 leading-relaxed">{arrNames(s.next_steps).join('、') || '—'}</span>
                          )}
                          <EditIcon field="next_steps" />
                        </div>

                        {/* 草稿子任务 */}
                        {proposedSubtasks.length > 0 && (
                          <div className="py-3 border-b" style={{ borderColor: '#F1F5F9' }}>
                            <div className="flex items-center gap-2 mb-2">
                              <div className="w-1 h-3.5 rounded-full" style={{ background: '#6366F1' }} />
                              <span className="text-xs font-semibold text-indigo-600">下周草稿子任务</span>
                              <span className="text-xs text-slate-400">提交后发给负责人审批，通过后自动创建</span>
                            </div>
                            <div className="space-y-2">
                              {proposedSubtasks.map((ps, i) => (
                                <div key={i} className="flex items-center gap-2 p-2.5 rounded-xl" style={{ background: '#F5F3FF', border: '1px solid #DDD6FE' }}>
                                  <div className="flex-1 min-w-0 space-y-1">
                                    <input
                                      className="w-full text-xs border border-indigo-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-300 bg-white"
                                      value={ps.title}
                                      onChange={e => setProposedSubtasks(prev => prev.map((x, j) => j === i ? { ...x, title: e.target.value } : x))}
                                      placeholder="任务说明"
                                    />
                                    <div className="flex gap-1.5">
                                      <input
                                        className="flex-1 text-xs border border-indigo-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-300 bg-white"
                                        value={ps.assignee}
                                        onChange={e => setProposedSubtasks(prev => prev.map((x, j) => j === i ? { ...x, assignee: e.target.value } : x))}
                                        placeholder="执行人"
                                      />
                                      <input
                                        className="flex-1 text-xs border border-indigo-200 rounded-lg px-2 py-1 focus:outline-none focus:ring-1 focus:ring-indigo-300 bg-white"
                                        value={ps.plan_time}
                                        onChange={e => setProposedSubtasks(prev => prev.map((x, j) => j === i ? { ...x, plan_time: e.target.value } : x))}
                                        placeholder="计划时间（可选）"
                                      />
                                    </div>
                                  </div>
                                  <button onClick={() => setProposedSubtasks(prev => prev.filter((_, j) => j !== i))} className="flex-shrink-0 p-1 rounded hover:bg-red-100 text-slate-300 hover:text-red-400">
                                    <svg style={{ width: 13, height: 13 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
                                  </button>
                                </div>
                              ))}
                              <button
                                onClick={() => setProposedSubtasks(prev => [...prev, { title: '', assignee: currentUser?.name ?? '', plan_time: '' }])}
                                className="text-xs text-indigo-500 hover:text-indigo-700 font-semibold"
                              >
                                + 手动添加
                              </button>
                            </div>
                          </div>
                        )}

                        {/* 需协调 */}
                        <div className="flex items-start py-3 border-b" style={{ borderColor: '#F1F5F9' }}>
                          <span className="w-16 flex-shrink-0 text-xs font-semibold text-slate-400 pt-0.5">需协调人</span>
                          {isEditing('need_coordination') ? (
                            <input autoFocus type="text" className="flex-1 text-sm border border-blue-300 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-400/30"
                              defaultValue={(s.need_coordination as string[] ?? []).join('、')}
                              onBlur={(e) => { setField('need_coordination', e.target.value.split(/[,，、]/).map((v) => v.trim()).filter(Boolean)); setEditingField(null) }}
                              placeholder="用、分隔多人" />
                          ) : (
                            <div className="flex-1 flex flex-wrap gap-1.5">
                              {(s.need_coordination as string[] ?? []).length > 0
                                ? (s.need_coordination as string[]).map((item, i) => {
                                    const [bg, color] = COORD_CHIP_COLORS[i % COORD_CHIP_COLORS.length].split(':')
                                    return (
                                      <span key={i} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold" style={{ background: bg, color }}>
                                        <span className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />{item}
                                      </span>
                                    )
                                  })
                                : <span className="text-sm text-slate-300">—</span>
                              }
                            </div>
                          )}
                          <EditIcon field="need_coordination" />
                        </div>

                        {/* 状态建议 */}
                        <div className="flex items-center py-3 border-b" style={{ borderColor: '#F1F5F9' }}>
                          <span className="w-16 flex-shrink-0 text-xs font-semibold text-slate-400">状态建议</span>
                          {isEditing('status_suggestion') ? (
                            <select autoFocus className="flex-1 text-sm border border-blue-300 rounded-lg px-2 py-1 bg-white focus:outline-none focus:ring-2 focus:ring-blue-400/30"
                              value={s.status_suggestion as string ?? '进行中'}
                              onChange={(e) => setField('status_suggestion', e.target.value)}
                              onBlur={() => setEditingField(null)}>
                              {['未开始', '进行中', '已完成', '延期', '暂缓'].map((v) => <option key={v}>{v}</option>)}
                            </select>
                          ) : (
                            <div className="flex-1 flex items-center gap-2">
                              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: statusColor }} />
                              <span className="text-sm font-semibold" style={{ color: statusColor }}>{s.status_suggestion as string}</span>
                              <span className="text-xs text-slate-400">（建议保持当前计划）</span>
                            </div>
                          )}
                          <EditIcon field="status_suggestion" />
                        </div>

                        {/* 置信度 */}
                        {confidence > 0 && (
                          <div className="flex items-center py-3">
                            <span className="w-16 flex-shrink-0 text-xs font-semibold text-slate-400">置信度</span>
                            <div className="flex-1 flex items-center gap-3">
                              <span className="text-2xl font-bold" style={{ color: confColor }}>{confPct}%</span>
                              <div className="flex-1 h-2 rounded-full bg-slate-100 overflow-hidden">
                                <div className="h-full rounded-full transition-all" style={{ width: `${confPct}%`, background: confColor }} />
                              </div>
                              <span className="text-xs text-slate-400 flex-shrink-0">{confLabel}</span>
                            </div>
                          </div>
                        )}

                        </>}
                      </div>
                    </div>
                  )
                })()}
              </div>
            </div>

            {/* Submit panel */}
            <div className="bg-white rounded-2xl border p-5 flex-shrink-0" style={{ borderColor: '#E9EFF6', boxShadow: '0 1px 4px rgba(15,23,42,0.06)' }}>
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-bold text-slate-700">关联与确认</h3>
                  <span className="text-xs text-slate-400">{phase === 'input' || phase === 'extracting' ? '步骤 1/2' : phase === 'extracted' || phase === 'submitting' ? '步骤 2/2' : ''}</span>
                </div>
                <div className="flex items-center gap-1.5 text-xs" style={{ color: '#D97706' }}>
                  <svg style={{ width: 12, height: 12 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                  <span className="font-medium">AI 提取后需确认，再提交给负责人审核</span>
                </div>
              </div>

              {phase === 'submitted' ? (
                /* 提交成功状态 */
                <div className="space-y-3">
                  <div className="flex items-center gap-2 p-3 rounded-xl" style={{ background: '#F0FDF4', border: '1px solid #BBF7D0' }}>
                    <svg style={{ width: 16, height: 16, color: '#059669' }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    <div>
                      <p className="text-sm text-emerald-700 font-semibold">已提交，等待负责人确认</p>
                      <p className="text-xs text-emerald-600 mt-0.5">提交时间：{submittedAt}</p>
                    </div>
                  </div>
                  <button
                    onClick={() => resetExtractionState({ clearText: true })}
                    className="cursor-pointer w-full py-2.5 rounded-xl border-2 text-sm font-semibold transition-all hover:bg-slate-50"
                    style={{ borderColor: '#E2E8F0', color: '#475569' }}
                  >
                    继续提交新进展
                  </button>
                </div>
              ) : (
                <>
                  <div className="mb-4 flex items-center gap-2">
                    <span className="text-xs font-semibold text-slate-400">提交人</span>
                    <span className="text-sm font-semibold text-slate-700">{currentUser?.name ?? '—'}</span>
                  </div>

                  {/* 步骤1按钮：保存草稿 + AI提取 */}
                  {(phase === 'input' || phase === 'extracting') && (
                    <div className="flex items-center gap-3">
                      <button
                        className="cursor-pointer flex-1 py-2.5 rounded-xl border-2 text-sm font-semibold transition-all"
                        style={{ borderColor: draftSaved ? '#34D399' : '#E2E8F0', color: draftSaved ? '#059669' : '#475569', background: draftSaved ? '#F0FDF4' : 'white' }}
                        onClick={() => {
                          try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ text, provider: selectedProvider })) } catch { /* ignore */ }
                          setDraftSaved(true)
                          setTimeout(() => setDraftSaved(false), 2000)
                        }}
                        disabled={phase === 'extracting'}
                      >
                        {draftSaved ? '✓ 已保存草稿' : '保存草稿'}
                      </button>
                      <button
                        onClick={handleExtract}
                        disabled={phase === 'extracting' || !text.trim()}
                        className="cursor-pointer flex-1 py-2.5 rounded-xl text-white text-sm font-bold transition-all hover:opacity-90 disabled:opacity-50"
                        style={{ background: 'linear-gradient(135deg,#0369A1,#0EA5E9)', boxShadow: '0 2px 8px rgba(3,105,161,0.3)' }}
                      >
                        {phase === 'extracting' ? 'AI提取中…' : 'AI提取'}
                      </button>
                    </div>
                  )}

                  {/* 步骤2按钮：重新提取 + 提交给负责人 */}
                  {(phase === 'extracted' || phase === 'submitting') && (
                    <div className="space-y-2">
                      <p className="text-xs text-slate-400">确认AI提取结果无误后，提交给项目负责人审核</p>
                      <div className="flex items-center gap-3">
                        <button
                          onClick={() => resetExtractionState()}
                          disabled={phase === 'submitting'}
                          className="cursor-pointer flex-1 py-2.5 rounded-xl border-2 text-sm font-semibold transition-all hover:bg-slate-50 disabled:opacity-50"
                          style={{ borderColor: '#E2E8F0', color: '#475569' }}
                        >
                          重新提取
                        </button>
                        {(() => {
                          const hasMissingSuggest = taskReports.some((r, i) => {
                            if ((r as Record<string, unknown>).type !== 'suggest_new_subtask') return false
                            const hasParent = !!(r as Record<string, unknown>).parent_task_id
                            return !hasParent && !(cardEdits[i]?.modified && cardEdits[i].taskId)
                          })
                          return (
                            <button
                              onClick={handleSubmitFinal}
                              disabled={phase === 'submitting' || hasMissingSuggest}
                              title={hasMissingSuggest ? '请先为所有建议新增子任务选择归属关键任务' : undefined}
                              className="cursor-pointer flex-[2] py-2.5 rounded-xl text-white text-sm font-bold transition-all hover:opacity-90 disabled:opacity-50"
                              style={{
                                background: hasMissingSuggest ? '#94A3B8' : 'linear-gradient(135deg,#059669,#0EA5E9)',
                                boxShadow: hasMissingSuggest ? 'none' : '0 2px 8px rgba(5,150,105,0.3)',
                              }}
                            >
                              {phase === 'submitting' ? '提交中…' : hasMissingSuggest ? '请先选择归属关键任务' : '提交给负责人'}
                            </button>
                          )
                        })()}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
            {/* History - 只显示自己的提交 */}
            {(() => {
              const myHistory = history.filter(item => item.submitter === currentUser?.name)
              const STATUS_MAP: Record<string, { cls: string; dot: string; label: string }> = {
                [SS.S_NEW]:                 { cls: 'bg-amber-100 text-amber-700',   dot: '#F59E0B', label: '待确认' },
                [SS.S_PENDING_OWNER]:       { cls: 'bg-amber-100 text-amber-700',   dot: '#F59E0B', label: '待审核' },
                [SS.S_CONFIRMED]:           { cls: 'bg-emerald-100 text-emerald-700', dot: '#10B981', label: '已入库' },
                [SS.S_RETURNED]:            { cls: 'bg-red-100 text-red-700',       dot: '#EF4444', label: '已退回' },
                [SS.S_WAITING_COORDINATOR]: { cls: 'bg-purple-100 text-purple-700', dot: '#8B5CF6', label: '已转交统筹' },
                [SS.S_COORDINATOR_GIVEN]:   { cls: 'bg-purple-100 text-purple-700', dot: '#8B5CF6', label: '统筹已反馈' },
                [SS.S_WAITING_CEO]:         { cls: 'bg-blue-100 text-blue-700',     dot: '#3B82F6', label: '待CEO决策' },
                [SS.S_CEO_DECIDED]:         { cls: 'bg-blue-100 text-blue-700',     dot: '#3B82F6', label: 'CEO已批示' },
                [SS.S_WITHDRAWN]:           { cls: 'bg-slate-100 text-slate-500',   dot: '#94A3B8', label: '已撤回' },
                [SS.S_NEEDS_REVISION]:      { cls: 'bg-orange-100 text-orange-700', dot: '#F97316', label: '需修改' },
              }
              return (
                <div className="bg-white rounded-2xl border flex-shrink-0" style={{ borderColor: '#E9EFF6', boxShadow: '0 1px 4px rgba(15,23,42,0.06)' }}>
                  <div className="flex items-center justify-between px-5 py-3 border-b" style={{ borderColor: '#E9EFF6' }}>
                    <h3 className="text-sm font-bold text-slate-700">我的提交记录</h3>
                    <span className="text-xs text-slate-400">{myHistory.length} 条 · 点击查看流转状态</span>
                  </div>
                  {myHistory.length === 0 ? (
                    <div className="py-6 text-center text-xs text-slate-400">暂无提交记录</div>
                  ) : (
                    <div className="overflow-y-auto" style={{ maxHeight: 240 }}>
                      {myHistory.slice(0, 8).map((item) => {
                        const st = STATUS_MAP[SS.normalize(item.confirm_status)] ?? { cls: 'bg-slate-100 text-slate-500', dot: '#94A3B8', label: item.confirm_status || '-' }
                        const summary = (() => {
                          try { return JSON.parse(item.ai_result_json || '{}').summary || item.transcript_text } catch { return item.transcript_text }
                        })()
                        const time = fmtShort(item.created_at)
                        return (
                          <div
                            key={item.id}
                            className="flex items-center gap-3 px-5 py-2.5 border-b last:border-b-0 hover:bg-sky-50 transition-colors group cursor-pointer"
                            style={{ borderColor: '#F8FAFC' }}
                            onClick={async () => {
                              setShowTranscript(false)
                              setDetailItem(null)
                              setDetailLoading(true)
                              try {
                                const detail = await getUpdate(item.id)
                                setDetailItem(detail)
                              } catch { /* ignore */ } finally { setDetailLoading(false) }
                            }}
                          >
                            {/* 状态指示点 */}
                            <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: st.dot }} />
                            <div className="flex-1 min-w-0">
                              <p className="text-xs text-slate-700 truncate">{summary || '—'}</p>
                              <p className="text-xs text-slate-400 mt-0.5">{item.source_type} · {time}</p>
                            </div>
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold flex-shrink-0 ${st.cls}`}>
                              {st.label}
                            </span>
                            <svg className="opacity-0 group-hover:opacity-60 flex-shrink-0" style={{ width: 12, height: 12, color: '#64748B' }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" /></svg>
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })()}

            {/* 流转侧面板 */}
            {(detailItem || detailLoading) && (
              <div
                className="fixed inset-0 z-50"
                style={{ background: 'rgba(15,23,42,0.3)' }}
                onClick={() => { setDetailItem(null); setDetailLoading(false) }}
              >
                <div
                  className="absolute right-0 top-0 h-full bg-white overflow-y-auto flex flex-col"
                  style={{ width: 400, boxShadow: '-4px 0 24px rgba(15,23,42,0.12)' }}
                  onClick={(e) => e.stopPropagation()}
                >
                  {/* Panel header */}
                  <div className="flex items-center justify-between px-5 py-4 border-b flex-shrink-0" style={{ borderColor: '#E9EFF6' }}>
                    <div>
                      <h3 className="text-sm font-bold text-slate-800">任务流转记录</h3>
                      {detailItem && (
                        <p className="text-xs text-slate-400 mt-0.5">
                          {detailItem.source_type} · {fmtFull(detailItem.created_at)}
                        </p>
                      )}
                    </div>
                    <button
                      className="w-7 h-7 rounded-lg flex items-center justify-center hover:bg-slate-100 text-slate-400 cursor-pointer"
                      onClick={() => { setDetailItem(null); setDetailLoading(false) }}
                    >
                      <svg style={{ width: 14, height: 14 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
                    </button>
                  </div>

                  {detailLoading ? (
                    <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">加载中…</div>
                  ) : detailItem ? (
                    <div className="flex-1 p-5 space-y-3 overflow-y-auto">
                      {/* Timeline */}
                      <div className="relative">
                        {timelineNodes.map((node, idx) => (
                          <div key={idx} className="flex gap-3">
                            <div className="flex flex-col items-center flex-shrink-0" style={{ width: 36 }}>
                              <div
                                className="w-9 h-9 rounded-xl flex items-center justify-center text-base flex-shrink-0"
                                style={{
                                  background: node.iconBg,
                                  border: node.active ? '2px solid #F59E0B' : '2px solid #E9EFF6',
                                  opacity: node.done || node.active ? 1 : 0.4,
                                }}
                              >
                                {node.icon}
                              </div>
                              {idx < timelineNodes.length - 1 && (
                                <div className="w-0.5 my-1" style={{ background: '#E9EFF6', minHeight: 20 }} />
                              )}
                            </div>
                            <div className="flex-1 pb-4">
                              <div className="flex items-center gap-2 mb-0.5">
                                <span className="text-xs font-bold text-slate-800">{node.title}</span>
                                {node.active && (
                                  <span className="text-xs px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-600 font-semibold">进行中</span>
                                )}
                              </div>
                              {node.time && <p className="text-xs text-slate-400 mb-0.5">{node.time}</p>}
                              {node.sub && <p className="text-xs text-slate-500 leading-relaxed">{node.sub}</p>}
                            </div>
                          </div>
                        ))}
                      </div>

                      {/* AI提取摘要 */}
                      {(detailItem.ai_result?.summary as string | undefined) && (
                        <div className="p-3 rounded-xl" style={{ background: '#EFF6FF', border: '1px solid #BFDBFE' }}>
                          <p className="text-xs font-semibold text-slate-500 mb-1">AI提取摘要</p>
                          <p className="text-xs text-slate-700 leading-relaxed">{detailItem.ai_result?.summary as string}</p>
                        </div>
                      )}

                      {/* 原文折叠 */}
                      <div className="rounded-xl border overflow-hidden" style={{ borderColor: '#E9EFF6' }}>
                        <button
                          className="w-full flex items-center justify-between px-4 py-2.5 text-xs font-semibold text-slate-500 hover:bg-slate-50 cursor-pointer"
                          onClick={() => setShowTranscript((v) => !v)}
                        >
                          <span>原始文本</span>
                          <svg style={{ width: 12, height: 12, transition: 'transform 0.2s', transform: showTranscript ? 'rotate(180deg)' : 'rotate(0deg)' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
                          </svg>
                        </button>
                        {showTranscript && (
                          <div className="px-4 pb-3 text-xs text-slate-600 leading-relaxed" style={{ background: '#F8FAFC', borderTop: '1px solid #E9EFF6', maxHeight: 200, overflowY: 'auto' }}>
                            {detailItem.transcript_text || '—'}
                          </div>
                        )}
                      </div>

                      {/* 退回时可基于原文重新提交 */}
                      {SS.RETURNED_TO_SUBMITTER.has(SS.normalize(detailItem.confirm_status)) && (
                        <div className="p-3 rounded-xl" style={{ background: '#FEF2F2', border: '1px solid #FECACA' }}>
                          <p className="text-xs text-red-700 font-semibold mb-2">该提交已被退回</p>
                          <button
                            className="text-xs text-red-600 underline cursor-pointer"
                            onClick={() => { setText(detailItem.transcript_text || ''); setPhase('input'); setDetailItem(null) }}
                          >
                            基于原文重新编辑提交
                          </button>
                        </div>
                      )}
                    </div>
                  ) : null}
                </div>
              </div>
            )}


          </div>
        </div>
      </main>

      <style>{`
        @keyframes wave {
          0%, 100% { height: 6px; }
          50% { height: 24px; }
        }
      `}</style>
    </div>
  )
}

function FieldRow({ label, icon, value, empty, highlight }: {
  label: string; icon: string; value: string | null; empty: string; highlight?: boolean
}) {
  return (
    <div className="flex items-start gap-3 px-4 py-2.5">
      <span className="w-14 flex-shrink-0 text-xs font-semibold text-slate-400 pt-0.5 flex items-center gap-1">
        <span>{icon}</span><span>{label}</span>
      </span>
      <span className="flex-1 text-xs leading-relaxed" style={{ color: value ? (highlight ? '#DC2626' : '#334155') : '#CBD5E1' }}>
        {value ?? empty}
      </span>
    </div>
  )
}

// ── WebM → WAV 转换（浏览器端，不依赖外部库）──────────────────
async function encodeToWav(blob: Blob): Promise<Blob> {
  const TARGET_RATE = 16000  // 与 Dashscope Paraformer 要求一致

  const arrayBuffer = await blob.arrayBuffer()
  const audioCtx = new AudioContext()
  const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer)
  await audioCtx.close()

  // 用 OfflineAudioContext 重采样到 16000Hz，保证与后端 sample_rate 一致
  const targetLength = Math.ceil(audioBuffer.duration * TARGET_RATE)
  const offlineCtx = new OfflineAudioContext(1, targetLength, TARGET_RATE)
  const source = offlineCtx.createBufferSource()
  source.buffer = audioBuffer
  source.connect(offlineCtx.destination)
  source.start(0)
  const resampled = await offlineCtx.startRendering()

  const pcm = resampled.getChannelData(0)
  const length = pcm.length

  // WAV 文件头 + PCM 数据
  const wavBuf = new ArrayBuffer(44 + length * 2)
  const view = new DataView(wavBuf)
  const writeStr = (off: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)) }

  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + length * 2, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, TARGET_RATE, true)
  view.setUint32(28, TARGET_RATE * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeStr(36, 'data')
  view.setUint32(40, length * 2, true)

  let off = 44
  for (let i = 0; i < length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]))
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    off += 2
  }

  return new Blob([wavBuf], { type: 'audio/wav' })
}
