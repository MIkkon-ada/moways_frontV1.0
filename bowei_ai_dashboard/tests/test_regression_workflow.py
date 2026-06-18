"""
回归测试 - 子任务提交确认工作流

手工回归编号覆盖：
  WF-1: 普通成员提交子任务状态更新 → 进入确认流程，不直接修改子任务状态
  WF-2: 项目负责人确认后，子任务状态/最新进展更新
  WF-3: 子任务全部完成后，关键任务不自动关闭（保持进行中）
  WF-4: 已完成关键任务新增子任务后，关键任务重新打开为进行中
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
from app.domain import task_status as TS
from app.main import app
from app.models import Person, Project, ProjectMember, SubTask, Task
from app.permissions import ROLE_NORMAL

TEST_PASSWORD = "testpass123"


@dataclass
class WFCase:
    project_id: int
    project_name: str
    owner: str
    member: str


@pytest.fixture
def wf_case(admin_client, passwords_file: Path) -> WFCase:
    suffix = str(time.time_ns())
    project_name = f"TEST_WF_{suffix}"
    names = {"owner": f"wf_own_{suffix}", "member": f"wf_mem_{suffix}"}

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
        return WFCase(
            project_id=proj.id, project_name=project_name,
            owner=names["owner"], member=names["member"],
        )


@pytest.fixture
def wf_clients(wf_case: WFCase):
    clients: dict[str, TestClient] = {}
    for role in ("owner", "member"):
        c = TestClient(app)
        resp = c.post("/api/auth/login",
                      json={"username": getattr(wf_case, role), "password": TEST_PASSWORD})
        assert resp.status_code == 200, resp.json()
        clients[role] = c
    yield clients
    for c in clients.values():
        c.close()


def _create_task(owner: TestClient, case: WFCase, title: str) -> int:
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


def _create_subtask(owner: TestClient, task_id: int, assignee: str, title: str) -> int:
    resp = owner.post(f"/api/tasks/{task_id}/subtasks", json={
        "title": title,
        "assignee": assignee,
        "plan_time": "2026-06",
        "status": "进行中",
    })
    assert resp.status_code == 200, resp.json()
    return resp.json()["id"]


def _member_request_status(member: TestClient, subtask_id: int, status: str) -> int:
    """成员提交子任务状态变更，返回 submission_id。"""
    resp = member.patch(f"/api/subtasks/{subtask_id}/status", json={"status": status})
    assert resp.status_code == 200, resp.json()
    body = resp.json()
    assert body.get("status") == "pending_confirmation", (
        f"Expected pending_confirmation from member status PATCH, got: {body}"
    )
    return body["submission_id"]


# ── WF-1 ─────────────────────────────────────────────────────────────────────


def test_member_status_update_enters_confirmation_not_direct(wf_case: WFCase, wf_clients):
    """
    WF-1: 普通成员 PATCH /api/subtasks/{id}/status → 进入确认流程。
    返回 {"status": "pending_confirmation"}，子任务状态未直接改变。
    """
    owner = wf_clients["owner"]
    member = wf_clients["member"]

    task_id = _create_task(owner, wf_case, "WF1关键任务")
    subtask_id = _create_subtask(owner, task_id, wf_case.member, "WF1子任务")

    resp = member.patch(f"/api/subtasks/{subtask_id}/status", json={"status": "已完成"})
    assert resp.status_code == 200, resp.json()
    body = resp.json()
    assert body.get("status") == "pending_confirmation", f"应进入确认流程: {body}"
    assert "submission_id" in body, "应返回 submission_id"

    # 子任务状态未直接变更
    with SessionLocal() as db:
        sub = db.get(SubTask, subtask_id)
        assert TS.normalize(sub.status) != TS.S_COMPLETED, "普通成员不应直接修改子任务状态"


# ── WF-2 ─────────────────────────────────────────────────────────────────────


def test_owner_confirm_updates_subtask_status(wf_case: WFCase, wf_clients):
    """
    WF-2: 项目负责人确认子任务状态变更后，子任务状态和 source_submission_id 均更新。
    """
    owner = wf_clients["owner"]
    member = wf_clients["member"]

    task_id = _create_task(owner, wf_case, "WF2关键任务")
    subtask_id = _create_subtask(owner, task_id, wf_case.member, "WF2子任务")

    submission_id = _member_request_status(member, subtask_id, "已完成")

    confirm_resp = owner.post(
        f"/api/confirmations/{submission_id}/confirm",
        json={"operator": wf_case.owner},
    )
    assert confirm_resp.status_code == 200, confirm_resp.json()

    with SessionLocal() as db:
        sub = db.get(SubTask, subtask_id)
        assert TS.normalize(sub.status) == TS.S_COMPLETED, (
            f"确认后子任务应为已完成，实际: {sub.status}"
        )
        assert sub.source_submission_id == submission_id, (
            "子任务应记录来源 submission_id"
        )


# ── WF-3 ─────────────────────────────────────────────────────────────────────


def test_all_subtasks_done_task_stays_in_progress(wf_case: WFCase, wf_clients):
    """
    WF-3: 子任务全部完成后，关键任务不自动关闭，保持进行中。
    关键任务只能由负责人显式关闭（通过满足所有子任务完成后单独操作）。
    """
    owner = wf_clients["owner"]
    member = wf_clients["member"]

    task_id = _create_task(owner, wf_case, "WF3关键任务")
    subtask_a = _create_subtask(owner, task_id, wf_case.member, "WF3子任务A")
    subtask_b = _create_subtask(owner, task_id, wf_case.member, "WF3子任务B")

    for subtask_id in (subtask_a, subtask_b):
        sub_id = _member_request_status(member, subtask_id, "已完成")
        confirm_resp = owner.post(
            f"/api/confirmations/{sub_id}/confirm",
            json={"operator": wf_case.owner},
        )
        assert confirm_resp.status_code == 200, confirm_resp.json()

    # 验证两个子任务均已完成
    with SessionLocal() as db:
        for sid in (subtask_a, subtask_b):
            sub = db.get(SubTask, sid)
            assert TS.normalize(sub.status) == TS.S_COMPLETED

    # 关键任务应仍为进行中
    task_resp = owner.get(f"/api/tasks/{task_id}")
    assert task_resp.status_code == 200
    task_status = TS.normalize(task_resp.json()["status"])
    assert task_status == TS.S_IN_PROGRESS, (
        f"子任务全部完成后，关键任务不应自动关闭，实际状态: {task_status}"
    )


# ── WF-4 ─────────────────────────────────────────────────────────────────────


def test_completed_task_reopened_when_subtask_added(wf_case: WFCase, wf_clients):
    """
    WF-4: 已完成关键任务新增子任务后，关键任务自动重新打开为进行中。
    """
    owner = wf_clients["owner"]

    task_id = _create_task(owner, wf_case, "WF4关键任务")
    # 负责人直接创建并关闭初始子任务
    subtask_id = _create_subtask(owner, task_id, wf_case.owner, "WF4初始子任务")
    mark_resp = owner.patch(f"/api/subtasks/{subtask_id}/status", json={"status": "已完成"})
    assert mark_resp.status_code == 200

    # 直接写库把关键任务标记为已完成（模拟负责人显式关闭）
    with SessionLocal() as db:
        task = db.get(Task, task_id)
        task.status = TS.S_COMPLETED
        db.commit()

    with SessionLocal() as db:
        task = db.get(Task, task_id)
        assert TS.normalize(task.status) == TS.S_COMPLETED, "前置条件：任务应已完成"

    # 新增子任务后，关键任务自动重新打开
    new_sub_resp = owner.post(f"/api/tasks/{task_id}/subtasks", json={
        "title": "WF4新增子任务",
        "assignee": wf_case.member,
        "plan_time": "2026-07",
        "status": "未开始",
    })
    assert new_sub_resp.status_code == 200, new_sub_resp.json()

    task_resp = owner.get(f"/api/tasks/{task_id}")
    assert task_resp.status_code == 200
    task_status = TS.normalize(task_resp.json()["status"])
    assert task_status == TS.S_IN_PROGRESS, (
        f"已完成关键任务新增子任务后应重新打开为进行中，实际: {task_status}"
    )
