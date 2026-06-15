import json
import logging
import os
import re
from datetime import date

from ..permissions import PROJECT_AREAS

logger = logging.getLogger("bowei.extractor")

USE_LLM = os.getenv("BOWEI_USE_LLM", "false").lower() == "true"
LLM_PROVIDER = os.getenv("LLM_PROVIDER", "anthropic").lower()
# 单次 LLM 调用最长等待秒数，可通过环境变量覆盖
_LLM_TIMEOUT = int(os.getenv("LLM_CALL_TIMEOUT", "45"))

PROJECTS = [area["name"] for area in PROJECT_AREAS]
PROJECT_ALIASES = {
    "知识库": "知识资产AI化",
    "知识资产": "知识资产AI化",
    "知识问答": "知识资产AI化",
    "顾问": "顾问作业AI化",
    "质检": "顾问作业AI化",
    "prompt": "顾问作业AI化",
    "交付": "交付流程AI化",
    "流程": "交付流程AI化",
    "产品化": "咨询服务产品化",
    "训练营": "咨询服务产品化",
    "销售材料": "咨询服务产品化",
    "平台": "技术底座与平台预研",
    "底座": "技术底座与平台预研",
    "agent": "技术底座与平台预研",
}

ACHIEVEMENT_TYPES = [
    "方案",
    "表格",
    "模板",
    "SOP",
    "Prompt",
    "Agent原型",
    "会议纪要",
    "复盘报告",
    "案例包",
    "产品材料",
]
REUSE_TAGS = ["内部使用", "项目复用", "产品材料", "客户交付"]
ISSUE_TYPES = ["问题", "风险", "决策", "待协调"]
STATUS_VALUES = ["未开始", "进行中", "已完成", "延期", "暂缓"]

_EXTRACT_PROMPT = """你是博维AI升级项目的结构化提取助手。请从下面的进度文本或会议纪要中提取结构化信息，只输出 JSON，不要输出解释。
文本：
```
{text}
```

要求：
1. `special_project` 如实提取文本中明确提到的专项名称；若文本中没有明确说明则留空，不要猜测或发明项目名
2. `related_task` 是对**本周主要工作内容**的简短概括（10-25字），描述本周在做什么，不要写下周计划
3. `completed_items` 是本周已完成的具体事项列表，与 `related_task` 互补：related_task 是概述，completed_items 是明细
4. `achievements` 只记录真实产出的成果，如方案、模板、报告、SOP、Prompt、Agent原型、会议纪要、案例包、产品材料
5. `issues` 只记录明确的问题、风险、待协调事项、待决策事项
6. 没提到的信息填空字符串或空数组，不要编造
7. `summary` 用一句话概括本次进展的核心内容（不超过60字），不要直接抄原文

输出格式：
{{
  "summary": "",
  "special_project": "",
  "related_task": "",
  "completed_items": [""],
  "achievements": [
    {{
      "name": "",
      "achievement_type": "方案/表格/模板/SOP/Prompt/Agent原型/会议纪要/复盘报告/案例包/产品材料",
      "special_project": "",
      "owner": "",
      "version": "V0.1",
      "file_link": "",
      "scenario": "",
      "reuse_tag": "内部使用/项目复用/产品材料/客户交付",
      "status": "草稿/可复用"
    }}
  ],
  "issues": [
    {{
      "issue_type": "问题/风险/决策/待协调",
      "description": "",
      "owner": "",
      "helper": "",
      "priority": "高/中/低",
      "status": "待处理",
      "need_decision_by": "",
      "expected_resolve_time": "",
      "resolution": "",
      "special_project": ""
    }}
  ],
  "next_steps": [""],
  "status_suggestion": "未开始/进行中/已完成/延期/暂缓",
  "need_coordination": [""]
}}
"""


def _get_cfg(provider: str) -> dict:
    from ..llm_config import get_provider_config

    cfg = get_provider_config(provider)
    if not cfg.get("api_key"):
        env_map = {
            "anthropic": "ANTHROPIC_API_KEY",
            "dashscope": "DASHSCOPE_API_KEY",
            "deepseek": "DEEPSEEK_API_KEY",
            "glm": "ZHIPUAI_API_KEY",
        }
        cfg["api_key"] = os.getenv(env_map.get(provider, ""), "")
    return cfg


