"""
P1 priority tests: status flow and permission boundary.

Covers requirements A–F from the 工作推进表状态与权限流转设计.md document:

  A/B  coordinator cannot close a key task; only owner / tech_admin can
  C    subtask assignee status change goes to confirmation centre, not direct
  D    assigning an owner auto-promotes subtask from 未开始 to 进行中
  E    adding a subtask to a completed key task auto-reopens it to 进行中
  F    member role cannot directly create subtasks
"""
from __future__ import annotations

import pytest

# Reuse shared fixtures from test_core_business_regressions
from test_core_business_regressions import case_data, client_pool  # noqa: F401


# ─── helpers ──────────────────────────────────────────────────────────────────

def _task_payload(case, status: str = "未开始") -> dict:
    return {
        "project_id": case.project_id,
        "special_project": case.project_name,
        "key_task": "权限流转测试关键任务",
        "plan_time": "2026-07",
        "status": status,
    }


def _create_task(owner_client, case) -> int:
    resp = owner_client.post("/api/tasks", json=_task_payload(case))
    assert resp.status_code == 200, resp.json()
    return resp.json()["id"]


def _create_subtask(owner_client, task_id, assignee, status="进行中") -> int:
    resp = owner_client.post(
        f"/api/tasks/{task_id}/subtasks",
        json={"title": "测试子任务", "assignee": assignee, "plan_time": "2026-07", "status": status},
    )
    assert resp.status_code == 200, resp.json()
    return resp.json()["id"]


# ─── A/B: 关闭关键任务权限 ────────────────────────────────────────────────────

def test_coordinator_cannot_close_key_task_via_patch(case_data, client_pool):
    """A: PATCH /status 到 已完成 时，coordinator 被拒绝（403）。"""
    owner = client_pool(case_data.owner)
    coordinator = client_pool(case_data.coordinator)

    task_id = _create_task(owner, case_data)
    _create_subtask(owner, task_id, case_data.owner, status="已完成")

    resp = coordinator.patch(f"/api/tasks/{task_id}/status", json={"status": "已完成"})
    assert resp.status_code == 403, resp.json()


def test_coordinator_cannot_close_key_task_via_put(case_data, client_pool):
    """B: PUT（全量更新）到 已完成 时，coordinator 被拒绝（403）。"""
    owner = client_pool(case_data.owner)
    coordinator = client_pool(case_data.coordinator)

    task_id = _create_task(owner, case_data)
    _create_subtask(owner, task_id, case_data.owner, status="已完成")

    payload = {**_task_payload(case_data, status="已完成"), "key_task": "权限流转测试关键任务"}
    resp = coordinator.put(f"/api/tasks/{task_id}", json=payload)
    assert resp.status_code == 403, resp.json()


def test_coordinator_can_change_to_non_complete_status(case_data, client_pool):
    """A/B 边界：coordinator 可以把关键任务设为暂缓（非 已完成），不被拦截。"""
    owner = client_pool(case_data.owner)
    coordinator = client_pool(case_data.coordinator)

    task_id = _create_task(owner, case_data)

    resp = coordinator.patch(f"/api/tasks/{task_id}/status", json={"status": "暂缓"})
    assert resp.status_code == 200, resp.json()
    assert resp.json()["status"] == "暂缓"


def test_owner_can_close_key_task(case_data, client_pool):
    """A/B: owner 可以关闭关键任务（需先完成全部子任务）。"""
    owner = client_pool(case_data.owner)

    task_id = _create_task(owner, case_data)
    _create_subtask(owner, task_id, case_data.owner, status="已完成")

    resp = owner.patch(f"/api/tasks/{task_id}/status", json={"status": "已完成"})
    assert resp.status_code == 200, resp.json()
    assert resp.json()["status"] == "已完成"


def test_tech_admin_can_close_key_task(case_data, client_pool, admin_client):
    """A/B: 技术管理员（is_tech_admin=True）可以关闭任意项目的关键任务。"""
    owner = client_pool(case_data.owner)

    task_id = _create_task(owner, case_data)
    _create_subtask(owner, task_id, case_data.owner, status="已完成")

    resp = admin_client.patch(f"/api/tasks/{task_id}/status", json={"status": "已完成"})
    assert resp.status_code == 200, resp.json()
    assert resp.json()["status"] == "已完成"


