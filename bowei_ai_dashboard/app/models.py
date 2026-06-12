from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, Float, ForeignKey, Integer, String, Text, UniqueConstraint

from .database import Base


def now():
    return datetime.utcnow()


class TimestampMixin:
    created_at = Column(DateTime, default=now)
    updated_at = Column(DateTime, default=now, onupdate=now)


class Task(Base, TimestampMixin):
    __tablename__ = "tasks"

    id = Column(Integer, primary_key=True, index=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=True, index=True)
    special_project = Column(String(80), index=True)
    key_task = Column(String(200), nullable=False)
    key_achievement = Column(String(200), default="")
    completion_standard = Column(Text, default="")
    coordinator = Column(String(50), default="")
    owner = Column(String(50), index=True)
    collaborators = Column(String(200), default="")
    plan_time = Column(String(20), index=True)
    status = Column(String(20), default="未开始", index=True)
    problem_note = Column(Text, default="")
    achievement_links = Column(Text, default="")
    source_type = Column(String(40), default="人工录入")
    submitter = Column(String(50), default="")
    confirmed_at = Column(DateTime, nullable=True)


class UpdateSubmission(Base, TimestampMixin):
    __tablename__ = "update_submissions"

    id = Column(Integer, primary_key=True, index=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=True, index=True)
    source_type = Column(String(40), index=True)
    submitter = Column(String(50), default="")
    title = Column(String(200), default="")
    transcript_text = Column(Text, nullable=False)
    ai_result_json = Column(Text, default="")
    human_result_json = Column(Text, default="")
    confirm_status = Column(String(20), default="待确认", index=True)
    confidence = Column(Float, default=0)
    related_task_id = Column(Integer, ForeignKey("tasks.id"), nullable=True)
    confirmed_by = Column(String(50), default="")
    confirmed_at = Column(DateTime, nullable=True)
    reject_reason = Column(Text, default="")
    coordinator_note = Column(Text, default="")
    ceo_note = Column(Text, default="")


class Meeting(Base, TimestampMixin):
    __tablename__ = "meetings"

    id = Column(Integer, primary_key=True, index=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=True, index=True)
    meeting_type = Column(String(40), default="")
    title = Column(String(200), default="")
    meeting_date = Column(String(20), default="")
    host = Column(String(50), default="")
    participants = Column(Text, default="")
    transcript_text = Column(Text, default="")
    summary = Column(Text, default="")
    task_list_json = Column(Text, default="")
    decision_items_json = Column(Text, default="")
    risk_items_json = Column(Text, default="")
    related_special_project = Column(String(80), default="")
    publish_status = Column(String(20), default="draft")


class Achievement(Base, TimestampMixin):
    __tablename__ = "achievements"

    id = Column(Integer, primary_key=True, index=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=True, index=True)
    name = Column(String(200), nullable=False)
    achievement_type = Column(String(40), index=True)
    special_project = Column(String(80), index=True)
    related_task_id = Column(Integer, ForeignKey("tasks.id"), nullable=True)
    owner = Column(String(50), index=True)
    version = Column(String(30), default="V0.1")
    file_link = Column(Text, default="")
    scenario = Column(Text, default="")
    reuse_tag = Column(String(80), default="")
    status = Column(String(20), default="草稿", index=True)
    source_type = Column(String(40), default="人工录入")
    confirmed_at = Column(DateTime, nullable=True)


class Issue(Base, TimestampMixin):
    __tablename__ = "issues"

    id = Column(Integer, primary_key=True, index=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=True, index=True)
    issue_type = Column(String(40), index=True)
    description = Column(Text, nullable=False)
    owner = Column(String(50), index=True)
    helper = Column(String(100), default="")
    priority = Column(String(10), default="中", index=True)
    status = Column(String(20), default="待处理", index=True)
    need_decision_by = Column(String(50), default="")
    expected_resolve_time = Column(String(20), default="")
    resolution = Column(Text, default="")
    closed_at = Column(DateTime, nullable=True)
    related_task_id = Column(Integer, ForeignKey("tasks.id"), nullable=True)
    special_project = Column(String(80), index=True)
    source_type = Column(String(40), default="人工录入")


class Project(Base, TimestampMixin):
    __tablename__ = "projects"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), nullable=False, unique=True, index=True)
    coordinator = Column(String(50), default="")
    owners = Column(String(200), default="")
    collaborators = Column(Text, default="")
    sort_order = Column(Integer, default=0)
    is_active = Column(Boolean, default=True)


class Person(Base, TimestampMixin):
    __tablename__ = "people"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(50), nullable=False, index=True)
    role = Column(String(40), default="")          # 职务描述，仅展示用
    system_role = Column(String(40), default="普通成员", index=True)  # 全局权限角色（组长CEO/过程保障/超级管理员/普通成员）
    department = Column(String(80), default="")
    special_project_duty = Column(Text, default="")
    permission = Column(String(40), default="查看")
    contact = Column(String(100), default="")
    is_active = Column(Boolean, default=True)
    is_admin = Column(Boolean, default=False)


class PlatformSettings(Base, TimestampMixin):
    __tablename__ = "platform_settings"

    id = Column(Integer, primary_key=True, default=1)  # 单行，始终 id=1
    data_json = Column(Text, default="{}")


class OperationLog(Base, TimestampMixin):
    __tablename__ = "operation_logs"

    id = Column(Integer, primary_key=True, index=True)
    project_id = Column(Integer, nullable=True, index=True)
    operator = Column(String(50), default="")
    action = Column(String(80), default="")
    target_type = Column(String(40), default="")
    target_id = Column(Integer, nullable=True)
    before_json = Column(Text, default="")
    after_json = Column(Text, default="")


class AuthSession(Base):
    __tablename__ = "auth_sessions"

    session_id = Column(String(64), primary_key=True, index=True)
    username = Column(String(50), nullable=False, index=True)
    created_at = Column(DateTime, nullable=False, default=now)
    expires_at = Column(DateTime, nullable=False, index=True)
    last_seen_at = Column(DateTime, nullable=False, default=now)


class SubTask(Base, TimestampMixin):
    __tablename__ = "subtasks"

    id = Column(Integer, primary_key=True, index=True)
    task_id = Column(Integer, ForeignKey("tasks.id"), nullable=False, index=True)
    title = Column(String(200), nullable=False)
    assignee = Column(String(50), nullable=False, index=True)
    plan_time = Column(String(20), default="")
    status = Column(String(20), default="未开始", index=True)
    completion_criteria = Column(Text, default="")
    notes = Column(Text, default="")


class ProjectMember(Base, TimestampMixin):
    __tablename__ = "project_members"

    id = Column(Integer, primary_key=True, index=True)
    project_id = Column(Integer, ForeignKey("projects.id"), nullable=False, index=True)
    person_id = Column(Integer, ForeignKey("people.id"), nullable=False, index=True)
    person_name_snapshot = Column(String(50), default="", index=True)
    role = Column(String(30), nullable=False, index=True)
    joined_at = Column(DateTime, default=now)
    note = Column(Text, default="")

    __table_args__ = (
        UniqueConstraint("project_id", "person_id", "role", name="uq_project_member_role"),
    )
