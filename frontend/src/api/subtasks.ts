import { apiGet, apiPost, apiPatch, apiDelete } from './client'
import type { SubTaskItem } from '../types'

export type SubTaskWithParent = SubTaskItem & {
  parent_key_task: string
  parent_task_id: number
  parent_project_id: number | null
  parent_special_project: string
}

export function fetchSubTasks(taskId: number, deleted = false): Promise<SubTaskItem[]> {
  return apiGet<SubTaskItem[]>(`/api/tasks/${taskId}/subtasks?deleted=${deleted ? 'true' : 'false'}`)
}

export function createSubTask(taskId: number, data: Omit<SubTaskItem, 'id' | 'task_id' | 'created_at' | 'updated_at'>): Promise<SubTaskItem> {
  return apiPost<SubTaskItem>(`/api/tasks/${taskId}/subtasks`, data)
}

export function updateSubTask(id: number, data: Omit<SubTaskItem, 'id' | 'task_id' | 'created_at' | 'updated_at'>): Promise<SubTaskItem> {
  return apiPatch<SubTaskItem>(`/api/subtasks/${id}`, data)
}

export type PendingConfirmationResult = {
  status: 'pending_confirmation'
  submission_id: number
}

export type SubTaskStatusResult = SubTaskItem | PendingConfirmationResult

export function isPendingConfirmation(r: SubTaskStatusResult): r is PendingConfirmationResult {
  return (r as PendingConfirmationResult).status === 'pending_confirmation'
}

export function patchSubTaskStatus(id: number, status: string): Promise<SubTaskStatusResult> {
  return apiPatch<SubTaskStatusResult>(`/api/subtasks/${id}/status`, { status })
}

export function deleteSubTask(id: number, reason = ''): Promise<unknown> {
  const qs = reason ? `?reason=${encodeURIComponent(reason)}` : ''
  return apiDelete(`/api/subtasks/${id}${qs}`)
}

export function restoreSubTask(id: number): Promise<SubTaskItem> {
  return apiPost<SubTaskItem>(`/api/subtasks/${id}/restore`, {})
}

export type SubTaskDetail = SubTaskItem & {
  parent_task?: { id: number; key_task: string; special_project: string }
  source_submission?: {
    id: number
    submitter: string
    source_type: string
    title: string
    created_at: string | null
    summary: string
    completed_items: string[]
    transcript_text: string
  }
  related_achievements?: {
    id: number
    name: string
    achievement_type: string
    status: string
    owner: string
    version: string
    created_at: string | null
  }[]
  related_issues?: {
    id: number
    description: string
    issue_type: string
    status: string
    priority: string
    owner: string
    created_at: string | null
  }[]
}

export function fetchSubtaskDetail(id: number): Promise<SubTaskDetail> {
  return apiGet<SubTaskDetail>(`/api/subtasks/${id}/detail`)
}

export function fetchSubtasksByAssignee(assignee: string, projectId: number | null): Promise<SubTaskWithParent[]> {
  const qs = new URLSearchParams({ assignee })
  if (projectId != null) qs.set('project_id', String(projectId))
  return apiGet<SubTaskWithParent[]>(`/api/subtasks?${qs}`)
}

export function fetchSubtasksByProject(projectId: number): Promise<SubTaskWithParent[]> {
  return apiGet<SubTaskWithParent[]>(`/api/subtasks?project_id=${projectId}`)
}
