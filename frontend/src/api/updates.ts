import { apiDelete, apiGet, apiPost } from './client'

export type CreateUpdatePayload = {
  project_id: number          // P0-2 硬约束：提交必带 project_id（后端无 project_id 返回 422）
  source_type: string
  transcript_text: string
  submitter?: string
  title?: string
  llm_provider?: string
  human_result?: Record<string, unknown>  // 用户编辑后的结果（两步流程第二步传入）
}

export type ExtractOnlyPayload = {
  source_type: string
  transcript_text: string
  submitter?: string
  llm_provider?: string
}

export type CreateUpdateResult = {
  submission?: { id?: number; confirm_status?: string; [k: string]: unknown }
  suggestion?: Record<string, unknown>
}

// 纯AI提取，不写DB：POST /api/updates/extract
export function extractOnly(payload: ExtractOnlyPayload): Promise<{ suggestion: Record<string, unknown> }> {
  return apiPost<{ suggestion: Record<string, unknown> }>('/api/updates/extract', payload)
}

// 成员提交进展（第二步确认后写DB）：POST /api/updates
export function createUpdate(payload: CreateUpdatePayload): Promise<CreateUpdateResult> {
  return apiPost<CreateUpdateResult>('/api/updates', payload)
}

export type UpdateHistoryItem = {
  id: number
  project_id?: number | null
  submitter: string
  source_type: string
  title?: string
  transcript_text: string
  confirm_status: string
  confidence: number | null
  special_project?: string
  created_at: string
  updated_at?: string
  ai_result_json?: string
  reject_reason?: string
  coordinator_note?: string
  ceo_note?: string
  [key: string]: unknown
}

export type UpdateDetail = UpdateHistoryItem & {
  confirmed_by?: string
  confirmed_at?: string
  reject_reason?: string
  coordinator_note?: string
  ceo_note?: string
  related_task_id?: number | null
  ai_result?: Record<string, unknown>
  human_result?: Record<string, unknown>
}

export function fetchUpdates(projectId: number): Promise<UpdateHistoryItem[]> {
  return apiGet<UpdateHistoryItem[]>(`/api/updates?project_id=${projectId}`)
}

export function fetchMyUpdates(): Promise<UpdateHistoryItem[]> {
  return apiGet<UpdateHistoryItem[]>('/api/updates?mine=true')
}

export function getUpdate(id: number): Promise<UpdateDetail> {
  return apiGet<UpdateDetail>(`/api/updates/${id}`)
}

export function deleteUpdate(id: number): Promise<unknown> {
  return apiDelete(`/api/updates/${id}`)
}
