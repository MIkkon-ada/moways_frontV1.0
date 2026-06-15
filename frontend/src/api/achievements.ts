import { apiDelete, apiGet, apiPost } from './client'
import type { AchievementItem } from '../types'

export function fetchAchievements(projectId?: number | null): Promise<AchievementItem[]> {
  const qs = projectId != null ? `?project_id=${projectId}` : ''
  return apiGet<AchievementItem[]>(`/api/achievements${qs}`)
}

export function deleteAchievement(id: number): Promise<unknown> {
  return apiDelete(`/api/achievements/${id}`)
}

export type AchievementPayload = {
  project_id?: number | null
  name: string
  achievement_type?: string
  special_project?: string
  related_task_id?: number | null
  owner?: string
  version?: string
  file_link?: string
  scenario?: string
  reuse_tag?: string
  status?: string
  source_type?: string
}

export function createAchievement(payload: AchievementPayload): Promise<AchievementItem> {
  return apiPost<AchievementItem>('/api/achievements', payload)
}
