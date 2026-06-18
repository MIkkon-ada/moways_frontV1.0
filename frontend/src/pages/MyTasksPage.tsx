import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useProject } from '../context/ProjectContext'
import { fetchSubtasksByAssignee, patchSubTaskStatus, isPendingConfirmation } from '../api/subtasks'
import type { SubTaskWithParent } from '../api/subtasks'
import { createUpdate } from '../api/updates'
import {
  filterMyTasksByProject,
  getMemberTaskActions,
  groupMyTasks,
  normalizeTaskStatus,
} from '../domain/myTasksFlow'

type QuickModal =
  | { kind: 'progress'; task: SubTaskWithParent; completeAfterSubmit?: boolean }
  | { kind: 'issue'; task: SubTaskWithParent }
  | null

const GROUP_STYLE: Record<string, { color: string; bg: string; dot: string }> = {
  '进行中': { color: '#1E40AF', bg: '#DBEAFE', dot: '#3B82F6' },
  '未开始': { color: '#475569', bg: '#F1F5F9', dot: '#94A3B8' },
  '延期/暂缓': { color: '#B45309', bg: '#FEF3C7', dot: '#F59E0B' },
  '已完成': { color: '#065F46', bg: '#D1FAE5', dot: '#10B981' },
}

const BADGE_STYLE: Record<string, { label: string; bg: string; color: string }> = {
  '未开始': { label: '未开始', bg: '#F1F5F9', color: '#475569' },
  '进行中': { label: '进行中', bg: '#DBEAFE', color: '#1E40AF' },
  '已完成': { label: '已完成', bg: '#D1FAE5', color: '#065F46' },
  '延期': { label: '延期', bg: '#FEE2E2', color: '#991B1B' },
  '暂缓': { label: '暂缓', bg: '#FEF3C7', color: '#92400E' },
}

function badgeFor(status?: string) {
  return BADGE_STYLE[normalizeTaskStatus(status)] ?? BADGE_STYLE['未开始']
}

