import json
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import crud, models, schemas
from ..database import get_db
from ..domain import submission_status as SS
from ..permissions import (
    can_access_confirmation_center,
    can_assign_submission,
    get_current_user_name,
    get_user_context_from_db,
    resolve_project_id,
)
from ..services import policy as P
from ..services import workflow as W

router = APIRouter(prefix="/api/confirmations", tags=["confirmations"])

# ── Confirmation-center tab mapping ──────────────────────────
TAB_STATUS_MAP: dict[str, frozenset[str]] = {
    "待审核": SS.TAB_PENDING_REVIEW,
    "流转中": SS.TAB_IN_FLIGHT,
    "已完成": SS.TAB_COMPLETED,
    "ceo":    SS.TAB_CEO_PENDING,
}

_WITHDRAWABLE_STATUSES = SS.WITHDRAWABLE
_ACTIVE_STATUSES       = list(SS.ALL_ACTIVE)


def _load_submission(db: Session, submission_id: int) -> models.UpdateSubmission:
    row = db.get(models.UpdateSubmission, submission_id)
    if not row:
        raise HTTPException(404, "confirmation not found")
    return row


def _require_confirmation_center(context: dict) -> None:
    if not can_access_confirmation_center(context):
        raise HTTPException(403, "permission denied")


# ── Endpoints ─────────────────────────────────────────────────

