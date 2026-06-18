"""
回归测试 - 核心权限边界矩阵

手工回归编号覆盖：
  PERM-1: 普通成员不能确认 AI 入库（confirmations confirm → 403）
  PERM-2: 项目负责人只能确认自己负责的项目（跨项目 → 403）
  PERM-3: 技术管理员可以处理任意项目的提交
  PERM-4: 非项目成员不能查看或提交该项目数据
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
from app.models import Person, Project, ProjectMember
from app.permissions import ROLE_NORMAL

TEST_PASSWORD = "testpass123"


@dataclass
class PermProject:
    project_id: int
    project_name: str
    owner: str
    member: str


@dataclass
class PermCase:
    proj_a: PermProject
    proj_b: PermProject
    outsider: str
    clients: dict[str, TestClient] = field(default_factory=dict)


def _create_project_with_members(
    suffix: str,
    tag: str,
    passwords_file: Path,
) -> tuple[PermProject, dict[str, str]]:
    """创建一个含 owner+member 的测试项目，返回 (PermProject, {role: username})。"""
    project_name = f"TEST_PERM_{tag}_{suffix}"
    names = {
        f"owner_{tag}": f"perm_own_{tag}_{suffix}",
        f"member_{tag}": f"perm_mem_{tag}_{suffix}",
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
            name=project_name, coordinator="",
            owners=names[f"owner_{tag}"],
            collaborators=names[f"member_{tag}"],
            sort_order=0, is_active=True,
        )
        db.add(proj)
        db.flush()

        db.add(ProjectMember(
            project_id=proj.id,
            person_id=people[f"owner_{tag}"].id,
            person_name_snapshot=people[f"owner_{tag}"].name,
            role="owner",
        ))
        db.add(ProjectMember(
            project_id=proj.id,
            person_id=people[f"member_{tag}"].id,
            person_name_snapshot=people[f"member_{tag}"].name,
            role="member",
        ))
        db.commit()
        project_id = proj.id

    pp = PermProject(
        project_id=project_id, project_name=project_name,
        owner=names[f"owner_{tag}"], member=names[f"member_{tag}"],
    )
    return pp, names


@pytest.fixture
def perm_case(admin_client, passwords_file: Path) -> PermCase:
    suffix = str(time.time_ns())

    proj_a, names_a = _create_project_with_members(suffix, "A", passwords_file)
    proj_b, names_b = _create_project_with_members(suffix, "B", passwords_file)

    # 局外人（不属于任何测试项目）
    outsider_name = f"perm_out_{suffix}"
    raw = json.loads(passwords_file.read_text(encoding="utf-8"))
    raw[outsider_name] = hash_password(TEST_PASSWORD)
    passwords_file.write_text(json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")
    with SessionLocal() as db:
        out = Person(name=outsider_name, system_role=ROLE_NORMAL, permission="view",
                     is_active=True, is_admin=False)
        db.add(out)
        db.commit()

    all_names = {**names_a, **names_b, "outsider": outsider_name}
    clients: dict[str, TestClient] = {}
    for key, name in all_names.items():
        c = TestClient(app)
        resp = c.post("/api/auth/login",
                      json={"username": name, "password": TEST_PASSWORD})
        assert resp.status_code == 200, f"{key} login: {resp.json()}"
        clients[key] = c

    case = PermCase(
        proj_a=proj_a, proj_b=proj_b, outsider=outsider_name, clients=clients,
    )
    yield case
    for c in clients.values():
        c.close()


def _member_submit_update(client: TestClient, project_id: int,
                          project_name: str, member_name: str) -> int:
    """成员提交工作更新，返回 submission_id。"""
    resp = client.post("/api/updates", json={
        "project_id": project_id,
        "source_type": "text_update",
        "transcript_text": f"权限测试更新 {time.time_ns()}",
        "submitter": member_name,
    })
    assert resp.status_code == 200, resp.json()
    return resp.json()["submission"]["id"]


# ── PERM-1 ─────────────────────────────────────────────────────────────────────


def test_member_cannot_confirm_ai_submission(perm_case: PermCase):
    """PERM-1: 普通成员不能确认 AI 入库（403）。"""
    proj = perm_case.proj_a
    member_client = perm_case.clients["member_A"]

    sub_id = _member_submit_update(member_client, proj.project_id, proj.project_name, proj.member)

    # 成员尝试自行确认
    confirm_resp = member_client.post(
        f"/api/confirmations/{sub_id}/confirm",
        json={"operator": proj.member},
    )
    assert confirm_resp.status_code == 403, (
        f"PERM-1: 普通成员不应能确认提交，实际状态码: {confirm_resp.status_code}"
    )


# ── PERM-2 ─────────────────────────────────────────────────────────────────────


def test_owner_cannot_confirm_cross_project_submission(perm_case: PermCase):
    """PERM-2: 项目 A 的负责人不能确认项目 B 的提交（403）。"""
    proj_b = perm_case.proj_b
    member_b_client = perm_case.clients["member_B"]
    owner_a_client = perm_case.clients["owner_A"]

    # 项目 B 成员提交
    sub_id = _member_submit_update(
        member_b_client, proj_b.project_id, proj_b.project_name, proj_b.member
    )

    # 项目 A 负责人尝试确认项目 B 的提交
    confirm_resp = owner_a_client.post(
        f"/api/confirmations/{sub_id}/confirm",
        json={"operator": perm_case.proj_a.owner},
    )
    assert confirm_resp.status_code == 403, (
        f"PERM-2: 跨项目确认应返回 403，实际: {confirm_resp.status_code}, body: {confirm_resp.json()}"
    )


def test_owner_can_confirm_own_project_submission(perm_case: PermCase):
    """PERM-2 正向：项目 A 的负责人可以确认项目 A 的提交。"""
    proj_a = perm_case.proj_a
    member_a_client = perm_case.clients["member_A"]
    owner_a_client = perm_case.clients["owner_A"]

    sub_id = _member_submit_update(
        member_a_client, proj_a.project_id, proj_a.project_name, proj_a.member
    )

    confirm_resp = owner_a_client.post(
        f"/api/confirmations/{sub_id}/confirm",
        json={"operator": proj_a.owner},
    )
    assert confirm_resp.status_code == 200, (
        f"PERM-2: 负责人应能确认自己项目的提交，实际: {confirm_resp.json()}"
    )


# ── PERM-3 ─────────────────────────────────────────────────────────────────────


def test_tech_admin_can_confirm_any_project(perm_case: PermCase, admin_client):
    """PERM-3: 技术管理员可以确认任意项目的提交。"""
    proj_b = perm_case.proj_b
    member_b_client = perm_case.clients["member_B"]

    sub_id = _member_submit_update(
        member_b_client, proj_b.project_id, proj_b.project_name, proj_b.member
    )

    confirm_resp = admin_client.post(
        f"/api/confirmations/{sub_id}/confirm",
        json={"operator": "testadmin"},
    )
    assert confirm_resp.status_code == 200, (
        f"PERM-3: 技术管理员应能确认任意项目提交，实际: {confirm_resp.json()}"
    )


def test_tech_admin_can_resolve_issues_across_projects(perm_case: PermCase, admin_client):
    """PERM-3 扩展：技术管理员可以处理任意项目的 Issue。"""
    proj_b = perm_case.proj_b

    # admin 在项目 B 创建 issue
    issue_resp = admin_client.post("/api/issues", json={
        "project_id": proj_b.project_id,
        "issue_type": "风险",
        "description": "PERM3管理员跨项目测试风险",
        "priority": "低",
    })
    assert issue_resp.status_code == 200, issue_resp.json()
    issue_id = issue_resp.json()["id"]

    resolve_resp = admin_client.patch(
        f"/api/issues/{issue_id}/resolve",
        json={"resolution": "管理员已处理"},
    )
    assert resolve_resp.status_code == 200, resolve_resp.json()


# ── PERM-4 ─────────────────────────────────────────────────────────────────────


def test_non_member_cannot_view_project_tasks(perm_case: PermCase):
    """PERM-4: 非项目成员获取项目任务列表时为空（无权可见）。"""
    outsider_client = perm_case.clients["outsider"]
    proj_a = perm_case.proj_a

    # 首先 admin 在项目 A 创建一条任务
    with SessionLocal() as db:
        from app.models import Task as TaskModel
        t = TaskModel(
            project_id=proj_a.project_id,
            special_project=proj_a.project_name,
            key_task="PERM4测试任务",
            status="进行中",
        )
        db.add(t)
        db.commit()

    resp = outsider_client.get(f"/api/tasks?project_id={proj_a.project_id}")
    assert resp.status_code == 200
    assert resp.json() == [], (
        f"PERM-4: 非项目成员应看到空任务列表，实际: {resp.json()}"
    )


def test_non_member_cannot_submit_update(perm_case: PermCase):
    """PERM-4 扩展：非项目成员不能向该项目提交工作更新（403）。"""
    outsider_client = perm_case.clients["outsider"]
    proj_a = perm_case.proj_a

    resp = outsider_client.post("/api/updates", json={
        "project_id": proj_a.project_id,
        "source_type": "text_update",
        "transcript_text": "局外人尝试提交",
        "submitter": perm_case.outsider,
    })
    assert resp.status_code == 403, (
        f"PERM-4: 非项目成员不应能提交，实际: {resp.status_code}, {resp.json()}"
    )


def test_non_member_cannot_submit_achievement(perm_case: PermCase, admin_client):
    """PERM-4 扩展：非项目成员不能向该项目提交成果（403）。"""
    outsider_client = perm_case.clients["outsider"]
    proj_a = perm_case.proj_a

    # 先创建一个关键任务（admin）
    task_resp = admin_client.post("/api/tasks", json={
        "project_id": proj_a.project_id,
        "special_project": proj_a.project_name,
        "key_task": "PERM4成果测试任务",
        "status": "进行中",
    })
    assert task_resp.status_code == 200
    task_id = task_resp.json()["id"]

    resp = outsider_client.post("/api/achievement-submissions", json={
        "project_id": proj_a.project_id,
        "related_task_id": task_id,
        "name": "局外人成果",
        "achievement_type": "方案",
        "version": "V0.1",
        "file_link": "",
        "scenario": "",
        "reuse_tag": "",
    })
    assert resp.status_code == 403, (
        f"PERM-4: 非项目成员不应能提交成果，实际: {resp.status_code}, {resp.json()}"
    )
