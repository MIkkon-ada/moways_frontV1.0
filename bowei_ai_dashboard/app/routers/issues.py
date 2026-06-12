from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import and_, or_, text
from sqlalchemy.orm import Session

from .. import crud, models, schemas
from ..database import get_db
from ..permissions import (
    PROJECT_ROLE_OWNER,
    can_view_issue_decisions,
    can_view_issue_risks,
    can_view_project,
    get_all_project_roles,
    get_current_user_name,
    get_user_context_from_db,
    resolve_project_id,
)

router = APIRouter(prefix="/api/issues", tags=["issues"])
_CLOSED_STATUSES = {"已关闭", "已决策", "已解决", "关闭"}

# ── 5C 写权限检查 ─────────────────────────────────────────────
_WRITE_ROLES = ["owner"]


def _check_write(context: dict, project_id: int | None, proj_name: str, db: Session) -> None:
    """
    写权限：仅 super_admin 或项目 owner 可写主数据。
    process_guard / coordinator / member / project_ceo 均不允许。
    """
    if context.get("is_tech_admin"):
        return

    person_id = context.get("person_id")
    if project_id is not None and person_id is not None:
        has_pm = db.execute(
            text("SELECT 1 FROM project_members WHERE project_id = :pid LIMIT 1"),
            {"pid": project_id},
        ).fetchone()
        if has_pm:
            if "owner" in get_all_project_roles(person_id, project_id, db):
                return
            raise HTTPException(403, "permission denied — 仅项目负责人（owner）或超级管理员可执行写操作")

    if proj_name and context.get("project_roles", {}).get(proj_name) == PROJECT_ROLE_OWNER:
        return

    raise HTTPException(403, "permission denied — 仅项目负责人（owner）或超级管理员可执行写操作")


def _row_project_id(row: models.Issue, db: Session) -> int | None:
    if row.project_id is not None:
        return row.project_id
    return resolve_project_id(row.special_project or "", None, db)


# ── 业务辅助 ──────────────────────────────────────────────────

def _is_decision_issue(row: models.Issue) -> bool:
    issue_type = (row.issue_type or "").strip()
    need_decision_by = (row.need_decision_by or "").strip()
    return "决策" in issue_type or bool(need_decision_by)


def _can_view_issue_row(context: dict, row: models.Issue) -> bool:
    if not can_view_project(context, row.special_project or ""):
        return False
    if _is_decision_issue(row):
        return can_view_issue_decisions(context)
    return can_view_issue_risks(context)


def _sync_issue_closed_at(row: models.Issue) -> None:
    if (row.status or "").strip() in _CLOSED_STATUSES:
        row.closed_at = row.closed_at or datetime.utcnow()
    else:
        row.closed_at = None


# ── 端点 ──────────────────────────────────────────────────────

