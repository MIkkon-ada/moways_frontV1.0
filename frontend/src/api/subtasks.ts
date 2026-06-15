import { apiGet, apiPost, apiPatch, apiDelete } from './client'
import type { SubTaskItem } from '../types'

export function fetchSubTasks(taskId: number, deleted = false): Promise<SubTaskItem[]> {
  return apiGet<SubTaskItem[]>(`/api/tasks/${taskId}/subtasks?deleted=${deleted ? 'true' : 'false'}`)
}

export function createSubTask(taskId: number, data: Omit<SubTaskItem, 'id' | 'task_id' | 'created_at' | 'updated_at'>): Promise<SubTaskItem> {
  return apiPost<SubTaskItem>(`/api/tasks/${taskId}/subtasks`, data)
}

export function updateSubTask(id: number, data: Omit<SubTaskItem, 'id' | 'task_id' | 'created_at' | 'updated_at'>): Promise<SubTaskItem> {
  return apiPatch<SubTaskItem>(`/api/subtasks/${id}`, data)
}

export function patchSubTaskStatus(id: number, status: string): Promise<SubTaskItem> {
  return apiPatch<SubTaskItem>(`/api/subtasks/${id}/status`, { status })
}

export function deleteSubTask(id: number, reason = ''): Promise<unknown> {
  const qs = reason ? `?reason=${encodeURIComponent(reason)}` : ''
  return apiDelete(`/api/subtasks/${id}${qs}`)
}

export function restoreSubTask(id: number): Promise<SubTaskItem> {
  return apiPost<SubTaskItem>(`/api/subtasks/${id}/restore`, {})
}
