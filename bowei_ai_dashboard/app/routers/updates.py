import json
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import crud, models, schemas
from ..database import get_db
from ..domain import submission_status as SS
from ..permissions import (
    ROLE_CEO,
    can_view_submission,
    get_current_user_name,
    get_person_id,
    get_user_context_from_db,
    resolve_project_id,
)
from ..services.policy import can_submit_to_project as _can_submit_to_project
from ..services.extractor import extract_update

router = APIRouter(prefix="/api/updates", tags=["updates"])


# ── 内部工具 ───────────────────────────────────────────────────

def _update_human_result(row: models.UpdateSubmission) -> dict:
    try:
        return json.loads(row.human_result_json or row.ai_result_json or "{}")
    except Exception:
        return {}


def _can_view_update(context: dict, row: models.UpdateSubmission) -> bool:
    human = _update_human_result(row)
    return can_view_submission(context, human, row.submitter or "")


def _ceo_name(db: Session) -> str:
    row = db.query(models.Person).filter_by(system_role=ROLE_CEO, is_active=True).first()
    return row.name if row else ""


# ── 端点 ───────────────────────────────────────────────────────

@router.post("/extract")
def extract(
    payload: schemas.ExtractRequest,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    """纯 AI 提取，不创建提交记录，不要求 project_id。语音更新模块专用，强制走 LLM。"""
    _ = current_user
    try:
        result = extract_update(
            payload.source_type, payload.transcript_text,
            payload.submitter, payload.llm_provider, _ceo_name(db),
            require_llm=True,
        )
    except RuntimeError as exc:
        raise HTTPException(502, str(exc))
    return {"suggestion": result}


@router.post("")
def create_update(
    payload: schemas.ExtractRequest,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    context = get_user_context_from_db(current_user, db)
    submitter = payload.submitter or current_user

    # ── 1. 解析 project_id ────────────────────────────────────────
    effective_project_id = resolve_project_id(payload.special_project, payload.project_id, db)
    if effective_project_id is None:
        raise HTTPException(
            422,
            "project_id is required (provide project_id or a valid special_project)",
        )

    # ── 2. 成员角色校验 ───────────────────────────────────────────
    # Ensure context carries person_id (submitter may differ from current_user)
    if not context.get("person_id"):
        context = dict(context, person_id=get_person_id(submitter, db))
    if not _can_submit_to_project(context, effective_project_id, db):
        raise HTTPException(403, "只有项目负责人（owner）、统筹人（coordinator）或成员（member）可以提交进展")

    # ── 3. 去重：60秒内同一提交人+同一原文不重复入库 ─────────────
    cutoff = datetime.utcnow() - timedelta(seconds=60)
    dup = db.query(models.UpdateSubmission).filter(
        models.UpdateSubmission.submitter == (submitter or ""),
        models.UpdateSubmission.transcript_text == (payload.transcript_text or ""),
        models.UpdateSubmission.source_type == (payload.source_type or ""),
        models.UpdateSubmission.created_at >= cutoff,
    ).first()
    # 换了 AI 引擎的重复提交不走缓存，允许重新提取
    if dup:
        dup_provider = json.loads(dup.ai_result_json or "{}").get("engine", "rules")
        current_provider = payload.llm_provider or "rules"
        if dup_provider == current_provider:
            return {"submission": crud.to_dict(dup), "suggestion": json.loads(dup.ai_result_json or "{}")}

    # ── 4. AI 提取 ────────────────────────────────────────────────
    # 指定了 LLM provider 就强制走 LLM，失败直接报错不降级
    _require_llm = bool(payload.llm_provider and payload.llm_provider != "rules")
    try:
        result = extract_update(
            payload.source_type, payload.transcript_text,
            submitter, payload.llm_provider, _ceo_name(db),
            require_llm=_require_llm,
        )
    except RuntimeError as exc:
        raise HTTPException(502, str(exc))
    human_result = payload.human_result or payload.edited_suggestion or result

    # ── 5. 回填 special_project 到 human_result JSON ─────────────
    # UpdateSubmission 无独立 special_project 列，项目名在 JSON 内。
    # 注入保证旧 extract_submission_project() 逻辑可以读到项目名。
    proj_name = crud.get_project_name_by_id(effective_project_id, db) or payload.special_project or ""
    if proj_name:
        human_result = dict(human_result)
        if not human_result.get("special_project"):
            human_result["special_project"] = proj_name

    # ── 6. 写入 DB ────────────────────────────────────────────────
    row = models.UpdateSubmission(
        project_id=effective_project_id,
        source_type=payload.source_type,
        submitter=submitter or "",
        title=payload.title or "未命名更新",
        transcript_text=payload.transcript_text,
        ai_result_json=json.dumps(result, ensure_ascii=False),
        human_result_json=json.dumps(human_result, ensure_ascii=False),
        confirm_status=SS.S_NEW,
        confidence=human_result.get("confidence", result.get("confidence", 0)),
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return {"submission": crud.to_dict(row), "suggestion": result}


@router.get("")
def list_updates(
    project_id: int | None = None,
    special_project: str | None = None,
    mine: bool = False,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    context = get_user_context_from_db(current_user, db)

    # mine=true：只看自己提交的，无需项目过滤，无需确认中心权限
    if mine:
        rows = db.query(models.UpdateSubmission).filter(
            models.UpdateSubmission.submitter == current_user
        ).order_by(models.UpdateSubmission.created_at.desc()).all()
        result = []
        for row in rows:
            item = crud.to_dict(row)
            human = _update_human_result(row)
            item["special_project"] = (
                human.get("special_project")
                or (human.get("task") or {}).get("special_project")
                or ""
            )
            result.append(item)
        return result

    # ── 解析有效 project_id ───────────────────────────────────────
    # 策略：special_project 无法解析时返回 []，保持 GET 请求不破坏旧页面
    effective_project_id: int | None = None
    if project_id is not None:
        effective_project_id = project_id
    elif special_project:
        effective_project_id = resolve_project_id(special_project, None, db)
        if effective_project_id is None:
            return []

    # 预先解析项目名（用于旧数据的 JSON 匹配）
    filter_proj_name: str | None = None
    if effective_project_id is not None:
        filter_proj_name = crud.get_project_name_by_id(effective_project_id, db)

    rows = db.query(models.UpdateSubmission).order_by(
        models.UpdateSubmission.created_at.desc()
    ).all()

    result = []
    for row in rows:
        # 原有可见性权限检查（不变）
        if not _can_view_update(context, row):
            continue

        # ── 项目过滤（兼容新旧数据）──────────────────────────────
        if effective_project_id is not None:
            if row.project_id == effective_project_id:
                pass  # 新数据：project_id 已写入
            elif row.project_id is None:
                # 旧数据：从 human_result_json / ai_result_json 解析 special_project
                human = _update_human_result(row)
                row_proj = (
                    human.get("special_project")
                    or (human.get("task") or {}).get("special_project")
                    or ""
                ).strip()
                if not filter_proj_name or row_proj != filter_proj_name:
                    continue
            else:
                continue  # project_id 已设置但与目标不符

        item = crud.to_dict(row)
        human = _update_human_result(row)
        item["special_project"] = (
            human.get("special_project")
            or (human.get("task") or {}).get("special_project")
            or ""
        )
        result.append(item)
    return result


@router.get("/{submission_id}")
def get_update(
    submission_id: int,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    context = get_user_context_from_db(current_user, db)
    row = db.get(models.UpdateSubmission, submission_id)
    if not row:
        raise HTTPException(404, "update not found")
    if not _can_view_update(context, row):
        raise HTTPException(403, "permission denied")
    data = crud.to_dict(row)
    data["ai_result"] = json.loads(row.ai_result_json or "{}")
    data["human_result"] = json.loads(row.human_result_json or row.ai_result_json or "{}")
    return data


@router.delete("/{submission_id}")
def delete_update(
    submission_id: int,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    context = get_user_context_from_db(current_user, db)
    row = db.get(models.UpdateSubmission, submission_id)
    if not row:
        raise HTTPException(404, "update not found")
    # 只允许本人或 tech_admin 删除
    is_owner = row.submitter == context["name"]
    if not is_owner and not context.get("is_tech_admin"):
        raise HTTPException(403, "permission denied — 只能删除自己的提交记录")
    db.delete(row)
    db.commit()
    return {"ok": True}
