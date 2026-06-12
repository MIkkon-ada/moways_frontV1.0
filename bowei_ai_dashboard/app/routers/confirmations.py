import json
from datetime import datetime
from difflib import SequenceMatcher

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import crud, models, schemas
from ..database import get_db
from ..permissions import (
    PROJECT_ROLE_COORDINATOR,
    PROJECT_ROLE_OWNER,
    can_access_confirmation_center,
    can_assign_submission,
    can_ceo_decide,
    can_ceo_decide_by_project,
    can_confirm_submission,
    can_confirm_submission_by_project,
    can_coordinator_feedback,
    can_coordinator_feedback_by_project,
    can_escalate_to_ceo,
    can_escalate_to_ceo_by_project,
    can_view_submission_in_confirmation,
    can_view_submission_in_confirmation_by_project,
    get_all_project_roles,
    get_current_user_name,
    get_user_context_from_db,
    resolve_project_id,
)

router = APIRouter(prefix="/api/confirmations", tags=["confirmations"])

# 待审核：等待负责人处理（包含各种中间流转后回到负责人处理的状态）
# 流转中：在流转过程中等待特定角色处理
# 已完成：最终状态
TAB_STATUS_MAP = {
    "待审核": ["待确认", "待负责人审核", "提交人已确认", "已重新提交", "统筹人已反馈", "CEO已批示"],
    "流转中": ["需修改", "已打回提交人", "已撤回", "已转交统筹人", "待CEO决策"],
    "已完成": ["已确认", "已退回", "已确认入库", "已入库", "不入库", "已归档"],
    # CEO 决策中心专用 tab：仅显示等待 CEO 批示的事项
    "ceo": ["待CEO决策", "pending_ceo_decision"],
}

_WITHDRAWABLE_STATUSES = {"待确认", "待负责人审核", "提交人已确认", "已重新提交", "已打回", "已打回提交人", "returned_to_submitter", "已撤回"}

# 所有活跃（未完成）状态，用于 dashboard 角标计数
_ACTIVE_STATUSES = TAB_STATUS_MAP["待审核"] + TAB_STATUS_MAP["流转中"]


def _load_submission(db: Session, submission_id: int):
    row = db.get(models.UpdateSubmission, submission_id)
    if not row:
        raise HTTPException(404, "confirmation not found")
    return row


def _require_confirmation_center(context: dict):
    if not can_access_confirmation_center(context):
        raise HTTPException(403, "permission denied")


def _filtered(model, data: dict):
    return {k: v for k, v in data.items() if hasattr(model, k) and v != ""}


def _json_or_empty(value: str):
    return json.loads(value or "{}")


def _submission_result(row: models.UpdateSubmission):
    if row.human_result_json:
        return _json_or_empty(row.human_result_json)
    if row.ai_result_json:
        return _json_or_empty(row.ai_result_json)
    return {}


_CONFIRM_STATUS_ALIASES = {
    "pending_owner_review": "待负责人审核",
    "resubmitted": "已重新提交",
    "returned_to_submitter": "已打回提交人",
    "withdrawn": "已撤回",
    "withdrawn_editable": "已撤回",
    "transferred_to_coordinator": "已转交统筹人",
    "coordinator_feedback_given": "统筹人已反馈",
    "pending_ceo_decision": "待CEO决策",
    "ceo_decided": "CEO已批示",
    "stored": "已入库",
    "approved_for_storage": "已入库",
}

_OWNER_REVIEW_STATUSES = {"待确认", "待负责人审核", "已重新提交", "统筹人已反馈", "CEO已批示"}
_RETURNED_STATUSES = {"已打回", "已打回提交人", "returned_to_submitter", "已撤回"}
_TRANSFERABLE_STATUSES = {"待确认", "待负责人审核", "已重新提交"}
_ESCALATABLE_STATUSES = {"待确认", "待负责人审核", "已重新提交", "统筹人已反馈"}
_CEO_DECISION_STATUSES = {"待CEO决策"}
_STORED_STATUSES = {"已确认入库", "stored", "approved_for_storage", "已入库"}

# ── 5D：角色可见状态集合 ──────────────────────────────────────
# coordinator 只看 transfer-coordinator 动作后等待统筹反馈的事项
_COORDINATOR_REVIEW_STATUSES = {"已转交统筹人", "transferred_to_coordinator"}
# project_ceo 只看 escalate-ceo 动作后等待 CEO 决策的事项
_CEO_REVIEW_STATUSES = {"待CEO决策", "pending_ceo_decision"}


