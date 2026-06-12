import type { ReactNode } from 'react'

type DetailField = {
  label: string
  value: ReactNode
}

type DetailSection = {
  title: string
  content: ReactNode
}

type SubmissionDetailPanelProps = {
  title: string
  fields: DetailField[]
  sections?: DetailSection[]
  actions?: ReactNode
  emptyText?: string
  className?: string
}

export function SubmissionDetailPanel({
  title,
  fields,
  sections = [],
  actions,
  emptyText = '请选择左侧事项查看详情',
  className = 'card confirm-detail-card',
}: SubmissionDetailPanelProps) {
  return (
    <aside className={className}>
      <div className="panel-head">
        <h2 className="panel-title">{title}</h2>
      </div>
      {fields.length > 0 ? (
        <>
          <dl className="confirm-detail-fields">
            {fields.map((field) => (
              <div key={field.label}>
                <dt>{field.label}</dt>
                <dd>{field.value}</dd>
              </div>
            ))}
          </dl>

          {sections.map((section) => (
            <div key={section.title} className="drawer-section">
              <h3 className="drawer-subtitle">{section.title}</h3>
              {typeof section.content === 'string' ? (
                <p className="drawer-text">{section.content}</p>
              ) : (
                section.content
              )}
            </div>
          ))}

          {actions ? <div className="confirm-actions">{actions}</div> : null}
        </>
      ) : (
        <p className="readonly-hint">{emptyText}</p>
      )}
    </aside>
  )
}
