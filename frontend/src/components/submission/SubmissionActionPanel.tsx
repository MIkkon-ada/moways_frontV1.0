import type { ReactNode } from 'react'

type SubmissionActionPanelProps = {
  children: ReactNode
  className?: string
}

export function SubmissionActionPanel({ children, className = 'confirm-actions' }: SubmissionActionPanelProps) {
  return <div className={className}>{children}</div>
}