def _normalize_confirm_status(status: str) -> str:
    raw = (status or "").strip()
    return _CONFIRM_STATUS_ALIASES.get(raw, raw)


def _submission_status(row: models.UpdateSubmission) -> str:
    return _normalize_confirm_status(row.confirm_status)


def _status_ok(row: models.UpdateSubmission, allowed: set[str]) -> bool:
    return _submission_status(row) in allowed


def _status_message() -> str:
    return "当前状态不允许执行该操作。"


def _require_submission_status(row: models.UpdateSubmission, allowed: set[str]):
    if _submission_status(row) not in allowed:
        raise HTTPException(409, _status_message())


def similarity(left: str, right: str) -> float:
    return SequenceMatcher(None, left or "", right or "").ratio()


def find_planned_achievement(db: Session, item: dict, task_id: int | None, project: str):
    query = db.query(models.Achievement).filter(models.Achievement.source_type == "Excel预定成果")
    if task_id:
        query = query.filter(models.Achievement.related_task_id == task_id)
    elif project:
        query = query.filter(models.Achievement.special_project == project)
    candidates = query.all()
    if not candidates:
        return None
    name = item.get("name", "")
    best = max(candidates, key=lambda row: similarity(name, row.name))
    return best if similarity(name, best.name) >= 0.58 else None


def fulfill_or_create_achievement(db: Session, item: dict, source_type: str, task_id: int | None, project: str):
    planned = find_planned_achievement(db, item, task_id, project)
    clean = _filtered(models.Achievement, item)
    if planned:
        planned.status = item.get("status") if item.get("status") and item.get("status") != "计划中" else "已形成"
        planned.source_type = "Excel预定成果 + AI确认"
        planned.owner = item.get("owner") or planned.owner
        planned.version = item.get("version") or planned.version or "V0.1"
        planned.file_link = item.get("file_link") or planned.file_link
        planned.scenario = item.get("scenario") or planned.scenario
        planned.reuse_tag = item.get("reuse_tag") or planned.reuse_tag
        planned.achievement_type = item.get("achievement_type") or planned.achievement_type
        return planned

    achievement = models.Achievement(**clean)
    achievement.related_task_id = clean.get("related_task_id") or task_id
    achievement.special_project = clean.get("special_project") or project
    achievement.status = clean.get("status") or "补充成果"
    achievement.source_type = source_type or "AI确认"
    db.add(achievement)
    return achievement


# ── 项目 ID 解析 ───────────────────────────────────────────────

def _resolve_submission_project_id(row: models.UpdateSubmission, db: Session) -> int | None:
    """
    从 UpdateSubmission 解析所属项目 ID。
    5E: project_id 已全量回填，直接返回 row.project_id。
    project_id=NULL 的孤立记录返回 None，所有项目角色操作均被拒绝。
    """
    return row.project_id


# ── 确认中心权限辅助 ──────────────────────────────────────────

def _can_confirm(context: dict, row: models.UpdateSubmission, db: Session) -> bool:
    """确认入库/打回/转交/reject-final：owner 或 super_admin。
    5E-hotfix: project_id=NULL 时只有 is_tech_admin 可操作（不使用 can_confirm_all，
    因为全局 CEO 也有 can_confirm_all=True 但不应操作孤立记录）。
    """
    proj_id = _resolve_submission_project_id(row, db)
    if proj_id is None:
        return context.get("is_tech_admin", False)
    return can_confirm_submission_by_project(context, proj_id, db)


def _can_coordinator(context: dict, row: models.UpdateSubmission, db: Session) -> bool:
    """统筹人反馈：coordinator 或 super_admin。
    5E-hotfix: project_id=NULL 时只有 is_tech_admin 可操作。
    """
    proj_id = _resolve_submission_project_id(row, db)
    if proj_id is None:
        return context.get("is_tech_admin", False)
    return can_coordinator_feedback_by_project(context, proj_id, db)