def _extract_json_blob(raw: str) -> dict:
    match = re.search(r"\{[\s\S]+\}", raw.strip())
    if not match:
        raise ValueError("LLM did not return valid JSON")
    return json.loads(match.group())


def _call_anthropic(text: str) -> dict:
    import anthropic

    cfg = _get_cfg("anthropic")
    if not cfg.get("api_key"):
        raise ValueError("Claude API Key not configured")
    client = anthropic.Anthropic(api_key=cfg["api_key"], timeout=_LLM_TIMEOUT)
    prompt = _EXTRACT_PROMPT.format(text=text)
    resp = client.messages.create(
        model=cfg["model"],
        max_tokens=2048,
        messages=[{"role": "user", "content": prompt}],
    )
    return _extract_json_blob(resp.content[0].text)


def _call_openai_compat(text: str, provider: str) -> dict:
    from openai import OpenAI

    cfg = _get_cfg(provider)
    if not cfg.get("api_key"):
        raise ValueError(f"{provider} API Key not configured")
    client = OpenAI(api_key=cfg["api_key"], base_url=cfg["base_url"], timeout=_LLM_TIMEOUT)
    prompt = _EXTRACT_PROMPT.format(text=text)
    resp = client.chat.completions.create(
        model=cfg["model"],
        messages=[{"role": "user", "content": prompt}],
        max_tokens=2048,
    )
    return _extract_json_blob(resp.choices[0].message.content or "")


def _extract_with_llm(text: str, provider: str) -> dict | None:
    try:
        data = _call_anthropic(text) if provider == "anthropic" else _call_openai_compat(text, provider)
        logger.info("LLM extract success provider=%s project=%s", provider, data.get("special_project"))
        return data
    except Exception as exc:
        logger.warning("LLM extract failed provider=%s: %s", provider, exc)
        return None


def _clean_text(text: str) -> str:
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+", " ", text)
    return text.strip()


def _sentences(text: str) -> list[str]:
    parts = re.split(r"[。！？；;\n]+", _clean_text(text))
    return [part.strip(" ，。；;") for part in parts if part.strip(" ，。；;")]


def _contains_any(text: str, words: list[str]) -> bool:
    lowered = text.lower()
    return any(word.lower() in lowered for word in words)


def _dedupe(items: list[str]) -> list[str]:
    seen: list[str] = []
    for item in items:
        value = str(item or "").strip()
        if value and value not in seen:
            seen.append(value)
    return seen


def _pick_project(text: str) -> str:
    for project in PROJECTS:
        if project and project in text:
            return project
    lowered = text.lower()
    for alias, project in PROJECT_ALIASES.items():
        if alias in lowered:
            return project
    return ""


def _take_sentences(text: str, include: list[str], exclude: list[str] | None = None, limit: int = 5) -> list[str]:
    exclude = exclude or []
    rows = []
    for sentence in _sentences(text):
        if _contains_any(sentence, include) and not _contains_any(sentence, exclude):
            rows.append(sentence)
    return _dedupe(rows)[:limit]


def _status(text: str) -> str:
    if _contains_any(text, ["延期", "阻塞", "卡点", "风险", "受阻"]):
        return "延期"
    if _contains_any(text, ["暂停", "暂缓", "先放一放"]):
        return "暂缓"
    if _contains_any(text, ["完成", "已完成", "交付", "上线", "收尾", "验收通过"]):
        return "已完成"
    if _contains_any(text, ["计划", "准备", "开始", "启动", "推进"]):
        return "进行中"
    return "进行中"


def _achievement_type(name: str) -> str:
    upper = name.upper()
    if "SOP" in upper:
        return "SOP"
    if "PROMPT" in upper or "提示词" in name:
        return "Prompt"
    if "AGENT" in upper or "原型" in name:
        return "Agent原型"
    if "模板" in name:
        return "模板"
    if "表" in name or "清单" in name:
        return "表格"
    if "复盘" in name or "报告" in name:
        return "复盘报告"
    if "案例" in name:
        return "案例包"
    if "纪要" in name:
        return "会议纪要"
    if "产品" in name or "销售" in name or "物料" in name:
        return "产品材料"
    return "方案"


