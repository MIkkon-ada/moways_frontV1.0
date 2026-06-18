"""
Tests for issue visibility permissions.

Scenarios:
1. project owner can see ALL issue types (问题/风险/待协调/需决策) in their project
2. project coordinator can see 问题/风险/待协调 but NOT 需决策
3. tech_admin (super_admin) can see all issues globally
4. outsider (no project role) sees nothing
5. project_ceo role can see 需决策 in their CEO project
6. regular member (not owner) cannot see 需决策
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
class VisCase:
    project_id: int
    project_name: str
    users: dict[str, str]   # role_key → username
    issue_ids: dict[str, int]  # "问题"/"需决策"/"风险" → issue id


@pytest.fixture
def vis_case(admin_client, passwords_file: Path) -> VisCase:
    suffix = str(time.time_ns())
    project_name = f"TEST_VIS_{suffix}"
    roles = {
        "owner": f"vis_own_{suffix}",
        "coordinator": f"vis_coo_{suffix}",
        "member": f"vis_mem_{suffix}",
        "project_ceo": f"vis_ceo_{suffix}",
        "outsider": f"vis_out_{suffix}",
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
            collaborators=roles["member"],
            sort_order=0,
            is_active=True,
        )
        db.add(proj)
        db.flush()

        # owner, coordinator, member, project_ceo — each gets their role
        for role_key, pm_role in (
            ("owner", "owner"),
            ("coordinator", "coordinator"),
            ("member", "member"),
            ("project_ceo", "project_ceo"),
        ):
            db.add(ProjectMember(
                project_id=proj.id,
                person_id=people[role_key].id,
                person_name_snapshot=people[role_key].name,
                role=pm_role,
            ))
        # outsider gets no project membership

        # Create 3 issues directly in DB (bypass API perms)
        issue_ids: dict[str, int] = {}
        for issue_type in (IF.TYPE_ISSUE, IF.TYPE_RISK, IF.TYPE_DECISION):
            iss = Issue(
                project_id=proj.id,
                issue_type=issue_type,
                description=f"测试{issue_type}事项",
                owner=roles["owner"],
                priority="中",
                status=IF.default_status_for_type(issue_type),
                special_project=project_name,
                source_type="人工录入",
                confirmed_by="testadmin",
            )
            db.add(iss)
            db.flush()
            issue_ids[issue_type] = iss.id

        db.commit()
        return VisCase(
            project_id=proj.id,
            project_name=project_name,
            users=roles,
            issue_ids=issue_ids,
        )


@pytest.fixture
def vis_clients(vis_case: VisCase):
    clients: dict[str, TestClient] = {}
    for role in ("owner", "coordinator", "member", "project_ceo", "outsider"):
        c = TestClient(app)
        resp = c.post("/api/auth/login",
                      json={"username": vis_case.users[role], "password": TEST_PASSWORD})
        assert resp.status_code == 200, f"{role} login failed: {resp.json()}"
        clients[role] = c
    yield clients
    for c in clients.values():
        c.close()


def _list(client: TestClient, project_id: int) -> list[dict]:
    resp = client.get(f"/api/issues?project_id={project_id}")
    assert resp.status_code == 200, resp.json()
    return resp.json()


def _types(items: list[dict]) -> set[str]:
    return {i["issue_type"] for i in items}


# ── Tests ─────────────────────────────────────────────────────


def test_owner_sees_all_issue_types(vis_case: VisCase, vis_clients):
    """Project owner should see 问题, 风险, 需决策 in their project."""
    items = _list(vis_clients["owner"], vis_case.project_id)
    visible_types = _types(items)
    assert IF.TYPE_ISSUE in visible_types, "owner should see 问题"
    assert IF.TYPE_RISK in visible_types, "owner should see 风险"
    assert IF.TYPE_DECISION in visible_types, "owner should see 需决策"


def test_coordinator_cannot_see_decision_issues(vis_case: VisCase, vis_clients):
    """Project coordinator should see 问题/风险 but NOT 需决策."""
    items = _list(vis_clients["coordinator"], vis_case.project_id)
    visible_types = _types(items)
    assert IF.TYPE_DECISION not in visible_types, "coordinator should NOT see 需决策"
    # coordinator should still see non-decision types
    assert IF.TYPE_ISSUE in visible_types or IF.TYPE_RISK in visible_types, \
        "coordinator should see at least 问题 or 风险"


def test_tech_admin_sees_all(vis_case: VisCase, admin_client):
    """Tech admin should see all issue types across all projects."""
    items = _list(admin_client, vis_case.project_id)
    visible_types = _types(items)
    assert IF.TYPE_ISSUE in visible_types
    assert IF.TYPE_RISK in visible_types
    assert IF.TYPE_DECISION in visible_types


def test_outsider_sees_nothing(vis_case: VisCase, vis_clients):
    """User with no project role should see empty list."""
    items = _list(vis_clients["outsider"], vis_case.project_id)
    # outsider is not a member of the project → can_view_project fails → no results
    assert len(items) == 0, f"outsider should see nothing, got {items}"


def test_member_cannot_see_decision_issues(vis_case: VisCase, vis_clients):
    """Regular member (not owner) should NOT see 需决策."""
    items = _list(vis_clients["member"], vis_case.project_id)
    visible_types = _types(items)
    assert IF.TYPE_DECISION not in visible_types, "member should NOT see 需决策"


def test_project_ceo_sees_decision_issues(vis_case: VisCase, vis_clients):
    """project_ceo role should see 需决策 in their CEO project."""
    items = _list(vis_clients["project_ceo"], vis_case.project_id)
    visible_types = _types(items)
    assert IF.TYPE_DECISION in visible_types, "project_ceo should see 需决策"


def test_owner_decision_issue_not_visible_to_coordinator_via_filter(vis_case: VisCase, vis_clients):
    """GET /api/issues?issue_type=需决策 returns empty for coordinator."""
    resp = vis_clients["coordinator"].get(
        f"/api/issues?project_id={vis_case.project_id}&issue_type=需决策"
    )
    assert resp.status_code == 200
    assert len(resp.json()) == 0, "coordinator should get empty list for 需决策 filter"
