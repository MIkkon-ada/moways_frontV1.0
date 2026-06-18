export type TaskItem = {
  id: number
  special_project: string
  key_task: string
  key_achievement: string
  completion_standard: string
  coordinator: string
  owner: string
  collaborators: string
  plan_time: string
  status: string
  problem_note: string
  achievement_links: string
  source_type: string
  submitter?: string
  confirmed_by?: string
  confirmed_at?: string | null
  edit_count?: number
  is_deleted?: boolean
  deleted_at?: string | null
  deleted_by?: string
  delete_reason?: string
  delete_batch_id?: string
  created_at?: string
  updated_at?: string
}

export type TaskFilters = {
  query: string
  project: string
  status: string
  month: string
}

export type TaskStatItem = {
  label: string
  value: number
  tone: 'total' | 'notstart' | 'progress' | 'done' | 'delayed' | 'paused'
}

export type AppPage = 'dashboard' | 'voice' | 'meeting' | 'confirm' | 'table' | 'achievements' | 'issues' | 'coordinate' | 'decisions' | 'settings' | 'mytasks'

// ── 项目化地基类型（P0-1）──────────────────────────────────

// GET /api/people/me 返回（仅声明本批会用到的字段，其余字段后端仍返回）
export type CurrentUser = {
  account_id?: number | null
  person_id?: number | null
  username?: string
  name: string
  system_role: string
  is_tech_admin: boolean
  is_ceo: boolean
  is_process_guard: boolean
  is_coordinator: boolean
  can_view_all: boolean
  can_confirm_all: boolean
  visible_projects: string[]
  project_roles: Record<string, string>
  must_change_password?: boolean
}

// GET /api/projects 列表项
export type Project = {
  id: number
  name: string
  code: string
  description: string
  status: string
  is_active: boolean
  start_date?: string
  end_date?: string
  coordinator?: string
  owners?: string[]
  collaborators?: string[]
  user_roles: string[]           // 当前用户在该项目的角色：owner/coordinator/member/project_ceo/super_admin
  member_counts: Record<string, number>
}

// GET /api/projects/{id}/capabilities
export type ProjectCapabilities = {
  roles: string[]
  canSubmit: boolean
  canConfirm: boolean
  canCoordinate: boolean
  canEscalateToCEO: boolean
  canCeoDecide: boolean
  canViewCenter: boolean
  pendingCount: number
}

// GET /api/projects/{id}/members
export type ProjectMember = {
  id: number
  project_id: number
  person_id: number
  person_name_snapshot: string
  role: string
  note: string
  joined_at: string | null
}

// ── P0-2：主链路 API 类型 ──────────────────────────────────

// GET /api/dashboard/overview?project_id=X（项目模式，字段做兜底容错）
export type DashboardOverview = {
  project?: { id: number | null; name: string }
  task_stats?: {
    total_tasks?: number
    not_started?: number
    in_progress?: number
    completed?: number
    delayed?: number
    paused?: number
  }
  achievement_stats?: { total_achievements?: number; recent_achievements?: unknown[] }
  issue_stats?: {
    total_issues?: number
    open_issues?: number
    high_priority_issues?: number
    waiting_ceo_decision?: number
  }
  submission_stats?: {
    total_submissions?: number
    pending_owner_confirmation?: number | null
    returned_submissions?: number | null
    confirmed_submissions?: number
  }
  ceo_decision_stats?: { pending_ceo_decisions?: number; ceo_decided_awaiting_owner?: number }
  recent?: {
    submissions?: Array<Record<string, unknown>>
    tasks?: Array<Record<string, unknown>>
    issues?: Array<Record<string, unknown>>
  }
  [key: string]: unknown
}

// GET /api/people 列表项（人员选择器用）
export type Person = {
  id: number
  name: string
  system_role?: string
  department?: string
  contact?: string
  is_active?: boolean
  special_project_duty?: string
  [key: string]: unknown
}

// GET /api/achievements?project_id=X 列表项
export type AchievementItem = {
  id: number
  project_id: number | null
  name?: string
  achievement_type?: string
  special_project?: string
  related_task_id?: number | null
  owner?: string
  version?: string
  file_link?: string
  scenario?: string
  reuse_tag?: string
  status?: string
  confirmed_by?: string
  confirmed_at?: string | null
  source_submission_id?: number | null
  source_achievement_submission_id?: number | null
  created_at?: string
  updated_at?: string
  [key: string]: unknown
}

// GET /api/achievement-submissions
export type AchievementSubmissionItem = {
  id: number
  project_id: number | null
  special_project?: string
  related_task_id?: number | null
  related_subtask_id?: number | null
  submitter?: string
  name: string
  achievement_type?: string
  version?: string
  file_link?: string
  scenario?: string
  reuse_tag?: string
  status: string  // 待确认 / 已确认 / 已退回 / 已撤回
  reviewer?: string
  reviewed_at?: string | null
  reject_reason?: string
  source_type?: string
  created_at?: string
  updated_at?: string
  [key: string]: unknown
}

// GET /api/issues?project_id=X 列表项
export type IssueItem = {
  id: number
  project_id: number | null
  issue_type?: string
  description?: string
  owner?: string
  helper?: string
  priority?: string
  status?: string
  need_decision_by?: string
  expected_resolve_time?: string
  resolution?: string
  created_at?: string
  updated_at?: string
  [key: string]: unknown
}

// GET /api/meetings?project_id=X 列表项（Meeting 模型字段，做兜底容错）
export type MeetingItem = {
  id: number
  project_id: number | null
  related_special_project?: string
  meeting_type?: string
  title?: string
  meeting_date?: string
  host?: string
  participants?: string
  summary?: string
  task_list_json?: string
  decision_items_json?: string
  risk_items_json?: string
  publish_status?: string
  created_at?: string
  updated_at?: string
  [key: string]: unknown
}

// GET /api/tasks/{id}/subtasks 子任务列表项
export type SubTaskItem = {
  id: number
  task_id: number
  title: string
  assignee: string
  plan_time: string
  status: string
  completion_criteria?: string
  notes?: string
  source_submission_id?: number | null
  is_deleted?: boolean
  deleted_at?: string | null
  deleted_by?: string
  delete_reason?: string
  delete_batch_id?: string
  deleted_by_parent_id?: number | null
  created_at?: string
  updated_at?: string
}

// GET /api/confirmations/pending?project_id=X 列表项（crud.to_dict + 注入字段）
export type ConfirmationItem = {
  id: number
  project_id: number | null
  submitter: string
  source_type: string
  title: string
  confirm_status: string
  confidence: number
  special_project?: string
  related_task?: string
  created_at?: string
  updated_at?: string
  reject_reason?: string
  coordinator_note?: string
  ceo_note?: string
  [key: string]: unknown
}
