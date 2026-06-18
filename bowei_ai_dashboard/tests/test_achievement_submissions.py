"""
Tests for POST/GET/PATCH /api/achievement-submissions.

Scenarios:
1.  Member submits achievement → AchievementSubmission created, no Achievement yet
2.  Owner confirms → Achievement created, submission.status = 已确认
3.  Owner rejects → submission.status = 已退回, reject_reason saved
4.  Submitter withdraws → submission.status = 已撤回
5.  Non-owner cannot confirm (403)
6.  Non-owner cannot reject (403)
7.  Normal member sees only their own submissions
8.  Owner sees all submissions for their project
9.  Cannot confirm a non-pending submission (422)
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
from app.models import Achievement
from app.permissions import ROLE_NORMAL

TEST_PASSWORD = "testpass123"


@dataclass
class SubCase:
    project_id: int
    project_name: str
    task_id: int
    users: dict[str, str]
    clients: dict[str, TestClient] = field(default_factory=dict)


@pytest.fixture
def sub_case(admin_client, passwords_file: Path) -> SubCase:
    suffix = str(time.time_ns())
    project_name = f"SUB_TEST_{suffix}"
    roles = {
        "owner":  f"sub_own_{suffix}",
        "member": f"sub_mem_{suffix}",
        "other":  f"sub_oth_{suffix}",
    }

    raw = json.loads(passwords_file.read_text(encoding="utf-8"))
    raw.update({name: hash_password(TEST_PASSWORD) for name in roles.values()})
    passwords_file.write_text(json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")

    with SessionLocal() as db:
        from app.models import Person, Project, ProjectMember

        people: dict[str, Person] = {}
        for key, name in roles.items():
            p = Person(name=name, system_role=ROLE_NORMAL, permission="view", is_active=True, is_admin=False)
            db.add(p)
            db.flush()
            people[key] = p

        proj = Project(name=project_name, coordinator="", owners=roles["owner"],
                       collaborators="", sort_order=0, is_active=True)
        db.add(proj)
        db.flush()

        for key, pm_role in (("owner", "owner"), ("member", "member")):
            db.add(ProjectMember(
                project_id=proj.id,
                person_id=people[key].id,
                person_name_snapshot=people[key].name,
                role=pm_role,
            ))

        project_id = proj.id
        db.commit()

    # Create a task in the project (via API as admin)
    task_resp = admin_client.post("/api/tasks", json={
        "project_id": project_id,
        "special_project": project_name,
        "key_task": "子任务_成果提交测试",
        "status": "进行中",
    })
    assert task_resp.status_code == 200, task_resp.json()
    task_id = task_resp.json()["id"]

    clients: dict[str, TestClient] = {}
    for role in roles:
        c = TestClient(app)
        resp = c.post("/api/auth/login", json={"username": roles[role], "password": TEST_PASSWORD})
        assert resp.status_code == 200, f"{role} login failed: {resp.json()}"
        clients[role] = c

    case = SubCase(project_id=project_id, project_name=project_name,
                   task_id=task_id, users=roles, clients=clients)
    yield case
    for c in clients.values():
        c.close()


def _submit(case: SubCase, role: str = "member", name: str = "测试成果") -> dict:
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


# ── Tests ─────────────────────────────────────────────────────────


def test_member_submit_creates_submission_not_achievement(sub_case: SubCase):
    """Submitting creates AchievementSubmission with status=待确认, no Achievement yet."""
    sub = _submit(sub_case)
    assert sub["status"] == "待确认"
    assert sub["project_id"] == sub_case.project_id

    with SessionLocal() as db:
        # No Achievement should exist for this submission yet
        ach = db.query(Achievement).filter_by(source_submission_id=sub["id"]).first()
        assert ach is None, "Achievement must not be created before confirmation"


def test_owner_confirm_creates_achievement(sub_case: SubCase):
    """Owner confirming creates Achievement and marks submission 已确认.

    source_submission_id must be NULL (reserved for UpdateSubmission).
    source_achievement_submission_id must equal AchievementSubmission.id.
    """
    sub = _submit(sub_case)
    sub_id = sub["id"]

    resp = sub_case.clients["owner"].patch(f"/api/achievement-submissions/{sub_id}/confirm")
    assert resp.status_code == 200, resp.json()
    body = resp.json()
    assert body["submission"]["status"] == "已确认"
    ach = body["achievement"]
    assert ach["name"] == sub["name"]
    assert ach["confirmed_by"] == sub_case.users["owner"]
    # source_submission_id is reserved for UpdateSubmission — must be null here
    assert ach["source_submission_id"] is None, (
        f"source_submission_id should be null for human-submitted achievements, got {ach['source_submission_id']}"
    )
    # source_achievement_submission_id must point back to the AchievementSubmission
    assert ach["source_achievement_submission_id"] == sub_id, (
        f"expected source_achievement_submission_id={sub_id}, got {ach['source_achievement_submission_id']}"
    )


def test_owner_reject_saves_reason(sub_case: SubCase):
    """Owner rejecting sets status=已退回 and stores reject_reason."""
    sub = _submit(sub_case)
    sub_id = sub["id"]

    reason = "成果描述不完整，请补充"
    resp = sub_case.clients["owner"].patch(
        f"/api/achievement-submissions/{sub_id}/reject",
        json={"reject_reason": reason},
    )
    assert resp.status_code == 200, resp.json()
    body = resp.json()
    assert body["status"] == "已退回"
    assert body["reject_reason"] == reason


def test_submitter_withdraw(sub_case: SubCase):
    """Submitter can withdraw a pending submission."""
    sub = _submit(sub_case)
    sub_id = sub["id"]

    resp = sub_case.clients["member"].patch(f"/api/achievement-submissions/{sub_id}/withdraw")
    assert resp.status_code == 200, resp.json()
    assert resp.json()["status"] == "已撤回"


def test_non_owner_cannot_confirm(sub_case: SubCase):
    """A plain member cannot confirm (403)."""
    sub = _submit(sub_case)
    resp = sub_case.clients["member"].patch(f"/api/achievement-submissions/{sub['id']}/confirm")
    assert resp.status_code == 403, resp.json()


def test_non_owner_cannot_reject(sub_case: SubCase):
    """A plain member cannot reject (403)."""
    sub = _submit(sub_case)
    resp = sub_case.clients["member"].patch(
        f"/api/achievement-submissions/{sub['id']}/reject",
        json={"reject_reason": "test"},
    )
    assert resp.status_code == 403, resp.json()


def test_member_sees_only_own_submissions(sub_case: SubCase):
    """Normal member can only see their own submissions."""
    # Owner submits one; member submits one
    _submit(sub_case, role="owner", name="owner成果")
    _submit(sub_case, role="member", name="member成果")

    resp = sub_case.clients["member"].get(
        f"/api/achievement-submissions?project_id={sub_case.project_id}"
    )
    assert resp.status_code == 200
    names = {s["name"] for s in resp.json()}
    assert "member成果" in names
    # "other" user submitted nothing, "owner" submitted as different submitter name
    assert "owner成果" not in names


def test_owner_sees_all_project_submissions(sub_case: SubCase):
    """Project owner sees all submissions for their project."""
    _submit(sub_case, role="owner", name="owner提交成果")
    _submit(sub_case, role="member", name="member提交成果")

    resp = sub_case.clients["owner"].get(
        f"/api/achievement-submissions?project_id={sub_case.project_id}"
    )
    assert resp.status_code == 200
    names = {s["name"] for s in resp.json()}
    assert "owner提交成果" in names
    assert "member提交成果" in names


def test_cannot_confirm_non_pending(sub_case: SubCase):
    """Confirming an already-confirmed submission returns 422."""
    sub = _submit(sub_case)
    sub_id = sub["id"]

    # First confirm succeeds
    resp1 = sub_case.clients["owner"].patch(f"/api/achievement-submissions/{sub_id}/confirm")
    assert resp1.status_code == 200

    # Second confirm fails
    resp2 = sub_case.clients["owner"].patch(f"/api/achievement-submissions/{sub_id}/confirm")
    assert resp2.status_code == 422, resp2.json()


def test_outsider_cannot_submit(sub_case: SubCase):
    """User not in the project cannot submit (403)."""
    resp = sub_case.clients["other"].post("/api/achievement-submissions", json={
        "project_id": sub_case.project_id,
        "related_task_id": sub_case.task_id,
        "name": "外部成果",
        "achievement_type": "方案",
        "version": "V0.1",
        "file_link": "",
        "scenario": "",
        "reuse_tag": "",
    })
    assert resp.status_code == 403, resp.json()
