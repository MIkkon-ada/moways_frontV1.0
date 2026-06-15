from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import and_, or_, text
from sqlalchemy.orm import Session

from .. import crud, models, schemas
from ..database import get_db
from ..permissions import (
    PROJECT_ROLE_COORDINATOR,
    PROJECT_ROLE_OWNER,
    can_view_project,
    get_all_project_roles,
    get_current_user_name,
    get_user_context_from_db,
    resolve_project_id,
)

router = APIRouter(prefix="/api/achievements", tags=["achievements"])

# ── 写权限：owner 或 coordinator 可直接编辑已入库事项（Path B）────
_WRITE_ROLES = {"owner", "coordinator"}


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

    legacy_role = context.get("project_roles", {}).get(proj_name, "")
    if proj_name and legacy_role in {PROJECT_ROLE_OWNER, PROJECT_ROLE_COORDINATOR}:
        return

    raise HTTPException(403, "permission denied — 仅项目负责人（owner）、统筹人（coordinator）或超级管理员可执行写操作")


def _row_project_id(row: models.Achievement, db: Session) -> int | None:
    if row.project_id is not None:
        return row.project_id
    return resolve_project_id(row.special_project or "", None, db)


# ── 端点 ──────────────────────────────────────────────────────

@router.get("")
def list_achievements(
    project_id: int | None = None,
    achievement_type: str | None = None,
    special_project: str | None = None,
    owner: str | None = None,
    reuse_tag: str | None = None,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    context = get_user_context_from_db(current_user, db)

    # ── 解析有效 project_id ───────────────────────────────────────
    effective_project_id: int | None = None
    if project_id is not None:
        effective_project_id = project_id
    elif special_project:
        effective_project_id = resolve_project_id(special_project, None, db)
        if effective_project_id is None:
            return []

    q = db.query(models.Achievement)

    # ── 权限：限制可见专项 ────────────────────────────────────────
    if not context["can_view_all"]:
        if not context["visible_projects"]:
            return []
        q = q.filter(models.Achievement.special_project.in_(context["visible_projects"]))

    # ── 项目过滤 ─────────────────────────────────────────────────
    if effective_project_id is not None:
        proj_name = crud.get_project_name_by_id(effective_project_id, db)
        if not proj_name or not can_view_project(context, proj_name):
            return []
        q = q.filter(
            or_(
                models.Achievement.project_id == effective_project_id,
                and_(models.Achievement.project_id.is_(None), models.Achievement.special_project == proj_name),
            )
        )
    elif special_project:
        if not can_view_project(context, special_project):
            return []
        q = q.filter(models.Achievement.special_project == special_project)

    if achievement_type:
        q = q.filter(models.Achievement.achievement_type == achievement_type)
    if owner:
        q = q.filter(models.Achievement.owner == owner)
    if reuse_tag:
        q = q.filter(models.Achievement.reuse_tag.like(f"%{reuse_tag}%"))
    return [crud.to_dict(r) for r in q.order_by(models.Achievement.updated_at.desc()).all()]


@router.post("")
def create_achievement(
    payload: schemas.AchievementPayload,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    # POST achievements: 仅 owner / super_admin（5C 收口）
    # member 提交成果应走 POST /api/updates，再经确认中心入库
    context = get_user_context_from_db(current_user, db)

    effective_project_id = resolve_project_id(payload.special_project, payload.project_id, db)
    if effective_project_id is None:
        raise HTTPException(422, "project_id is required (provide project_id or a valid special_project)")

    proj_name = crud.get_project_name_by_id(effective_project_id, db) or payload.special_project or ""
    _check_write(context, effective_project_id, proj_name, db)

    data = {k: v for k, v in payload.dict().items() if k != "project_id"}
    row = models.Achievement(**data)
    row.project_id = effective_project_id
    if not row.special_project:
        row.special_project = proj_name
    db.add(row)
    db.flush()
    crud.log(db, current_user, "新建成果", "achievement", row.id, {}, crud.to_dict(row))
    db.commit()
    db.refresh(row)
    return crud.to_dict(row)


@router.get("/{row_id}")
def get_achievement(
    row_id: int,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    context = get_user_context_from_db(current_user, db)
    row = db.get(models.Achievement, row_id)
    if not row:
        raise HTTPException(404, "achievement not found")
    if not can_view_project(context, row.special_project or ""):
        raise HTTPException(403, "permission denied")
    return crud.to_dict(row)


@router.put("/{row_id}")
def update_achievement(
    row_id: int,
    payload: schemas.AchievementPayload,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    context = get_user_context_from_db(current_user, db)
    row = db.get(models.Achievement, row_id)
    if not row:
        raise HTTPException(404, "achievement not found")

    project_id = _row_project_id(row, db)
    _check_write(context, project_id, row.special_project or "", db)

    before = crud.to_dict(row)
    update_data = {k: v for k, v in payload.dict().items() if k != "project_id"}
    crud.update_model(row, update_data)
    new_pid = resolve_project_id(payload.special_project, payload.project_id, db)
    if new_pid is not None:
        row.project_id = new_pid
    row.edit_count = (row.edit_count or 0) + 1
    effective_pid = row.project_id or project_id
    crud.log(db, current_user, "修改成果", "achievement", row.id, before, payload.dict(), project_id=effective_pid)
    db.commit()
    return crud.to_dict(row)


@router.delete("/{row_id}")
def delete_achievement(
    row_id: int,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    context = get_user_context_from_db(current_user, db)
    row = db.get(models.Achievement, row_id)
    if not row:
        raise HTTPException(404, "achievement not found")

    project_id = _row_project_id(row, db)
    _check_write(context, project_id, row.special_project or "", db)

    before = crud.to_dict(row)
    crud.log(db, current_user, "删除成果", "achievement", row_id, before, {})
    db.delete(row)
    db.commit()
    return {"ok": True}
