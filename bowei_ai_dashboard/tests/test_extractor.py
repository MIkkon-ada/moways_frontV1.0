"""
更新提取链路回归测试。
运行方式：
  python tests/test_extractor.py
  pytest tests/test_extractor.py -v
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.extractor import (
    extract_update,
    _normalize_task_reports,
    _subtasks_ordered_by_transcript,
    _build_pending_items,
    _normalize_pending_text,
)


def test_text_update_extracts_project_achievement_and_issue():
    text = (
        "本周知识资产AI化专项完成了知识库选型评审，"
        "输出《知识库平台选型方案V1》。"
        "当前风险是脱敏数据提供偏慢，影响接入测试。"
        "下周将完成供应商比选和PoC计划。"
    )
    result = extract_update("text_update", text, "杨宇帆", "rules")

    assert result["special_project"] == "知识资产AI化"
    assert result["llm_used"] is False
    assert result["engine"] == "rules"
    assert result["pipeline"] == "rule_extract"
    assert result["achievements"], "应识别出成果"
    assert result["issues"], "应识别出风险或问题"
    assert any("方案" in item["name"] for item in result["achievements"])
    assert any(item["issue_type"] == "风险" for item in result["issues"])
    assert result["next_steps"], "应识别出下周计划"


def test_meeting_extracts_decision_and_meeting_payload():
    text = (
        "会议纪要：顾问作业AI化专项本周完成检索Prompt第一轮测试。"
        "当前问题是客户样例不足，导致评估不充分。"
        "需要冯海林决策是否追加训练预算。"
        "下周输出顾问检索Prompt优化方案。"
    )
    result = extract_update("meeting", text, "刘万超", "rules")

    assert result["special_project"] == "顾问作业AI化"
    assert result["meeting"]["title"] == "顾问作业AI化会议纪要"
    # decision_items no longer auto-classified; reviewer assigns type in confirm center
    assert result["decision_items"] == [], "decision_items 应为空，由负责人在确认中心定性"
    # issues still carry issue_type for backward compat; normalize_type maps "决策" → "需决策"
    assert any(item["issue_type"] == "需决策" for item in result["issues"])
    assert result["pending_items"], "需处理事项应汇入 pending_items"
    assert result["meeting"]["decision_items"] == result["decision_items"]


def test_empty_input_returns_safe_shape():
    result = extract_update("text_update", "", "杨宇帆", "rules")

    assert result["special_project"] == ""
    assert result["confidence"] == 0.0
    assert result["engine"] == "rules"
    assert result["task"]["owner"] == "杨宇帆"


# ── subtasks_ordered_by_transcript ───────────────────────────────────────────

def test_subtasks_ordered_transcript_puts_mentioned_first():
    subs = [
        {"id": 1, "title": "知识库首页设计", "parent_task_id": 10, "parent_key_task": "UI模块"},
        {"id": 2, "title": "知识库文档检索功能设计", "parent_task_id": 10, "parent_key_task": "UI模块"},
        {"id": 3, "title": "知识库权限校验功能设计", "parent_task_id": 11, "parent_key_task": "权限模块"},
        {"id": 4, "title": "其他不相关子任务", "parent_task_id": 12, "parent_key_task": "其他"},
    ]
    transcript = "今天推进知识库文档检索功能设计，顺带完成了知识库首页设计的初版。"
    ordered = _subtasks_ordered_by_transcript(subs, transcript)
    mentioned_ids = [s["id"] for s in ordered[:2]]
    assert 2 in mentioned_ids, "知识库文档检索功能设计 应排在前面"
    assert 1 in mentioned_ids, "知识库首页设计 应排在前面"
    assert ordered[-1]["id"] in {3, 4}, "未提及的子任务应排在后面"


# ── _normalize_task_reports — 非当前用户 assignee 的子任务识别 ─────────────────

def test_normalize_matches_non_assignee_subtask_via_title():
    """子任务 assignee 是张三，提交人是李四，但原文中提到了子任务标题，必须识别为 progress。"""
    user_subtasks = [
        {
            "id": 5,
            "title": "知识库文档检索功能设计",
            "assignee": "张三",   # 不是提交人
            "status": "进行中",
            "parent_task_id": 2,
            "parent_key_task": "知识库模块开发",
        }
    ]
    raw = [
        {
            "type": "progress",
            "matched_subtask_id": None,   # LLM 未能匹配 ID
            "matched_subtask_title": "知识库文档检索功能设计",
            "completed": "完成了检索入口和结果列表页面结构",
            "status_update": "进行中",
            "achievements": [],
            "subtask_issues": [],
            "next_steps": [],
        }
    ]
    result = _normalize_task_reports(raw, "李四", user_subtasks)
    assert len(result) == 1
    r = result[0]
    assert r["type"] == "progress", f"应为 progress，实际为 {r['type']}"
    assert r["matched_subtask_id"] == 5, f"应匹配 id=5，实际为 {r.get('matched_subtask_id')}"
    assert r["parent_task_id"] == 2
    assert r["parent_key_task"] == "知识库模块开发"


def test_normalize_transcript_text_forces_match_over_suggest():
    """原文中明确出现子任务标题时，不允许输出 suggest_new_subtask。"""
    user_subtasks = [
        {"id": 7, "title": "知识库首页设计", "assignee": "王五", "status": "进行中", "parent_task_id": 3, "parent_key_task": "前端模块"},
    ]
    transcript = "今天完成了知识库首页设计的顶部导航和常用文档区域。"
    raw = [
        {
            "type": "progress",
            "matched_subtask_id": None,
            "matched_subtask_title": "知识库首页设计",
            "completed": "完成了顶部导航和常用文档区域",
            "status_update": "进行中",
            "achievements": [],
            "subtask_issues": [],
            "next_steps": [],
        }
    ]
    result = _normalize_task_reports(raw, "李四", user_subtasks, transcript)
    assert len(result) == 1
    r = result[0]
    assert r["type"] == "progress", f"原文明确提到已有子任务，不应为 suggest_new_subtask，实际为 {r['type']}"
    assert r["matched_subtask_id"] == 7


def test_normalize_acceptance_scenario_three_subtasks():
    """
    验收场景：同一次提交包含三个已有子任务进展，assignee 全部是其他人。
    原文中明确出现三个子任务标题，全部必须识别为 progress。
    """
    user_subtasks = [
        {"id": 11, "title": "知识库文档检索功能设计", "assignee": "张三", "status": "进行中", "parent_task_id": 10, "parent_key_task": "知识库模块"},
        {"id": 12, "title": "知识库首页设计",          "assignee": "张三", "status": "进行中", "parent_task_id": 10, "parent_key_task": "知识库模块"},
        {"id": 13, "title": "知识库权限校验功能设计",   "assignee": "王五", "status": "进行中", "parent_task_id": 11, "parent_key_task": "权限模块"},
    ]
    transcript = (
        "今天继续推进知识库文档检索功能设计，完成了检索入口和结果列表页面结构；"
        "同时推进知识库首页设计，完成了顶部导航和常用文档区域。"
        "此外知识库权限校验功能设计完成了接口权限分层定义。"
    )
    raw = [
        {"type": "progress", "matched_subtask_id": None, "matched_subtask_title": "知识库文档检索功能设计",
         "completed": "完成了检索入口和结果列表页面结构", "status_update": "进行中",
         "achievements": [], "subtask_issues": [], "next_steps": []},
        {"type": "progress", "matched_subtask_id": None, "matched_subtask_title": "知识库首页设计",
         "completed": "完成了顶部导航和常用文档区域", "status_update": "进行中",
         "achievements": [], "subtask_issues": [], "next_steps": []},
        {"type": "progress", "matched_subtask_id": None, "matched_subtask_title": "知识库权限校验功能设计",
         "completed": "完成了接口权限分层定义", "status_update": "进行中",
         "achievements": [], "subtask_issues": [], "next_steps": []},
    ]
    result = _normalize_task_reports(raw, "李四", user_subtasks, transcript)
    assert len(result) == 3, f"应生成 3 张任务卡，实际为 {len(result)}"
    types = [r["type"] for r in result]
    assert all(t == "progress" for t in types), f"全部应为 progress，实际为 {types}"
    matched_ids = {r["matched_subtask_id"] for r in result}
    assert matched_ids == {11, 12, 13}, f"三个 ID 必须全部匹配，实际为 {matched_ids}"
    for r in result:
        assert r["parent_task_id"] is not None, f"{r['matched_subtask_title']} 缺少 parent_task_id"
        assert r["parent_key_task"], f"{r['matched_subtask_title']} 缺少 parent_key_task"


# ── _build_pending_items & dedup ─────────────────────────────────────────────

def test_build_pending_items_deduplicates_same_description():
    issues = [{"description": "脱敏数据提供偏慢", "priority": "高"}]
    key_task_issues = [{"description": "问题：脱敏数据提供偏慢", "priority": "中", "key_task_title": "数据接入"}]
    result = _build_pending_items(issues, key_task_issues, [])
    assert len(result) == 1, f"相同描述（含前缀）应去重，实际为 {len(result)} 条"
    assert result[0]["description"] == "脱敏数据提供偏慢"


def test_build_pending_items_preserves_related_task():
    key_task_issues = [
        {"description": "接口权限分层未确定", "priority": "中", "key_task_title": "权限模块"},
    ]
    result = _build_pending_items([], key_task_issues, [])
    assert len(result) == 1
    assert result[0].get("related_task_title") == "权限模块"


def test_build_pending_items_includes_subtask_issues():
    task_reports = [
        {
            "matched_subtask_title": "知识库首页设计",
            "subtask_issues": [
                {"description": "UI库版本冲突", "priority": "高"},
                "组件缺少暗黑模式",
            ],
        }
    ]
    result = _build_pending_items([], [], task_reports)
    descs = [r["description"] for r in result]
    assert "UI库版本冲突" in descs
    assert "组件缺少暗黑模式" in descs


def test_normalize_pending_text_strips_noise_prefix():
    assert _normalize_pending_text("问题：脱敏数据提供偏慢") == _normalize_pending_text("脱敏数据提供偏慢")
    assert _normalize_pending_text("风险：接口超时") == _normalize_pending_text("接口超时")


def test_rule_extract_result_has_pending_items():
    text = (
        "本周知识资产AI化专项完成了知识库选型评审。"
        "当前风险是脱敏数据提供偏慢，影响接入测试。"
        "下周将完成供应商比选。"
    )
    result = extract_update("text_update", text, "杨宇帆", "rules")
    assert "pending_items" in result, "rule_extract 结果应包含 pending_items 字段"
    assert isinstance(result["pending_items"], list)
    assert len(result["pending_items"]) > 0, "应从 issues 归并出 pending_items"


if __name__ == "__main__":
    test_text_update_extracts_project_achievement_and_issue()
    test_meeting_extracts_decision_and_meeting_payload()
    test_empty_input_returns_safe_shape()
    test_subtasks_ordered_transcript_puts_mentioned_first()
    test_normalize_matches_non_assignee_subtask_via_title()
    test_normalize_transcript_text_forces_match_over_suggest()
    test_normalize_acceptance_scenario_three_subtasks()
    test_build_pending_items_deduplicates_same_description()
    test_build_pending_items_preserves_related_task()
    test_build_pending_items_includes_subtask_issues()
    test_normalize_pending_text_strips_noise_prefix()
    test_rule_extract_result_has_pending_items()
    print("test_extractor.py passed")
