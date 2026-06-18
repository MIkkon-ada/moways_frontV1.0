"""
Tests for issue_flow normalization and integration.

Scenarios:
1. normalize_type: canonical pass-through
2. normalize_type: legacy alias mapping ("决策" → "需决策", etc.)
3. normalize_type: unknown value → "问题"
4. normalize_status: canonical pass-through
5. normalize_status: legacy alias ("已决策" → "已解决", "关闭" → "已关闭")
6. normalize_status: unknown value → "待处理"
7. default_status_for_type: 需决策 → 待决策, others → 待处理
8. POST /api/issues normalizes type and status on create
9. PATCH /api/issues/{id}/status normalizes status
10. confirmations confirm → key_task_issues written with normalized type/status
11. list_issues: filter by 需决策 returns decision items only
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
from app.domain import issue_flow as IF
from app.main import app
from app.models import Issue, Person, Project, ProjectMember
from app.permissions import ROLE_NORMAL


TEST_PASSWORD = "testpass123"


# ── Unit tests ────────────────────────────────────────────────


class TestNormalizeType:
    def test_canonical_passthrough(self):
        for t in IF.ALL_TYPES:
            assert IF.normalize_type(t) == t

    def test_legacy_decision_aliases(self):
        for alias in ("决策", "需决策", "决策事项", "需CEO决策", "待CEO决策"):
            assert IF.normalize_type(alias) == IF.TYPE_DECISION

    def test_legacy_coordinate_aliases(self):
        for alias in ("协调", "需协调", "待协调"):
            assert IF.normalize_type(alias) == IF.TYPE_COORDINATE

    def test_unknown_falls_back_to_issue(self):
        assert IF.normalize_type("乱七八糟") == IF.TYPE_ISSUE
        assert IF.normalize_type("") == IF.TYPE_ISSUE
        assert IF.normalize_type(None) == IF.TYPE_ISSUE


class TestNormalizeStatus:
    def test_canonical_passthrough(self):
        for s in IF.ALL_STATUSES:
            assert IF.normalize_status(s) == s

    def test_legacy_resolved_aliases(self):
        for alias in ("已决策", "完成", "已完成", "已解决"):
            assert IF.normalize_status(alias) == IF.STATUS_RESOLVED

    def test_legacy_closed_aliases(self):
        for alias in ("关闭", "已关闭"):
            assert IF.normalize_status(alias) == IF.STATUS_CLOSED

    def test_legacy_pending_decision(self):
        for alias in ("待决策", "待CEO决策"):
            assert IF.normalize_status(alias) == IF.STATUS_PENDING_DECISION

    def test_unknown_falls_back_to_pending(self):
        assert IF.normalize_status("随便啥") == IF.STATUS_PENDING
        assert IF.normalize_status(None) == IF.STATUS_PENDING


class TestDefaultStatusForType:
    def test_decision_type_gives_pending_decision(self):
        assert IF.default_status_for_type(IF.TYPE_DECISION) == IF.STATUS_PENDING_DECISION
        assert IF.default_status_for_type("决策") == IF.STATUS_PENDING_DECISION

    def test_other_types_give_pending(self):
        for t in (IF.TYPE_ISSUE, IF.TYPE_RISK, IF.TYPE_COORDINATE):
            assert IF.default_status_for_type(t) == IF.STATUS_PENDING
        assert IF.default_status_for_type(None) == IF.STATUS_PENDING


# ── Integration fixtures ──────────────────────────────────────


@dataclass
class IFCase:
    project_id: int
    project_name: str
    owner: str
    member: str


@pytest.fixture
def if_case(admin_client, passwords_file: Path) -> IFCase:
    suffix = str(time.time_ns())
    project_name = f"TEST_IF_{suffix}"
    names = {"owner": f"if_own_{suffix}", "member": f"if_mem_{suffix}"}

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
        return IFCase(
            project_id=proj.id,
            project_name=project_name,
            owner=names["owner"],
            member=names["member"],
        )


@pytest.fixture
def if_clients(if_case: IFCase):
    clients: dict[str, TestClient] = {}
    for role in ("owner", "member"):
        c = TestClient(app)
        resp = c.post("/api/auth/login",
                      json={"username": getattr(if_case, role), "password": TEST_PASSWORD})
        assert resp.status_code == 200, resp.json()
        clients[role] = c
    yield clients
    for c in clients.values():
        c.close()


# ── Integration tests ─────────────────────────────────────────


def test_create_issue_normalizes_legacy_decision_type(if_case, admin_client):
    """POST /api/issues with issue_type='决策' → stored as '需决策', status='待决策' (requires admin/CEO)."""
    resp = admin_client.post("/api/issues", json={
        "project_id": if_case.project_id,
        "issue_type": "决策",
        "description": "需要拍板的决策事项",
        "priority": "高",
    })
    assert resp.status_code == 200, resp.json()
    data = resp.json()
    assert data["issue_type"] == IF.TYPE_DECISION
    assert data["status"] == IF.STATUS_PENDING_DECISION


def test_create_issue_normalizes_coordinate_alias(if_case, if_clients):
    """POST /api/issues with issue_type='协调' (legacy alias) → stored as '待协调', status='待处理'."""
    owner = if_clients["owner"]
    resp = owner.post("/api/issues", json={
        "project_id": if_case.project_id,
        "issue_type": "协调",
        "description": "需要跨部门协调的事项",
        "priority": "中",
    })
    assert resp.status_code == 200, resp.json()
    data = resp.json()
    assert data["issue_type"] == IF.TYPE_COORDINATE
    assert data["status"] == IF.STATUS_PENDING


def test_create_issue_normalizes_risk_type(if_case, if_clients):
    """POST /api/issues with issue_type='风险' → stored as '风险', status='待处理'."""
    owner = if_clients["owner"]
    resp = owner.post("/api/issues", json={
        "project_id": if_case.project_id,
        "issue_type": "风险",
        "description": "项目存在延期风险",
        "priority": "中",
    })
    assert resp.status_code == 200, resp.json()
    data = resp.json()
    assert data["issue_type"] == IF.TYPE_RISK
    assert data["status"] == IF.STATUS_PENDING


def test_patch_status_normalizes_legacy_resolved(if_case, if_clients):
    """PATCH /api/issues/{id}/status with status='已决策' (legacy) → stored as '已解决'."""
    owner = if_clients["owner"]
    # Create a risk-type issue (owner has permission for non-decision types)
    create = owner.post("/api/issues", json={
        "project_id": if_case.project_id,
        "issue_type": "风险",
        "description": "某风险事项待解决",
        "priority": "中",
    })
    assert create.status_code == 200, create.json()
    issue_id = create.json()["id"]

    # Patch with legacy "已决策" status → should normalize to "已解决"
    resp = owner.patch(f"/api/issues/{issue_id}/status", json={"status": "已决策"})
    assert resp.status_code == 200, resp.json()
    assert resp.json()["status"] == IF.STATUS_RESOLVED


def test_list_issues_filter_by_decision_type(if_case, admin_client):
    """GET /api/issues?issue_type=需决策 returns only decision-type issues (requires admin)."""
    admin_client.post("/api/issues", json={
        "project_id": if_case.project_id,
        "issue_type": "需决策",
        "description": "决策事项A",
        "priority": "高",
    })
    admin_client.post("/api/issues", json={
        "project_id": if_case.project_id,
        "issue_type": "问题",
        "description": "普通问题B",
        "priority": "中",
    })

    resp = admin_client.get(f"/api/issues?project_id={if_case.project_id}&issue_type=需决策")
    assert resp.status_code == 200
    items = resp.json()
    assert len(items) >= 1
    for item in items:
        assert item["issue_type"] == IF.TYPE_DECISION or item.get("need_decision_by")


def _create_task(owner: TestClient, case: IFCase, title: str) -> int:
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


def _create_subtask(owner: TestClient, task_id: int, title: str, assignee: str) -> int:
    resp = owner.post(f"/api/tasks/{task_id}/subtasks", json={
        "title": title,
        "assignee": assignee,
        "plan_time": "2026-06",
        "status": "进行中",
    })
    assert resp.status_code == 200, resp.json()
    return resp.json()["id"]


def _submit_task_reports(client: TestClient, case: IFCase, subtask_id: int,
                         subtask_issues: list) -> int:
    payload = {
        "project_id": case.project_id,
        "source_type": "text_update",
        "transcript_text": "本周进展汇报",
        "submitter": case.member,
        "human_result": {
            "special_project": case.project_name,
            "project_id": case.project_id,
            "task_reports": [{
                "type": "progress",
                "result_type": "subtask_progress",
                "matched_subtask_id": subtask_id,
                "matched_subtask_title": "测试子任务",
                "completed": "完成了一些工作",
                "achievements": [],
                "subtask_issues": subtask_issues,
                "next_steps": [],
                "status_update": "进行中",
            }],
            "key_task_issues": [],
            "write_task_reports_issues": True,
        },
    }
    resp = client.post("/api/updates", json=payload)
    assert resp.status_code == 200, resp.json()
    return resp.json()["submission"]["id"]


def test_confirmations_key_task_issues_normalize_type(if_case, if_clients):
    """Confirm写入key_task_issues时，issue_type='决策'→'需决策', status='待决策'."""
    member = if_clients["member"]
    owner = if_clients["owner"]

    sub_resp = member.post("/api/updates", json={
        "project_id": if_case.project_id,
        "source_type": "text_update",
        "transcript_text": "本周遇到决策问题需要拍板",
        "submitter": if_case.member,
        "human_result": {
            "special_project": if_case.project_name,
            "project_id": if_case.project_id,
            "task_reports": [],
            "key_task_issues": [
                {
                    "key_task_title": "某关键任务",
                    "issue_type": "决策",
                    "description": "需要拍板的事项",
                    "need_coordination": [],
                    "priority": "高",
                }
            ],
        },
    })
    assert sub_resp.status_code == 200, sub_resp.json()
    sub_id = sub_resp.json()["submission"]["id"]

    confirm_resp = owner.post(f"/api/confirmations/{sub_id}/confirm", json={
        "operator": if_case.owner,
        "human_result": {
            "write_task_reports_issues": True,
            "special_project": if_case.project_name,
            "project_id": if_case.project_id,
            "task_reports": [],
            "key_task_issues": [
                {
                    "key_task_title": "某关键任务",
                    "issue_type": "决策",
                    "description": "需要拍板的事项",
                    "need_coordination": [],
                    "priority": "高",
                }
            ],
        },
    })
    assert confirm_resp.status_code == 200, confirm_resp.json()

    with SessionLocal() as db:
        issue = db.query(Issue).filter(
            Issue.source_submission_id == sub_id,
            Issue.description == "需要拍板的事项",
        ).first()
        assert issue is not None, "Issue should have been written"
        assert issue.issue_type == IF.TYPE_DECISION
        assert issue.status == IF.STATUS_PENDING_DECISION


# ── subtask_issues prefix tests ───────────────────────────────


def _confirm_and_get_issues(owner: TestClient, case: IFCase, sub_id: int) -> list:
    """Confirm a submission and return all issues written from it."""
    resp = owner.post(f"/api/confirmations/{sub_id}/confirm", json={
        "operator": case.owner,
        "human_result": {
            "special_project": case.project_name,
            "project_id": case.project_id,
            "write_task_reports_issues": True,
            # Deliberately not overriding task_reports — use what was submitted
        },
    })
    assert resp.status_code == 200, resp.json()
    with SessionLocal() as db:
        return db.query(Issue).filter(Issue.source_submission_id == sub_id).all()


def test_subtask_issues_risk_prefix_saves_as_risk(if_case, if_clients):
    """subtask_issues=['风险：xxx'] → issue_type=风险, status=待处理."""
    owner = if_clients["owner"]
    member = if_clients["member"]
    task_id = _create_task(owner, if_case, "风险测试关键任务")
    subtask_id = _create_subtask(owner, task_id, "风险测试子任务", if_case.member)

    sub_id = _submit_task_reports(member, if_case, subtask_id,
                                  ["风险：文档类型和关键词字段统一规则未确认"])
    issues = _confirm_and_get_issues(owner, if_case, sub_id)

    risk_issues = [i for i in issues if i.description == "文档类型和关键词字段统一规则未确认"]
    assert len(risk_issues) == 1, f"Expected 1 risk issue, got {[i.issue_type+':'+i.description for i in issues]}"
    assert risk_issues[0].issue_type == IF.TYPE_RISK
    assert risk_issues[0].status == IF.STATUS_PENDING


def test_subtask_issues_decision_prefix_saves_as_decision(if_case, if_clients):
    """subtask_issues=['决策：xxx'] → issue_type=需决策, status=待决策."""
    owner = if_clients["owner"]
    member = if_clients["member"]
    task_id = _create_task(owner, if_case, "决策测试关键任务")
    subtask_id = _create_subtask(owner, task_id, "决策测试子任务", if_case.member)

    sub_id = _submit_task_reports(member, if_case, subtask_id,
                                  ["决策：检索首页第一版先做关键词搜索还是标签筛选"])
    issues = _confirm_and_get_issues(owner, if_case, sub_id)

    dec_issues = [i for i in issues if i.description == "检索首页第一版先做关键词搜索还是标签筛选"]
    assert len(dec_issues) == 1, f"Expected 1 decision issue, got {[i.issue_type+':'+i.description for i in issues]}"
    assert dec_issues[0].issue_type == IF.TYPE_DECISION
    assert dec_issues[0].status == IF.STATUS_PENDING_DECISION


def test_subtask_issues_coordinate_prefix_saves_as_coordinate(if_case, if_clients):
    """subtask_issues=['待协调：xxx'] → issue_type=待协调, status=待处理."""
    owner = if_clients["owner"]
    member = if_clients["member"]
    task_id = _create_task(owner, if_case, "协调测试关键任务")
    subtask_id = _create_subtask(owner, task_id, "协调测试子任务", if_case.member)

    sub_id = _submit_task_reports(member, if_case, subtask_id,
                                  ["待协调：需要和数据组确认字段格式"])
    issues = _confirm_and_get_issues(owner, if_case, sub_id)

    coord_issues = [i for i in issues if i.description == "需要和数据组确认字段格式"]
    assert len(coord_issues) == 1
    assert coord_issues[0].issue_type == IF.TYPE_COORDINATE
    assert coord_issues[0].status == IF.STATUS_PENDING


def test_subtask_issues_plain_string_saves_as_issue(if_case, if_clients):
    """subtask_issues=['plain string'] → issue_type=问题, status=待处理."""
    owner = if_clients["owner"]
    member = if_clients["member"]
    task_id = _create_task(owner, if_case, "普通问题测试关键任务")
    subtask_id = _create_subtask(owner, task_id, "普通问题测试子任务", if_case.member)

    sub_id = _submit_task_reports(member, if_case, subtask_id,
                                  ["接口联调存在卡点，需要排查"])
    issues = _confirm_and_get_issues(owner, if_case, sub_id)

    plain_issues = [i for i in issues if i.description == "接口联调存在卡点，需要排查"]
    assert len(plain_issues) == 1
    assert plain_issues[0].issue_type == IF.TYPE_ISSUE
    assert plain_issues[0].status == IF.STATUS_PENDING