def _can_escalate(context: dict, row: models.UpdateSubmission, db: Session) -> bool:
    """上报 CEO：owner、process_guard 或 super_admin。
    5E-hotfix: project_id=NULL 时只有 is_tech_admin 可操作。
    """
    proj_id = _resolve_submission_project_id(row, db)
    if proj_id is None:
        return context.get("is_tech_admin", False)
    return can_escalate_to_ceo_by_project(context, proj_id, db)


def _can_ceo(context: dict, row: models.UpdateSubmission, db: Session) -> bool:
    """CEO 批示：project_ceo 或 super_admin。
    5E-hotfix: project_id=NULL 时只有 is_tech_admin 可操作。
    """
    proj_id = _resolve_submission_project_id(row, db)
    if proj_id is None:
        return context.get("is_tech_admin", False)
    return can_ceo_decide_by_project(context, proj_id, db)


def _can_view_in_center(context: dict, row: models.UpdateSubmission, db: Session) -> bool:
    """确认中心可见性：基于 project_id + project_members。
    5E: project_id=NULL 孤立记录由 can_view_submission_in_confirmation_by_project 处理：
        - super_admin（can_view_all）→ 可见
        - 提交人自己（submitter==name）→ 可见
        - 其余角色 → 不可见
    """
    proj_id = _resolve_submission_project_id(row, db)
    return can_view_submission_in_confirmation_by_project(
        context, proj_id, row.submitter or "", db
    )


# ── 5E-hotfix-2：project_id=NULL 孤立提交守卫 ────────────────

def _require_project_id(row: models.UpdateSubmission) -> None:
    """
    project_id=NULL 的孤立提交不能进入项目闭环动作（confirm/reject/transfer/ceo等）。
    任何角色（含 super_admin）均不能对无项目归属的提交执行入库或流转操作，
    以防止生成无 project_id 的 task/issue/achievement 脏数据。
    """
    if row.project_id is None:
        raise HTTPException(
            status_code=422,
            detail="该提交缺少项目归属（project_id=NULL），无法执行项目闭环操作。"
                   "请先通过数据迁移脚本为历史数据补充 project_id 后再操作。",
        )


# ── 5D：确认中心角色可见范围收口 ──────────────────────────────

def _is_waiting_coordinator_feedback(row: models.UpdateSubmission) -> bool:
    """提交处于等待统筹人反馈状态（transfer-coordinator 动作后的状态）。"""
    return _submission_status(row) in _COORDINATOR_REVIEW_STATUSES


def _is_waiting_ceo_decision(row: models.UpdateSubmission) -> bool:
    """提交处于等待 CEO 决策状态（escalate-ceo 动作后的状态）。"""
    return _submission_status(row) in _CEO_REVIEW_STATUSES


def _user_roles_in_project(
    context: dict,
    project_id: int | None,
    db: Session,
) -> set[str]:
    """
    当前用户在该项目的角色集合。
    新系统优先（project_members 表），回落旧字符串 context。
    super_admin 返回 {"super_admin"}；无记录返回空集合（按 member 处理）。
    """
    if context.get("is_tech_admin"):
        return {"super_admin"}

    person_id = context.get("person_id")
    if person_id and project_id:
        db_roles = get_all_project_roles(person_id, project_id, db)
        if db_roles:
            return set(db_roles)

    # 过渡期回落：旧字符串字段
    if project_id:
        proj_name = crud.get_project_name_by_id(project_id, db)
        if proj_name:
            old_role = context.get("project_roles", {}).get(proj_name)
            if old_role == PROJECT_ROLE_OWNER:
                return {"owner"}
            if old_role == PROJECT_ROLE_COORDINATOR:
                return {"coordinator"}

    # legacy CEO
    if context.get("is_ceo"):
        return {"project_ceo"}

    return set()


def _role_allows_pending_view(
    context: dict,
    row: models.UpdateSubmission,
    db: Session,
    sub_proj_id: int | None = None,
) -> bool:
    """
    5D 角色可见过滤：在基础可见性之上按角色限制状态。
    super_admin / owner → 不限制；
    coordinator → 只看等待统筹反馈事项；
    project_ceo → 只看等待 CEO 决策事项；
    member / 无角色 → 只看自己的提交。
    """
    if context.get("is_tech_admin"):
        return True
    if sub_proj_id is None:
        sub_proj_id = _resolve_submission_project_id(row, db)
    roles = _user_roles_in_project(context, sub_proj_id, db)

    if "owner" in roles or "super_admin" in roles:
        return True
    if "coordinator" in roles:
        return _is_waiting_coordinator_feedback(row)
    if "project_ceo" in roles:
        return _is_waiting_ceo_decision(row)
    # member 或无角色：仅自己的提交
    return (row.submitter or "") == context.get("name", "")