export function MyTasksPage() {
  const { currentUser, projects } = useProject()
  const [subtasks, setSubtasks] = useState<SubTaskWithParent[]>([])
  const [loading, setLoading] = useState(true)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [updatingId, setUpdatingId] = useState<number | null>(null)
  const [projectFilter, setProjectFilter] = useState<number | null>(null)
  const [modal, setModal] = useState<QuickModal>(null)

  function reload() {
    if (!currentUser?.name) return
    setLoading(true)
    setFetchError(null)
    fetchSubtasksByAssignee(currentUser.name, null)
      .then((data) => setSubtasks(data.filter((s) => !s.is_deleted)))
      .catch((e: unknown) => setFetchError(e instanceof Error ? e.message : '加载失败，请刷新重试'))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    reload()
  }, [currentUser?.name])

  const visibleTasks = useMemo(
    () => filterMyTasksByProject(subtasks, projectFilter),
    [subtasks, projectFilter],
  )
  const grouped = useMemo(() => groupMyTasks(visibleTasks), [visibleTasks])
  const activeGroups = Object.entries(grouped).filter(([, items]) => items.length > 0)

  const total = visibleTasks.length
  const inProgressCount = visibleTasks.filter((s) => normalizeTaskStatus(s.status) === '进行中').length
  const doneCount = visibleTasks.filter((s) => normalizeTaskStatus(s.status) === '已完成').length
  const waitingCount = visibleTasks.filter((s) => normalizeTaskStatus(s.status) === '未开始').length
  const blockedCount = visibleTasks.filter((s) => ['延期', '暂缓'].includes(normalizeTaskStatus(s.status))).length

  async function handleStatusChange(st: SubTaskWithParent, next: string) {
    setUpdatingId(st.id)
    try {
      const updated = await patchSubTaskStatus(st.id, next)
      if (isPendingConfirmation(updated)) { alert('已提交至确认中心，等待项目负责人确认'); return }
      setSubtasks((prev) => prev.map((s) => (s.id === st.id ? { ...s, status: updated.status } : s)))
    } catch (e) {
      alert(e instanceof Error ? e.message : '状态更新失败，请重试')
    } finally {
      setUpdatingId(null)
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden" style={{ background: '#F1F5F9' }}>
      <header className="flex-shrink-0 px-8 pt-7 pb-5 bg-white border-b" style={{ borderColor: '#E9EFF6' }}>
        <div className="flex items-end justify-between gap-6">
          <div>
            <h1 className="text-xl font-bold text-slate-800">我的工作台</h1>
            <p className="text-sm text-slate-400 mt-0.5">
              汇总分配给 <span className="font-semibold text-slate-600">{currentUser?.name}</span> 的全部子任务
            </p>
          </div>
          <div className="flex items-center gap-3">
            <select
              value={projectFilter ?? ''}
              onChange={(e) => setProjectFilter(e.target.value ? Number(e.target.value) : null)}
              className="text-sm border border-slate-200 rounded-xl px-3 py-2 bg-white text-slate-600 focus:outline-none"
            >
              <option value="">全部项目</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <button
              onClick={reload}
              className="px-3 py-2 rounded-xl border border-slate-200 text-sm font-semibold text-slate-600 hover:bg-slate-50"
            >
              刷新
            </button>
          </div>
        </div>
        <div className="grid grid-cols-4 gap-3 mt-5 max-w-2xl">
          <Stat label="待开始" value={waitingCount} color="#64748B" />
          <Stat label="进行中" value={inProgressCount} color="#0369A1" />
          <Stat label="延期/暂缓" value={blockedCount} color="#D97706" />
          <Stat label="已完成" value={doneCount} color="#10B981" />
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-8 py-6">
        {loading ? (
          <div className="flex items-center justify-center py-24">
            <div className="w-6 h-6 rounded-full border-2 border-indigo-400 border-t-transparent animate-spin" />
          </div>
        ) : fetchError ? (
          <EmptyState title={fetchError} />
        ) : total === 0 ? (
          <EmptyState title="暂无分配给你的子任务" subtitle="如果你参与了项目，请让负责人在关键任务下分配子任务。" />
        ) : (
          <div className="space-y-8">
            {activeGroups.map(([label, items]) => (
              <section key={label}>
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-2 h-2 rounded-full" style={{ background: GROUP_STYLE[label].dot }} />
                  <span className="text-sm font-bold" style={{ color: GROUP_STYLE[label].color }}>{label}</span>
                  <span className="ml-1 px-1.5 py-0.5 rounded-full text-xs font-bold" style={{ background: GROUP_STYLE[label].bg, color: GROUP_STYLE[label].color }}>{items.length}</span>
                </div>
                <div className="space-y-2.5">
                  {items.map((st) => (
                    <SubTaskCard
                      key={st.id}
                      st={st}
                      updating={updatingId === st.id}
                      onStatusChange={handleStatusChange}
                      onOpenModal={setModal}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </main>

      {modal && (
        <TaskUpdateModal
          modal={modal}
          currentUserName={currentUser?.name ?? ''}
          onClose={() => setModal(null)}
          onSubmitted={() => {
            setModal(null)
            reload()
          }}
        />
      )}
    </div>
  )
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div
      className="rounded-2xl border bg-white px-4 py-3"
      style={{ borderColor: '#E9EFF6', boxShadow: '0 1px 4px rgba(15,23,42,0.06)' }}
    >
      <span className="block text-xl font-bold leading-none" style={{ color }}>{value}</span>
      <span className="block text-xs text-slate-400 mt-1">{label}</span>
    </div>
  )
}

function EmptyState({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-3 text-center">
      <div className="w-14 h-14 rounded-2xl flex items-center justify-center" style={{ background: '#F1F5F9' }}>
        <svg style={{ width: 28, height: 28, color: '#CBD5E1' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
        </svg>
      </div>
      <p className="text-slate-500 text-sm font-semibold">{title}</p>
      {subtitle ? <p className="text-slate-400 text-xs">{subtitle}</p> : null}
    </div>
  )
}

function SubTaskCard({
  st,
  updating,
  onStatusChange,
  onOpenModal,
}: {
  st: SubTaskWithParent
  updating: boolean
  onStatusChange: (st: SubTaskWithParent, next: string) => void
  onOpenModal: (modal: QuickModal) => void
}) {
  const navigate = useNavigate()
  const badge = badgeFor(st.status)
  const actions = getMemberTaskActions(st.status)

  function goToTask() {
    if (st.parent_project_id && st.parent_task_id) {
      navigate(`/project/${st.parent_project_id}/tasks?open_task=${st.parent_task_id}`)
    }
  }

  return (
    <div
      className="bg-white border rounded-2xl px-5 py-4"
      style={{ borderColor: '#E9EFF6', boxShadow: '0 1px 4px rgba(15,23,42,0.06)' }}
    >
      <div className="flex items-center gap-4">
        <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: badge.color }} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm font-semibold text-slate-800 truncate">{st.title}</p>
            <span className="px-2 py-0.5 rounded-full text-xs font-semibold flex-shrink-0" style={{ background: badge.bg, color: badge.color }}>
              {badge.label}
            </span>
          </div>
          <button
            onClick={goToTask}
            className="text-xs text-indigo-500 hover:text-indigo-700 mt-1 truncate block max-w-full text-left"
            title="查看所属关键任务"
          >
            {st.parent_special_project || '项目'} / {st.parent_key_task}
          </button>
        </div>
        {st.plan_time ? <span className="text-xs text-slate-400 hidden md:block">{st.plan_time}</span> : null}
        <div className="flex items-center gap-2 flex-shrink-0">
          {actions.includes('start') && (
            <ActionButton disabled={updating} tone="blue" onClick={() => onStatusChange(st, '进行中')}>
              开始
            </ActionButton>
          )}
          {actions.includes('resume') && (
            <ActionButton disabled={updating} tone="blue" onClick={() => onStatusChange(st, '进行中')}>
              恢复推进
            </ActionButton>
          )}
          {actions.includes('submit_progress') && (
            <ActionButton disabled={updating} tone="slate" onClick={() => onOpenModal({ kind: 'progress', task: st })}>
              更新进展
            </ActionButton>
          )}
          {actions.includes('complete') && (
            <ActionButton disabled={updating} tone="green" onClick={() => onOpenModal({ kind: 'progress', task: st, completeAfterSubmit: true })}>
              提交完成
            </ActionButton>
          )}
          {actions.includes('report_issue') && (
            <ActionButton disabled={updating} tone="amber" onClick={() => onOpenModal({ kind: 'issue', task: st })}>
              上报问题
            </ActionButton>
          )}
        </div>
      </div>
      {st.completion_criteria ? (
        <div className="mt-3 ml-6 rounded-xl px-3 py-2 text-xs text-slate-500" style={{ background: '#F8FAFC' }}>
          完成标准：{st.completion_criteria}
        </div>
      ) : null}
    </div>
  )
}

function ActionButton({
  children,
  disabled,
  tone,
  onClick,
}: {
  children: React.ReactNode
  disabled?: boolean
  tone: 'blue' | 'green' | 'amber' | 'slate'
  onClick: () => void
}) {
  const styles = {
    blue: { bg: 'linear-gradient(135deg, #0369A1, #0EA5E9)', color: 'white', border: '#0369A1' },
    green: { bg: '#059669', color: 'white', border: '#059669' },
    amber: { bg: '#FFFBEB', color: '#B45309', border: '#FDE68A' },
    slate: { bg: 'white', color: '#475569', border: '#CBD5E1' },
  }[tone]
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className="px-3 py-1.5 rounded-lg text-xs font-semibold border disabled:opacity-50"
      style={{ background: styles.bg, color: styles.color, borderColor: styles.border }}
    >
      {children}
    </button>
  )
}

function TaskUpdateModal({
  modal,
  currentUserName,
  onClose,
  onSubmitted,
}: {
  modal: Exclude<QuickModal, null>
  currentUserName: string
  onClose: () => void
  onSubmitted: () => void
}) {
  const isIssue = modal.kind === 'issue'
  const completeAfterSubmit = modal.kind === 'progress' && Boolean(modal.completeAfterSubmit)
  const [text, setText] = useState('')
  const [issueType, setIssueType] = useState('问题')
  const [saving, setSaving] = useState(false)

  async function handleSubmit() {
    const content = text.trim()
    if (!content) return
    const projectId = modal.task.parent_project_id
    if (!projectId) {
      alert('该子任务缺少项目归属，无法提交')
      return
    }
    setSaving(true)
    try {
      await createUpdate({
        project_id: projectId,
        source_type: isIssue ? '我的任务-问题上报' : '我的任务-进展更新',
        title: `${modal.task.title}${isIssue ? '问题上报' : '进展更新'}`,
        transcript_text: isIssue
          ? `子任务：${modal.task.title}\n问题类型：${issueType}\n问题描述：${content}`
          : `子任务：${modal.task.title}\n所属关键任务：${modal.task.parent_key_task}\n本次进展：${content}`,
        submitter: currentUserName,
        human_result: {
          summary: content,
          special_project: modal.task.parent_special_project,
          related_task: modal.task.parent_key_task,
          task_reports: isIssue ? [] : [{
            type: 'progress',
            matched_subtask_id: modal.task.id,
            matched_subtask_title: modal.task.title,
            completed: content,
            achievements: [],
            subtask_issues: [],
            next_steps: [],
            status_update: '进行中',
          }],
          key_task_issues: isIssue ? [{
            key_task_title: modal.task.parent_key_task,
            issue_type: issueType,
            description: content,
            need_coordination: [],
            priority: issueType === '需决策' ? '高' : '中',
          }] : [],
        },
      })
      if (!isIssue && (completeAfterSubmit || /完成|已完成|交付|收尾/.test(content))) {
        const statusResult = await patchSubTaskStatus(modal.task.id, '已完成')
        if (isPendingConfirmation(statusResult)) {
          alert('已提交至确认中心，等待项目负责人确认')
        }
      }
      onSubmitted()
    } catch (e) {
      alert(e instanceof Error ? e.message : '提交失败，请重试')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(15,23,42,0.35)' }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden">
        <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: '#E9EFF6' }}>
          <div>
            <h2 className="text-base font-bold text-slate-800">{isIssue ? '上报问题' : completeAfterSubmit ? '提交完成' : '更新进展'}</h2>
            <p className="text-xs text-slate-400 mt-0.5">{modal.task.parent_key_task} / {modal.task.title}</p>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600">关闭</button>
        </div>
        <div className="p-5 space-y-4">
          {isIssue ? (
            <div>
              <label className="block text-xs font-semibold text-slate-500 mb-1.5">问题类型</label>
              <select
                value={issueType}
                onChange={(e) => setIssueType(e.target.value)}
                className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm bg-white focus:outline-none"
              >
                <option>问题</option>
                <option>风险</option>
                <option>需协调</option>
                <option>需决策</option>
              </select>
            </div>
          ) : null}
          <div>
            <label className="block text-xs font-semibold text-slate-500 mb-1.5">
              {isIssue ? '问题描述' : '本次进展'}
            </label>
            <textarea
              rows={6}
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
              placeholder={isIssue ? '说明遇到的问题、影响和需要谁协助。' : completeAfterSubmit ? '说明已经完成了什么、形成了什么成果或交付物。提交后会把该子任务标记为已完成。' : '说明完成了什么、形成了什么成果、还有什么下一步。写到“完成/已完成/交付”会同步把子任务标记为已完成。'}
            />
          </div>
        </div>
        <div className="px-5 py-4 border-t flex justify-end gap-3" style={{ borderColor: '#E9EFF6' }}>
          <button onClick={onClose} className="px-4 py-2 rounded-xl border border-slate-200 text-slate-600 text-sm font-semibold">取消</button>
          <button
            disabled={saving || !text.trim()}
            onClick={handleSubmit}
            className="px-5 py-2 rounded-xl text-white text-sm font-bold disabled:opacity-50"
            style={{ background: isIssue ? '#D97706' : 'linear-gradient(135deg, #0369A1, #0EA5E9)' }}
          >
            {saving ? '提交中...' : '提交给负责人'}
          </button>
        </div>
      </div>
    </div>
  )
}
