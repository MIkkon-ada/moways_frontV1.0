"""
Tests for per-item result_type routing in AI 确认中心.

Scenarios:
1. suggest_new_subtask without parent_task_id → 422
2. suggest_new_subtask is NOT created before confirm (submission alone is safe)
3. suggest_new_subtask with parent_task_id → SubTask created only after confirm
4. subtask_progress → notes updated, status NOT changed
5. subtask_complete → status changed to 已完成
6. task_issue (old flat format) → Issue written to problem DB
7. achievement (old flat format) → Achievement written to achievement DB
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.auth import hash_password
from app.database import SessionLocal
from app.main import app
from app.models import Achievement, Issue, Person, Project, ProjectMember, SubTask
from app.permissions import ROLE_NORMAL


TEST_PASSWORD = "testpass123"


@dataclass
class RtCase:
    project_id: int
    project_name: str
    owner: str
    member: str


@pytest.fixture
def rt_case(admin_client, passwords_file: Path) -> RtCase:
    suffix = str(time.time_ns())
    project_name = f"TEST_RT_{suffix}"
    names = {"owner": f"rt_own_{suffix}", "member": f"rt_mem_{suffix}"}

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
            name=project_name,
            coordinator="",
            owners=names["owner"],
            collaborators=names["member"],
            sort_order=0,
            is_active=True,
        )
        db.add(proj)
        db.flush()

        for key, role in (("owner", "owner"), ("member", "member")):
            db.add(ProjectMember(
                project_id=proj.id,
                person_id=people[key].id,
                person_name_snapshot=people[key].name,
                role=role,
            ))

        db.commit()
        return RtCase(
            project_id=proj.id,
            project_name=project_name,
            owner=names["owner"],
            member=names["member"],
        )


@pytest.fixture
def rt_clients(rt_case: RtCase):
    clients: dict[str, TestClient] = {}
    for role in ("owner", "member"):
        c = TestClient(app)
        resp = c.post("/api/auth/login",
                      json={"username": getattr(rt_case, role), "password": TEST_PASSWORD})
        assert resp.status_code == 200, resp.json()
        clients[role] = c
    yield clients
    for c in clients.values():
        c.close()


def _submit(client: TestClient, case: RtCase, tag: str,
            human_result: dict | None = None) -> dict:
    payload: dict = {
        "project_id": case.project_id,
        "source_type": "text_update",
        "transcript_text": f"{tag} text",
        "submitter": case.member,
    }
    if human_result is not None:
        payload["human_result"] = human_result
    resp = client.post("/api/updates", json=payload)
    assert resp.status_code == 200, resp.json()
    return resp.json()["submission"]


def _create_task(owner: TestClient, case: RtCase, title: str) -> int:
    resp = owner.post("/api/tasks", json={
        "project_id": case.project_id,
        "special_project": case.project_name,
        "key_task": title,
        "key_achievement": "",
        "owner": case.owner,
        "plan_time": "2026-06",
        "status": "进行中",
    })
    assert resp.status_code == 200, resp.json()
    return resp.json()["id"]


def _create_subtask(owner: TestClient, task_id: int,
                    title: str, assignee: str) -> int:
    resp = owner.post(f"/api/tasks/{task_id}/subtasks", json={
        "title": title,
        "assignee": assignee,
        "plan_time": "2026-06",
        "status": "进行中",
    })
    assert resp.status_code == 200, resp.json()
    return resp.json()["id"]


# ── Test 1 ──────────────────────────────────────────────────────────────────

def test_suggest_subtask_missing_parent_task_id_returns_422(rt_case: RtCase, rt_clients):
    owner = rt_clients["owner"]
    member = rt_clients["member"]

    submission = _submit(member, rt_case, "suggest-no-parent", human_result={
        "special_project": rt_case.project_name,
        "task_reports": [
            {
                "result_type": "suggest_new_subtask",
                "type": "suggest_new_subtask",
                "title": "子任务建议：未选父级",
                # parent_task_id deliberately omitted
            }
        ],
    })

    resp = owner.post(f"/api/confirmations/{submission['id']}/confirm",
                      json={"operator": rt_case.owner})
    assert resp.status_code == 422, resp.json()
    assert "parent_task_id" in resp.json().get("detail", "").lower() or \
           "归属" in resp.json().get("detail", "")


# ── Test 2 ──────────────────────────────────────────────────────────────────

def test_suggest_subtask_not_created_before_confirm(rt_case: RtCase, rt_clients):
    owner = rt_clients["owner"]
    member = rt_clients["member"]

    task_id = _create_task(owner, rt_case, "目标关键任务-待建子任务")

    _submit(member, rt_case, "suggest-pre-confirm", human_result={
        "special_project": rt_case.project_name,
        "task_reports": [
            {
                "result_type": "suggest_new_subtask",
                "type": "suggest_new_subtask",
                "title": "尚未入库的建议子任务",
                "parent_task_id": task_id,
            }
        ],
    })

    # Submission alone must NOT create any subtask
    with SessionLocal() as db:
        count = db.query(SubTask).filter(SubTask.task_id == task_id).count()
    assert count == 0, f"子任务不应在 confirm 前创建，实际发现 {count} 条"


# ── Test 3 ──────────────────────────────────────────────────────────────────

def test_suggest_subtask_created_after_confirm(rt_case: RtCase, rt_clients):
    owner = rt_clients["owner"]
    member = rt_clients["member"]

    task_id = _create_task(owner, rt_case, "目标关键任务-确认后建子任务")

    submission = _submit(member, rt_case, "suggest-confirm", human_result={
        "special_project": rt_case.project_name,
        "task_reports": [
            {
                "result_type": "suggest_new_subtask",
                "type": "suggest_new_subtask",
                "title": "新增子任务-经负责人确认",
                "parent_task_id": task_id,
                "assignee": rt_case.member,
            }
        ],
    })

    resp = owner.post(f"/api/confirmations/{submission['id']}/confirm",
                      json={"operator": rt_case.owner})
    assert resp.status_code == 200, resp.json()

    with SessionLocal() as db:
        subtasks = db.query(SubTask).filter(SubTask.task_id == task_id).all()
    assert len(subtasks) == 1
    assert subtasks[0].title == "新增子任务-经负责人确认"
    assert subtasks[0].source_submission_id == submission["id"]


# ── Test 4 ──────────────────────────────────────────────────────────────────

def test_subtask_progress_updates_notes_but_not_status(rt_case: RtCase, rt_clients):
    owner = rt_clients["owner"]
    member = rt_clients["member"]

    task_id = _create_task(owner, rt_case, "进展类关键任务")
    sub_id = _create_subtask(owner, task_id, "进展中子任务", rt_case.member)

    submission = _submit(member, rt_case, "progress-only", human_result={
        "special_project": rt_case.project_name,
        "task_reports": [
            {
                "result_type": "subtask_progress",
                "type": "progress",
                "matched_subtask_id": sub_id,
                "matched_subtask_title": "进展中子任务",
                "completed": "本周完成了接口联调",
            }
        ],
    })

    resp = owner.post(f"/api/confirmations/{submission['id']}/confirm",
                      json={"operator": rt_case.owner})
    assert resp.status_code == 200, resp.json()

    with SessionLocal() as db:
        sub = db.get(SubTask, sub_id)
    assert sub.status == "进行中", f"status 不应被 subtask_progress 更改，实际为 {sub.status!r}"
    assert "本周完成了接口联调" in (sub.notes or ""), "进展备注应已写入 notes"


# ── Test 5 ──────────────────────────────────────────────────────────────────

def test_subtask_complete_sets_status_done(rt_case: RtCase, rt_clients):
    owner = rt_clients["owner"]
    member = rt_clients["member"]

    task_id = _create_task(owner, rt_case, "完成类关键任务")
    sub_id = _create_subtask(owner, task_id, "待完成子任务", rt_case.member)

    submission = _submit(member, rt_case, "complete", human_result={
        "special_project": rt_case.project_name,
        "task_reports": [
            {
                "result_type": "subtask_complete",
                "type": "progress",
                "matched_subtask_id": sub_id,
                "matched_subtask_title": "待完成子任务",
                "completed": "全部完成，已提交交付物",
                "status_update": "已完成",
            }
        ],
    })

    resp = owner.post(f"/api/confirmations/{submission['id']}/confirm",
                      json={"operator": rt_case.owner})
    assert resp.status_code == 200, resp.json()

    with SessionLocal() as db:
        sub = db.get(SubTask, sub_id)
    assert sub.status == "已完成", f"subtask_complete 应将 status 改为已完成，实际为 {sub.status!r}"
    assert "全部完成" in (sub.notes or ""), "完成备注应已写入 notes"


# ── Test 6 ──────────────────────────────────────────────────────────────────

def test_task_issue_written_to_issue_db_old_format(rt_case: RtCase, rt_clients):
    owner = rt_clients["owner"]
    member = rt_clients["member"]

    submission = _submit(member, rt_case, "issue-old", human_result={
        "special_project": rt_case.project_name,
        "issues": [
            {
                "special_project": rt_case.project_name,
                "description": "需要确认上线窗口时间",
                "issue_type": "risk",
                "owner": rt_case.owner,
                "priority": "high",
                "status": "open",
                "write_issue": "true",
            }
        ],
    })

    resp = owner.post(f"/api/confirmations/{submission['id']}/confirm",
                      json={"operator": rt_case.owner})
    assert resp.status_code == 200, resp.json()

    with SessionLocal() as db:
        issues = (
            db.query(Issue)
            .filter(Issue.project_id == rt_case.project_id)
            .filter(Issue.source_submission_id == submission["id"])
            .all()
        )
    assert len(issues) == 1
    assert issues[0].description == "需要确认上线窗口时间"


# ── Test 7 ──────────────────────────────────────────────────────────────────

def test_achievement_written_to_achievement_db_old_format(rt_case: RtCase, rt_clients):
    owner = rt_clients["owner"]
    member = rt_clients["member"]

    submission = _submit(member, rt_case, "ach-old", human_result={
        "special_project": rt_case.project_name,
        "achievements": [
            {
                "special_project": rt_case.project_name,
                "name": "完成 AI 确认中心集成测试文档",
                "achievement_type": "document",
                "owner": rt_case.member,
                "write_achievement": "true",
            }
        ],
    })

    resp = owner.post(f"/api/confirmations/{submission['id']}/confirm",
                      json={"operator": rt_case.owner})
    assert resp.status_code == 200, resp.json()

    with SessionLocal() as db:
        achievements = (
            db.query(Achievement)
            .filter(Achievement.project_id == rt_case.project_id)
            .filter(Achievement.source_submission_id == submission["id"])
            .all()
        )
    assert len(achievements) == 1
    assert achievements[0].name == "完成 AI 确认中心集成测试文档"