# ── 端点 ───────────────────────────────────────────────────────

@router.get("/my-rejected")
def my_rejected(current_user: str = Depends(get_current_user_name), db: Session = Depends(get_db)):
    """任意登录用户：查询打回给自己的提交，用于首页提醒。"""
    rows = (
        db.query(models.UpdateSubmission)
        .filter(
            models.UpdateSubmission.submitter == current_user,
        )
        .order_by(models.UpdateSubmission.updated_at.desc())
        .all()
    )
    result = []
    for row in rows:
        if _submission_status(row) not in _RETURNED_STATUSES and _submission_status(row) != "已撤回":
            continue
        human = _submission_result(row)
        item = crud.to_dict(row)
        item["special_project"] = human.get("special_project") or (human.get("task") or {}).get("special_project", "")
        result.append(item)
    return result


@router.get("/counts")
def counts(current_user: str = Depends(get_current_user_name), db: Session = Depends(get_db)):
    context = get_user_context_from_db(current_user, db)
    _require_confirmation_center(context)
    rows = db.query(models.UpdateSubmission).all()
    # 5D: 先基础可见性，再角色状态限制
    visible_rows = [
        row for row in rows
        if _can_view_in_center(context, row, db)
        and _role_allows_pending_view(context, row, db)
    ]
    result = {}
    for tab, statuses in TAB_STATUS_MAP.items():
        result[tab] = sum(1 for row in visible_rows if _submission_status(row) in statuses)
    return result


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

    # ── 解析项目过滤 ──────────────────────────────────────────
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
        # 状态过滤
        if _submission_status(row) not in status_filter:
            continue

        # 可见性权限检查（优先 project_id，回落 JSON）
        if not _can_view_in_center(context, row, db):
            continue

        # 解析提交所属项目（项目过滤和角色过滤共用）
        sub_proj_id = _resolve_submission_project_id(row, db)

        # 项目过滤
        if effective_project_id is not None and sub_proj_id != effective_project_id:
            continue

        # 5D：角色可见范围收口
        # coordinator → 仅等待统筹反馈事项；project_ceo → 仅等待 CEO 决策事项
        if not _role_allows_pending_view(context, row, db, sub_proj_id=sub_proj_id):
            continue

        human = _submission_result(row)
        item = crud.to_dict(row)
        item["special_project"] = human.get("special_project") or (human.get("task") or {}).get("special_project", "")
        item["related_task"] = human.get("related_task") or (human.get("task") or {}).get("key_task", "")
        result.append(item)
    return result


@router.get("/{submission_id}")
def detail(submission_id: int, current_user: str = Depends(get_current_user_name), db: Session = Depends(get_db)):
    context = get_user_context_from_db(current_user, db)
    _require_confirmation_center(context)
    row = _load_submission(db, submission_id)
    if not _can_view_in_center(context, row, db):
        raise HTTPException(403, "permission denied")
    data = crud.to_dict(row)
    data["ai_result"] = _json_or_empty(row.ai_result_json)
    data["human_result"] = _submission_result(row)
    return data


@router.post("/{submission_id}/save")
def save(submission_id: int, payload: schemas.ConfirmationSaveRequest, current_user: str = Depends(get_current_user_name), db: Session = Depends(get_db)):
    row = _load_submission(db, submission_id)
    context = get_user_context_from_db(current_user, db)
    _require_confirmation_center(context)
    if not (_can_confirm(context, row, db) or can_assign_submission(context)):
        raise HTTPException(403, "permission denied")
    before = crud.to_dict(row)
    row.human_result_json = json.dumps(payload.human_result, ensure_ascii=False)
    row.confirm_status = "需修改"
    crud.log(db, current_user or "管理员", "保存确认修改", "confirmation", row.id, before, payload.human_result)
    db.commit()
    return {"ok": True, "submission": crud.to_dict(row)}


