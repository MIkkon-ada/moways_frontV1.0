import json
from fastapi import APIRouter, Depends, HTTPException
from datetime import datetime
from sqlalchemy.orm import Session

from sqlalchemy import text

from .. import crud, models, schemas
from ..database import get_db
from ..domain import task_status as TS
from ..domain import submission_result_type as RT
from ..permissions import (
    PROJECT_ROLE_COORDINATOR,
    PROJECT_ROLE_OWNER,
    can_view_project,
    get_all_project_roles,
    get_current_user_name,
    get_user_context_from_db,
    resolve_project_id,
)

router = APIRouter(tags=["subtasks"])
_TRASH_ROLES = {"owner"}


def _get_task_project_id(task: models.Task, db: Session) -> int | None:
    if task.project_id is not None:
        return task.project_id
    return resolve_project_id(task.special_project or "", None, db)


def _check_owner_write(context: dict, task: models.Task, db: Session) -> None:
    if context.get("is_tech_admin"):
        return
    project_id = _get_task_project_id(task, db)
    person_id = context.get("person_id")
    if project_id is not None and person_id is not None:
        has_pm = db.execute(
            text("SELECT 1 FROM project_members WHERE project_id = :pid LIMIT 1"),
            {"pid": project_id},
        ).fetchone()
        if has_pm:
            if set(get_all_project_roles(person_id, project_id, db)) & {"owner", "coordinator"}:
                return
            raise HTTPException(403, "permission denied — 仅项目负责人（owner）、统筹人（coordinator）或超级管理员可管理子任务")
    # 旧字符串字段回落（project_members 未录入时）
    proj_name = task.special_project or ""
    if proj_name and context.get("project_roles", {}).get(proj_name) in {PROJECT_ROLE_OWNER, PROJECT_ROLE_COORDINATOR}:
        return
    raise HTTPException(403, "permission denied — 仅项目负责人（owner）、统筹人（coordinator）或超级管理员可管理子任务")


def _check_trash_access(context: dict, task: models.Task, db: Session) -> None:
    if context.get("is_tech_admin"):
        return
    project_id = _get_task_project_id(task, db)
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
    proj_name = task.special_project or ""
    if proj_name and context.get("project_roles", {}).get(proj_name) in {PROJECT_ROLE_OWNER}:
        return
    raise HTTPException(403, "permission denied — 仅项目负责人（owner）或超级管理员可访问回收站")


def _can_edit_subtask(context: dict, row: models.SubTask, task: models.Task, db: Session) -> bool:
    if context.get("is_tech_admin"):
        return True
    current_name = context.get("name") or ""
    if current_name and current_name == row.assignee:
        return True
    project_id = _get_task_project_id(task, db)
    person_id = context.get("person_id")
    if project_id is not None and person_id is not None:
        has_pm = db.execute(
            text("SELECT 1 FROM project_members WHERE project_id = :pid LIMIT 1"),
            {"pid": project_id},
        ).fetchone()
        if has_pm:
            return bool(set(get_all_project_roles(person_id, project_id, db)) & {"owner", "coordinator"})
    proj_name = task.special_project or ""
    return bool(proj_name and context.get("project_roles", {}).get(proj_name) in {PROJECT_ROLE_OWNER, PROJECT_ROLE_COORDINATOR})


def _is_privileged_write(context: dict, task: models.Task, db: Session) -> bool:
    """True if the current user is owner, coordinator, or tech_admin for this task's project.
    Returns False when the caller is only the subtask assignee (member role)."""
    if context.get("is_tech_admin"):
        return True
    project_id = _get_task_project_id(task, db)
    person_id = context.get("person_id")
    if project_id is not None and person_id is not None:
        has_pm = db.execute(
            text("SELECT 1 FROM project_members WHERE project_id = :pid LIMIT 1"),
            {"pid": project_id},
        ).fetchone()
        if has_pm:
            return bool(set(get_all_project_roles(person_id, project_id, db)) & {"owner", "coordinator"})
    proj_name = task.special_project or ""
    return bool(proj_name and context.get("project_roles", {}).get(proj_name) in {PROJECT_ROLE_OWNER, PROJECT_ROLE_COORDINATOR})


