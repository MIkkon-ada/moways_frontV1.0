// 展示 update_submissions 的 AI 提取结果 / 人工修正结果。
// 输入是 unknown：可能是对象、数组、JSON 字符串、普通文本或 null。
// 任何解析失败都退回原始文本展示，绝不白屏。

type StructuredResultViewProps = {
  data: unknown
}

// 常见字段中文 label 映射
const LABELS: Record<string, string> = {
  key_task: '关键任务',
  achievement: '成果',
  key_achievement: '关键成果',
  issue: '问题',
  risk: '风险',
  next_step: '下一步',
  owner: '负责人',
  deadline: '截止时间',
  special_project: '项目',
  summary: '摘要',
  title: '标题',
  description: '描述',
  status: '状态',
  priority: '优先级',
  collaborators: '协同人',
  coordinator: '统筹人',
  completion_standard: '完成标准',
  plan_time: '计划时间',
  issue_type: '问题类型',
  achievement_type: '成果类型',
  version: '版本',
}

function labelFor(key: string): string {
  return LABELS[key] ?? key
}

// 字符串若像 JSON 则尝试解析，失败返回原字符串
function normalize(data: unknown): unknown {
  if (typeof data === 'string') {
    const s = data.trim()
    if (s && (s.startsWith('{') || s.startsWith('['))) {
      try {
        return JSON.parse(s)
      } catch {
        return data
      }
    }
  }
  return data
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') return Object.keys(value as object).length === 0
  return false
}

export function StructuredResultView({ data }: StructuredResultViewProps) {
  const value = normalize(data)
  if (isEmpty(value)) {
    return <div className="structured-empty">暂无结构化内容</div>
  }
  return (
    <div className="structured-view">
      <Node value={value} />
    </div>
  )
}

// 递归渲染任意 JSON 节点
function Node({ value }: { value: unknown }) {
  const v = normalize(value)

  if (v === null || v === undefined || v === '') {
    return <span className="structured-scalar">-</span>
  }
  if (typeof v === 'boolean') {
    return <span className="structured-scalar">{v ? '是' : '否'}</span>
  }
  if (typeof v === 'string' || typeof v === 'number') {
    return <span className="structured-scalar">{String(v)}</span>
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return <span className="structured-scalar">-</span>
    return (
      <ul className="structured-list">
        {v.map((item, i) => (
          <li key={i} className="structured-list-item">
            <Node value={item} />
          </li>
        ))}
      </ul>
    )
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>)
    if (entries.length === 0) return <span className="structured-scalar">-</span>
    return (
      <div className="structured-obj">
        {entries.map(([k, val]) => (
          <div className="structured-row" key={k}>
            <div className="structured-key">{labelFor(k)}</div>
            <div className="structured-val">
              <Node value={val} />
            </div>
          </div>
        ))}
      </div>
    )
  }
  // 兜底：任何意外类型都转成字符串，不白屏
  return <span className="structured-scalar">{String(v)}</span>
}