# ─── C: 子任务 assignee 状态变更进确认中心 ────────────────────────────────────

def test_assignee_status_change_routes_to_confirmation_center(case_data, client_pool):
    """C: member（仅 assignee）调用 PATCH /status 不直接改状态，返回 pending_confirmation。"""
    owner = client_pool(case_data.owner)
    member = client_pool(case_data.member)

    task_id = _create_task(owner, case_data)
    sub_id = _create_subtask(owner, task_id, case_data.member, status="进行中")

    resp = member.patch(f"/api/subtasks/{sub_id}/status", json={"status": "已完成"})
    assert resp.status_code == 200, resp.json()
    body = resp.json()
    assert body.get("status") == "pending_confirmation", body
    assert isinstance(body.get("submission_id"), int)

    # 子任务状态不应变化
    subs = owner.get(f"/api/tasks/{task_id}/subtasks")
    matching = [s for s in subs.json() if s["id"] == sub_id]
    assert len(matching) == 1
    assert matching[0]["status"] == "进行中", matching[0]


def test_assignee_status_change_confirmation_updates_subtask_and_context(case_data, client_pool):
    """C 回归: assignee 状态变更确认入库后，应写回子任务，并携带项目/关键任务/子任务上下文。"""
    owner = client_pool(case_data.owner)
    member = client_pool(case_data.member)

    task_id = _create_task(owner, case_data)
    sub_id = _create_subtask(owner, task_id, case_data.member, status="进行中")

    pending = member.patch(f"/api/subtasks/{sub_id}/status", json={"status": "已完成"})
    assert pending.status_code == 200, pending.json()
    submission_id = pending.json()["submission_id"]

    detail = owner.get(f"/api/confirmations/{submission_id}")
    assert detail.status_code == 200, detail.json()
    ai_result = detail.json()["ai_result"]
    assert ai_result["project_id"] == case_data.project_id
    assert ai_result["task_id"] == task_id
    assert ai_result["subtask_id"] == sub_id
    assert ai_result["key_task"] == "权限流转测试关键任务"
    assert ai_result["subtask_title"] == "测试子任务"
    assert ai_result["to_status"] == "已完成"

    confirmed = owner.post(
        f"/api/confirmations/{submission_id}/confirm",
        json={"operator": case_data.owner, "human_result": {}},
    )
    assert confirmed.status_code == 200, confirmed.json()

    subs = owner.get(f"/api/tasks/{task_id}/subtasks")
    matching = [s for s in subs.json() if s["id"] == sub_id]
    assert len(matching) == 1
    assert matching[0]["status"] == "已完成", matching[0]


def test_assignee_cannot_change_status_via_update(case_data, client_pool):
    """C 边界: member 通过 PATCH /api/subtasks/{id}（整体更新）修改 status 也被拒绝。"""
    owner = client_pool(case_data.owner)
    member = client_pool(case_data.member)

    task_id = _create_task(owner, case_data)
    sub_id = _create_subtask(owner, task_id, case_data.member, status="进行中")

    resp = member.patch(
        f"/api/subtasks/{sub_id}",
        json={"title": "修改了标题", "assignee": case_data.member, "status": "已完成", "plan_time": "2026-07"},
    )
    assert resp.status_code == 403, resp.json()


def test_owner_status_change_is_direct(case_data, client_pool):
    """C: owner 调用 PATCH /status 直接修改，不进确认中心。"""
    owner = client_pool(case_data.owner)

    task_id = _create_task(owner, case_data)
    sub_id = _create_subtask(owner, task_id, case_data.member, status="进行中")

    resp = owner.patch(f"/api/subtasks/{sub_id}/status", json={"status": "已完成"})
    assert resp.status_code == 200, resp.json()
    assert resp.json().get("status") == "已完成"


def test_coordinator_status_change_is_direct(case_data, client_pool):
    """C: coordinator 调用 PATCH /status 直接修改，不进确认中心。"""
    owner = client_pool(case_data.owner)
    coordinator = client_pool(case_data.coordinator)

    task_id = _create_task(owner, case_data)
    sub_id = _create_subtask(owner, task_id, case_data.member, status="进行中")

    resp = coordinator.patch(f"/api/subtasks/{sub_id}/status", json={"status": "暂缓"})
    assert resp.status_code == 200, resp.json()
    assert resp.json().get("status") == "暂缓"


