import json
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import crud, models, schemas
from .subtasks import _sync_parent_task_status
from ..database import get_db
from ..domain import issue_flow as IF
from ..domain import submission_result_type as RT
from ..domain import submission_status as SS
from ..domain import task_status as TS
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

# ── Issue-type prefix table for plain-string subtask_issues ──
_ISSUE_PREFIX_TABLE: list[tuple[tuple[str, ...], str]] = [
    (("风险：", "风险:"), IF.TYPE_RISK),
    (("需决策：", "需决策:", "决策：", "决策:"), IF.TYPE_DECISION),
    (("待协调：", "待协调:", "协调：", "协调:"), IF.TYPE_COORDINATE),
    (("问题：", "问题:"), IF.TYPE_ISSUE),
]


def _parse_subtask_issue(item: object) -> dict | None:
    """Parse a subtask_issues item (str or dict) into {issue_type, description, priority}."""
    if isinstance(item, dict):
        desc = (item.get("description") or "").strip()
        if not desc:
            return None
        return {
            "issue_type": IF.normalize_type(item.get("issue_type")),
            "description": desc,
            "priority": str(item.get("priority") or "中"),
        }
    if isinstance(item, str):
        text = item.strip()
        if not text:
            return None
        for prefixes, itype in _ISSUE_PREFIX_TABLE:
            for prefix in prefixes:
                if text.startswith(prefix):
                    return {"issue_type": itype, "description": text[len(prefix):].strip(), "priority": "中"}
        return {"issue_type": IF.TYPE_ISSUE, "description": text, "priority": "中"}
    return None

