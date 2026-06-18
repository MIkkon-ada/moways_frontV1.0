from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import crud, models, schemas
from ..database import get_db
from ..permissions import get_current_user_name, get_user_context_from_db

router = APIRouter(prefix="/api/subtask-drafts", tags=["subtask-drafts"])


def _now():
    return datetime.utcnow()


def _draft_dict(d: models.SubTaskDraft) -> dict:
    result = crud.to_dict(d)
    # 附带父任务信息方便前端展示
    return result


@router.post("")
def create_drafts(
    payload: schemas.SubTaskDraftsPayload,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    """语音更新确认时，批量保存下周计划为草稿子任务。"""
    created = []
    for item in payload.drafts:
        if not item.title.strip():
            continue
        draft = models.SubTaskDraft(
            project_id=payload.project_id,
            parent_task_id=item.parent_task_id,
            title=item.title.strip(),
            proposer=current_user,
            assignee=item.assignee or current_user,
            plan_time=item.plan_time or "",
            status="pending",
            source_submission_id=payload.source_submission_id,
            created_at=_now(),
            updated_at=_now(),
        )
        db.add(draft)
        created.append(draft)
    db.commit()
    for d in created:
        db.refresh(d)
    return [_draft_dict(d) for d in created]


@router.get("")
def list_drafts(
    project_id: int | None = None,
    status: str = "pending",
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    """
    owner/coordinator/超管 查询待审批草稿列表。
    status 可传 pending / approved / rejected / all。
    """
    context = get_user_context_from_db(current_user, db)
    is_admin = context.get("is_tech_admin", False)

    q = db.query(models.SubTaskDraft)
    if project_id is not None:
        q = q.filter(models.SubTaskDraft.project_id == project_id)
    if status != "all":
        q = q.filter(models.SubTaskDraft.status == status)
    q = q.order_by(models.SubTaskDraft.created_at.desc())
    rows = q.all()

    # 非超管只能看自己项目的（通过 project_id 过滤已经限制了）
    # 如果没有传 project_id，非超管只能看自己提交或分配给自己的
    if not is_admin and project_id is None:
        rows = [r for r in rows if r.proposer == current_user or r.assignee == current_user]

    result = []
    for d in rows:
        item = _draft_dict(d)
        # 附带父任务标题
        if d.parent_task_id:
            task = db.get(models.Task, d.parent_task_id)
            item["parent_task_title"] = task.key_task if task else ""
            item["parent_task_project"] = task.special_project if task else ""
        else:
            item["parent_task_title"] = ""
            item["parent_task_project"] = ""
        result.append(item)
    return result


@router.post("/{draft_id}/approve")
def approve_draft(
    draft_id: int,
    payload: schemas.SubTaskDraftApprovePayload,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    """
    owner/coordinator/超管 审批通过：自动创建正式子任务。
    """
    context = get_user_context_from_db(current_user, db)
    draft = db.get(models.SubTaskDraft, draft_id)
    if not draft:
        raise HTTPException(404, "draft not found")
    if draft.status != "pending":
        raise HTTPException(400, f"draft is already {draft.status}")

    parent_task_id = payload.parent_task_id or draft.parent_task_id
    if not parent_task_id:
        raise HTTPException(422, "parent_task_id is required")

    task = db.get(models.Task, parent_task_id)
    if not task:
        raise HTTPException(404, "parent task not found")

    # 权限校验：must be owner / coordinator / admin of that task's project
    is_admin = context.get("is_tech_admin", False)
    if not is_admin:
        pid = task.project_id
        member = (
            db.query(models.ProjectMember)
            .filter(
                models.ProjectMember.project_id == pid,
                models.ProjectMember.person_name_snapshot == current_user,
                models.ProjectMember.role.in_(["owner", "coordinator", "project_ceo"]),
            )
            .first()
        )
        if not member:
            raise HTTPException(403, "只有负责人或统筹人可以审批草稿子任务")

    # 创建正式子任务
    subtask = models.SubTask(
        task_id=parent_task_id,
        title=draft.title,
        assignee=payload.assignee or draft.assignee or draft.proposer,
        plan_time=payload.plan_time or draft.plan_time or "",
        status="未开始",
        source_submission_id=draft.source_submission_id,
        created_at=_now(),
        updated_at=_now(),
    )
    db.add(subtask)

    draft.status = "approved"
    draft.updated_at = _now()
    db.commit()
    db.refresh(subtask)

    return {"ok": True, "subtask_id": subtask.id, "draft_id": draft_id}


@router.post("/{draft_id}/reject")
def reject_draft(
    draft_id: int,
    payload: schemas.SubTaskDraftRejectPayload,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    context = get_user_context_from_db(current_user, db)
    draft = db.get(models.SubTaskDraft, draft_id)
    if not draft:
        raise HTTPException(404, "draft not found")
    if draft.status != "pending":
        raise HTTPException(400, f"draft is already {draft.status}")

    is_admin = context.get("is_tech_admin", False)
    if not is_admin:
        pid = draft.project_id
        member = (
            db.query(models.ProjectMember)
            .filter(
                models.ProjectMember.project_id == pid,
                models.ProjectMember.person_name_snapshot == current_user,
                models.ProjectMember.role.in_(["owner", "coordinator", "project_ceo"]),
            )
            .first()
        )
        if not member:
            raise HTTPException(403, "只有负责人或统筹人可以驳回草稿子任务")

    draft.status = "rejected"
    draft.reject_reason = payload.reason or ""
    draft.updated_at = _now()
    db.commit()
    return {"ok": True}


@router.delete("/{draft_id}")
def delete_draft(
    draft_id: int,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    """提交人可以撤回自己的草稿（pending 状态）。"""
    context = get_user_context_from_db(current_user, db)
    draft = db.get(models.SubTaskDraft, draft_id)
    if not draft:
        raise HTTPException(404, "draft not found")
    if draft.proposer != current_user and not context.get("is_tech_admin"):
        raise HTTPException(403, "只能删除自己提交的草稿")
    db.delete(draft)
    db.commit()
    return {"ok": True}
