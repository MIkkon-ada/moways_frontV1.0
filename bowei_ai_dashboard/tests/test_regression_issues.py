"""
回归测试 - 问题与决策处理流程

手工回归编号覆盖：
  ISS-1: AI确认后风险写入 Issue，issue_type=风险，status=待处理
  ISS-2: AI确认后需决策写入 Issue，issue_type=需决策，status=待决策
  ISS-3: 项目负责人能看到需决策事项（GET /api/issues?issue_type=需决策）
  ISS-4: 项目负责人可以通过 resolve 确认/处置决策
  ISS-5: 风险可以填写处理结论并标记已解决
  ISS-6: 待协调事项可以指定协助人；负责人可将状态设为处理中
  ISS-7: 普通成员不能执行处理动作（resolve/close/assign-helper 403）
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
class IssCase:
    project_id: int
    project_name: str
    owner: str
    member: str
    clients: dict[str, TestClient] = field(default_factory=dict)


@pytest.fixture
def iss_case(admin_client, passwords_file: Path) -> IssCase:
    suffix = str(time.time_ns())
    project_name = f"TEST_ISS_{suffix}"
    names = {
        "owner":  f"iss_own_{suffix}",
        "member": f"iss_mem_{suffix}",
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

    clients: dict[str, TestClient] = {}
    for role in names:
        c = TestClient(app)
        resp = c.post("/api/auth/login",
                      json={"username": names[role], "password": TEST_PASSWORD})
        assert resp.status_code == 200, f"{role} login: {resp.json()}"
        clients[role] = c

    case = IssCase(
        project_id=project_id, project_name=project_name,
        owner=names["owner"], member=names["member"], clients=clients,
    )
    yield case
    for c in clients.values():
        c.close()


def _submit_and_confirm_issues(case: IssCase, key_task_issues: list[dict]) -> list[Issue]:
    """成员提交含 key_task_issues 的更新，负责人确认，返回写入的 Issue 列表。"""
    member = case.clients["member"]
    owner = case.clients["owner"]

    sub_resp = member.post("/api/updates", json={
        "project_id": case.project_id,
        "source_type": "text_update",
        "transcript_text": "问题上报测试",
        "submitter": case.member,
        "human_result": {
            "special_project": case.project_name,
            "task_reports": [],
            "key_task_issues": key_task_issues,
        },
    })
    assert sub_resp.status_code == 200, sub_resp.json()
    sub_id = sub_resp.json()["submission"]["id"]

    confirm_resp = owner.post(
        f"/api/confirmations/{sub_id}/confirm",
        json={
            "operator": case.owner,
            "human_result": {
                "special_project": case.project_name,
                "write_task_reports_issues": True,
                "task_reports": [],
                "key_task_issues": key_task_issues,
            },
        },
    )
    assert confirm_resp.status_code == 200, confirm_resp.json()

    with SessionLocal() as db:
        return (
            db.query(Issue)
            .filter(Issue.source_submission_id == sub_id)
            .all()
        )


def _make_issue_direct(case: IssCase, issue_type: str) -> int:
    """负责人直接创建 Issue，返回 issue_id。"""
    resp = case.clients["owner"].post("/api/issues", json={
        "project_id": case.project_id,
        "issue_type": issue_type,
        "description": f"直接创建测试{issue_type}事项_{time.time_ns()}",
        "priority": "中",
    })
    assert resp.status_code == 200, resp.json()
    return resp.json()["id"]


# ── ISS-1 ──────────────────────────────────────────────────────────────────────


def test_ai_confirm_risk_creates_risk_issue(iss_case: IssCase):
    """ISS-1: AI确认后风险写入 Issue，issue_type=风险，status=待处理。"""
    issues = _submit_and_confirm_issues(iss_case, [
        {
            "key_task_title": "测试关键任务",
            "issue_type": "风险",
            "description": "ISS1-存在进度延期风险",
            "priority": "中",
        }
    ])
    risk_issues = [i for i in issues if i.description == "ISS1-存在进度延期风险"]
    assert len(risk_issues) == 1, f"应创建1条风险记录，实际: {[i.description for i in issues]}"
    assert risk_issues[0].issue_type == IF.TYPE_RISK
    assert risk_issues[0].status == IF.STATUS_PENDING


# ── ISS-2 ──────────────────────────────────────────────────────────────────────


def test_ai_confirm_decision_creates_decision_issue(iss_case: IssCase):
    """ISS-2: AI确认后需决策写入 Issue，issue_type=需决策，status=待决策。"""
    issues = _submit_and_confirm_issues(iss_case, [
        {
            "key_task_title": "测试关键任务",
            "issue_type": "需决策",
            "description": "ISS2-先做关键词搜索还是标签筛选",
            "priority": "高",
        }
    ])
    dec_issues = [i for i in issues if i.description == "ISS2-先做关键词搜索还是标签筛选"]
    assert len(dec_issues) == 1, f"应创建1条决策记录，实际: {[i.description for i in issues]}"
    assert dec_issues[0].issue_type == IF.TYPE_DECISION
    assert dec_issues[0].status == IF.STATUS_PENDING_DECISION


# ── ISS-3 ──────────────────────────────────────────────────────────────────────


def test_owner_can_see_decision_issues(iss_case: IssCase):
    """ISS-3: 项目负责人能通过 issue_type=需决策 过滤看到决策事项。"""
    _submit_and_confirm_issues(iss_case, [
        {
            "key_task_title": "测试关键任务",
            "issue_type": "需决策",
            "description": "ISS3-需要负责人拍板的决策",
            "priority": "高",
        }
    ])

    resp = iss_case.clients["owner"].get(
        f"/api/issues?project_id={iss_case.project_id}&issue_type={IF.TYPE_DECISION}"
    )
    assert resp.status_code == 200, resp.json()
    items = resp.json()
    dec_items = [i for i in items if i.get("description") == "ISS3-需要负责人拍板的决策"]
    assert len(dec_items) >= 1, "负责人应能看到需决策事项"
    assert all(i["issue_type"] == IF.TYPE_DECISION for i in dec_items)


# ── ISS-4 ──────────────────────────────────────────────────────────────────────


def test_owner_can_resolve_decision_issue(iss_case: IssCase, admin_client):
    """ISS-4: 项目负责人可以通过 resolve 确认/处置需决策事项。

    需决策事项的直接创建需要 admin/CEO 权限（can_view_issue_decisions），
    因此用 admin 创建，再由负责人 resolve。
    """
    # 技术管理员直接创建决策事项
    resp = admin_client.post("/api/issues", json={
        "project_id": iss_case.project_id,
        "issue_type": IF.TYPE_DECISION,
        "description": "ISS4-负责人需要拍板的决策",
        "priority": "高",
    })
    assert resp.status_code == 200, resp.json()
    issue_id = resp.json()["id"]

    # 负责人 resolve
    resolve_resp = iss_case.clients["owner"].patch(
        f"/api/issues/{issue_id}/resolve",
        json={"resolution": "负责人决定先做关键词搜索"},
    )
    assert resolve_resp.status_code == 200, resolve_resp.json()
    body = resolve_resp.json()
    assert body["status"] == IF.STATUS_RESOLVED
    assert body["resolution"] == "负责人决定先做关键词搜索"


# ── ISS-5 ──────────────────────────────────────────────────────────────────────


def test_risk_can_be_resolved_with_resolution(iss_case: IssCase):
    """ISS-5: 风险可以填写处理结论并标记已解决。"""
    issue_id = _make_issue_direct(iss_case, IF.TYPE_RISK)

    resp = iss_case.clients["owner"].patch(
        f"/api/issues/{issue_id}/resolve",
        json={"resolution": "已联系相关方，风险已消除"},
    )
    assert resp.status_code == 200, resp.json()
    body = resp.json()
    assert body["status"] == IF.STATUS_RESOLVED
    assert "风险已消除" in body["resolution"]


# ── ISS-6 ──────────────────────────────────────────────────────────────────────


def test_coordinate_assign_helper_and_set_in_progress(iss_case: IssCase):
    """ISS-6: 待协调事项可以指定协助人；负责人可显式将状态设为处理中。"""
    issue_id = _make_issue_direct(iss_case, IF.TYPE_COORDINATE)

    # 指定协助人
    assign_resp = iss_case.clients["owner"].patch(
        f"/api/issues/{issue_id}/assign-helper",
        json={"helper": "张三"},
    )
    assert assign_resp.status_code == 200, assign_resp.json()
    assert assign_resp.json()["helper"] == "张三"

    # 负责人显式设状态为处理中
    status_resp = iss_case.clients["owner"].patch(
        f"/api/issues/{issue_id}/status",
        json={"status": IF.STATUS_IN_PROGRESS},
    )
    assert status_resp.status_code == 200, status_resp.json()
    assert status_resp.json()["status"] == IF.STATUS_IN_PROGRESS


# ── ISS-7 ──────────────────────────────────────────────────────────────────────


def test_member_cannot_execute_issue_actions(iss_case: IssCase):
    """ISS-7: 普通成员不能执行 resolve / close / assign-helper（均返回 403）。"""
    issue_id = _make_issue_direct(iss_case, IF.TYPE_RISK)
    member = iss_case.clients["member"]

    resolve_resp = member.patch(f"/api/issues/{issue_id}/resolve", json={})
    assert resolve_resp.status_code == 403, resolve_resp.json()

    close_resp = member.patch(f"/api/issues/{issue_id}/close", json={})
    assert close_resp.status_code == 403, close_resp.json()

    assign_resp = member.patch(
        f"/api/issues/{issue_id}/assign-helper", json={"helper": "李四"}
    )
    assert assign_resp.status_code == 403, assign_resp.json()