# ── Confirmation-center tab mapping ──────────────────────────
TAB_STATUS_MAP: dict[str, frozenset[str]] = {
    "待审核": SS.TAB_PENDING_REVIEW,
    "流转中": SS.TAB_IN_FLIGHT,
    "已完成": SS.TAB_COMPLETED,
    "ceo":    SS.TAB_CEO_PENDING,
    "all":    SS.TAB_PENDING_REVIEW | SS.TAB_IN_FLIGHT | SS.TAB_COMPLETED,
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
        .filter(models.UpdateSubmission.confirm_status.in_(list(status_filter)))
        .order_by(models.UpdateSubmission.updated_at.desc())
        .limit(500)
        .all()
    )
    result = []
    for row in rows:
        # normalize handles any remaining legacy aliases not in status_filter
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

    # ── 写入模式分支 ──────────────────────────────────────────
    write_mode = str(task_data.pop("write_mode", "task_new"))          # task_new | subtask_update | subtask_new | task_reports
    target_subtask_id = task_data.pop("target_subtask_id", None)
    target_task_id = task_data.pop("target_task_id", None)
    write_task = str(task_data.pop("write_task", "true")).lower() != "false"
    if write_mode == "task_new" and data.get("task_reports"):
        write_mode = "task_reports"
        write_task = False

    if data.get("result_type") == RT.TYPE_SUBTASK_STATUS_UPDATE:
        subtask_id = data.get("subtask_id")
        if not subtask_id:
            raise HTTPException(400, "subtask_status_update missing subtask_id")
        subtask = db.get(models.SubTask, int(subtask_id))
        if not subtask or subtask.is_deleted:
            raise HTTPException(404, "subtask not found")
        to_status = data.get("to_status") or data.get("suggested_status")
        if not to_status:
            raise HTTPException(400, "subtask_status_update missing to_status")
        subtask.status = TS.normalize(str(to_status))
        subtask.source_submission_id = row.id
        parent_task = db.get(models.Task, subtask.task_id)
        if parent_task:
            task_id = parent_task.id
            row.related_task_id = parent_task.id
            _sync_parent_task_status(parent_task, db, payload.operator)
        write_task = False

    elif write_mode == "subtask_update" and target_subtask_id:
        # 模式1：更新已有子任务进度
        subtask = db.get(models.SubTask, int(target_subtask_id))
        if subtask and not subtask.is_deleted:
            completed = data.get("completed_items") or []
            notes_text = "；".join(completed) if completed else task_data.get("key_achievement", "")
            subtask.status = task_data.get("status") or subtask.status
            subtask.source_submission_id = row.id
            if notes_text:
                existing_notes = subtask.notes or ""
                subtask.notes = f"{existing_notes}\n[{now.strftime('%Y-%m-%d')}] {notes_text}".strip()
            parent_task = db.get(models.Task, subtask.task_id)
            if parent_task:
                _sync_parent_task_status(parent_task, db, payload.operator)
                task_id = parent_task.id
                row.related_task_id = parent_task.id
        write_task = False

    elif write_mode == "subtask_new" and target_task_id:
        # 模式2：在已有关键任务下新增子任务
        parent_task = db.get(models.Task, int(target_task_id))
        if parent_task and not parent_task.is_deleted:
            title = task_data.get("key_task") or data.get("related_task") or "新增子任务"
            new_sub = models.SubTask(
                task_id=parent_task.id,
                title=str(title)[:200],
                assignee=row.submitter or "",
                plan_time=task_data.get("plan_time") or "",
                status=task_data.get("status") or "进行中",
                completion_criteria=task_data.get("completion_standard") or "",
                notes=task_data.get("key_achievement") or "",
                source_submission_id=row.id,
            )
            db.add(new_sub)
            db.flush()
            _sync_parent_task_status(parent_task, db, payload.operator)
            task_id = parent_task.id
            row.related_task_id = parent_task.id
        write_task = False

    # 模式3（task_new）：新建关键任务（原有逻辑）
    task = None
    if write_task and task_data.get("key_task"):
        task = models.Task(**W.filtered_fields(models.Task, task_data))
        task.source_type = row.source_type
        task.submitter = row.submitter
        task.confirmed_by = payload.operator
        task.confirmed_at = now
        task.source_submission_id = row.id
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

    # ── 新格式：按 task_reports 更新匹配子任务 ────────────────────
    key_task_issues_written = False
    if write_mode == "task_reports":
        write_tr_achievements = bool(data.get("write_task_reports_achievements", True))
        write_tr_issues = bool(data.get("write_task_reports_issues", True))
        task_reports_list = data.get("task_reports") or []

        # ── Pre-validate: every suggest_new_subtask item must carry parent_task_id ──
        for _report in task_reports_list:
            if not isinstance(_report, dict):
                continue
            if _report.get("result_type") == RT.TYPE_SUGGEST_NEW_SUBTASK:
                if not _report.get("parent_task_id"):
                    raise HTTPException(422, "建议新增子任务缺少归属关键任务，请负责人先选择后再确认")

        for report in task_reports_list:
            if not isinstance(report, dict):
                continue

            item_rt = report.get("result_type")  # may be None for old-format items

            # ── suggest_new_subtask: create SubTask under owner-chosen parent ──
            if item_rt == RT.TYPE_SUGGEST_NEW_SUBTASK:
                parent_task_id = report.get("parent_task_id")
                parent_task = db.get(models.Task, int(parent_task_id))
                if parent_task and not parent_task.is_deleted:
                    new_sub = models.SubTask(
                        task_id=parent_task.id,
                        title=str(report.get("title") or "新增子任务")[:200],
                        assignee=str(report.get("assignee") or row.submitter or ""),
                        plan_time=str(report.get("plan_end") or ""),
                        status="进行中",
                        source_submission_id=row.id,
                    )
                    db.add(new_sub)
                    db.flush()
                    _sync_parent_task_status(parent_task, db, payload.operator)
                    if not task_id:
                        task_id = parent_task.id
                        row.related_task_id = parent_task.id
                    crud.log(
                        db, payload.operator, "负责人确认新增子任务", "subtask", new_sub.id,
                        {}, {"title": new_sub.title, "task_id": parent_task.id,
                              "from_submission": row.id},
                        project_id=effective_project_id,
                    )
                continue

            # ── subtask_progress / subtask_complete / old-format (no result_type) ──
            # Old format: type=="progress" with no result_type field
            old_type = report.get("type", "progress")
            if item_rt not in (RT.TYPE_SUBTASK_PROGRESS, RT.TYPE_SUBTASK_COMPLETE, None):
                continue
            if item_rt is None and old_type != "progress":
                continue

            matched_id = report.get("matched_subtask_id")
            if not matched_id:
                continue
            subtask = db.get(models.SubTask, int(matched_id))
            if not subtask or subtask.is_deleted:
                continue

            # Append progress note
            completed = (report.get("completed") or "").strip()
            if completed:
                existing = subtask.notes or ""
                subtask.notes = f"{existing}\n[{now.strftime('%Y-%m-%d')}] {completed}".strip()

            # Status update rules:
            # - subtask_complete → set 已完成
            # - subtask_progress → no status change
            # - old format (no result_type) → use status_update field (backward compat)
            if item_rt == RT.TYPE_SUBTASK_COMPLETE:
                subtask.status = TS.S_COMPLETED
            elif item_rt is None and report.get("status_update"):
                subtask.status = report["status_update"]
            # subtask_progress: deliberately skip status change

            subtask.source_submission_id = row.id
            parent = db.get(models.Task, subtask.task_id)
            if parent:
                _sync_parent_task_status(parent, db, payload.operator)
                if not task_id:
                    task_id = parent.id
                    row.related_task_id = parent.id

            # Write per-subtask achievements
            if write_tr_achievements:
                for ach_item in (report.get("achievements") or []):
                    if isinstance(ach_item, dict) and ach_item.get("name"):
                        ach_dict = dict(ach_item)
                        ach_dict.setdefault("special_project", project)
                        ach_dict.setdefault("owner", row.submitter or "")
                        ach = W.fulfill_or_create_achievement(
                            db, ach_dict, row.source_type, task_id,
                            ach_dict.get("special_project") or project,
                            submission_id=row.id,
                        )
                        if ach:
                            ach.confirmed_by = payload.operator
                            ach.confirmed_at = now
                            if effective_project_id and not ach.project_id:
                                ach.project_id = effective_project_id

            # Write per-subtask issues
            if write_tr_issues:
                for issue_item in (report.get("subtask_issues") or []):
                    parsed = _parse_subtask_issue(issue_item)
                    if not parsed:
                        continue
                    norm_type = parsed["issue_type"]
                    issue = models.Issue(
                        issue_type=norm_type,
                        description=parsed["description"],
                        owner=row.submitter or "",
                        priority=parsed["priority"],
                        status=IF.default_status_for_type(norm_type),
                        special_project=project,
                        source_type=row.source_type,
                        confirmed_by=payload.operator,
                        source_submission_id=row.id,
                        related_task_id=subtask.task_id if subtask else None,
                    )
                    if effective_project_id:
                        issue.project_id = effective_project_id
                    db.add(issue)

        # key_task_issues → 问题库
        if write_tr_issues:
            for ki in (data.get("key_task_issues") or []):
                if not isinstance(ki, dict) or not (ki.get("description") or "").strip():
                    continue
                norm_type = IF.normalize_type(ki.get("issue_type"))
                issue = models.Issue(
                    issue_type=norm_type,
                    description=ki["description"].strip(),
                    owner=row.submitter or "",
                    helper="、".join(ki.get("need_coordination") or []),
                    priority=ki.get("priority") or "中",
                    status=IF.default_status_for_type(norm_type),
                    special_project=project,
                    source_type=row.source_type,
                    confirmed_by=payload.operator,
                    source_submission_id=row.id,
                )
                if not ki.get("need_coordination"):
                    issue.helper = ""
                if effective_project_id:
                    issue.project_id = effective_project_id
                db.add(issue)

    # ── 旧格式：平铺 achievements / issues ───────────────────────
    else:
        for item in data.get("achievements", []):
            write_item = str(item.pop("write_achievement", "true")).lower() != "false"
            if write_item and item.get("name"):
                ach = W.fulfill_or_create_achievement(
                    db, item, row.source_type,
                    task_id, item.get("special_project") or project,
                    submission_id=row.id,
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
                issue.source_submission_id = row.id
                if effective_project_id and not issue.project_id:
                    issue.project_id = effective_project_id
                db.add(issue)

    if write_mode != "task_reports":
        for ki in (data.get("key_task_issues") or []):
            if not isinstance(ki, dict) or not (ki.get("description") or "").strip():
                continue
            norm_type = IF.normalize_type(ki.get("issue_type"))
            issue = models.Issue(
                issue_type=norm_type,
                description=ki["description"].strip(),
                owner=row.submitter or "",
                helper="、".join(ki.get("need_coordination") or []),
                priority=ki.get("priority") or "中",
                status=IF.default_status_for_type(norm_type),
                special_project=project,
                source_type=row.source_type,
                confirmed_by=payload.operator,
                source_submission_id=row.id,
            )
            if effective_project_id:
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
    """提交人自行撤回。tech_admin 也可以代撤。"""
    row = _load_submission(db, submission_id)
    context = get_user_context_from_db(current_user, db)
    is_tech_admin = context.get("is_tech_admin", False)
    if row.submitter != current_user and not is_tech_admin:
        raise HTTPException(403, "只有原提交人或管理员可以撤回")
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