@router.post("/{submission_id}/confirm")
def confirm(submission_id: int, payload: schemas.ConfirmRequest, current_user: str = Depends(get_current_user_name), db: Session = Depends(get_db)):
    row = _load_submission(db, submission_id)
    _require_project_id(row)
    context = get_user_context_from_db(current_user or payload.operator, db)
    _require_confirmation_center(context)
    if not _can_confirm(context, row, db):
        raise HTTPException(403, "permission denied — 仅项目负责人（owner）或管理员可确认入库")
    if _submission_status(row) not in _OWNER_REVIEW_STATUSES:
        raise HTTPException(409, _status_message())
    before = crud.to_dict(row)

    effective_project_id = _resolve_submission_project_id(row, db)
    now = datetime.utcnow()
    data = _submission_result(row)

    # 合并前端传入的 human_result（含入库开关、字段修改）
    if payload.human_result:
        hr = payload.human_result
        # 顶层字段（special_project 等）直接覆盖
        for k, v in hr.items():
            if k not in ("task", "achievements", "issues"):
                data[k] = v
        # task 子对象：深度合并
        if "task" in hr and isinstance(hr["task"], dict):
            data["task"] = {**(data.get("task") or {}), **hr["task"]}
        # achievements / issues：整体替换（前端已附加 write_ 开关）
        if "achievements" in hr:
            data["achievements"] = hr["achievements"]
        if "issues" in hr:
            data["issues"] = hr["issues"]
        row.human_result_json = json.dumps(data, ensure_ascii=False)

    task_id = row.related_task_id
    task_data = data.get("task") or {}
    task_before = {}
    existing_task = None
    if task_id:
        existing_task = db.get(models.Task, task_id)
        if existing_task:
            task_before = crud.to_dict(existing_task)
    write_task = str(task_data.pop("write_task", "true")).lower() != "false"
    task = None
    if write_task and task_data.get("key_task"):
        task = models.Task(**_filtered(models.Task, task_data))
        task.source_type = row.source_type
        task.submitter = row.submitter
        task.confirmed_at = now
        # 继承 submission 的 project_id
        if effective_project_id and not task.project_id:
            task.project_id = effective_project_id
        if not task.coordinator:
            proj = db.query(models.Project).filter(models.Project.name == (task.special_project or "")).first()
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
            ach = fulfill_or_create_achievement(db, item, row.source_type, task_id, item.get("special_project") or project)
            if ach:
                ach.confirmed_at = now
                # 继承 submission 的 project_id
                if effective_project_id and not ach.project_id:
                    ach.project_id = effective_project_id

    for item in data.get("issues", []):
        write_item = str(item.pop("write_issue", "true")).lower() != "false"
        if write_item and item.get("description"):
            issue = models.Issue(**_filtered(models.Issue, item))
            issue.source_type = row.source_type
            # 继承 submission 的 project_id
            if effective_project_id and not issue.project_id:
                issue.project_id = effective_project_id
            db.add(issue)

    row.human_result_json = json.dumps(data, ensure_ascii=False)
    row.confirm_status = "已入库"
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
        crud.log(db, payload.operator, "AI确认写入", "task", task_id, task_before, task_log_after)
    crud.log(db, payload.operator, "确认写入业务数据", "confirmation", row.id, before, data)
    db.commit()
    return {"ok": True, "submission": crud.to_dict(row)}


@router.post("/{submission_id}/reject")
def reject(submission_id: int, payload: schemas.RejectRequest, current_user: str = Depends(get_current_user_name), db: Session = Depends(get_db)):
    """打回给提交人补充：提交人需补充后重新提交。"""
    row = _load_submission(db, submission_id)
    _require_project_id(row)
    context = get_user_context_from_db(current_user or payload.operator, db)
    _require_confirmation_center(context)
    if not _can_confirm(context, row, db):
        raise HTTPException(403, "permission denied — 仅项目负责人（owner）可打回")
    _require_submission_status(row, _OWNER_REVIEW_STATUSES)
    before = crud.to_dict(row)
    row.confirm_status = "已打回提交人"
    row.reject_reason = payload.reason
    crud.log(db, payload.operator, "打回提交人补充", "confirmation", row.id, before, {"reason": payload.reason})
    db.commit()
    return {"ok": True, "submission": crud.to_dict(row)}


