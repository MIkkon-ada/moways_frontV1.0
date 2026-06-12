import { apiDelete, apiGet } from './client'
import type { IssueItem } from '../types'

export function fetchIssues(projectId?: number | null): Promise<IssueItem[]> {
  const query = projectId ? `?project_id=${projectId}` : ''
  return apiGet<IssueItem[]>(`/api/issues${query}`)
}

export function deleteIssue(id: number): Promise<unknown> {
  return apiDelete(`/api/issues/${id}`)
}