@router.get("/my-rejected")
def my_rejected(
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    """任意登录用户：查询打回给自己的提交，用于首页提醒。"""
    rows = (
        db.query(models.UpdateSubmission)
        .filter(models.UpdateSubmission.submitter == current_user)
        .order_by(models.UpdateSubmission.updated_at.desc())
        .all()
    )
    result = []
    for row in rows:
        if W.submission_status(row) not in (SS.RETURNED_TO_SUBMITTER | SS.WITHDRAWN):
            continue
        human = W.submission_result(row)
        item = crud.to_dict(row)
        item["special_project"] = human.get("special_project") or (human.get("task") or {}).get("special_project", "")
        result.append(item)
    return result


@router.get("/counts")
def counts(
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    context = get_user_context_from_db(current_user, db)
    _require_confirmation_center(context)
    rows = db.query(models.UpdateSubmission).all()
    visible_rows = [
        row for row in rows
        if P.can_view_in_center(context, row, db)
        and P.role_allows_pending_view(context, row, db)
    ]
    return {
        tab: sum(1 for row in visible_rows if W.submission_status(row) in statuses)
        for tab, statuses in TAB_STATUS_MAP.items()
    }


@router.get("/pending")
def pending(
    tab: str = "待审核",
    project_id: int | None = None,
    special_project: str | None = None,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    context = get_user_context_from_db(current_user, db)
    _require_confirmation_center(context)
    status_filter = TAB_STATUS_MAP.get(tab, TAB_STATUS_MAP["待审核"])

    effective_project_id: int | None = None
    if project_id is not None:
        effective_project_id = project_id
    elif special_project:
        effective_project_id = resolve_project_id(special_project, None, db)
        if effective_project_id is None:
            return []

    rows = (
        db.query(models.UpdateSubmission)
        .order_by(models.UpdateSubmission.updated_at.desc())
        .all()
    )
    result = []
    for row in rows:
        if W.submission_status(row) not in status_filter:
            continue
        if not P.can_view_in_center(context, row, db):
            continue
        sub_proj_id = P.project_id_of(row)
        if effective_project_id is not None and sub_proj_id != effective_project_id:
            continue
        if not P.role_allows_pending_view(context, row, db, proj_id=sub_proj_id):
            continue
        human = W.submission_result(row)
        item = crud.to_dict(row)
        item["special_project"] = human.get("special_project") or (human.get("task") or {}).get("special_project", "")
        item["related_task"] = human.get("related_task") or (human.get("task") or {}).get("key_task", "")
        result.append(item)
    return result


@router.get("/{submission_id}")
def detail(
    submission_id: int,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    context = get_user_context_from_db(current_user, db)
    _require_confirmation_center(context)
    row = _load_submission(db, submission_id)
    if not P.can_view_in_center(context, row, db):
        raise HTTPException(403, "permission denied")
    data = crud.to_dict(row)
    data["ai_result"] = W.json_or_empty(row.ai_result_json)
    data["human_result"] = W.submission_result(row)
    return data


@router.post("/{submission_id}/save")
def save(
    submission_id: int,
    payload: schemas.ConfirmationSaveRequest,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    row = _load_submission(db, submission_id)
    context = get_user_context_from_db(current_user, db)
    _require_confirmation_center(context)
    if not (P.can_confirm(context, row, db) or can_assign_submission(context)):
        raise HTTPException(403, "permission denied")
    before = crud.to_dict(row)
    row.human_result_json = json.dumps(payload.human_result, ensure_ascii=False)
    row.confirm_status = SS.S_NEEDS_REVISION
    crud.log(db, current_user or "管理员", "保存确认修改", "confirmation", row.id, before, payload.human_result)
    db.commit()
    return {"ok": True, "submission": crud.to_dict(row)}


@router.post("/{submission_id}/confirm")
def confirm(
    submission_id: int,
    payload: schemas.ConfirmRequest,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    row = _load_submission(db, submission_id)
    W.require_project_id(row)
    context = get_user_context_from_db(current_user or payload.operator, db)
    _require_confirmation_center(context)
    if not P.can_confirm(context, row, db):
        raise HTTPException(403, "permission denied — 仅项目负责人（owner）或管理员可确认入库")
    W.require_submission_status(row, SS.OWNER_ACTIONABLE)
    before = crud.to_dict(row)

    effective_project_id = P.project_id_of(row)
    now = datetime.utcnow()
    data = W.submission_result(row)

    # Merge human_result from frontend (contains field edits and write-flags)
    if payload.human_result:
        hr = payload.human_result
        for k, v in hr.items():
            if k not in ("task", "achievements", "issues"):
                data[k] = v
        if "task" in hr and isinstance(hr["task"], dict):
            data["task"] = {**(data.get("task") or {}), **hr["task"]}
        if "achievements" in hr:
            data["achievements"] = hr["achievements"]
        if "issues" in hr:
            data["issues"] = hr["issues"]
        row.human_result_json = json.dumps(data, ensure_ascii=False)

    task_id = row.related_task_id
    task_data = data.get("task") or {}
    task_before: dict = {}
    existing_task = None
    if task_id:
        existing_task = db.get(models.Task, task_id)
        if existing_task:
            task_before = crud.to_dict(existing_task)

    write_task = str(task_data.pop("write_task", "true")).lower() != "false"
    task = None
    if write_task and task_data.get("key_task"):
        task = models.Task(**W.filtered_fields(models.Task, task_data))
        task.source_type = row.source_type
        task.submitter = row.submitter
        task.confirmed_by = payload.operator
        task.confirmed_at = now
        task.source_submission_id = row.id          # Task 4: traceability
        if effective_project_id and not task.project_id:
            task.project_id = effective_project_id
        if not task.coordinator:
            proj = db.query(models.Project).filter(
                models.Project.name == (task.special_project or "")
            ).first()
            if proj and proj.coordinator:
                task.coordinator = proj.coordinator
        db.add(task)
        db.flush()
        task_id = task.id
        row.related_task_id = task.id

    project = (task_data or {}).get("special_project") or data.get("special_project", "")
    for item in data.get("achievements", []):
        write_item = str(item.pop("write_achievement", "true")).lower() != "false"
        if write_item and item.get("name"):
            ach = W.fulfill_or_create_achievement(
                db, item, row.source_type,
                task_id, item.get("special_project") or project,
                submission_id=row.id,               # Task 4: traceability
            )
            if ach:
                ach.confirmed_by = payload.operator
                ach.confirmed_at = now
                if effective_project_id and not ach.project_id:
                    ach.project_id = effective_project_id

    for item in data.get("issues", []):
        write_item = str(item.pop("write_issue", "true")).lower() != "false"
        if write_item and item.get("description"):
            issue = models.Issue(**W.filtered_fields(models.Issue, item))
            issue.source_type = row.source_type
            issue.confirmed_by = payload.operator
            issue.source_submission_id = row.id     # Task 4: traceability
            if effective_project_id and not issue.project_id:
                issue.project_id = effective_project_id
            db.add(issue)

    row.human_result_json = json.dumps(data, ensure_ascii=False)
    row.confirm_status = SS.S_CONFIRMED
    row.confirmed_by = payload.operator
    row.confirmed_at = datetime.utcnow()

    if task_id:
        task_log_after = {
            "source": "AI确认中心",
            "submission_id": row.id,
            "submitter": row.submitter,
            "confirmed_by": payload.operator,
            "source_type": row.source_type,
            "title": row.title,
            "project": project,
            "task": crud.to_dict(task) if task is not None else (crud.to_dict(existing_task) if existing_task else task_data),
            "achievement": data.get("achievements", []),
            "issue": data.get("issues", []),
        }
        crud.log(db, payload.operator, "AI确认写入", "task", task_id, task_before, task_log_after,
                 project_id=effective_project_id)
    crud.log(db, payload.operator, "确认写入业务数据", "confirmation", row.id, before, data,
             project_id=effective_project_id)
    db.commit()
    return {"ok": True, "submission": crud.to_dict(row)}


@router.post("/{submission_id}/reject")
def reject(
    submission_id: int,
    payload: schemas.RejectRequest,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    """打回给提交人补充。"""
    row = _load_submission(db, submission_id)
    W.require_project_id(row)
    context = get_user_context_from_db(current_user or payload.operator, db)
    _require_confirmation_center(context)
    if not P.can_confirm(context, row, db):
        raise HTTPException(403, "permission denied — 仅项目负责人（owner）可打回")
    W.require_submission_status(row, SS.OWNER_ACTIONABLE)
    before = crud.to_dict(row)
    row.confirm_status = SS.S_RETURNED
    row.reject_reason = payload.reason
    crud.log(db, payload.operator, "打回提交人补充", "confirmation", row.id, before, {"reason": payload.reason})
    db.commit()
    return {"ok": True, "submission": crud.to_dict(row)}


@router.post("/{submission_id}/resubmit")
def resubmit(
    submission_id: int,
    payload: schemas.ResubmitRequest,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    """提交人补充后重新提交：状态回到待负责人审核。"""
    row = _load_submission(db, submission_id)
    operator = payload.operator or current_user
    if row.submitter and row.submitter != operator:
        raise HTTPException(403, "只有原提交人可以重新提交")
    W.require_submission_status(row, SS.RETURNED_TO_SUBMITTER)
    before = crud.to_dict(row)
    if payload.human_result:
        new_result = dict(payload.human_result)
        if payload.supplement_note:
            new_result["supplement_note"] = payload.supplement_note
        row.human_result_json = json.dumps(new_result, ensure_ascii=False)
    elif payload.supplement_note:
        existing = W.json_or_empty(row.human_result_json or row.ai_result_json)
        existing["supplement_note"] = payload.supplement_note
        row.human_result_json = json.dumps(existing, ensure_ascii=False)
    row.confirm_status = SS.S_PENDING_OWNER
    row.reject_reason = None
    crud.log(db, operator, "提交人重新提交", "confirmation", row.id, before, {"note": payload.supplement_note or ""})
    db.commit()
    return {"ok": True, "submission": crud.to_dict(row)}


@router.post("/{submission_id}/withdraw")
def withdraw(
    submission_id: int,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    """提交人自行撤回。"""
    row = _load_submission(db, submission_id)
    if row.submitter != current_user:
        raise HTTPException(403, "只有原提交人可以撤回")
    W.require_submission_status(row, _WITHDRAWABLE_STATUSES)
    before = crud.to_dict(row)
    row.confirm_status = SS.S_WITHDRAWN
    crud.log(db, current_user, "提交人撤回", "confirmation", row.id, before, {})
    db.commit()
    return {"ok": True, "submission": crud.to_dict(row)}


@router.post("/{submission_id}/reject-final")
def reject_final(
    submission_id: int,
    payload: schemas.RejectRequest,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    """永久不入库。"""
    row = _load_submission(db, submission_id)
    W.require_project_id(row)
    context = get_user_context_from_db(current_user or payload.operator, db)
    _require_confirmation_center(context)
    if not P.can_confirm(context, row, db):
        raise HTTPException(403, "permission denied — 仅项目负责人（owner）可永久拒绝")
    before = crud.to_dict(row)
    row.confirm_status = SS.S_PERMANENTLY_REJECTED
    row.reject_reason = payload.reason
    crud.log(db, payload.operator, "标记不入库", "confirmation", row.id, before, {"reason": payload.reason})
    db.commit()
    return {"ok": True, "submission": crud.to_dict(row)}


@router.post("/{submission_id}/transfer-coordinator")
def transfer_coordinator(
    submission_id: int,
    payload: schemas.WorkflowNoteRequest,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    """转交统筹人给意见。"""
    row = _load_submission(db, submission_id)
    W.require_project_id(row)
    context = get_user_context_from_db(current_user or payload.operator, db)
    _require_confirmation_center(context)
    if not P.can_confirm(context, row, db):
        raise HTTPException(403, "permission denied — 仅项目负责人（owner）可转交统筹人")
    W.require_submission_status(row, SS.TRANSFERABLE_TO_COORDINATOR)
    before = crud.to_dict(row)
    row.confirm_status = SS.S_WAITING_COORDINATOR
    if payload.note:
        row.reject_reason = payload.note
    crud.log(db, payload.operator, "转交统筹人给意见", "confirmation", row.id, before, {"note": payload.note})
    db.commit()
    return {"ok": True, "submission": crud.to_dict(row)}


@router.post("/{submission_id}/coordinator-feedback")
def coordinator_feedback(
    submission_id: int,
    payload: schemas.WorkflowNoteRequest,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    """统筹人反馈意见。"""
    row = _load_submission(db, submission_id)
    W.require_project_id(row)
    context = get_user_context_from_db(current_user or payload.operator, db)
    _require_confirmation_center(context)
    if not P.can_coordinate(context, row, db):
        raise HTTPException(403, "permission denied — 仅该专项统筹人（coordinator）可反馈")
    W.require_submission_status(row, SS.WAITING_COORDINATOR_FEEDBACK)
    before = crud.to_dict(row)
    row.confirm_status = SS.S_COORDINATOR_GIVEN
    row.coordinator_note = payload.note or ""
    crud.log(db, payload.operator, "统筹人反馈意见", "confirmation", row.id, before, {"note": payload.note})
    db.commit()
    return {"ok": True, "submission": crud.to_dict(row)}


@router.post("/{submission_id}/escalate-ceo")
def escalate_ceo(
    submission_id: int,
    payload: schemas.WorkflowNoteRequest,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    """上报CEO决策。"""
    row = _load_submission(db, submission_id)
    W.require_project_id(row)
    context = get_user_context_from_db(current_user or payload.operator, db)
    _require_confirmation_center(context)
    if not P.can_escalate(context, row, db):
        raise HTTPException(403, "permission denied — 仅项目负责人（owner）或过程保障可上报CEO")
    W.require_submission_status(row, SS.ESCALATABLE_TO_CEO)
    before = crud.to_dict(row)
    row.confirm_status = SS.S_WAITING_CEO
    if payload.note:
        row.reject_reason = payload.note
    crud.log(db, payload.operator, "上报CEO决策", "confirmation", row.id, before, {"note": payload.note})
    db.commit()
    return {"ok": True, "submission": crud.to_dict(row)}


@router.post("/{submission_id}/ceo-decide")
def ceo_decide(
    submission_id: int,
    payload: schemas.WorkflowNoteRequest,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    """CEO批示：批示后回到负责人执行确认写入。"""
    row = _load_submission(db, submission_id)
    W.require_project_id(row)
    context = get_user_context_from_db(current_user or payload.operator, db)
    _require_confirmation_center(context)
    if not P.can_ceo_decide(context, row, db):
        raise HTTPException(403, "permission denied — 仅该项目 project_ceo 或管理员可批示")
    W.require_submission_status(row, SS.WAITING_CEO_DECISION)
    before = crud.to_dict(row)
    row.confirm_status = SS.S_CEO_DECIDED
    row.ceo_note = payload.note or ""
    crud.log(db, payload.operator, "CEO批示", "confirmation", row.id, before, {"note": payload.note})
    db.commit()
    return {"ok": True, "submission": crud.to_dict(row)}


@router.post("/{submission_id}/mark-unrecognized")
def mark_unrecognized(
    submission_id: int,
    payload: schemas.RejectRequest,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    """过程保障标记需人工处理。"""
    row = _load_submission(db, submission_id)
    context = get_user_context_from_db(current_user or payload.operator, db)
    _require_confirmation_center(context)
    if not (P.can_confirm(context, row, db) or can_assign_submission(context)):
        raise HTTPException(403, "permission denied")
    before = crud.to_dict(row)
    row.confirm_status = SS.S_NEEDS_REVISION
    row.reject_reason = payload.reason
    crud.log(db, payload.operator, "转交过程保障处理", "confirmation", row.id, before, {"reason": payload.reason})
    db.commit()
    return {"ok": True, "submission": crud.to_dict(row)}


@router.post("/{submission_id}/assign")
def assign(
    submission_id: int,
    payload: schemas.AssignRequest,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    row = _load_submission(db, submission_id)
    context = get_user_context_from_db(current_user or payload.operator, db)
    _require_confirmation_center(context)
    if not can_assign_submission(context):
        raise HTTPException(403, "permission denied")
    before = crud.to_dict(row)
    data = W.submission_result(row)
    data["assigned_to"] = payload.assignee
    if "task" in data:
        data["task"]["owner"] = payload.assignee
    row.human_result_json = json.dumps(data, ensure_ascii=False)
    row.confirm_status = SS.S_PENDING_OWNER
    crud.log(db, payload.operator, f"指定责任人：{payload.assignee}", "confirmation", row.id, before, data)
    db.commit()
    return {"ok": True, "submission": crud.to_dict(row)}