@router.post("/{submission_id}/resubmit")
def resubmit(submission_id: int, payload: schemas.ResubmitRequest, current_user: str = Depends(get_current_user_name), db: Session = Depends(get_db)):
    """提交人补充后重新提交：状态回到待负责人审核。"""
    row = _load_submission(db, submission_id)
    operator = payload.operator or current_user
    if row.submitter and row.submitter != operator:
        raise HTTPException(403, "只有原提交人可以重新提交")
    if _submission_status(row) not in _RETURNED_STATUSES:
        raise HTTPException(409, _status_message())
    before = crud.to_dict(row)
    if payload.human_result:
        new_result = dict(payload.human_result)
        if payload.supplement_note:
            new_result["supplement_note"] = payload.supplement_note
        row.human_result_json = json.dumps(new_result, ensure_ascii=False)
    elif payload.supplement_note:
        existing = json.loads(row.human_result_json or row.ai_result_json or "{}")
        existing["supplement_note"] = payload.supplement_note
        row.human_result_json = json.dumps(existing, ensure_ascii=False)
    row.confirm_status = "待负责人审核"
    row.reject_reason = None
    crud.log(db, operator, "提交人重新提交", "confirmation", row.id, before, {"note": payload.supplement_note or ""})
    db.commit()
    return {"ok": True, "submission": crud.to_dict(row)}


@router.post("/{submission_id}/withdraw")
def withdraw(submission_id: int, current_user: str = Depends(get_current_user_name), db: Session = Depends(get_db)):
    """提交人自行撤回：可修改后重新提交。"""
    row = _load_submission(db, submission_id)
    if row.submitter != current_user:
        raise HTTPException(403, "只有原提交人可以撤回")
    if _submission_status(row) not in _WITHDRAWABLE_STATUSES:
        raise HTTPException(400, "当前状态不允许撤回")
    before = crud.to_dict(row)
    row.confirm_status = "已撤回"
    crud.log(db, current_user, "提交人撤回", "confirmation", row.id, before, {})
    db.commit()
    return {"ok": True, "submission": crud.to_dict(row)}


@router.post("/{submission_id}/reject-final")
def reject_final(submission_id: int, payload: schemas.RejectRequest, current_user: str = Depends(get_current_user_name), db: Session = Depends(get_db)):
    """永久不入库：该记录不写入任何业务表。"""
    row = _load_submission(db, submission_id)
    _require_project_id(row)
    context = get_user_context_from_db(current_user or payload.operator, db)
    _require_confirmation_center(context)
    if not _can_confirm(context, row, db):
        raise HTTPException(403, "permission denied — 仅项目负责人（owner）可永久拒绝")
    before = crud.to_dict(row)
    row.confirm_status = "不入库"
    row.reject_reason = payload.reason
    crud.log(db, payload.operator, "标记不入库", "confirmation", row.id, before, {"reason": payload.reason})
    db.commit()
    return {"ok": True, "submission": crud.to_dict(row)}


@router.post("/{submission_id}/transfer-coordinator")
def transfer_coordinator(submission_id: int, payload: schemas.WorkflowNoteRequest, current_user: str = Depends(get_current_user_name), db: Session = Depends(get_db)):
    """转交统筹人给意见：统筹人将反馈后回到负责人处理。"""
    row = _load_submission(db, submission_id)
    _require_project_id(row)
    context = get_user_context_from_db(current_user or payload.operator, db)
    _require_confirmation_center(context)
    if not _can_confirm(context, row, db):
        raise HTTPException(403, "permission denied — 仅项目负责人（owner）可转交统筹人")
    _require_submission_status(row, _TRANSFERABLE_STATUSES)
    before = crud.to_dict(row)
    row.confirm_status = "已转交统筹人"
    if payload.note:
        row.reject_reason = payload.note
    crud.log(db, payload.operator, "转交统筹人给意见", "confirmation", row.id, before, {"note": payload.note})
    db.commit()
    return {"ok": True, "submission": crud.to_dict(row)}


@router.post("/{submission_id}/coordinator-feedback")
def coordinator_feedback(submission_id: int, payload: schemas.WorkflowNoteRequest, current_user: str = Depends(get_current_user_name), db: Session = Depends(get_db)):
    """统筹人反馈意见：意见回到负责人，由负责人决定后续。"""
    row = _load_submission(db, submission_id)
    _require_project_id(row)
    context = get_user_context_from_db(current_user or payload.operator, db)
    _require_confirmation_center(context)
    if not _can_coordinator(context, row, db):
        raise HTTPException(403, "permission denied — 仅该专项统筹人（coordinator）可反馈")
    _require_submission_status(row, {"已转交统筹人", "transferred_to_coordinator"})
    before = crud.to_dict(row)
    row.confirm_status = "统筹人已反馈"
    row.coordinator_note = payload.note or ""
    crud.log(db, payload.operator, "统筹人反馈意见", "confirmation", row.id, before, {"note": payload.note})
    db.commit()
    return {"ok": True, "submission": crud.to_dict(row)}