def _achievement_rows(text: str, project: str, submitter: str | None) -> list[dict]:
    lines = _take_sentences(
        text,
        ["形成", "产出", "输出", "沉淀", "完成", "报告", "方案", "模板", "SOP", "Prompt", "Agent", "清单", "纪要", "工具包", "手册"],
        ["问题", "风险", "下周", "下一步"],
        limit=6,
    )
    rows = []
    for line in lines:
        if not _contains_any(line, ["报告", "方案", "模板", "SOP", "Prompt", "Agent", "清单", "纪要", "工具包", "文档", "手册", "案例", "机制"]):
            continue
        rows.append(
            {
                "name": line[:80],
                "achievement_type": _achievement_type(line),
                "special_project": project,
                "owner": submitter or "",
                "version": "V0.1",
                "file_link": "",
                "scenario": "项目推进复用",
                "reuse_tag": "项目复用",
                "status": "可复用" if _contains_any(line, ["完成", "已完成", "输出", "交付"]) else "草稿",
            }
        )
    return rows


def _issue_type(line: str) -> str:
    if _contains_any(line, ["决策", "拍板", "审批"]):
        return "决策"
    if _contains_any(line, ["风险", "延期", "阻塞", "受阻"]):
        return "风险"
    if _contains_any(line, ["协调", "支持", "依赖", "权限"]):
        return "待协调"
    return "问题"


def _issue_priority(line: str) -> str:
    if _contains_any(line, ["风险", "阻塞", "延期", "拍板", "决策", "权限", "卡住"]):
        return "高"
    if _contains_any(line, ["关注", "跟进", "协调"]):
        return "中"
    return "低"


def _decision_owner(line: str, ceo_name: str = "") -> str:
    if _contains_any(line, ["海总", "组长", "拍板", "决策", "审批"]):
        return ceo_name
    if ceo_name and _contains_any(line, [ceo_name]):
        return ceo_name
    return ""


def _issue_rows(text: str, project: str, submitter: str | None, ceo_name: str = "") -> list[dict]:
    lines = _take_sentences(
        text,
        ["问题", "风险", "卡点", "阻塞", "延期", "决策", "拍板", "协调", "依赖", "权限", "需要"],
        ["完成", "已完成"],
        limit=5,
    )
    rows = []
    for line in lines:
        issue_type = _issue_type(line)
        rows.append(
            {
                "issue_type": issue_type,
                "description": line,
                "owner": submitter or "",
                "helper": ceo_name if ceo_name and _contains_any(line, ([ceo_name] if ceo_name else []) + ["海总", "协调"]) else "",
                "priority": _issue_priority(line),
                "status": "待处理",
                "need_decision_by": _decision_owner(line, ceo_name) if issue_type == "决策" else "",
                "expected_resolve_time": "",
                "resolution": "",
                "special_project": project,
            }
        )
    return rows


