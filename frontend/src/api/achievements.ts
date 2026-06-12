import { apiDelete, apiGet } from './client'
import type { AchievementItem } from '../types'

export function fetchAchievements(projectId?: number | null): Promise<AchievementItem[]> {
  const qs = projectId != null ? `?project_id=${projectId}` : ''
  return apiGet<AchievementItem[]>(`/api/achievements${qs}`)
}

export function deleteAchievement(id: number): Promise<unknown> {
  return apiDelete(`/api/achievements/${id}`)
}
