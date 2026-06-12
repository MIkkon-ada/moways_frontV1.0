"""
更新提取链路回归测试。
运行方式：
  python tests/test_extractor.py
  pytest tests/test_extractor.py -v
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.extractor import extract_update


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
    assert result["decision_items"], "会议纪要应识别出待决策项"
    assert any(item["issue_type"] == "决策" for item in result["issues"])
    assert result["meeting"]["decision_items"] == result["decision_items"]


def test_empty_input_returns_safe_shape():
    result = extract_update("text_update", "", "杨宇帆", "rules")

    assert result["special_project"] == ""
    assert result["confidence"] == 0.0
    assert result["engine"] == "rules"
    assert result["task"]["owner"] == "杨宇帆"


if __name__ == "__main__":
    test_text_update_extracts_project_achievement_and_issue()
    test_meeting_extracts_decision_and_meeting_payload()
    test_empty_input_returns_safe_shape()
    print("test_extractor.py passed")
