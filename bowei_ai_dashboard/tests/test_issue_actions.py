"""
Tests for Issue action endpoints:
  PATCH /api/issues/{id}/resolve
  PATCH /api/issues/{id}/close
  PATCH /api/issues/{id}/assign-helper
  PATCH /api/issues/{id}/request-ceo

Permission rule: only tech_admin or project owner may call these endpoints.
coordinator and project_ceo (unless also owner) must be blocked.

Scenarios (9):
1.  owner can resolve a non-decision issue
2.  owner can close a non-decision issue
3.  owner can assign-helper
4.  owner can request-ceo (issue_type → 需决策, status → 待决策)
5.  coordinator cannot resolve → 403
6.  coordinator cannot close → 403
7.  project_ceo cannot resolve (pure project_ceo, not owner) → 403
8.  tech_admin can resolve any issue
9.  coordinator can VIEW issue (GET 200) but cannot assign-helper (PATCH 403)
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
from app.domain import issue_flow as IF
from app.main import app
from app.models import Issue, Person, Project, ProjectMember
from app.permissions import ROLE_NORMAL

TEST_PASSWORD = "testpass123"


@dataclass
class ActionsCase:
    project_id: int
    project_name: str
    users: dict[str, str]   # role_key → username
    clients: dict[str, TestClient] = field(default_factory=dict)


def _make_issue(db, project_id: int, project_name: str, issue_type: str = IF.TYPE_RISK) -> int:
    iss = Issue(
        project_id=project_id,
        issue_type=issue_type,
        description=f"测试{issue_type}事项_{time.time_ns()}",
        owner="",
        priority="中",
        status=IF.default_status_for_type(issue_type),
        special_project=project_name,
        source_type="人工录入",
        confirmed_by="testadmin",
    )
    db.add(iss)
    db.flush()
    issue_id = iss.id
    db.commit()
    return issue_id


@pytest.fixture
def actions_case(admin_client, passwords_file: Path) -> ActionsCase:
    suffix = str(time.time_ns())
    project_name = f"TEST_ACT_{suffix}"
    roles = {
        "owner":       f"act_own_{suffix}",
        "coordinator": f"act_coo_{suffix}",
        "project_ceo": f"act_ceo_{suffix}",
    }

    raw = json.loads(passwords_file.read_text(encoding="utf-8"))
    raw.update({name: hash_password(TEST_PASSWORD) for name in roles.values()})
    passwords_file.write_text(json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")

    with SessionLocal() as db:
        people: dict[str, Person] = {}
        for key, name in roles.items():
            p = Person(name=name, system_role=ROLE_NORMAL, permission="view",
                       is_active=True, is_admin=False)
            db.add(p)
            db.flush()
            people[key] = p

        proj = Project(
            name=project_name,
            coordinator="",
            owners=roles["owner"],
            collaborators="",
            sort_order=0,
            is_active=True,
        )
        db.add(proj)
        db.flush()

        for role_key, pm_role in (
            ("owner",       "owner"),
            ("coordinator", "coordinator"),
            ("project_ceo", "project_ceo"),
        ):
            db.add(ProjectMember(
                project_id=proj.id,
                person_id=people[role_key].id,
                person_name_snapshot=people[role_key].name,
                role=pm_role,
            ))

        project_id = proj.id
        db.commit()

    clients: dict[str, TestClient] = {}
    for role in roles:
        c = TestClient(app)
        resp = c.post("/api/auth/login",
                      json={"username": roles[role], "password": TEST_PASSWORD})
        assert resp.status_code == 200, f"{role} login failed: {resp.json()}"
        clients[role] = c

    case = ActionsCase(
        project_id=project_id,
        project_name=project_name,
        users=roles,
        clients=clients,
    )
    yield case
    for c in clients.values():
        c.close()


# ── Helpers ───────────────────────────────────────────────────


def _fresh_issue(case: ActionsCase, issue_type: str = IF.TYPE_RISK) -> int:
    with SessionLocal() as db:
        return _make_issue(db, case.project_id, case.project_name, issue_type)


# ── Tests ─────────────────────────────────────────────────────


def test_owner_can_resolve(actions_case: ActionsCase):
    issue_id = _fresh_issue(actions_case)
    resp = actions_case.clients["owner"].patch(
        f"/api/issues/{issue_id}/resolve", json={"resolution": "已处理完毕"}
    )
    assert resp.status_code == 200, resp.json()
    body = resp.json()
    assert body["status"] == IF.STATUS_RESOLVED
    assert body["resolution"] == "已处理完毕"


def test_owner_can_close(actions_case: ActionsCase):
    issue_id = _fresh_issue(actions_case)
    resp = actions_case.clients["owner"].patch(
        f"/api/issues/{issue_id}/close", json={"reason": "已关闭"}
    )
    assert resp.status_code == 200, resp.json()
    assert resp.json()["status"] == IF.STATUS_CLOSED


def test_owner_can_assign_helper(actions_case: ActionsCase):
    issue_id = _fresh_issue(actions_case)
    resp = actions_case.clients["owner"].patch(
        f"/api/issues/{issue_id}/assign-helper", json={"helper": "张三"}
    )
    assert resp.status_code == 200, resp.json()
    assert resp.json()["helper"] == "张三"


def test_owner_can_request_ceo(actions_case: ActionsCase):
    issue_id = _fresh_issue(actions_case, IF.TYPE_RISK)
    resp = actions_case.clients["owner"].patch(
        f"/api/issues/{issue_id}/request-ceo",
        json={"need_decision_by": "CEO", "note": "需要CEO拍板"},
    )
    assert resp.status_code == 200, resp.json()
    body = resp.json()
    assert body["issue_type"] == IF.TYPE_DECISION
    assert body["status"] == IF.STATUS_PENDING_DECISION
    assert body["need_decision_by"] == "CEO"
    assert "需要CEO拍板" in (body["resolution"] or "")


def test_coordinator_cannot_resolve(actions_case: ActionsCase):
    issue_id = _fresh_issue(actions_case)
    resp = actions_case.clients["coordinator"].patch(
        f"/api/issues/{issue_id}/resolve", json={}
    )
    assert resp.status_code == 403, resp.json()


def test_coordinator_cannot_close(actions_case: ActionsCase):
    issue_id = _fresh_issue(actions_case)
    resp = actions_case.clients["coordinator"].patch(
        f"/api/issues/{issue_id}/close", json={}
    )
    assert resp.status_code == 403, resp.json()


def test_project_ceo_cannot_resolve(actions_case: ActionsCase):
    """Pure project_ceo (not owner, not tech_admin) must be blocked."""
    # Use a decision issue — project_ceo can definitely view it.
    issue_id = _fresh_issue(actions_case, IF.TYPE_DECISION)
    resp = actions_case.clients["project_ceo"].patch(
        f"/api/issues/{issue_id}/resolve", json={}
    )
    assert resp.status_code == 403, resp.json()


def test_tech_admin_can_resolve_any(actions_case: ActionsCase, admin_client):
    issue_id = _fresh_issue(actions_case)
    resp = admin_client.patch(
        f"/api/issues/{issue_id}/resolve", json={"resolution": "管理员处理"}
    )
    assert resp.status_code == 200, resp.json()
    assert resp.json()["status"] == IF.STATUS_RESOLVED


def test_coordinator_can_view_but_not_assign_helper(actions_case: ActionsCase):
    """Coordinator can GET the issue (view) but cannot PATCH assign-helper."""
    issue_id = _fresh_issue(actions_case, IF.TYPE_COORDINATE)
    # view
    get_resp = actions_case.clients["coordinator"].get(f"/api/issues/{issue_id}")
    assert get_resp.status_code == 200, f"coordinator should be able to view: {get_resp.json()}"
    # action blocked
    patch_resp = actions_case.clients["coordinator"].patch(
        f"/api/issues/{issue_id}/assign-helper", json={"helper": "李四"}
    )
    assert patch_resp.status_code == 403, patch_resp.json()
