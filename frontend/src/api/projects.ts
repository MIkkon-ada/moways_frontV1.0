import { apiGet, apiPost, apiPatch, apiDelete } from './client'
import type { Project, ProjectCapabilities, ProjectMember } from '../types'

// 当前用户可见项目：GET /api/projects[?include_archived=true]
export function getProjects(includeArchived = false): Promise<Project[]> {
  const q = includeArchived ? '?include_archived=true' : ''
  return apiGet<Project[]>(`/api/projects${q}`)
}

// 项目详情：GET /api/projects/{id}
export function getProject(projectId: number): Promise<Project> {
  return apiGet<Project>(`/api/projects/${projectId}`)
}

// 项目成员：GET /api/projects/{id}/members
export function getProjectMembers(projectId: number): Promise<ProjectMember[]> {
  return apiGet<ProjectMember[]>(`/api/projects/${projectId}/members`)
}

// 当前用户在该项目的能力标志：GET /api/projects/{id}/capabilities
export function getProjectCapabilities(projectId: number): Promise<ProjectCapabilities> {
  return apiGet<ProjectCapabilities>(`/api/projects/${projectId}/capabilities`)
}

// ── 4B：项目主数据管理（super_admin）────────────────────────

export type ProjectCreatePayload = {
  name: string
  code?: string
  description?: string
  status?: string
  start_date?: string
  end_date?: string
  // 初始成员（可选）
  project_ceo_ids?: number[]
  owner_ids?: number[]
  coordinator_ids?: number[]
  member_ids?: number[]
}

export type ProjectPatchPayload = {
  name?: string
  code?: string
  description?: string
  status?: string
  start_date?: string
  end_date?: string
}

export function createProject(payload: ProjectCreatePayload): Promise<Project> {
  return apiPost<Project>('/api/projects', payload)
}

export function patchProject(projectId: number, payload: ProjectPatchPayload): Promise<Project> {
  return apiPatch<Project>(`/api/projects/${projectId}`, payload)
}

export function archiveProject(projectId: number): Promise<{ ok: boolean; status: string }> {
  return apiPost(`/api/projects/${projectId}/archive`)
}

export type BatchImportRow = {
  project_name: string
  key_task: string
  key_achievement?: string
  completion_standard?: string
  coordinator?: string
  owner?: string
  collaborators?: string
  plan_time?: string
  status?: string
  issue?: string
}

export type BatchImportResult = {
  ok: boolean
  projects_created: number
  projects_matched: number
  tasks_created: number
  issues_created: number
  skipped_rows: number
}

export function batchImportProjects(rows: BatchImportRow[]): Promise<BatchImportResult> {
  return apiPost<BatchImportResult>('/api/projects/batch-import', { rows })
}

// ── 4A：项目成员管理（super_admin）──────────────────────────

export type MemberAddPayload = {
  person_id: number
  role: string
  note?: string
}

export type MemberPatchPayload = {
  role?: string
  note?: string
}

export function addProjectMember(projectId: number, payload: MemberAddPayload): Promise<ProjectMember> {
  return apiPost<ProjectMember>(`/api/projects/${projectId}/members`, payload)
}

export function updateProjectMember(
  projectId: number,
  memberId: number,
  payload: MemberPatchPayload,
): Promise<ProjectMember> {
  return apiPatch<ProjectMember>(`/api/projects/${projectId}/members/${memberId}`, payload)
}

export function removeProjectMember(projectId: number, memberId: number): Promise<{ ok: boolean }> {
  return apiDelete(`/api/projects/${projectId}/members/${memberId}`)
}
