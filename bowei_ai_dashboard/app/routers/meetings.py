import asyncio
import json
import logging
import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import and_, or_, text
from sqlalchemy.orm import Session

from .. import crud, models, schemas
from ..database import get_db
from ..llm_config import get_provider_config

logger = logging.getLogger("bowei.meetings")
from ..permissions import (
    PROJECT_ROLE_OWNER,
    can_view_project,
    get_all_project_roles,
    get_current_user_name,
    get_user_context_from_db,
    resolve_project_id,
)

router = APIRouter(prefix="/api/meetings", tags=["meetings"])

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


def _row_project_id(row: models.Meeting, db: Session) -> int | None:
    if row.project_id is not None:
        return row.project_id
    return resolve_project_id(row.related_special_project or "", None, db)


# ── 端点 ──────────────────────────────────────────────────────

@router.get("")
def list_meetings(
    project_id: int | None = None,
    related_special_project: str | None = None,
    meeting_type: str | None = None,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    context = get_user_context_from_db(current_user, db)

    # ── 解析有效 project_id ───────────────────────────────────────
    effective_project_id: int | None = None
    if project_id is not None:
        effective_project_id = project_id
    elif related_special_project:
        effective_project_id = resolve_project_id(related_special_project, None, db)
        if effective_project_id is None:
            return []

    q = db.query(models.Meeting)

    # ── 权限：限制可见专项 ────────────────────────────────────────
    if not context["can_view_all"]:
        if not context["visible_projects"]:
            return []
        q = q.filter(models.Meeting.related_special_project.in_(context["visible_projects"]))

    # ── 项目过滤 ─────────────────────────────────────────────────
    if effective_project_id is not None:
        proj_name = crud.get_project_name_by_id(effective_project_id, db)
        if not proj_name or not can_view_project(context, proj_name):
            return []
        q = q.filter(
            or_(
                models.Meeting.project_id == effective_project_id,
                and_(
                    models.Meeting.project_id.is_(None),
                    models.Meeting.related_special_project == proj_name,
                ),
            )
        )
    elif related_special_project:
        if not can_view_project(context, related_special_project):
            return []
        q = q.filter(models.Meeting.related_special_project == related_special_project)

    if meeting_type:
        q = q.filter(models.Meeting.meeting_type == meeting_type)

    return [
        crud.to_dict(r)
        for r in q.order_by(
            models.Meeting.meeting_date.desc(),
            models.Meeting.updated_at.desc(),
        ).all()
    ]


@router.post("")
def create_meeting(
    payload: schemas.MeetingPayload,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    context = get_user_context_from_db(current_user, db)

    effective_project_id = resolve_project_id(payload.related_special_project, payload.project_id, db)
    if effective_project_id is None:
        raise HTTPException(
            422,
            "project_id is required (provide project_id or a valid related_special_project)",
        )

    proj_name = crud.get_project_name_by_id(effective_project_id, db) or payload.related_special_project or ""
    _check_write(context, effective_project_id, proj_name, db)

    data = {k: v for k, v in payload.dict().items() if k != "project_id"}
    row = models.Meeting(**data)
    row.project_id = effective_project_id
    if not row.related_special_project:
        row.related_special_project = proj_name
    db.add(row)
    db.flush()
    crud.log(db, current_user, "新建会议", "meeting", row.id, {}, crud.to_dict(row))
    db.commit()
    db.refresh(row)
    return crud.to_dict(row)


# ── /analyze 必须在 /{row_id} 之前注册，否则 FastAPI 把 "analyze" 当 row_id ──

class MeetingAnalyzeRequest(BaseModel):
    text: str
    project_id: int | None = None


@router.post("/analyze")
async def analyze_meeting(
    payload: MeetingAnalyzeRequest,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    if not payload.text.strip():
        raise HTTPException(422, "text 不能为空")

    # 自动检测是否有"说话人N"标注，有则用项目汇报提示词（保留说话人标签）
    has_speakers = bool(re.search(r"说话人\s*\d+", payload.text))
    if has_speakers:
        prompt = _PROMPT_REPORT.format(
            member_context='（发言人身份待会议结束后映射，请直接使用"说话人N"作为成员标识）',
            text=payload.text[:10000],
        )
    else:
        prompt = _PROMPT_GENERIC.format(text=payload.text[:8000])

    provider = _pick_provider()
    try:
        result = await asyncio.to_thread(_do_analyze, payload.text, prompt, provider)
    except Exception as exc:
        logger.warning("meeting analyze failed: %s", exc)
        raise HTTPException(500, f"AI 分析失败：{exc}")

    reports      = result.get("reports") or []
    decisions    = result.get("decisions") or []
    action_items = result.get("action_items") or result.get("task_list") or []

    return {
        "title":               result.get("title", ""),
        "meeting_type":        result.get("meeting_type", ""),
        "meeting_date":        result.get("meeting_date", ""),
        "host":                result.get("host", ""),
        "participants":        result.get("participants", ""),
        "summary":             result.get("summary", ""),
        "reports_json":        json.dumps(reports, ensure_ascii=False),
        "task_list_json":      json.dumps(action_items, ensure_ascii=False),
        "decision_items_json": json.dumps(decisions, ensure_ascii=False),
        "risk_items_json":     json.dumps(result.get("risk_items") or [], ensure_ascii=False),
        "transcript_text":     payload.text,
        "has_speakers":        has_speakers,
    }


@router.get("/{row_id}")
def get_meeting(
    row_id: int,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    context = get_user_context_from_db(current_user, db)
    row = db.get(models.Meeting, row_id)
    if not row:
        raise HTTPException(404, "meeting not found")
    if not can_view_project(context, row.related_special_project or ""):
        raise HTTPException(403, "permission denied")
    return crud.to_dict(row)


@router.put("/{row_id}")
def update_meeting(
    row_id: int,
    payload: schemas.MeetingPayload,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    context = get_user_context_from_db(current_user, db)
    row = db.get(models.Meeting, row_id)
    if not row:
        raise HTTPException(404, "meeting not found")

    project_id = _row_project_id(row, db)
    _check_write(context, project_id, row.related_special_project or "", db)

    before = crud.to_dict(row)
    update_data = {k: v for k, v in payload.dict().items() if k != "project_id"}
    crud.update_model(row, update_data)
    new_pid = resolve_project_id(payload.related_special_project, payload.project_id, db)
    if new_pid is not None:
        row.project_id = new_pid
    crud.log(db, current_user, "修改会议", "meeting", row.id, before, payload.dict())
    db.commit()
    return crud.to_dict(row)


@router.patch("/{row_id}/status")
def patch_meeting_status(
    row_id: int,
    payload: schemas.MeetingStatusPatch,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    context = get_user_context_from_db(current_user, db)
    row = db.get(models.Meeting, row_id)
    if not row:
        raise HTTPException(404, "meeting not found")
    if not can_view_project(context, row.related_special_project or ""):
        raise HTTPException(403, "permission denied")

    allowed = {"draft", "published", "returned"}
    if payload.publish_status not in allowed:
        raise HTTPException(422, f"publish_status must be one of {allowed}")

    before = {"publish_status": row.publish_status}
    row.publish_status = payload.publish_status
    action = {"published": "发布会议纪要", "returned": "退回会议纪要", "draft": "重置为草稿"}.get(payload.publish_status, "更新状态")
    crud.log(db, current_user, action, "meeting", row.id, before, {"publish_status": payload.publish_status})
    db.commit()
    return crud.to_dict(row)


@router.delete("/{row_id}")
def delete_meeting(
    row_id: int,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    context = get_user_context_from_db(current_user, db)
    row = db.get(models.Meeting, row_id)
    if not row:
        raise HTTPException(404, "meeting not found")

    project_id = _row_project_id(row, db)
    _check_write(context, project_id, row.related_special_project or "", db)

    before = crud.to_dict(row)
    crud.log(db, current_user, "删除会议", "meeting", row_id, before, {})
    db.delete(row)
    db.commit()
    return {"ok": True}


# ── 会议纪要 AI 分析 ──────────────────────────────────────────────

# 通用提示词（无发言人映射时使用）
_PROMPT_GENERIC = """你是一个会议纪要结构化提取助手。请从下面的会议文字中提取结构化信息，只输出 JSON。

会议文字：
```
{text}
```

输出格式（严格 JSON，没有的字段填空字符串或空数组）：
{{
  "title": "根据内容自动生成会议标题",
  "meeting_type": "weekly/monthly/review/special/discuss，选最合适的",
  "meeting_date": "YYYY-MM-DD，未提及则空字符串",
  "host": "主持人姓名，未提及则空字符串",
  "participants": "参会人逗号分隔",
  "summary": "100字以内整体摘要",
  "reports": [],
  "decisions": ["决策事项"],
  "action_items": [{{"member": "负责人", "task": "事项", "deadline": "时间或空字符串"}}]
}}
"""

# 项目汇报会提示词（有发言人映射 + 成员上下文时使用）
_PROMPT_REPORT = """你是一个项目推进汇报会的会议纪要提取专家。

【参会人员及背景】
{member_context}

【会议转录文字】
```
{text}
```

【提取要求】
这是一场项目推进汇报会，每位成员依次汇报本期进展，领导进行点评和指导。

对每位汇报人，请提取：
1. 本期完成了什么（结合该成员"上次计划"对比，判断完成情况）
2. 遇到的问题或卡点
3. 请求领导协助或需要决策的事项
4. 领导对该人的反馈（分三类）：
   - 肯定的内容
   - 需要改进的地方
   - 补充提醒（汇报人没提到但领导专门指出的盲点，这个非常重要不能遗漏）
5. 该人宣布的下一步计划（含时间节点）

注意：
- "领导"角色的发言内容是评价和指导，不是汇报，不要给他生成报告条目
- 区分"已完成"和"进行中"，汇报人说"基本完成""差不多了"属于"部分完成"
- 如果汇报人的任务与上次计划对不上，要在 vs_last_plan 中说明

严格输出 JSON，不要任何解释：
{{
  "title": "会议标题",
  "meeting_type": "weekly/monthly/review/special/discuss",
  "meeting_date": "YYYY-MM-DD或空字符串",
  "host": "主持人姓名",
  "participants": "参会人逗号分隔",
  "summary": "100字以内整体摘要，概括本次汇报的整体完成情况和核心议题",
  "reports": [
    {{
      "member": "成员姓名",
      "role": "该成员在项目中的角色",
      "completed_items": ["本期完成的事项"],
      "vs_last_plan": "完成/部分完成/未完成/未提及",
      "issues": ["遇到的问题或卡点"],
      "requests": ["请求协助或需要决策的内容"],
      "leader_feedback": {{
        "positive": ["领导肯定的内容"],
        "improve": ["领导指出需要改进的地方"],
        "reminder": ["领导补充提醒但汇报人未提到的重要点"]
      }},
      "next_steps": [{{"task": "事项描述", "deadline": "时间节点或空字符串"}}]
    }}
  ],
  "decisions": ["本次会议整体决策事项"],
  "action_items": [{{"member": "负责人", "task": "事项", "deadline": "时间或空字符串"}}]
}}
"""




def _fetch_member_context(member_name: str, project_id: int, db: Session) -> dict:
    """查询该成员当前任务列表和上次提交的 next_steps。"""
    from sqlalchemy import or_
    from .. import models as m

    tasks = (
        db.query(m.Task)
        .filter(
            m.Task.project_id == project_id,
            or_(m.Task.owner == member_name, m.Task.collaborators.contains(member_name)),
            m.Task.status.notin_(["已完成"]),
        )
        .order_by(m.Task.plan_time)
        .limit(8)
        .all()
    )

    last_sub = (
        db.query(m.UpdateSubmission)
        .filter(
            m.UpdateSubmission.project_id == project_id,
            m.UpdateSubmission.submitter == member_name,
        )
        .order_by(m.UpdateSubmission.created_at.desc())
        .first()
    )

    next_steps: list[str] = []
    if last_sub:
        for field in (last_sub.human_result_json, last_sub.ai_result_json):
            if not field:
                continue
            try:
                data = json.loads(field)
                ns = data.get("next_steps") or []
                next_steps = [str(s) for s in ns if s]
                if next_steps:
                    break
            except Exception:
                pass

    return {
        "name": member_name,
        "tasks": [
            {
                "task": t.key_task,
                "status": t.status,
                "plan_time": t.plan_time or "",
                "problem": t.problem_note or "",
            }
            for t in tasks
        ],
        "last_next_steps": next_steps,
    }


def _build_member_context_text(
    speaker_map: dict[str, str],
    speaker_roles: dict[str, str],
    project_id: int,
    db: Session,
) -> str:
    lines: list[str] = []
    seen: set[str] = set()

    for speaker, name in speaker_map.items():
        role = speaker_roles.get(speaker, "其他")
        label = f"{speaker}（{name}，{role}）" if name else f"{speaker}（{role}）"

        if role == "领导":
            lines.append(f"- {label}：负责对汇报内容进行点评和指导，无需生成汇报条目")
            continue

        if not name or name in seen:
            lines.append(f"- {label}")
            continue
        seen.add(name)

        ctx = _fetch_member_context(name, project_id, db)

        block = [f"- {label}"]
        if ctx["last_next_steps"]:
            block.append(f"  上次计划的下一步：")
            for ns in ctx["last_next_steps"][:5]:
                block.append(f"    · {ns}")
        else:
            block.append(f"  上次计划：（无记录）")

        if ctx["tasks"]:
            block.append(f"  当前进行中任务：")
            for t in ctx["tasks"]:
                status_str = f"[{t['status']}]" if t["status"] else ""
                time_str = f"，计划{t['plan_time']}" if t["plan_time"] else ""
                problem_str = f"，问题：{t['problem']}" if t["problem"] else ""
                block.append(f"    · {t['task']}{status_str}{time_str}{problem_str}")
        lines.extend(block)

    return "\n".join(lines) if lines else "（未提供参会人信息）"


def _do_analyze(text: str, prompt: str, provider: str) -> dict:
    if provider == "anthropic":
        import anthropic
        cfg = get_provider_config("anthropic")
        if not cfg.get("api_key"):
            raise ValueError("未配置 Claude API Key")
        client = anthropic.Anthropic(api_key=cfg["api_key"], timeout=90)
        resp = client.messages.create(
            model=cfg["model"],
            max_tokens=4096,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = resp.content[0].text
    else:
        from openai import OpenAI
        cfg = get_provider_config(provider)
        if not cfg.get("api_key"):
            raise ValueError(f"未配置 {provider} API Key")
        client = OpenAI(api_key=cfg["api_key"], base_url=cfg["base_url"], timeout=90)
        resp = client.chat.completions.create(
            model=cfg["model"],
            messages=[{"role": "user", "content": prompt}],
            max_tokens=4096,
        )
        raw = resp.choices[0].message.content or ""

    match = re.search(r"\{[\s\S]+\}", raw.strip())
    if not match:
        raise ValueError("LLM 未返回有效 JSON")
    return json.loads(match.group())


def _pick_provider() -> str:
    for p in ("anthropic", "dashscope", "deepseek", "glm"):
        cfg = get_provider_config(p)
        if cfg.get("api_key") and cfg.get("enabled", False):
            return p
    for p in ("anthropic", "dashscope", "deepseek", "glm"):
        cfg = get_provider_config(p)
        if cfg.get("api_key"):
            return p
    return "anthropic"


