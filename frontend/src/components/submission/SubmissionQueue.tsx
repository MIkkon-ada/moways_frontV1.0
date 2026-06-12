import type { ConfirmationItem } from '../../types'

type SubmissionQueueProps = {
  items: ConfirmationItem[]
  selectedId?: number | string | null
  onSelect: (item: ConfirmationItem) => void
  emptyText?: string
  getBadgeLabel?: (item: ConfirmationItem) => string
  getSummary?: (item: ConfirmationItem) => string
  summaryHeader?: string
  createdAtHeader?: string
}

export function SubmissionQueue({
  items,
  selectedId,
  onSelect,
  emptyText = '当前没有待处理事项',
  getBadgeLabel,
  getSummary,
  summaryHeader = '专项',
  createdAtHeader = '时间',
}: SubmissionQueueProps) {
  if (items.length === 0) {
    return <p className="readonly-hint">{emptyText}</p>
  }

  const hasSummary = typeof getSummary === 'function'

  return (
    <section className="card confirm-queue-card">
      <div className="panel-head">
        <h2 className="panel-title">待处理事项（{items.length}）</h2>
      </div>
      <div className="table-wrap confirm-table-wrap">
        <table className="confirm-table">
          <thead>
            <tr>
              <th>提交人</th>
              <th>类型</th>
              <th>状态</th>
              <th>{createdAtHeader}</th>
              {hasSummary ? <th>{summaryHeader}</th> : null}
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const selected = selectedId !== undefined && selectedId !== null
                ? String(selectedId) === String(item.id)
                : false
              return (
                <tr
                  key={item.id}
                  className={selected ? 'row-selected' : ''}
                  onClick={() => onSelect(item)}
                  style={{ cursor: 'pointer' }}
                >
                  <td>{item.submitter}</td>
                  <td>{item.source_type}</td>
                  <td>{getBadgeLabel ? getBadgeLabel(item) : item.confirm_status}</td>
                  <td>{(item.created_at ?? '').slice(0, 16).replace('T', ' ')}</td>
                  {hasSummary ? <td>{getSummary?.(item) || '-'}</td> : null}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}
