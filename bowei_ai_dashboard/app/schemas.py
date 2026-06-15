from typing import Any

from pydantic import BaseModel


class ExtractRequest(BaseModel):
    project_id: int | None = None
    special_project: str | None = None
    source_type: str
    submitter: str | None = None
    title: str | None = None
    transcript_text: str
    human_result: dict[str, Any] | None = None
    edited_suggestion: dict[str, Any] | None = None
    llm_provider: str | None = None


class ConfirmationSaveRequest(BaseModel):
    human_result: dict[str, Any]


class ConfirmRequest(BaseModel):
    operator: str = "管理员"
    human_result: dict[str, Any] | None = None


class RejectRequest(BaseModel):
    reason: str
    operator: str = "管理员"


class StatusRequest(BaseModel):
    status: str


class TaskPayload(BaseModel):
    project_id: int | None = None
    special_project: str = ""
    key_task: str
    key_achievement: str = ""
    completion_standard: str = ""
    coordinator: str = ""
    owner: str = ""
    collaborators: str = ""
    plan_time: str = ""
    status: str = "未开始"
    problem_note: str = ""
    achievement_links: str = ""
    source_type: str = "人工录入"


class AchievementPayload(BaseModel):
    project_id: int | None = None
    name: str
    achievement_type: str = "方案"
    special_project: str = ""
    related_task_id: int | None = None
    owner: str = ""
    version: str = "V0.1"
    file_link: str = ""
    scenario: str = ""
    reuse_tag: str = ""
    status: str = "计划中"
    source_type: str = "人工录入"


class IssuePayload(BaseModel):
    project_id: int | None = None
    issue_type: str = "问题"
    description: str
    owner: str = ""
    helper: str = ""
    priority: str = "中"
    status: str = "待处理"
    need_decision_by: str = ""
    expected_resolve_time: str = ""
    resolution: str = ""
    related_task_id: int | None = None
    special_project: str = ""
    source_type: str = "人工录入"


class PersonPayload(BaseModel):
    name: str
    role: str = ""
    system_role: str = "普通成员"
    department: str = ""
    special_project_duty: str = ""
    permission: str = "查看"
    contact: str = ""
    is_active: bool = True
    is_admin: bool = False
    coordinated_projects: list[str] = []
    owned_projects: list[str] = []
    collaborated_projects: list[str] = []


class PersonBatchItem(BaseModel):
    name: str
    role: str = ""
    system_role: str = "普通成员"
    department: str = ""
    contact: str = ""


class PersonBatchPayload(BaseModel):
    people: list[PersonBatchItem]


class ProjectPayload(BaseModel):
    name: str
    coordinator: str = ""
    owners: list[str] = []
    collaborators: list[str] = []
    sort_order: int = 0
    is_active: bool = True


class AssignRequest(BaseModel):
    assignee: str
    operator: str = "管理员"


class ResubmitRequest(BaseModel):
    supplement_note: str = ""
    operator: str = ""
    human_result: dict[str, Any] | None = None


class WorkflowNoteRequest(BaseModel):
    note: str = ""
    operator: str = "管理员"


class ProjectMemberPayload(BaseModel):
    person_id: int
    role: str  # project_ceo / owner / coordinator / member
    note: str = ""


class ProjectMemberPatchPayload(BaseModel):
    role: str | None = None
    note: str | None = None


class ProjectCreatePayload(BaseModel):
    name: str
    code: str = ""
    description: str = ""
    status: str = "active"
    start_date: str = ""
    end_date: str = ""
    # 初始成员（可选），写入 project_members 并同步旧字段
    project_ceo_ids: list[int] = []
    owner_ids: list[int] = []
    coordinator_ids: list[int] = []
    member_ids: list[int] = []


class ProjectPatchPayload(BaseModel):
    name: str | None = None
    code: str | None = None
    description: str | None = None
    status: str | None = None
    start_date: str | None = None
    end_date: str | None = None


class MeetingPayload(BaseModel):
    project_id: int | None = None
    related_special_project: str = ""
    meeting_type: str = ""
    title: str = ""
    meeting_date: str = ""
    host: str = ""
    participants: str = ""
    transcript_text: str = ""
    summary: str = ""
    task_list_json: str = ""
    decision_items_json: str = ""
    risk_items_json: str = ""
    publish_status: str = "draft"


class MeetingStatusPatch(BaseModel):
    publish_status: str
    reject_reason: str = ""


class SubTaskPayload(BaseModel):
    title: str
    assignee: str
    plan_time: str = ""
    status: str = "未开始"
    completion_criteria: str = ""
    notes: str = ""


class TaskOutlineExtractRequest(BaseModel):
    project_id: int | None = None
    text: str
    llm_provider: str | None = None
    project_names: list[str] = []


class TaskDraft(BaseModel):
    key_task: str
    owner: str = ""
    coordinator: str = ""
    collaborators: str = ""
    plan_time: str = ""
    status: str = "未开始"
    key_achievement: str = ""
    completion_standard: str = ""


class TaskBatchCreateRequest(BaseModel):
    project_id: int
    tasks: list[TaskDraft]
