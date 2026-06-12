import { apiDelete, apiGet, apiPost, apiPut } from './client'
import type { TaskItem } from '../types'

export type TaskPayload = {
  project_id?: number | null
  special_project?: string
  key_task: string
  key_achievement?: string
  completion_standard?: string
  coordinator?: string
  owner?: string
  collaborators?: string
  plan_time?: string
  status?: string
  problem_note?: string
}

export function createTask(payload: TaskPayload): Promise<TaskItem> {
  return apiPost<TaskItem>('/api/tasks', payload)
}

export function updateTask(id: number, payload: TaskPayload): Promise<TaskItem> {
  return apiPut<TaskItem>(`/api/tasks/${id}`, payload)
}

export function fetchTasks(projectId: number | null): Promise<TaskItem[]> {
  const qs = projectId != null ? `?project_id=${projectId}` : ''
  return apiGet<TaskItem[]>(`/api/tasks${qs}`)
}

export function deleteTask(id: number): Promise<unknown> {
  return apiDelete(`/api/tasks/${id}`)
}

export type TaskLog = { action: string; operator: string; created_at: string }
export type TaskUpdate = { id: number; submitter: string; transcript_text: string; created_at: string }

export function fetchTaskLogs(id: number): Promise<TaskLog[]> {
  return apiGet<TaskLog[]>(`/api/tasks/${id}/logs`)
}

export function fetchTaskUpdates(id: number): Promise<TaskUpdate[]> {
  return apiGet<TaskUpdate[]>(`/api/tasks/${id}/updates`)
}
