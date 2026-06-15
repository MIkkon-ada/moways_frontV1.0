from fastapi import APIRouter, Depends, HTTPException
from datetime import datetime
from uuid import uuid4
from sqlalchemy import and_, or_, text
from sqlalchemy.orm import Session

from .. import crud, models, schemas
from ..database import get_db
from ..domain import task_status as TS
from ..permissions import (
    PROJECT_ROLE_COORDINATOR,
    PROJECT_ROLE_OWNER,
    can_view_project,
    get_all_project_roles,
    get_current_user_name,
    get_user_context_from_db,
    resolve_project_id,
)
from ..services.extractor import extract_tasks as _extract_tasks

router = APIRouter(prefix="/api/tasks", tags=["tasks"])


# ── 写权限：owner 或 coordinator 可直接编辑已入库事项（Path B）────
_WRITE_ROLES = {"owner", "coordinator"}
_TRASH_ROLES = {"owner"}


def _check_write(context: dict, project_id: int | None, proj_name: str, db: Session) -> None:
    """super_admin、项目 owner 或统筹人（coordinator）可写主数据。"""
    if context.get("is_tech_admin"):
        return

    person_id = context.get("person_id")
    if project_id is not None and person_id is not None:
        has_pm = db.execute(
            text("SELECT 1 FROM project_members WHERE project_id = :pid LIMIT 1"),
            {"pid": project_id},
        ).fetchone()
        if has_pm:
            if set(get_all_project_roles(person_id, project_id, db)) & _WRITE_ROLES:
                return
            raise HTTPException(403, "permission denied — 仅项目负责人（owner）、统筹人（coordinator）或超级管理员可执行写操作")

    # 过渡期回落：旧字符串字段
    legacy_role = context.get("project_roles", {}).get(proj_name, "")
    if proj_name and legacy_role in {PROJECT_ROLE_OWNER, PROJECT_ROLE_COORDINATOR}:
        return

    raise HTTPException(403, "permission denied — 仅项目负责人（owner）、统筹人（coordinator）或超级管理员可执行写操作")


def _check_trash_access(context: dict, project_id: int | None, proj_name: str, db: Session) -> None:
    """回收站相关操作仅项目 owner 或技术管理员可执行。"""
    if context.get("is_tech_admin"):
        return

    person_id = context.get("person_id")
    if project_id is not None and person_id is not None:
        has_pm = db.execute(
            text("SELECT 1 FROM project_members WHERE project_id = :pid LIMIT 1"),
            {"pid": project_id},
        ).fetchone()
        if has_pm:
            if set(get_all_project_roles(person_id, project_id, db)) & _TRASH_ROLES:
                return
            raise HTTPException(403, "permission denied — 仅项目负责人（owner）或超级管理员可访问回收站")

    legacy_role = context.get("project_roles", {}).get(proj_name, "")
    if proj_name and legacy_role in {PROJECT_ROLE_OWNER}:
        return

    raise HTTPException(403, "permission denied — 仅项目负责人（owner）或超级管理员可访问回收站")


def _row_project_id(row: models.Task, db: Session) -> int | None:
    if row.project_id is not None:
        return row.project_id
    return resolve_project_id(row.special_project or "", None, db)


def _assert_can_complete_from_subtasks(row: models.Task, db: Session) -> None:
    subtasks = db.query(models.SubTask).filter_by(task_id=row.id).all()
    if not subtasks:
        raise HTTPException(409, "关键任务完成前需要先拆解并完成子任务")
    if not all(TS.is_completed(sub.status) for sub in subtasks):
        raise HTTPException(409, "关键任务完成前必须先完成全部子任务")


def _task_is_deleted(row: models.Task) -> bool:
    return bool(getattr(row, "is_deleted", False))


def _soft_delete_task(row: models.Task, operator: str, reason: str = "", batch_id: str | None = None) -> str:
    batch = batch_id or uuid4().hex
    row.is_deleted = True
    row.deleted_at = datetime.utcnow()
    row.deleted_by = operator
    row.delete_reason = reason or ""
    row.delete_batch_id = batch
    return batch