# ─── D: assignee 设置后子任务自动进行中 ──────────────────────────────────────

def test_subtask_auto_in_progress_when_assignee_set_on_create(case_data, client_pool):
    """D: 创建时提供 assignee 且 status=未开始（默认），自动升级为进行中。"""
    owner = client_pool(case_data.owner)

    task_id = _create_task(owner, case_data)

    # 不传 status（默认 未开始），但有 assignee
    resp = owner.post(
        f"/api/tasks/{task_id}/subtasks",
        json={"title": "自动进行中测试", "assignee": case_data.member, "plan_time": "2026-07"},
    )
    assert resp.status_code == 200, resp.json()
    assert resp.json()["status"] == "进行中", resp.json()


def test_explicit_non_default_status_not_overridden(case_data, client_pool):
    """D 边界: 显式传入 status=延期 时，assignee 自动升级逻辑不覆盖。"""
    owner = client_pool(case_data.owner)

    task_id = _create_task(owner, case_data)

    resp = owner.post(
        f"/api/tasks/{task_id}/subtasks",
        json={"title": "延期子任务", "assignee": case_data.member, "plan_time": "2026-07", "status": "延期"},
    )
    assert resp.status_code == 200, resp.json()
    assert resp.json()["status"] == "延期", resp.json()


# ─── E: 已完成关键任务新增子任务后自动重新打开 ────────────────────────────────

def test_adding_subtask_to_completed_key_task_reopens_it(case_data, client_pool):
    """E: 向已完成关键任务新增子任务后，关键任务自动重新打开为进行中。"""
    owner = client_pool(case_data.owner)

    task_id = _create_task(owner, case_data)
    _create_subtask(owner, task_id, case_data.owner, status="已完成")

    close = owner.patch(f"/api/tasks/{task_id}/status", json={"status": "已完成"})
    assert close.status_code == 200, close.json()
    assert close.json()["status"] == "已完成"

    # 新增子任务应触发重新打开
    new_sub = owner.post(
        f"/api/tasks/{task_id}/subtasks",
        json={"title": "新增子任务", "assignee": case_data.member, "plan_time": "2026-07"},
    )
    assert new_sub.status_code == 200, new_sub.json()

    task = owner.get(f"/api/tasks/{task_id}")
    assert task.json()["status"] == "进行中", task.json()


# ─── F: member 不能直接创建子任务 ────────────────────────────────────────────

def test_member_cannot_directly_create_subtask(case_data, client_pool):
    """F: member 角色调用 POST /api/tasks/{id}/subtasks 返回 403。"""
    owner = client_pool(case_data.owner)
    member = client_pool(case_data.member)

    task_id = _create_task(owner, case_data)

    resp = member.post(
        f"/api/tasks/{task_id}/subtasks",
        json={"title": "member 尝试直接创建", "assignee": case_data.member, "plan_time": "2026-07"},
    )
    assert resp.status_code == 403, resp.json()


def test_coordinator_can_directly_create_subtask(case_data, client_pool):
    """F: coordinator 角色可以直接创建子任务。"""
    owner = client_pool(case_data.owner)
    coordinator = client_pool(case_data.coordinator)

    task_id = _create_task(owner, case_data)

    resp = coordinator.post(
        f"/api/tasks/{task_id}/subtasks",
        json={"title": "统筹人直接创建", "assignee": case_data.member, "plan_time": "2026-07"},
    )
    assert resp.status_code == 200, resp.json()


def test_outsider_cannot_create_subtask(case_data, client_pool):
    """F 兜底: 非项目成员仍被拒绝（403）。"""
    owner = client_pool(case_data.owner)
    outsider = client_pool(case_data.outsider)

    task_id = _create_task(owner, case_data)

    resp = outsider.post(
        f"/api/tasks/{task_id}/subtasks",
        json={"title": "外部人员不应提交", "assignee": case_data.outsider, "plan_time": "2026-07"},
    )
    assert resp.status_code == 403, resp.json()