def _check_project_member_create(context: dict, task: models.Task, db: Session) -> None:
    """直接创建子任务：仅项目负责人（owner）、统筹人（coordinator）和技术管理员可操作。
    普通执行人（member 角色）请通过子任务草稿建议流程提交。"""
    if context.get("is_tech_admin"):
        return
    project_id = _get_task_project_id(task, db)
    person_id = context.get("person_id")
    if project_id is not None and person_id is not None:
        has_pm = db.execute(
            text("SELECT 1 FROM project_members WHERE project_id = :pid LIMIT 1"),
            {"pid": project_id},
        ).fetchone()
        if has_pm:
            if set(get_all_project_roles(person_id, project_id, db)) & {"owner", "coordinator"}:
                return
            raise HTTPException(
                403,
                "permission denied — 仅项目负责人（owner）或统筹人（coordinator）可直接创建子任务，"
                "普通执行人请通过草稿建议流程提交",
            )
    # 旧字符串字段回落（project_members 未录入时）
    proj_name = task.special_project or ""
    if proj_name and context.get("project_roles", {}).get(proj_name) in {PROJECT_ROLE_OWNER, PROJECT_ROLE_COORDINATOR}:
        return
    raise HTTPException(
        403,
        "permission denied — 仅项目负责人（owner）或统筹人（coordinator）可直接创建子任务，"
        "普通执行人请通过草稿建议流程提交",
    )


def _sync_parent_task_status(task: models.Task, db: Session, current_user: str) -> None:
    subtasks = db.query(models.SubTask).filter_by(task_id=task.id).filter(models.SubTask.is_deleted.is_(False)).all()
    next_status = TS.derive_parent_status(task.status, [row.status or "" for row in subtasks])
    if TS.normalize(task.status) == next_status:
        return
    before_status = task.status
    task.status = next_status
    task.edit_count = (task.edit_count or 0) + 1
    crud.log(
        db,
        current_user,
        "同步关键任务状态",
        "task",
        task.id,
        {"status": before_status},
        {"status": next_status},
        project_id=_get_task_project_id(task, db),
    )


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


