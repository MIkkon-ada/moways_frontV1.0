from fastapi import APIRouter, Depends, HTTPException
from datetime import datetime
from sqlalchemy.orm import Session

from sqlalchemy import text

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


def _check_project_member_create(context: dict, task: models.Task, db: Session) -> None:
    if context.get("is_tech_admin"):
        return
    project_id = _get_task_project_id(task, db)
    person_id = context.get("person_id")
    if project_id is not None and person_id is not None:
        if get_all_project_roles(person_id, project_id, db):
            return
        raise HTTPException(403, "permission denied")
    if can_view_project(context, task.special_project or ""):
        return
    raise HTTPException(403, "permission denied")


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
    row = models.SubTask(task_id=task_id, **payload.dict())
    db.add(row)
    db.flush()
    crud.log(db, current_user, "新建子任务", "subtask", row.id, {}, crud.to_dict(row))
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
    before = crud.to_dict(row)
    crud.update_model(row, payload.dict())
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
    before_status = row.status
    row.status = payload.status
    crud.log(db, current_user, "更新子任务状态", "subtask", row.id, {"status": before_status}, {"status": payload.status})
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