def _normalize_llm_result(llm_data: dict, source_type: str, text: str, submitter: str | None, ceo_name: str = "") -> dict:
    # LLM 提取的 special_project 仅作展示用，不再用关键词猜测兜底
    project = (llm_data.get("special_project") or "").strip()
    completed = _dedupe(list(llm_data.get("completed_items") or []))
    next_steps = _dedupe(list(llm_data.get("next_steps") or []))
    achievements = list(llm_data.get("achievements") or [])
    issues = list(llm_data.get("issues") or [])

    for row in achievements:
        row["name"] = row.get("name", "")
        row["achievement_type"] = row.get("achievement_type") or _achievement_type(row["name"])
        row["special_project"] = row.get("special_project") or project
        row["owner"] = row.get("owner") or (submitter or "")
        row["version"] = row.get("version") or "V0.1"
        row["file_link"] = row.get("file_link") or ""
        row["scenario"] = row.get("scenario") or "项目推进复用"
        row["reuse_tag"] = row.get("reuse_tag") or "项目复用"
        row["status"] = row.get("status") or "草稿"

    for row in issues:
        issue_type = row.get("issue_type") or "问题"
        row["issue_type"] = issue_type if issue_type in ISSUE_TYPES else "问题"
        row["owner"] = row.get("owner") or (submitter or "")
        row["helper"] = row.get("helper") or ""
        row["priority"] = row.get("priority") or "中"
        row["status"] = row.get("status") or "待处理"
        row["need_decision_by"] = row.get("need_decision_by") or (_decision_owner(row.get("description", ""), ceo_name) if row["issue_type"] == "决策" else "")
        row["expected_resolve_time"] = row.get("expected_resolve_time") or ""
        row["resolution"] = row.get("resolution") or ""
        row["special_project"] = row.get("special_project") or project

    related_task = llm_data.get("related_task") or (completed[0] if completed else (next_steps[0] if next_steps else "持续推进专项工作"))
    summary = (llm_data.get("summary") or "").strip() or _clean_text(text)[:180]
    result = {
        "summary": summary,
        "special_project": project,
        "related_task": related_task,
        "completed_items": completed,
        "achievements": achievements,
        "issues": issues,
        "next_steps": next_steps,
        "decision_items": [row["description"] for row in issues if row.get("issue_type") == "决策"],
        "status_suggestion": llm_data.get("status_suggestion") or _status(text),
        "need_coordination": _dedupe(list(llm_data.get("need_coordination") or [])),
        "confidence": 0.93,
        "raw_type": source_type,
        "task": {
            "special_project": project,
            "key_task": related_task,
            "key_achievement": achievements[0]["name"] if achievements else "",
            "completion_standard": "负责人确认关键产出可复用，相关问题完成闭环。",
            "coordinator": "",
            "owner": submitter or "",
            "collaborators": "",
            "plan_time": str(date.today())[:7],
            "status": llm_data.get("status_suggestion") or _status(text),
            "problem_note": "；".join([row["description"] for row in issues]),
            "achievement_links": "",
        },
    }
    if source_type == "meeting":
        result["meeting"] = {
            "title": f"{project or '专项'}会议纪要",
            "date": str(date.today()),
            "participants": [submitter or ""],
            "discussion_points": completed,
            "task_items": next_steps,
            "decision_items": result["decision_items"],
            "risk_items": [row["description"] for row in issues if row["issue_type"] == "风险"],
            "next_focus": next_steps,
        }
    return result


def _rule_extract(source_type: str, text: str, submitter: str | None, ceo_name: str = "") -> dict:
    clean_text = _clean_text(text)
    project = _pick_project(clean_text)
    completed = _take_sentences(
        clean_text,
        ["完成", "已完成", "产出", "形成", "输出", "交付", "上线", "沉淀", "整理好"],
        ["问题", "风险", "下周", "下一步"],
        limit=5,
    )
    next_steps = _take_sentences(
        clean_text,
        ["下周", "下一步", "计划", "准备", "继续", "后续"],
        ["已完成"],
        limit=5,
    )
    achievements = _achievement_rows(clean_text, project, submitter)
    issues = _issue_rows(clean_text, project, submitter, ceo_name)

    if not achievements and completed:
        achievements.append(
            {
                "name": completed[0][:80],
                "achievement_type": _achievement_type(completed[0]),
                "special_project": project,
                "owner": submitter or "",
                "version": "V0.1",
                "file_link": "",
                "scenario": "项目推进复用",
                "reuse_tag": "内部使用",
                "status": "草稿",
            }
        )

    related_task = completed[0] if completed else (next_steps[0] if next_steps else "持续推进专项工作")
    result = {
        "summary": clean_text[:180],
        "special_project": project,
        "related_task": related_task,
        "completed_items": completed,
        "achievements": achievements,
        "issues": issues,
        "next_steps": next_steps,
        "decision_items": [row["description"] for row in issues if row["issue_type"] == "决策"],
        "status_suggestion": _status(clean_text),
        "need_coordination": [row["description"] for row in issues if row["issue_type"] in {"待协调", "决策"}],
        "confidence": 0.84 if len(clean_text) >= 60 else 0.62,
        "raw_type": source_type,
        "task": {
            "special_project": project,
            "key_task": related_task,
            "key_achievement": achievements[0]["name"] if achievements else "",
            "completion_standard": "负责人确认关键产出可复用，相关问题完成闭环。",
            "coordinator": "",
            "owner": submitter or "",
            "collaborators": "",
            "plan_time": str(date.today())[:7],
            "status": _status(clean_text),
            "problem_note": "；".join([row["description"] for row in issues]),
            "achievement_links": "",
        },
    }
    if source_type == "meeting":
        result["meeting"] = {
            "title": f"{project or '专项'}会议纪要",
            "date": str(date.today()),
            "participants": [submitter or ""],
            "discussion_points": completed,
            "task_items": next_steps,
            "decision_items": result["decision_items"],
            "risk_items": [row["description"] for row in issues if row["issue_type"] == "风险"],
            "next_focus": next_steps,
        }
    return result


