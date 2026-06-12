from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from sqlalchemy import text

from .. import crud, models, schemas
from ..database import get_db
from ..permissions import (
    PROJECT_ROLE_OWNER,
    can_view_project,
    get_all_project_roles,
    get_current_user_name,
    get_user_context_from_db,
    resolve_project_id,
)

router = APIRouter(tags=["subtasks"])


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
            if "owner" in get_all_project_roles(person_id, project_id, db):
                return
            raise HTTPException(403, "permission denied — 仅项目负责人（owner）或超级管理员可管理子任务")
    # 旧字符串字段回落（project_members 未录入时）
    proj_name = task.special_project or ""
    if proj_name and context.get("project_roles", {}).get(proj_name) == PROJECT_ROLE_OWNER:
        return
    raise HTTPException(403, "permission denied — 仅项目负责人（owner）或超级管理员可管理子任务")


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
            return "owner" in get_all_project_roles(person_id, project_id, db)
    proj_name = task.special_project or ""
    return bool(proj_name and context.get("project_roles", {}).get(proj_name) == PROJECT_ROLE_OWNER)


@router.get("/api/tasks/{task_id}/subtasks")
def list_subtasks(
    task_id: int,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    context = get_user_context_from_db(current_user, db)
    task = db.get(models.Task, task_id)
    if not task:
        raise HTTPException(404, "task not found")
    if not can_view_project(context, task.special_project or ""):
        raise HTTPException(403, "permission denied")
    rows = (
        db.query(models.SubTask)
        .filter_by(task_id=task_id)
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
    _check_owner_write(context, task, db)
    row = models.SubTask(task_id=task_id, **payload.dict())
    db.add(row)
    db.flush()
    crud.log(db, current_user, "新建子任务", "subtask", row.id, {}, crud.to_dict(row))
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
    if not _can_edit_subtask(context, row, task, db):
        raise HTTPException(403, "permission denied")
    before = crud.to_dict(row)
    crud.update_model(row, payload.dict())
    crud.log(db, current_user, "修改子任务", "subtask", row.id, before, payload.dict())
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
    if not _can_edit_subtask(context, row, task, db):
        raise HTTPException(403, "permission denied")
    before_status = row.status
    row.status = payload.status
    crud.log(db, current_user, "更新子任务状态", "subtask", row.id, {"status": before_status}, {"status": payload.status})
    db.commit()
    return crud.to_dict(row)


@router.delete("/api/subtasks/{row_id}")
def delete_subtask(
    row_id: int,
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
    _check_owner_write(context, task, db)
    before = crud.to_dict(row)
    crud.log(db, current_user, "删除子任务", "subtask", row.id, before, {})
    db.delete(row)
    db.commit()
    return {"ok": True}
