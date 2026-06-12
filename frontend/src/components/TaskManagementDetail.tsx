import type { TaskItem } from '../types'
import { formatDateTime, formatShortDate, formatCollaborators } from '../utils/taskPresentation'

type TaskManagementDetailProps = {
  task: TaskItem | null
}

export function TaskManagementDetail({ task }: TaskManagementDetailProps) {
  return (
    <aside className="card task-detail-card">
      <div className="task-detail-head">
        <div>
          <h2>任务详情</h2>
          <p>只读追溯信息</p>
        </div>
        <button type="button" className="close-detail-button" aria-label="关闭详情">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {!task ? (
        <div className="empty-detail">请选择一条任务查看详情</div>
      ) : (
        <div className="task-detail-body">
          <section>
            <h3>基本信息</h3>
            <div className="detail-list">
              <div>
                <span>专项</span>
                <strong>{task.special_project}</strong>
              </div>
              <div>
                <span>关键任务</span>
                <strong>{task.key_task}</strong>
              </div>
              <div>
                <span>关键成果</span>
                <strong>{task.key_achievement}</strong>
              </div>
              <div>
                <span>计划时间</span>
                <strong>{task.plan_time}</strong>
              </div>
              <div>
                <span>负责人</span>
                <strong>{task.owner}</strong>
              </div>
              <div>
                <span>协同</span>
                <strong>{formatCollaborators(task.collaborators)}</strong>
              </div>
              <div>
                <span>统筹</span>
                <strong>{task.coordinator}</strong>
              </div>
              <div>
                <span>当前状态</span>
                <strong>{task.status}</strong>
              </div>
            </div>
          </section>

          <section>
            <h3>完成标准</h3>
            <p>{task.completion_standard}</p>
          </section>

          <section>
            <h3>问题备注</h3>
            <p>{task.problem_note}</p>
          </section>

          <section>
            <h3>关联成果</h3>
            <p>{task.achievement_links}</p>
          </section>

          <section>
            <h3>来源信息</h3>
            <div className="detail-list">
              <div>
                <span>来源类型</span>
                <strong>{task.source_type}</strong>
              </div>
              <div>
                <span>创建时间</span>
                <strong>{formatShortDate(task.created_at)}</strong>
              </div>
              <div>
                <span>更新时间</span>
                <strong>{formatDateTime(task.updated_at)}</strong>
              </div>
              <div>
                <span>确认时间</span>
                <strong>{formatDateTime(task.confirmed_at)}</strong>
              </div>
            </div>
          </section>
        </div>
      )}
    </aside>
  )
}