def _with_meta(result: dict, provider: str, used_llm: bool, fallback_reason: str = "") -> dict:
    labels = {
        "rules": "规则引擎",
        "anthropic": "Claude",
        "dashscope": "通义千问",
        "deepseek": "DeepSeek",
        "glm": "智谱GLM",
    }
    result["engine"] = provider
    result["engine_label"] = labels.get(provider, provider)
    result["pipeline"] = "llm_extract" if used_llm else "rule_extract"
    result["llm_used"] = used_llm
    result["fallback_reason"] = fallback_reason
    result["generated_at"] = str(date.today())
    return result


_TASK_OUTLINE_PROMPT = """你是项目管理助手。从下面的大纲或计划文本中提取关键任务列表，只输出 JSON，不要解释。

当前年份：{current_year}

文本：
```
{text}
```

要求：
1. `project_guess`：从文本内容推断这批任务所属的项目或专项名称（用文本中出现的原词或最接近的概念，不确定则留空）
2. 每条任务：key_task（任务名称，10-30字）、owner（负责人姓名，未提及则空）、coordinator（统筹人姓名，未提及则空）、collaborators（协作人，多人用逗号分隔，未提及则空）、plan_time（格式 YYYY-MM 或 YYYY-MM~YYYY-MM，未提及则空；文本中只写了月份未写年份时，用当前年份 {current_year} 补全）、status（默认"未开始"）、key_achievement（期望成果，未提及则空）、completion_standard（完成标准，未提及则空）
3. 最多提取 20 条，按文本顺序排列
4. 只提取明确的任务，不要推断或发明

输出格式：
{{
  "project_guess": "",
  "tasks": [
    {{
      "key_task": "",
      "owner": "",
      "coordinator": "",
      "collaborators": "",
      "plan_time": "",
      "status": "未开始",
      "key_achievement": "",
      "completion_standard": ""
    }}
  ]
}}
"""


def _fix_past_year(plan_time: str) -> str:
    """把 plan_time 里所有早于今年的 YYYY 替换成今年。"""
    if not plan_time:
        return plan_time
    current_year = date.today().year
    def _replace(m: re.Match) -> str:
        y = int(m.group())
        return str(current_year) if y < current_year else m.group()
    return re.sub(r'\d{4}', _replace, plan_time)


def _match_project(guess: str, project_names: list[str]) -> tuple[str, float]:
    """将 AI 猜测的项目名与候选列表做模糊匹配，返回 (最佳匹配名, 置信度)。"""
    if not guess or not project_names:
        return ("", 0.0)
    guess_lower = guess.lower()
    # 精确包含匹配
    for name in project_names:
        if name == guess or name in guess or guess in name:
            return (name, 0.95)
    # 中文关键词（2字以上）或英文单词（3字以上）匹配
    for name in project_names:
        keywords = re.findall(r'[一-鿿]{2,}|[a-zA-Z]{3,}', name.lower())
        for kw in keywords:
            if kw in guess_lower:
                return (name, 0.75)
    return ("", 0.0)


