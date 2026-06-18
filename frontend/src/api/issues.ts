import { apiDelete, apiGet, apiPatch } from './client'
import type { IssueItem } from '../types'

export function fetchIssues(projectId?: number | null): Promise<IssueItem[]> {
  const query = projectId ? `?project_id=${projectId}` : ''
  return apiGet<IssueItem[]>(`/api/issues${query}`)
}

export function deleteIssue(id: number): Promise<unknown> {
  return apiDelete(`/api/issues/${id}`)
}

export function resolveIssue(id: number, resolution?: string): Promise<IssueItem> {
  return apiPatch<IssueItem>(`/api/issues/${id}/resolve`, { resolution: resolution ?? '' })
}

export function closeIssue(id: number, reason?: string): Promise<IssueItem> {
  return apiPatch<IssueItem>(`/api/issues/${id}/close`, { reason: reason ?? '' })
}

export function assignIssueHelper(id: number, helper: string): Promise<IssueItem> {
  return apiPatch<IssueItem>(`/api/issues/${id}/assign-helper`, { helper })
}

export function requestIssueCeo(id: number, needDecisionBy: string, note?: string): Promise<IssueItem> {
  return apiPatch<IssueItem>(`/api/issues/${id}/request-ceo`, {
    need_decision_by: needDecisionBy,
    note: note ?? '',
  })
}