def _restore_task(row: models.Task) -> None:
    row.is_deleted = False
    row.deleted_at = None
    row.deleted_by = ""
    row.delete_reason = ""
    row.delete_batch_id = ""


def _soft_delete_subtask(row: models.SubTask, operator: str, batch_id: str, parent_id: int, reason: str = "") -> None:
    row.is_deleted = True
    row.deleted_at = datetime.utcnow()
    row.deleted_by = operator
    row.delete_reason = reason or ""
    row.delete_batch_id = batch_id
    row.deleted_by_parent_id = parent_id


def _restore_subtask(row: models.SubTask) -> None:
    row.is_deleted = False
    row.deleted_at = None
    row.deleted_by = ""
    row.delete_reason = ""
    row.delete_batch_id = ""
    row.deleted_by_parent_id = None


# ── 端点 ──────────────────────────────────────────────────────

@router.get("")
def list_tasks(
    project_id: int | None = None,
    special_project: str | None = None,
    owner: str | None = None,
    status: str | None = None,
    month: str | None = None,
    deleted: bool = False,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    context = get_user_context_from_db(current_user, db)

    # ── 解析有效 project_id ───────────────────────────────────────
    # 策略：special_project 无法解析时返回 [] 而非 422，保证旧页面不崩溃
    effective_project_id: int | None = None
    if project_id is not None:
        effective_project_id = project_id
    elif special_project:
        effective_project_id = resolve_project_id(special_project, None, db)
        if effective_project_id is None:
            return []  # 传了 special_project 但解析不到项目 → 空列表

    if deleted and effective_project_id is None and not context.get("is_tech_admin"):
        raise HTTPException(403, "permission denied — 仅项目负责人（owner）或超级管理员可访问回收站")

    q = db.query(models.Task)
    q = q.filter(models.Task.is_deleted.is_(bool(deleted)))

    # ── 权限：限制可见专项（旧名字逻辑，覆盖 special_project 为 NULL 的旧数据）──
    if not context["can_view_all"]:
        if not context["visible_projects"]:
            return []
        q = q.filter(models.Task.special_project.in_(context["visible_projects"]))

    # ── 项目过滤 ─────────────────────────────────────────────────
    if effective_project_id is not None:
        proj_name = crud.get_project_name_by_id(effective_project_id, db)
        if not proj_name or not can_view_project(context, proj_name):
            return []
        if deleted:
            _check_trash_access(context, effective_project_id, proj_name, db)
        # 过渡期兼容：project_id 已回填的新数据 OR project_id 为 NULL 的旧数据
        q = q.filter(
            or_(
                models.Task.project_id == effective_project_id,
                and_(models.Task.project_id.is_(None), models.Task.special_project == proj_name),
            )
        )
    elif special_project:
        # 不应到达此分支（special_project 存在时 effective_project_id 已被赋值或已返回 []）
        if not can_view_project(context, special_project):
            return []
        if deleted:
            _check_trash_access(context, None, special_project, db)
        q = q.filter(models.Task.special_project == special_project)

    if owner:
        q = q.filter(models.Task.owner == owner)
    if status:
        q = q.filter(models.Task.status == status)
    if month:
        q = q.filter(models.Task.plan_time.like(f"{month}%"))
    if deleted:
        rows = q.order_by(models.Task.deleted_at.desc().nullslast(), models.Task.created_at.desc()).all()
    else:
        rows = q.order_by(models.Task.created_at.asc()).all()
    return [crud.to_dict(r) for r in rows]


@router.post("")
def create_task(
    payload: schemas.TaskPayload,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    context = get_user_context_from_db(current_user, db)

    effective_project_id = resolve_project_id(payload.special_project, payload.project_id, db)
    if effective_project_id is None:
        raise HTTPException(422, "project_id is required (provide project_id or a valid special_project)")

    proj_name = crud.get_project_name_by_id(effective_project_id, db) or payload.special_project or ""
    _check_write(context, effective_project_id, proj_name, db)

    data = {k: v for k, v in payload.dict().items() if k != "project_id"}
    row = models.Task(**data)
    row.project_id = effective_project_id
    if not row.special_project:
        row.special_project = proj_name
    db.add(row)
    db.flush()
    crud.log(db, current_user, "新建任务", "task", row.id, {}, crud.to_dict(row))
    db.commit()
    db.refresh(row)
    return crud.to_dict(row)


@router.get("/{row_id}")
def get_task(
    row_id: int,
    deleted: bool = False,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    context = get_user_context_from_db(current_user, db)
    row = db.get(models.Task, row_id)
    if not row:
        raise HTTPException(404, "task not found")
    if _task_is_deleted(row) != bool(deleted):
        raise HTTPException(404, "task not found")
    if deleted:
        _check_trash_access(context, _row_project_id(row, db), row.special_project or "", db)
    elif not can_view_project(context, row.special_project):
        raise HTTPException(403, "permission denied")
    return crud.to_dict(row)


@router.put("/{row_id}")
def update_task(
    row_id: int,
    payload: schemas.TaskPayload,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    context = get_user_context_from_db(current_user, db)
    row = db.get(models.Task, row_id)
    if not row:
        raise HTTPException(404, "task not found")

    project_id = _row_project_id(row, db)
    _check_trash_access(context, project_id, row.special_project or "", db)

    if TS.normalize(payload.status) == TS.S_COMPLETED:
        _assert_can_complete_from_subtasks(row, db)

    before = crud.to_dict(row)
    update_data = {k: v for k, v in payload.dict().items() if k != "project_id"}
    if "status" in update_data:
        update_data["status"] = TS.normalize(update_data["status"])
    crud.update_model(row, update_data)
    new_pid = resolve_project_id(payload.special_project, payload.project_id, db)
    if new_pid is not None:
        row.project_id = new_pid
    row.edit_count = (row.edit_count or 0) + 1
    effective_pid = row.project_id or project_id
    crud.log(db, current_user, "修改任务", "task", row.id, before, payload.dict(), project_id=effective_pid)
    db.commit()
    return crud.to_dict(row)


@router.delete("/{row_id}")
def delete_task(
    row_id: int,
    reason: str = "",
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    context = get_user_context_from_db(current_user, db)
    row = db.get(models.Task, row_id)
    if not row:
        raise HTTPException(404, "task not found")
    if _task_is_deleted(row):
        raise HTTPException(409, "task already deleted")

    project_id = _row_project_id(row, db)
    _check_trash_access(context, project_id, row.special_project or "", db)

    before = crud.to_dict(row)
    batch_id = _soft_delete_task(row, current_user, reason)
    crud.log(db, current_user, "删除任务(回收站)", "task", row_id, before, crud.to_dict(row),
             project_id=project_id, note=reason or "进入回收站")

    child_rows = (
        db.query(models.SubTask)
        .filter(models.SubTask.task_id == row_id, models.SubTask.is_deleted.is_(False))
        .all()
    )
    for child in child_rows:
        child_before = crud.to_dict(child)
        _soft_delete_subtask(child, current_user, batch_id, row_id, reason)
        crud.log(db, current_user, "删除子任务(随关键任务回收)", "subtask", child.id, child_before, crud.to_dict(child),
                 project_id=project_id, note=reason or "随关键任务进入回收站")

    db.commit()
    return {"ok": True}


@router.patch("/{row_id}/status")
def patch_status(
    row_id: int,
    payload: schemas.StatusRequest,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    context = get_user_context_from_db(current_user, db)
    row = db.get(models.Task, row_id)
    if not row:
        raise HTTPException(404, "task not found")
    if _task_is_deleted(row):
        raise HTTPException(409, "task is deleted")

    project_id = _row_project_id(row, db)
    _check_write(context, project_id, row.special_project or "", db)

    if TS.normalize(payload.status) == TS.S_COMPLETED:
        _assert_can_complete_from_subtasks(row, db)

    before_status = row.status
    row.status = TS.normalize(payload.status)
    row.edit_count = (row.edit_count or 0) + 1
    crud.log(db, current_user, "更新任务状态", "task", row.id,
             {"status": before_status}, {"status": payload.status},
             project_id=project_id)
    db.commit()
    return crud.to_dict(row)


@router.post("/{row_id}/restore")
def restore_task(
    row_id: int,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    context = get_user_context_from_db(current_user, db)
    row = db.get(models.Task, row_id)
    if not row:
        raise HTTPException(404, "task not found")
    if not _task_is_deleted(row):
        raise HTTPException(409, "task is not deleted")

    project_id = _row_project_id(row, db)
    _check_write(context, project_id, row.special_project or "", db)

    before = crud.to_dict(row)
    batch_id = row.delete_batch_id or ""
    _restore_task(row)
    crud.log(db, current_user, "恢复任务", "task", row.id, before, crud.to_dict(row), project_id=project_id)

    child_rows = (
        db.query(models.SubTask)
        .filter(
            models.SubTask.task_id == row.id,
            models.SubTask.is_deleted.is_(True),
            models.SubTask.deleted_by_parent_id == row.id,
        )
        .all()
    )
    for child in child_rows:
        if batch_id and child.delete_batch_id != batch_id:
            continue
        child_before = crud.to_dict(child)
        _restore_subtask(child)
        crud.log(
            db,
            current_user,
            "恢复子任务(随关键任务恢复)",
            "subtask",
            child.id,
            child_before,
            crud.to_dict(child),
            project_id=project_id,
        )

    db.commit()
    return {"ok": True, "task": crud.to_dict(row)}


@router.get("/{row_id}/logs")
def get_task_logs(
    row_id: int,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    _ = get_user_context_from_db(current_user, db)
    logs = (
        db.query(models.OperationLog)
        .filter_by(target_type="task", target_id=row_id)
        .order_by(models.OperationLog.created_at.asc())
        .limit(20)
        .all()
    )
    return [
        {
            "action": r.action,
            "operator": r.operator,
            "note": r.note or "",
            "created_at": r.created_at.strftime("%m-%d %H:%M") if r.created_at else "",
        }
        for r in logs
    ]


@router.get("/{row_id}/updates")
def get_task_updates(
    row_id: int,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    _ = get_user_context_from_db(current_user, db)
    rows = (
        db.query(models.UpdateSubmission)
        .filter_by(related_task_id=row_id)
        .order_by(models.UpdateSubmission.created_at.desc())
        .limit(10)
        .all()
    )
    return [
        {
            "id": r.id,
            "submitter": r.submitter,
            "transcript_text": (r.transcript_text or "")[:120],
            "created_at": r.created_at.strftime("%m-%d %H:%M") if r.created_at else "",
        }
        for r in rows
    ]


@router.post("/extract")
def extract_outline(
    payload: schemas.TaskOutlineExtractRequest,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    """从大纲文本 AI 提取任务草稿列表，不写库。登录用户均可调用；创建时再做写权限校验。"""
    try:
        result = _extract_tasks(payload.text, payload.llm_provider, payload.project_names)
    except RuntimeError as exc:
        raise HTTPException(502, str(exc))
    return result


@router.post("/batch")
def batch_create(
    payload: schemas.TaskBatchCreateRequest,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    """批量创建任务（大纲导入）。仅 owner/coordinator/super_admin 可调用。"""
    context = get_user_context_from_db(current_user, db)
    proj_name = crud.get_project_name_by_id(payload.project_id, db) or ""
    _check_write(context, payload.project_id, proj_name, db)

    created = []
    for draft in payload.tasks:
        if not draft.key_task.strip():
            continue
        row = models.Task(
            project_id=payload.project_id,
            special_project=proj_name,
            key_task=draft.key_task,
            owner=draft.owner,
            coordinator=draft.coordinator,
            collaborators=draft.collaborators,
            plan_time=draft.plan_time,
            status=draft.status or "未开始",
            key_achievement=draft.key_achievement,
            completion_standard=draft.completion_standard,
            source_type="大纲导入",
        )
        db.add(row)
        db.flush()
        crud.log(db, current_user, "大纲导入任务", "task", row.id, {}, crud.to_dict(row),
                 project_id=payload.project_id)
        created.append(crud.to_dict(row))
    db.commit()
    return created
