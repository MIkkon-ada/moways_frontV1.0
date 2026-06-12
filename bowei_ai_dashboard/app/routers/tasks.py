from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import and_, or_, text
from sqlalchemy.orm import Session

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

router = APIRouter(prefix="/api/tasks", tags=["tasks"])


# ── 5C 写权限检查 ─────────────────────────────────────────────
# 规则：super_admin / process_guard 直接通过；
#       project_members 已填充时严格限制 owner；
#       未填充时回落旧 can_write_project（过渡期兼容）。
_WRITE_ROLES = ["owner"]


def _check_write(context: dict, project_id: int | None, proj_name: str, db: Session) -> None:
    """
    写权限：仅 super_admin 或项目 owner 可写主数据。
    process_guard / coordinator / member / project_ceo 均不允许。
    """
    # super_admin（system_role=超级管理员 or is_admin=True）直接通过
    if context.get("is_tech_admin"):
        return

    person_id = context.get("person_id")
    if project_id is not None and person_id is not None:
        has_pm = db.execute(
            text("SELECT 1 FROM project_members WHERE project_id = :pid LIMIT 1"),
            {"pid": project_id},
        ).fetchone()
        if has_pm:
            # project_members 已填充：严格检查 owner 角色
            if "owner" in get_all_project_roles(person_id, project_id, db):
                return
            raise HTTPException(403, "permission denied — 仅项目负责人（owner）或超级管理员可执行写操作")

    # 过渡期回落：旧字符串字段，仅允许"项目负责人"（显式排除 process_guard）
    if proj_name and context.get("project_roles", {}).get(proj_name) == PROJECT_ROLE_OWNER:
        return

    raise HTTPException(403, "permission denied — 仅项目负责人（owner）或超级管理员可执行写操作")


def _row_project_id(row: models.Task, db: Session) -> int | None:
    if row.project_id is not None:
        return row.project_id
    return resolve_project_id(row.special_project or "", None, db)


# ── 端点 ──────────────────────────────────────────────────────

@router.get("")
def list_tasks(
    project_id: int | None = None,
    special_project: str | None = None,
    owner: str | None = None,
    status: str | None = None,
    month: str | None = None,
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

    q = db.query(models.Task)

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
        q = q.filter(models.Task.special_project == special_project)

    if owner:
        q = q.filter(models.Task.owner == owner)
    if status:
        q = q.filter(models.Task.status == status)
    if month:
        q = q.filter(models.Task.plan_time.like(f"{month}%"))
    return [crud.to_dict(r) for r in q.order_by(models.Task.created_at.asc()).all()]


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
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    context = get_user_context_from_db(current_user, db)
    row = db.get(models.Task, row_id)
    if not row:
        raise HTTPException(404, "task not found")
    if not can_view_project(context, row.special_project):
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
    _check_write(context, project_id, row.special_project or "", db)

    before = crud.to_dict(row)
    update_data = {k: v for k, v in payload.dict().items() if k != "project_id"}
    crud.update_model(row, update_data)
    new_pid = resolve_project_id(payload.special_project, payload.project_id, db)
    if new_pid is not None:
        row.project_id = new_pid
    crud.log(db, current_user, "修改任务", "task", row.id, before, payload.dict())
    db.commit()
    return crud.to_dict(row)


@router.delete("/{row_id}")
def delete_task(
    row_id: int,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    context = get_user_context_from_db(current_user, db)
    row = db.get(models.Task, row_id)
    if not row:
        raise HTTPException(404, "task not found")

    project_id = _row_project_id(row, db)
    _check_write(context, project_id, row.special_project or "", db)

    before = crud.to_dict(row)
    crud.log(db, current_user, "删除任务", "task", row_id, before, {})

    # 级联：删除关联问题
    db.query(models.Issue).filter(models.Issue.related_task_id == row_id).delete(synchronize_session=False)
    # 级联：解绑成果（保留成果，清除 task 引用）
    db.query(models.Achievement).filter(models.Achievement.related_task_id == row_id).update(
        {"related_task_id": None}, synchronize_session=False
    )

    db.delete(row)
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

    project_id = _row_project_id(row, db)
    _check_write(context, project_id, row.special_project or "", db)

    before_status = row.status
    row.status = payload.status
    crud.log(db, current_user, "更新任务状态", "task", row.id, {"status": before_status}, {"status": payload.status})
    db.commit()
    return crud.to_dict(row)


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