def extract_tasks(text: str, provider: str | None = None, project_names: list[str] | None = None) -> dict:
    """从大纲文本提取关键任务列表（LLM only），失败抛 RuntimeError。
    返回 {tasks, project_guess, suggested_project, confidence}。
    """
    clean = _clean_text(text)
    if not clean:
        return {"tasks": [], "project_guess": "", "suggested_project": "", "confidence": 0.0}

    effective_provider: str | None = None
    if provider and provider != "rules":
        effective_provider = provider
    elif USE_LLM:
        effective_provider = LLM_PROVIDER

    if not effective_provider:
        raise RuntimeError("未配置可用AI引擎，请在系统设置中配置API Key")

    prompt = _TASK_OUTLINE_PROMPT.format(text=clean, current_year=date.today().year)
    try:
        if effective_provider == "anthropic":
            import anthropic
            cfg = _get_cfg("anthropic")
            if not cfg.get("api_key"):
                raise ValueError("Claude API Key not configured")
            client = anthropic.Anthropic(api_key=cfg["api_key"], timeout=_LLM_TIMEOUT)
            resp = client.messages.create(
                model=cfg["model"], max_tokens=2048,
                messages=[{"role": "user", "content": prompt}],
            )
            data = _extract_json_blob(resp.content[0].text)
        else:
            from openai import OpenAI
            cfg = _get_cfg(effective_provider)
            if not cfg.get("api_key"):
                raise ValueError(f"{effective_provider} API Key not configured")
            client = OpenAI(api_key=cfg["api_key"], base_url=cfg["base_url"], timeout=_LLM_TIMEOUT)
            resp = client.chat.completions.create(
                model=cfg["model"], max_tokens=2048,
                messages=[{"role": "user", "content": prompt}],
            )
            data = _extract_json_blob(resp.choices[0].message.content or "")

        tasks = list(data.get("tasks") or [])
        for t in tasks:
            t.setdefault("key_task", "")
            t.setdefault("owner", "")
            t.setdefault("coordinator", "")
            t.setdefault("collaborators", "")
            t.setdefault("plan_time", "")
            t.setdefault("status", "未开始")
            t.setdefault("key_achievement", "")
            t.setdefault("completion_standard", "")
            t["plan_time"] = _fix_past_year(t["plan_time"])
        tasks = [t for t in tasks if t.get("key_task")]

        project_guess = (data.get("project_guess") or "").strip()
        suggested_project, confidence = _match_project(project_guess, project_names or [])

        return {
            "tasks": tasks,
            "project_guess": project_guess,
            "suggested_project": suggested_project,
            "confidence": confidence,
        }
    except Exception as exc:
        logger.warning("extract_tasks failed provider=%s: %s", effective_provider, exc)
        raise RuntimeError(f"AI引擎（{effective_provider}）提取任务失败：{exc}") from exc


def extract_update(source_type: str, transcript_text: str, submitter: str | None = None, provider: str | None = None, ceo_name: str = "", *, require_llm: bool = False) -> dict:
    text = _clean_text(transcript_text)
    if not text:
        return _with_meta({
            "summary": "",
            "special_project": "",
            "related_task": "",
            "completed_items": [],
            "achievements": [],
            "issues": [],
            "next_steps": [],
            "decision_items": [],
            "status_suggestion": "进行中",
            "need_coordination": [],
            "confidence": 0.0,
            "raw_type": source_type,
            "task": {
                "special_project": "",
                "key_task": "",
                "key_achievement": "",
                "completion_standard": "",
                "coordinator": "",
                "owner": submitter or "",
                "collaborators": "",
                "plan_time": str(date.today())[:7],
                "status": "进行中",
                "problem_note": "",
                "achievement_links": "",
            },
        }, provider or "rules", False, "")

    effective_provider = None
    if provider and provider != "rules":
        effective_provider = provider
    elif USE_LLM:
        effective_provider = LLM_PROVIDER

    if effective_provider:
        llm_data = _extract_with_llm(text, effective_provider)
        if llm_data is not None:
            return _with_meta(_normalize_llm_result(llm_data, source_type, text, submitter, ceo_name), effective_provider, True, "")
        if require_llm:
            raise RuntimeError(f"AI引擎（{effective_provider}）调用失败，请检查API Key配置后重试，或联系管理员")
        logger.info("LLM extract fell back to rule engine")
        return _with_meta(_rule_extract(source_type, text, submitter, ceo_name), "rules", False, f"{effective_provider} 调用失败，已回退到规则提取")

    if require_llm:
        raise RuntimeError("未配置可用AI引擎，请在系统设置中配置API Key")
    return _with_meta(_rule_extract(source_type, text, submitter, ceo_name), "rules", False, "")
