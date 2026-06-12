import { apiGet, apiPatch, apiPost, apiUpload } from './client'
import type { MeetingItem } from '../types'

export function fetchMeetings(projectId: number): Promise<MeetingItem[]> {
  return apiGet<MeetingItem[]>(`/api/meetings?project_id=${projectId}`)
}

export function patchMeetingStatus(
  id: number,
  publish_status: 'draft' | 'published' | 'returned',
): Promise<MeetingItem> {
  return apiPatch<MeetingItem>(`/api/meetings/${id}/status`, { publish_status })
}

export type MeetingAnalyzeResult = {
  title: string
  meeting_type: string
  meeting_date: string
  host: string
  participants: string
  summary: string
  reports_json: string        // 按人头的汇报结构（项目汇报模式）
  task_list_json: string      // 行动清单
  decision_items_json: string
  risk_items_json: string
  transcript_text: string
}

export function analyzeMeeting(
  text: string,
  project_id?: number,
): Promise<MeetingAnalyzeResult> {
  return apiPost<MeetingAnalyzeResult>('/api/meetings/analyze', { text, project_id })
}

export function transcribeAudio(file: File): Promise<{ text: string }> {
  const fd = new FormData()
  fd.append('file', file, file.name)
  return apiUpload<{ text: string }>('/api/transcribe', fd)
}

export function createMeeting(payload: {
  project_id: number
  title: string
  meeting_type: string
  meeting_date: string
  host: string
  participants: string
  summary: string
  task_list_json: string
  decision_items_json: string
  risk_items_json: string
  transcript_text: string
}): Promise<MeetingItem> {
  return apiPost<MeetingItem>('/api/meetings', payload)
}