@router.get("/api/subtasks")
def list_subtasks_global(
    assignee: str | None = None,
    project_id: int | None = None,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    """按 assignee / project_id 跨任务查询子任务，供确认中心选择目标子任务用。"""
    context = get_user_context_from_db(current_user, db)
    q = (
        db.query(models.SubTask, models.Task)
        .join(models.Task, models.SubTask.task_id == models.Task.id)
        .filter(
            models.SubTask.is_deleted.is_(False),
            models.Task.is_deleted.is_(False),
        )
    )
    if assignee:
        q = q.filter(models.SubTask.assignee == assignee)
    if project_id is not None:
        q = q.filter(models.Task.project_id == project_id)
    rows = q.order_by(models.Task.id.asc(), models.SubTask.created_at.asc()).all()
    result = []
    for subtask, task in rows:
        if not can_view_project(context, task.special_project or ""):
            continue
        d = crud.to_dict(subtask)
        d["parent_key_task"] = task.key_task
        d["parent_task_id"] = task.id
        d["parent_project_id"] = task.project_id
        d["parent_special_project"] = task.special_project or ""
        result.append(d)
    return result


@router.get("/api/tasks/{task_id}/subtasks")
def list_subtasks(
    task_id: int,
    deleted: bool = False,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    context = get_user_context_from_db(current_user, db)
    task = db.get(models.Task, task_id)
    if not task:
        raise HTTPException(404, "task not found")
    if bool(getattr(task, "is_deleted", False)) and not deleted:
        raise HTTPException(404, "task not found")
    if not can_view_project(context, task.special_project or ""):
        raise HTTPException(403, "permission denied")
    if deleted:
        _check_trash_access(context, task, db)
    rows = (
        db.query(models.SubTask)
        .filter_by(task_id=task_id)
        .filter(models.SubTask.is_deleted.is_(bool(deleted)))
        .order_by(models.SubTask.created_at.asc())
        .all()
    )
    return [crud.to_dict(r) for r in rows]


@router.get("/api/subtasks/{row_id}/detail")
def get_subtask_detail(
    row_id: int,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    """子任务详情，附带溯源的提交记录信息。"""
    row = db.get(models.SubTask, row_id)
    if not row or row.is_deleted:
        raise HTTPException(404, "subtask not found")

    # 通过父关键任务校验项目可见性
    parent = db.get(models.Task, row.task_id)
    if parent:
        context = get_user_context_from_db(current_user, db)
        if not can_view_project(context, parent.special_project):
            raise HTTPException(403, "permission denied")

    result = crud.to_dict(row)

    # 关联父级关键任务
    if parent:
        result["parent_task"] = {
            "id": parent.id,
            "key_task": parent.key_task,
            "special_project": parent.special_project,
        }

    # 溯源：来源提交记录
    if row.source_submission_id:
        sub = db.get(models.UpdateSubmission, row.source_submission_id)
        if sub:
            import json as _json
            ai_raw = {}
            try:
                ai_raw = _json.loads(sub.ai_result_json or "{}")
            except Exception:
                pass
            completed = ai_raw.get("completed_items") or []
            result["source_submission"] = {
                "id": sub.id,
                "submitter": sub.submitter,
                "source_type": sub.source_type,
                "title": sub.title,
                "created_at": sub.created_at.isoformat() if sub.created_at else None,
                "summary": ai_raw.get("summary") or ai_raw.get("related_task") or "",
                "completed_items": completed if isinstance(completed, list) else [],
                "transcript_text": (sub.transcript_text or "")[:500],
            }

    # 关联成果（父级关键任务下的所有成果）
    achievements = (
        db.query(models.Achievement)
        .filter(models.Achievement.related_task_id == row.task_id)
        .order_by(models.Achievement.created_at.desc())
        .limit(10)
        .all()
    )
    result["related_achievements"] = [
        {
            "id": a.id,
            "name": a.name,
            "achievement_type": a.achievement_type,
            "status": a.status,
            "owner": a.owner,
            "version": a.version,
            "created_at": a.created_at.isoformat() if a.created_at else None,
        }
        for a in achievements
    ]

    # 关联问题（父级关键任务下的所有问题）
    issues = (
        db.query(models.Issue)
        .filter(models.Issue.related_task_id == row.task_id)
        .order_by(models.Issue.created_at.desc())
        .limit(10)
        .all()
    )
    result["related_issues"] = [
        {
            "id": i.id,
            "description": i.description,
            "issue_type": i.issue_type,
            "status": i.status,
            "priority": i.priority,
            "owner": i.owner,
            "created_at": i.created_at.isoformat() if i.created_at else None,
        }
        for i in issues
    ]

    return result


@router.post("/api/tasks/{task_id}/subtasks")
def create_subtask(
    task_id: int,
    payload: schemas.SubTaskPayload,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    context = get_user_context_from_db(current_user, db)
    task = db.get(models.Task, task_id)
    if not task:
        raise HTTPException(404, "task not found")
    if bool(getattr(task, "is_deleted", False)):
        raise HTTPException(409, "task is deleted")
    _check_project_member_create(context, task, db)

    # D: 有负责人且状态为未开始时，自动进入进行中
    data = payload.dict()
    if (data.get("assignee") or "").strip() and TS.normalize(data.get("status", "")) == TS.S_NOT_STARTED:
        data["status"] = TS.S_IN_PROGRESS

    # E: 若父级关键任务已完成，记录需要重新打开（在 flush 之前先记录原始状态）
    parent_was_completed = TS.normalize(task.status) == TS.S_COMPLETED

    row = models.SubTask(task_id=task_id, **data)
    db.add(row)
    db.flush()
    crud.log(db, current_user, "新建子任务", "subtask", row.id, {}, crud.to_dict(row),
             project_id=_get_task_project_id(task, db))

    # E: 已完成关键任务新增子任务后自动重新打开为进行中，并写操作日志
    if parent_was_completed:
        before_task_status = task.status
        task.status = TS.S_IN_PROGRESS
        task.edit_count = (task.edit_count or 0) + 1
        crud.log(
            db, current_user, "关键任务重新打开", "task", task.id,
            {"status": before_task_status}, {"status": TS.S_IN_PROGRESS},
            project_id=_get_task_project_id(task, db),
            note="已完成关键任务因新增子任务自动重新打开为进行中",
        )

    _sync_parent_task_status(task, db, current_user)
    db.commit()
    db.refresh(row)
    return crud.to_dict(row)


@router.patch("/api/subtasks/{row_id}")
def update_subtask(
    row_id: int,
    payload: schemas.SubTaskPayload,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    context = get_user_context_from_db(current_user, db)
    row = db.get(models.SubTask, row_id)
    if not row:
        raise HTTPException(404, "subtask not found")
    task = db.get(models.Task, row.task_id)
    if not task:
        raise HTTPException(404, "parent task not found")
    if bool(getattr(row, "is_deleted", False)):
        raise HTTPException(404, "subtask not found")
    if bool(getattr(task, "is_deleted", False)):
        raise HTTPException(409, "parent task is deleted")
    if not _can_edit_subtask(context, row, task, db):
        raise HTTPException(403, "permission denied")

    # C: assignee-only 不能通过整体更新接口直接修改状态
    if not _is_privileged_write(context, task, db):
        new_status = TS.normalize(payload.status) if payload.status else ""
        if new_status and new_status != TS.normalize(row.status or ""):
            raise HTTPException(
                403,
                "permission denied — 子任务负责人修改状态请使用 PATCH /api/subtasks/{id}/status，"
                "变更将进入确认中心等待项目负责人确认",
            )

    before = crud.to_dict(row)
    before_assignee = (row.assignee or "").strip()
    crud.update_model(row, payload.dict())

    # D: assignee 从空变为非空时，若当前状态为未开始则自动进入进行中
    if not before_assignee and (row.assignee or "").strip():
        if TS.normalize(row.status) == TS.S_NOT_STARTED:
            row.status = TS.S_IN_PROGRESS

    crud.log(db, current_user, "修改子任务", "subtask", row.id, before, payload.dict())
    _sync_parent_task_status(task, db, current_user)
    db.commit()
    return crud.to_dict(row)


@router.patch("/api/subtasks/{row_id}/status")
def patch_subtask_status(
    row_id: int,
    payload: schemas.StatusRequest,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    context = get_user_context_from_db(current_user, db)
    row = db.get(models.SubTask, row_id)
    if not row:
        raise HTTPException(404, "subtask not found")
    task = db.get(models.Task, row.task_id)
    if not task:
        raise HTTPException(404, "parent task not found")
    if bool(getattr(row, "is_deleted", False)):
        raise HTTPException(404, "subtask not found")
    if bool(getattr(task, "is_deleted", False)):
        raise HTTPException(409, "parent task is deleted")
    if not _can_edit_subtask(context, row, task, db):
        raise HTTPException(403, "permission denied")

    before_status = row.status or ""
    project_id = _get_task_project_id(task, db)

    # C: assignee-only（非 owner/coordinator/admin）的状态变更路由到确认中心
    if not _is_privileged_write(context, task, db):
        sub = models.UpdateSubmission(
            project_id=project_id,
            source_type="子任务状态变更",
            submitter=current_user,
            title=f"子任务状态变更请求：{row.title[:80]}",
            transcript_text=(
                f"子任务「{row.title}」申请将状态从「{before_status}」变更为「{payload.status}」"
            ),
            ai_result_json=json.dumps(
                {
                    "result_type": RT.TYPE_SUBTASK_STATUS_UPDATE,
                    "project_id": project_id,
                    "special_project": getattr(task, "special_project", "") or "",
                    "task_id": row.task_id,
                    "key_task": getattr(task, "key_task", "") or "",
                    "subtask_id": row.id,
                    "subtask_title": row.title,
                    "from_status": before_status,
                    "to_status": payload.status,
                    "suggested_status": payload.status,
                },
                ensure_ascii=False,
            ),
            human_result_json="",
            confirm_status="待确认",
            confidence=0.9,
            related_task_id=row.task_id,
        )
        db.add(sub)
        db.flush()
        crud.log(
            db, current_user, "子任务状态变更进入确认中心", "subtask", row.id,
            {"status": before_status}, {"pending_status": payload.status},
            project_id=project_id,
        )
        db.commit()
        return {"status": "pending_confirmation", "submission_id": sub.id}

    # owner / coordinator / admin: 直接变更
    row.status = payload.status
    crud.log(
        db, current_user, "子任务状态直接变更", "subtask", row.id,
        {"status": before_status}, {"status": payload.status},
        project_id=project_id,
    )
    _sync_parent_task_status(task, db, current_user)
    db.commit()
    return crud.to_dict(row)


@router.delete("/api/subtasks/{row_id}")
def delete_subtask(
    row_id: int,
    reason: str = "",
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    context = get_user_context_from_db(current_user, db)
    row = db.get(models.SubTask, row_id)
    if not row:
        raise HTTPException(404, "subtask not found")
    task = db.get(models.Task, row.task_id)
    if not task:
        raise HTTPException(404, "parent task not found")
    if bool(getattr(row, "is_deleted", False)):
        raise HTTPException(409, "subtask already deleted")
    _check_trash_access(context, task, db)
    before = crud.to_dict(row)
    batch_id = row.delete_batch_id or f"subtask-{row.id}"
    _soft_delete_subtask(row, current_user, batch_id, task.id, reason)
    crud.log(db, current_user, "删除子任务(回收站)", "subtask", row.id, before, crud.to_dict(row),
             project_id=_get_task_project_id(task, db), note=reason or "进入回收站")
    db.flush()
    _sync_parent_task_status(task, db, current_user)
    db.commit()
    return {"ok": True}


@router.post("/api/subtasks/{row_id}/restore")
def restore_subtask(
    row_id: int,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    context = get_user_context_from_db(current_user, db)
    row = db.get(models.SubTask, row_id)
    if not row:
        raise HTTPException(404, "subtask not found")
    if not bool(getattr(row, "is_deleted", False)):
        raise HTTPException(409, "subtask is not deleted")
    task = db.get(models.Task, row.task_id)
    if not task:
        raise HTTPException(404, "parent task not found")
    if bool(getattr(task, "is_deleted", False)):
        raise HTTPException(409, "parent task is deleted")
    _check_trash_access(context, task, db)

    before = crud.to_dict(row)
    _restore_subtask(row)
    crud.log(db, current_user, "恢复子任务", "subtask", row.id, before, crud.to_dict(row),
             project_id=_get_task_project_id(task, db))
    db.flush()
    _sync_parent_task_status(task, db, current_user)
    db.commit()
    return {"ok": True, "subtask": crud.to_dict(row)}