@router.post("/{submission_id}/escalate-ceo")
def escalate_ceo(submission_id: int, payload: schemas.WorkflowNoteRequest, current_user: str = Depends(get_current_user_name), db: Session = Depends(get_db)):
    """上报CEO决策：涉及风险/预算/方向/跨部门协调时使用。"""
    row = _load_submission(db, submission_id)
    _require_project_id(row)
    context = get_user_context_from_db(current_user or payload.operator, db)
    _require_confirmation_center(context)
    if not _can_escalate(context, row, db):
        raise HTTPException(403, "permission denied — 仅项目负责人（owner）或过程保障可上报CEO")
    _require_submission_status(row, _ESCALATABLE_STATUSES)
    before = crud.to_dict(row)
    row.confirm_status = "待CEO决策"
    if payload.note:
        row.reject_reason = payload.note
    crud.log(db, payload.operator, "上报CEO决策", "confirmation", row.id, before, {"note": payload.note})
    db.commit()
    return {"ok": True, "submission": crud.to_dict(row)}


@router.post("/{submission_id}/ceo-decide")
def ceo_decide(submission_id: int, payload: schemas.WorkflowNoteRequest, current_user: str = Depends(get_current_user_name), db: Session = Depends(get_db)):
    """CEO批示：批示后回到负责人执行确认写入。"""
    row = _load_submission(db, submission_id)
    _require_project_id(row)
    context = get_user_context_from_db(current_user or payload.operator, db)
    _require_confirmation_center(context)
    if not _can_ceo(context, row, db):
        raise HTTPException(403, "permission denied — 仅该项目 project_ceo 或管理员可批示")
    _require_submission_status(row, _CEO_DECISION_STATUSES)
    before = crud.to_dict(row)
    row.confirm_status = "CEO已批示"
    row.ceo_note = payload.note or ""
    crud.log(db, payload.operator, "CEO批示", "confirmation", row.id, before, {"note": payload.note})
    db.commit()
    return {"ok": True, "submission": crud.to_dict(row)}


@router.post("/{submission_id}/mark-unrecognized")
def mark_unrecognized(submission_id: int, payload: schemas.RejectRequest, current_user: str = Depends(get_current_user_name), db: Session = Depends(get_db)):
    """过程保障标记需人工处理，移入流转中队列由过程保障分配。"""
    row = _load_submission(db, submission_id)
    context = get_user_context_from_db(current_user or payload.operator, db)
    _require_confirmation_center(context)
    if not (_can_confirm(context, row, db) or can_assign_submission(context)):
        raise HTTPException(403, "permission denied")
    before = crud.to_dict(row)
    row.confirm_status = "需修改"
    row.reject_reason = payload.reason
    crud.log(db, payload.operator, "转交过程保障处理", "confirmation", row.id, before, {"reason": payload.reason})
    db.commit()
    return {"ok": True, "submission": crud.to_dict(row)}


@router.post("/{submission_id}/assign")
def assign(submission_id: int, payload: schemas.AssignRequest, current_user: str = Depends(get_current_user_name), db: Session = Depends(get_db)):
    row = _load_submission(db, submission_id)
    context = get_user_context_from_db(current_user or payload.operator, db)
    _require_confirmation_center(context)
    if not can_assign_submission(context):
        raise HTTPException(403, "permission denied")
    before = crud.to_dict(row)
    data = _submission_result(row)
    data["assigned_to"] = payload.assignee
    if "task" in data:
        data["task"]["owner"] = payload.assignee
    row.human_result_json = json.dumps(data, ensure_ascii=False)
    row.confirm_status = "待负责人审核"
    crud.log(db, payload.operator, f"指定责任人：{payload.assignee}", "confirmation", row.id, before, data)
    db.commit()
    return {"ok": True, "submission": crud.to_dict(row)}