@router.get("")
def list_issues(
    project_id: int | None = None,
    issue_type: str | None = None,
    special_project: str | None = None,
    owner: str | None = None,
    priority: str | None = None,
    status: str | None = None,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    context = get_user_context_from_db(current_user, db)
    if not (can_view_issue_risks(context) or can_view_issue_decisions(context)):
        return []

    # ── 解析有效 project_id ───────────────────────────────────────
    effective_project_id: int | None = None
    if project_id is not None:
        effective_project_id = project_id
    elif special_project:
        effective_project_id = resolve_project_id(special_project, None, db)
        if effective_project_id is None:
            return []  # 传了 special_project 但解析不到 → 空列表

    filter_proj_name: str | None = None
    if effective_project_id is not None:
        filter_proj_name = crud.get_project_name_by_id(effective_project_id, db) or special_project

    rows = db.query(models.Issue).order_by(models.Issue.updated_at.desc()).all()
    result = []
    for row in rows:
        if not _can_view_issue_row(context, row):
            continue

        if effective_project_id is not None:
            row_matches = (
                row.project_id == effective_project_id
                or (row.project_id is None and row.special_project == filter_proj_name)
            )
            if not row_matches:
                continue

        if issue_type:
            if issue_type in {"决策", "decision"} and not _is_decision_issue(row):
                continue
            if issue_type in {"问题", "风险", "problem"} and _is_decision_issue(row):
                continue
            if issue_type not in {"决策", "decision", "问题", "风险", "problem"} and (row.issue_type or "").strip() != issue_type:
                continue
        if owner and row.owner != owner:
            continue
        if priority and row.priority != priority:
            continue
        if status and row.status != status:
            continue
        result.append(crud.to_dict(row))
    return result


@router.post("")
def create_issue(
    payload: schemas.IssuePayload,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    # POST issues: 仅 owner / super_admin（5C 收口）
    # member 反馈问题应走 POST /api/updates，再经确认中心入库
    context = get_user_context_from_db(current_user, db)

    effective_project_id = resolve_project_id(payload.special_project, payload.project_id, db)
    if effective_project_id is None:
        raise HTTPException(422, "project_id is required (provide project_id or a valid special_project)")

    proj_name = crud.get_project_name_by_id(effective_project_id, db) or payload.special_project or ""
    _check_write(context, effective_project_id, proj_name, db)

    if "决策" in (payload.issue_type or "") and not can_view_issue_decisions(context):
        raise HTTPException(403, "permission denied")

    data = {k: v for k, v in payload.dict().items() if k != "project_id"}
    row = models.Issue(**data)
    row.project_id = effective_project_id
    if not row.special_project:
        row.special_project = proj_name
    _sync_issue_closed_at(row)
    db.add(row)
    db.flush()
    crud.log(db, current_user, "新建问题", "issue", row.id, {}, crud.to_dict(row))
    db.commit()
    db.refresh(row)
    return crud.to_dict(row)


@router.get("/{row_id}")
def get_issue(
    row_id: int,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    context = get_user_context_from_db(current_user, db)
    row = db.get(models.Issue, row_id)
    if not row:
        raise HTTPException(404, "issue not found")
    if not _can_view_issue_row(context, row):
        raise HTTPException(403, "permission denied")
    return crud.to_dict(row)


@router.put("/{row_id}")
def update_issue(
    row_id: int,
    payload: schemas.IssuePayload,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    context = get_user_context_from_db(current_user, db)
    row = db.get(models.Issue, row_id)
    if not row:
        raise HTTPException(404, "issue not found")
    if not _can_view_issue_row(context, row):
        raise HTTPException(403, "permission denied")

    project_id = _row_project_id(row, db)
    _check_write(context, project_id, row.special_project or "", db)

    before = crud.to_dict(row)
    update_data = {k: v for k, v in payload.dict().items() if k != "project_id"}
    crud.update_model(row, update_data)
    new_pid = resolve_project_id(payload.special_project, payload.project_id, db)
    if new_pid is not None:
        row.project_id = new_pid
    _sync_issue_closed_at(row)
    crud.log(db, current_user, "修改问题", "issue", row.id, before, payload.dict())
    db.commit()
    return crud.to_dict(row)


@router.delete("/{row_id}")
def delete_issue(
    row_id: int,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    context = get_user_context_from_db(current_user, db)
    row = db.get(models.Issue, row_id)
    if not row:
        raise HTTPException(404, "issue not found")
    if not _can_view_issue_row(context, row):
        raise HTTPException(403, "permission denied")

    project_id = _row_project_id(row, db)
    _check_write(context, project_id, row.special_project or "", db)

    before = crud.to_dict(row)
    crud.log(db, current_user, "删除问题", "issue", row_id, before, {})
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
    row = db.get(models.Issue, row_id)
    if not row:
        raise HTTPException(404, "issue not found")
    if not _can_view_issue_row(context, row):
        raise HTTPException(403, "permission denied")

    project_id = _row_project_id(row, db)
    _check_write(context, project_id, row.special_project or "", db)

    before_status = row.status
    row.status = payload.status
    _sync_issue_closed_at(row)
    crud.log(db, current_user, "更新问题状态", "issue", row.id, {"status": before_status}, {"status": payload.status})
    db.commit()
    return crud.to_dict(row)
