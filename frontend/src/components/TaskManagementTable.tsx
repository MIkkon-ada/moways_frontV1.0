import type { TaskItem } from '../types'
import { classifyIssue, formatCollaborators, formatStatusTone } from '../utils/taskPresentation'

type TaskManagementTableProps = {
  tasks: TaskItem[]
  selectedId: number
  onSelectTask: (task: TaskItem) => void
}

export function TaskManagementTable({ tasks, selectedId, onSelectTask }: TaskManagementTableProps) {
  return (
    <section className="card task-board-card">
      <div className="panel-head">
        <h2 className="panel-title">台账主表</h2>
        <span className="panel-link">点击行查看右侧详情</span>
      </div>

      <div className="table-wrap task-board-wrap">
        <table className="task-board-table">
          <thead>
            <tr>
              <th className="col-check">
                <input type="checkbox" aria-label="全选" />
              </th>
              <th>专项</th>
              <th>关键任务</th>
              <th>关键成果</th>
              <th>完成标准</th>
              <th>负责人 / 协同</th>
              <th>计划时间</th>
              <th>当前状态</th>
              <th>问题与需协调事项</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => {
              const issue = classifyIssue(task.problem_note)
              const statusTone = formatStatusTone(task.status)
              return (
                <tr key={task.id} className={task.id === selectedId ? 'selected' : ''} onClick={() => onSelectTask(task)}>
                  <td className="col-check">
                    <input type="checkbox" onClick={(event) => event.stopPropagation()} />
                  </td>
                  <td>
                    <span className="task-project-dot" />
                    <span className="task-cell-text">{task.special_project}</span>
                  </td>
                  <td>
                    <div className="task-main-title">{task.key_task}</div>
                  </td>
                  <td>
                    <span className="task-cell-text">{task.key_achievement}</span>
                  </td>
                  <td>
                    <span className="task-standard-cell">{task.completion_standard}</span>
                  </td>
                  <td>
                    <div className="people-stack">
                      <div>
                        <span className="people-label">统筹：</span>
                        <span>{task.coordinator || '-'}</span>
                      </div>
                      <div>
                        <span className="people-label">负责人：</span>
                        <span>{task.owner || '-'}</span>
                      </div>
                      <div>
                        <span className="people-label">协同：</span>
                        <span>{formatCollaborators(task.collaborators)}</span>
                      </div>
                    </div>
                  </td>
                  <td>{task.plan_time}</td>
                  <td>
                    <span className={`status-pill status-${statusTone}`}>{task.status}</span>
                  </td>
                  <td>
                    <div className="issue-cell">
                      <span className={`issue-tag issue-${issue.tone}`}>{issue.label}</span>
                      <span className="issue-text">{task.problem_note}</span>
                    </div>
                  </td>
                  <td>
                    <button type="button" className="table-action" onClick={(event) => { event.stopPropagation(); onSelectTask(task) }}>
                      查看
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="task-pagination">
        <span>共 31 条</span>
        <div className="page-controls">
          <button type="button" disabled>
            ‹
          </button>
          <button type="button" className="active">
            1
          </button>
          <button type="button">2</button>
          <button type="button">3</button>
          <button type="button">›</button>
        </div>
        <div className="page-size">
          <select defaultValue="20 条/页">
            <option>20 条/页</option>
            <option>50 条/页</option>
          </select>
          <span>前往</span>
          <input type="number" defaultValue={1} />
          <span>页</span>
        </div>
      </div>
    </section>
  )
}
