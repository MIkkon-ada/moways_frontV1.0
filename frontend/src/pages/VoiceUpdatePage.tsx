import { useEffect, useMemo, useRef, useState } from 'react'
import { createUpdate, deleteUpdate, extractOnly, fetchUpdates, getUpdate } from '../api/updates'
import type { UpdateDetail, UpdateHistoryItem } from '../api/updates'
import { apiGet, apiUpload } from '../api/client'
import { useProject } from '../context/ProjectContext'
import { fmtFull, fmtShort } from '../utils/time'
import * as SS from '../domain/submissionStatus'

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
    if (currentProjectId) {
      fetchUpdates(currentProjectId)
        .then((rows) => setHistory(rows.slice(0, 20)))
        .catch(() => {})
    }
  }, [currentProjectId])

  function formatTime(s: number) {
    const m = Math.floor(s / 60)
    const sec = s % 60
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
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
    setPhase('extracting')
    setError(null)
    setResult(null)
    try {
      const res = await extractOnly({
        source_type: mode === 'voice' ? '语音更新' : '文字更新',
        transcript_text: content,
        submitter: currentUser?.name,
        llm_provider: selectedProvider,
      })
      const suggestion = res.suggestion ?? {}
      setResult(suggestion)
      setEditValues({ ...suggestion })
      setEditingField(null)
      setPhase('extracted')
      // special_project 仅作预览展示，不反向驱动项目选择
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
    const content = text.trim()
    setPhase('submitting')
    setError(null)
    try {
      await createUpdate({
        project_id: projectId,
        source_type: mode === 'voice' ? '语音更新' : '文字更新',
        transcript_text: content,
        submitter: currentUser.name,
        llm_provider: selectedProvider,
        human_result: editValues ?? undefined,
      })
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

      <main className="flex-1 overflow-y-auto p-6" style={{ background: '#F1F5F9' }}>
        <div className="grid grid-cols-5 gap-5 min-h-full">

          {/* Left: Input */}
          <div className="col-span-2 flex flex-col gap-5">
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

            {/* Input card */}
            <div className="bg-white rounded-2xl border p-6 flex flex-col items-center" style={{ borderColor: '#E9EFF6', boxShadow: '0 1px 4px rgba(15,23,42,0.06)' }}>
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
                  />
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
                    <textarea
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      placeholder="转写结果将显示在这里，可手动编辑…"
                      className="w-full mt-3 border border-slate-200 rounded-xl p-3 text-sm focus:outline-none focus:ring-2 resize-none"
                      style={{ height: 120 }}
                    />
                  )}
                </div>
              )}
            </div>

            {/* Guide questions */}
            <div className="bg-white rounded-2xl border p-5" style={{ borderColor: '#E9EFF6', boxShadow: '0 1px 4px rgba(15,23,42,0.06)' }}>
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
          <div className="col-span-3 flex flex-col gap-4">

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

                  return (
                    <div>
                      {/* AI 摘要 */}
                      {s.summary ? (
                        <div className="mb-4 p-3.5 rounded-xl" style={{ background: '#EFF6FF', border: '1px solid #BFDBFE' }}>
                          <p className="text-sm text-slate-700 leading-relaxed">{s.summary as string}</p>
                        </div>
                      ) : null}

                      {/* Warning / status */}
                      {phase === 'submitted' ? (
                        <div className="flex items-center gap-2 p-3 rounded-lg mb-4" style={{ background: '#F0FDF4', border: '1px solid #BBF7D0' }}>
                          <svg style={{ width: 13, height: 13, color: '#059669', flexShrink: 0 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                          <span className="text-xs text-emerald-700 font-medium">已提交给负责人，等待审核确认写入</span>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2 p-3 rounded-lg mb-4" style={{ background: '#FFF7ED', border: '1px solid #FED7AA' }}>
                          <svg style={{ width: 13, height: 13, color: '#D97706', flexShrink: 0 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                          <span className="text-xs text-amber-700 font-medium">AI已提取结果，请确认无误后点击"提交给负责人"</span>
                        </div>
                      )}

                      {/* Field rows */}
                      <div className="space-y-0">

                        {/* 专项 */}
                        <div className="flex items-center py-3 border-b" style={{ borderColor: '#F1F5F9' }}>
                          <span className="w-16 flex-shrink-0 text-xs font-semibold text-slate-400">专项</span>
                          {isEditing('special_project') ? (
                            <select autoFocus className="flex-1 text-sm border border-blue-300 rounded-lg px-2 py-1 bg-white focus:outline-none focus:ring-2 focus:ring-blue-400/30"
                              value={s.special_project as string ?? ''}
                              onChange={(e) => setField('special_project', e.target.value)}
                              onBlur={() => setEditingField(null)}>
                              {projects.map((p) => <option key={p.id}>{p.name}</option>)}
                            </select>
                          ) : (
                            <span className="flex-1 text-sm font-semibold" style={{ color: '#0369A1' }}>{s.special_project as string}</span>
                          )}
                          <EditIcon field="special_project" />
                        </div>

                        {/* 关键任务 */}
                        <div className="flex items-center py-3 border-b" style={{ borderColor: '#F1F5F9' }}>
                          <span className="w-16 flex-shrink-0 text-xs font-semibold text-slate-400">任务</span>
                          {isEditing('related_task') ? (
                            <input autoFocus type="text" className="flex-1 text-sm border border-blue-300 rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-blue-400/30"
                              value={s.related_task as string ?? ''}
                              onChange={(e) => setField('related_task', e.target.value)}
                              onBlur={() => setEditingField(null)} />
                          ) : (
                            <span className="flex-1 text-sm text-slate-700">{s.related_task as string || '—'}</span>
                          )}
                          <EditIcon field="related_task" />
                        </div>

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
                    onClick={() => { setPhase('input'); setText(''); setResult(null); setEditValues(null); setEditingField(null) }}
                    className="cursor-pointer w-full py-2.5 rounded-xl border-2 text-sm font-semibold transition-all hover:bg-slate-50"
                    style={{ borderColor: '#E2E8F0', color: '#475569' }}
                  >
                    继续提交新进展
                  </button>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-4 mb-4">
                    <div>
                      <label className="block text-xs font-semibold text-slate-500 mb-1.5">关联专项</label>
                      <select
                        value={selectedProjectId ?? ''}
                        onChange={(e) => setSelectedProjectId(Number(e.target.value))}
                        className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-white text-slate-700 cursor-pointer focus:outline-none"
                        disabled={phase === 'extracting' || phase === 'submitting'}
                      >
                        {projects.map((p) => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-xs font-semibold text-slate-500 mb-1.5">提交人</label>
                      <input type="text" defaultValue={currentUser?.name ?? ''} className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none bg-slate-50 text-slate-500" readOnly />
                    </div>
                  </div>

                  {/* AI引擎选择（仅步骤1显示）*/}
                  {(phase === 'input' || phase === 'extracting') && (
                    <div className="mb-4">
                      <label className="block text-xs font-semibold text-slate-500 mb-1.5">AI 引擎</label>
                      <select
                        value={selectedProvider}
                        onChange={(e) => setSelectedProvider(e.target.value)}
                        className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 bg-white text-slate-700 cursor-pointer focus:outline-none"
                        disabled={phase === 'extracting'}
                      >
                        {providers.map((p) => (
                          <option key={p.provider} value={p.provider}>
                            {p.display_name} ({p.model})
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

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
                          onClick={() => { setPhase('input'); setResult(null); setEditValues(null); setEditingField(null) }}
                          disabled={phase === 'submitting'}
                          className="cursor-pointer flex-1 py-2.5 rounded-xl border-2 text-sm font-semibold transition-all hover:bg-slate-50 disabled:opacity-50"
                          style={{ borderColor: '#E2E8F0', color: '#475569' }}
                        >
                          重新提取
                        </button>
                        <button
                          onClick={handleSubmitFinal}
                          disabled={phase === 'submitting'}
                          className="cursor-pointer flex-[2] py-2.5 rounded-xl text-white text-sm font-bold transition-all hover:opacity-90 disabled:opacity-50"
                          style={{ background: 'linear-gradient(135deg,#059669,#0EA5E9)', boxShadow: '0 2px 8px rgba(5,150,105,0.3)' }}
                        >
                          {phase === 'submitting' ? '提交中…' : '提交给负责人'}
                        </button>
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
