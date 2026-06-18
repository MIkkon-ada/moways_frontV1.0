"""
回归测试 - 成果库提交确认流程

手工回归编号覆盖：
  ACH-1: 普通成员登记成果 → 创建 AchievementSubmission，不创建正式 Achievement
  ACH-2: 项目负责人确认 → 创建正式 Achievement
  ACH-3: 人工登记来源写入 source_achievement_submission_id
  ACH-4: source_submission_id 保持为空（不污染 AI 确认路径）
  ACH-5: AI 确认路径（UpdateSubmission → confirm）创建 Achievement 使用 source_submission_id
  ACH-6: AI 确认路径 source_achievement_submission_id 保持为空
  ACH-7: 退回成果保存 reject_reason
  ACH-8: 提交人可撤回待确认成果
  ACH-9: 非负责人不能确认（403）
  ACH-10: 非负责人不能退回（403）
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.auth import hash_password
from app.database import SessionLocal
from app.main import app
from app.models import Achievement, Person, Project, ProjectMember
from app.permissions import ROLE_NORMAL

TEST_PASSWORD = "testpass123"


@dataclass
class AchCase:
    project_id: int
    project_name: str
    task_id: int
    owner: str
    member: str
    other: str
    clients: dict[str, TestClient] = field(default_factory=dict)


@pytest.fixture
def ach_case(admin_client, passwords_file: Path) -> AchCase:
    suffix = str(time.time_ns())
    project_name = f"TEST_ACH_{suffix}"
    names = {
        "owner":  f"ach_own_{suffix}",
        "member": f"ach_mem_{suffix}",
        "other":  f"ach_oth_{suffix}",
    }

    raw = json.loads(passwords_file.read_text(encoding="utf-8"))
    raw.update({n: hash_password(TEST_PASSWORD) for n in names.values()})
    passwords_file.write_text(json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")

    with SessionLocal() as db:
        people: dict[str, Person] = {}
        for key, name in names.items():
            p = Person(name=name, system_role=ROLE_NORMAL, permission="view",
                       is_active=True, is_admin=False)
            db.add(p)
            db.flush()
            people[key] = p

        proj = Project(
            name=project_name, coordinator="", owners=names["owner"],
            collaborators=names["member"], sort_order=0, is_active=True,
        )
        db.add(proj)
        db.flush()

        for key, role in (("owner", "owner"), ("member", "member")):
            db.add(ProjectMember(
                project_id=proj.id, person_id=people[key].id,
                person_name_snapshot=people[key].name, role=role,
            ))
        db.commit()
        project_id = proj.id

    # 创建关键任务（admin 操作，避免权限问题）
    task_resp = admin_client.post("/api/tasks", json={
        "project_id": project_id,
        "special_project": project_name,
        "key_task": "成果关联任务",
        "status": "进行中",
    })
    assert task_resp.status_code == 200, task_resp.json()
    task_id = task_resp.json()["id"]

    # 创建并登录各角色客户端
    clients: dict[str, TestClient] = {}
    for role in names:
        c = TestClient(app)
        resp = c.post("/api/auth/login",
                      json={"username": names[role], "password": TEST_PASSWORD})
        assert resp.status_code == 200, f"{role} login failed: {resp.json()}"
        clients[role] = c

    case = AchCase(
        project_id=project_id, project_name=project_name, task_id=task_id,
        owner=names["owner"], member=names["member"], other=names["other"],
        clients=clients,
    )
    yield case
    for c in clients.values():
        c.close()


def _submit(case: AchCase, role: str = "member", name: str = "测试成果") -> dict:
    resp = case.clients[role].post("/api/achievement-submissions", json={
        "project_id": case.project_id,
        "related_task_id": case.task_id,
        "name": name,
        "achievement_type": "方案",
        "version": "V0.1",
        "file_link": "https://example.com/doc",
        "scenario": "",
        "reuse_tag": "",
    })
    assert resp.status_code == 200, resp.json()
    return resp.json()


# ── ACH-1 ──────────────────────────────────────────────────────────────────────


def test_member_submit_creates_submission_only(ach_case: AchCase):
    """ACH-1: 普通成员提交成果 → AchievementSubmission 创建，没有正式 Achievement。"""
    sub = _submit(ach_case)
    assert sub["status"] == "待确认"
    assert sub["project_id"] == ach_case.project_id

    with SessionLocal() as db:
        ach_count = (
            db.query(Achievement)
            .filter(Achievement.source_achievement_submission_id == sub["id"])
            .count()
        )
        assert ach_count == 0, "提交后不应立即创建正式 Achievement"


# ── ACH-2 / ACH-3 / ACH-4 ──────────────────────────────────────────────────────


def test_owner_confirm_creates_achievement_with_correct_sources(ach_case: AchCase):
    """
    ACH-2: 负责人确认 → 创建正式 Achievement。
    ACH-3: source_achievement_submission_id = AchievementSubmission.id。
    ACH-4: source_submission_id 保持为 None（不污染 AI 路径字段）。
    """
    sub = _submit(ach_case, name="ACH2成果")
    sub_id = sub["id"]

    resp = ach_case.clients["owner"].patch(f"/api/achievement-submissions/{sub_id}/confirm")
    assert resp.status_code == 200, resp.json()

    body = resp.json()
    assert body["submission"]["status"] == "已确认"
    ach = body["achievement"]

    assert ach["name"] == "ACH2成果"
    assert ach["confirmed_by"] == ach_case.owner

    assert ach["source_achievement_submission_id"] == sub_id, (
        f"ACH-3: source_achievement_submission_id 应为 {sub_id}，"
        f"实际: {ach.get('source_achievement_submission_id')}"
    )
    assert ach["source_submission_id"] is None, (
        f"ACH-4: source_submission_id 应为 None，实际: {ach.get('source_submission_id')}"
    )


# ── ACH-5 / ACH-6 ──────────────────────────────────────────────────────────────


def test_ai_confirm_path_uses_source_submission_id(ach_case: AchCase):
    """
    ACH-5: AI确认路径（UpdateSubmission → confirmations confirm）创建 Achievement
           使用 source_submission_id。
    ACH-6: 此时 source_achievement_submission_id 保持为空。
    """
    member = ach_case.clients["member"]
    owner = ach_case.clients["owner"]

    update_resp = member.post("/api/updates", json={
        "project_id": ach_case.project_id,
        "source_type": "text_update",
        "transcript_text": "本周完成方案文档",
        "submitter": ach_case.member,
        "human_result": {
            "special_project": ach_case.project_name,
            "achievements": [
                {
                    "name": "AI路径成果",
                    "achievement_type": "方案",
                    "owner": ach_case.member,
                    "write_achievement": "true",
                }
            ],
            "issues": [],
        },
    })
    assert update_resp.status_code == 200, update_resp.json()
    submission_id = update_resp.json()["submission"]["id"]

    confirm_resp = owner.post(
        f"/api/confirmations/{submission_id}/confirm",
        json={
            "operator": ach_case.owner,
            "human_result": {
                "special_project": ach_case.project_name,
                "achievements": [
                    {
                        "name": "AI路径成果",
                        "achievement_type": "方案",
                        "owner": ach_case.member,
                        "write_achievement": "true",
                    }
                ],
                "issues": [],
            },
        },
    )
    assert confirm_resp.status_code == 200, confirm_resp.json()

    with SessionLocal() as db:
        ach = (
            db.query(Achievement)
            .filter(Achievement.source_submission_id == submission_id)
            .first()
        )
        assert ach is not None, "ACH-5: AI 确认路径应创建 Achievement"
        assert ach.source_submission_id == submission_id, "ACH-5: source_submission_id 应指向 UpdateSubmission"
        assert ach.source_achievement_submission_id is None, (
            f"ACH-6: AI 路径 source_achievement_submission_id 应为 None，"
            f"实际: {ach.source_achievement_submission_id}"
        )


# ── ACH-7 ──────────────────────────────────────────────────────────────────────


def test_reject_saves_reason(ach_case: AchCase):
    """ACH-7: 退回成果保存 reject_reason，状态变为已退回。"""
    sub = _submit(ach_case, name="ACH7成果")
    reason = "描述不完整，请补充使用场景"

    resp = ach_case.clients["owner"].patch(
        f"/api/achievement-submissions/{sub['id']}/reject",
        json={"reject_reason": reason},
    )
    assert resp.status_code == 200, resp.json()
    body = resp.json()
    assert body["status"] == "已退回"
    assert body["reject_reason"] == reason


# ── ACH-8 ──────────────────────────────────────────────────────────────────────


def test_submitter_can_withdraw(ach_case: AchCase):
    """ACH-8: 提交人可撤回待确认成果，状态变为已撤回。"""
    sub = _submit(ach_case, name="ACH8成果")
    resp = ach_case.clients["member"].patch(
        f"/api/achievement-submissions/{sub['id']}/withdraw"
    )
    assert resp.status_code == 200, resp.json()
    assert resp.json()["status"] == "已撤回"


# ── ACH-9 ──────────────────────────────────────────────────────────────────────


def test_non_owner_cannot_confirm(ach_case: AchCase):
    """ACH-9: 普通成员不能确认（403）。"""
    sub = _submit(ach_case, name="ACH9成果")
    resp = ach_case.clients["member"].patch(
        f"/api/achievement-submissions/{sub['id']}/confirm"
    )
    assert resp.status_code == 403, resp.json()


# ── ACH-10 ─────────────────────────────────────────────────────────────────────


def test_non_owner_cannot_reject(ach_case: AchCase):
    """ACH-10: 普通成员不能退回（403）。"""
    sub = _submit(ach_case, name="ACH10成果")
    resp = ach_case.clients["member"].patch(
        f"/api/achievement-submissions/{sub['id']}/reject",
        json={"reject_reason": "测试"},
    )
    assert resp.status_code == 403, resp.json()
