from __future__ import annotations

import pytest

from app.domain.task_status import derive_parent_status
from app.domain import task_status as TS
from app.database import SessionLocal
from app.models import SubTask, Task
from test_core_business_regressions import case_data, client_pool  # noqa: F401


def _task_payload(case, status: str = "未开始") -> dict:
    return {
        "project_id": case.project_id,
        "special_project": case.project_name,
        "key_task": "关键任务-三层分离",
        "key_achievement": "阶段成果",
        "completion_standard": "所有子任务完成后才算关键任务完成",
        "plan_time": "2026-06",
        "status": status,
    }


def test_derive_parent_status_from_subtasks():
    assert derive_parent_status("未开始", []) == "未开始"
    assert derive_parent_status("未开始", ["进行中", "未开始"]) == "进行中"
    assert derive_parent_status("进行中", ["已完成", "已完成"]) == "进行中"
    assert derive_parent_status("已完成", ["已完成", "进行中"]) == "进行中"
    assert derive_parent_status("进行中", ["暂缓"]) == "暂缓"
    assert derive_parent_status("进行中", ["延期", "暂缓"]) == "延期"
    assert derive_parent_status("暂缓", ["未开始"]) == "未开始"


def test_project_member_can_create_subtask_and_outsider_cannot(case_data, client_pool):
    """F: member 角色不能直接创建子任务；owner 可以；outsider 仍被拒绝。"""
    owner = client_pool(case_data.owner)
    member = client_pool(case_data.member)
    outsider = client_pool(case_data.outsider)

    task_resp = owner.post("/api/tasks", json=_task_payload(case_data))
    assert task_resp.status_code == 200, task_resp.json()
    task_id = task_resp.json()["id"]

    # F: member（role=member）不再允许直接创建子任务
    member_resp = member.post(
        f"/api/tasks/{task_id}/subtasks",
        json={
            "title": "成员不能直接创建子任务",
            "assignee": case_data.member,
            "plan_time": "2026-06",
            "status": "未开始",
            "completion_criteria": "提交可验收结果",
        },
    )
    assert member_resp.status_code == 403, member_resp.json()

    # owner 可以直接创建
    owner_resp = owner.post(
        f"/api/tasks/{task_id}/subtasks",
        json={
            "title": "负责人直接创建的子任务",
            "assignee": case_data.member,
            "plan_time": "2026-06",
            "status": "进行中",
        },
    )
    assert owner_resp.status_code == 200, owner_resp.json()

    outsider_resp = outsider.post(
        f"/api/tasks/{task_id}/subtasks",
        json={
            "title": "外部人员不应提交",
            "assignee": case_data.outsider,
            "plan_time": "2026-06",
            "status": "未开始",
        },
    )
    assert outsider_resp.status_code == 403, outsider_resp.json()


def test_subtask_status_syncs_parent_key_task_status(case_data, client_pool):
    """F: owner 创建子任务；owner 直接变更状态触发父级同步；所有子任务完成后关键任务不自动关闭。"""
    owner = client_pool(case_data.owner)

    task_resp = owner.post("/api/tasks", json=_task_payload(case_data))
    assert task_resp.status_code == 200, task_resp.json()
    task_id = task_resp.json()["id"]

    # F: 只有 owner/coordinator 可直接创建子任务
    sub1 = owner.post(
        f"/api/tasks/{task_id}/subtasks",
        json={"title": "动作一", "assignee": case_data.member, "plan_time": "2026-06", "status": "进行中"},
    )
    assert sub1.status_code == 200, sub1.json()

    task_after_active = owner.get(f"/api/tasks/{task_id}")
    assert task_after_active.status_code == 200, task_after_active.json()
    assert task_after_active.json()["status"] == "进行中"

    sub2 = owner.post(
        f"/api/tasks/{task_id}/subtasks",
        json={"title": "动作二", "assignee": case_data.member, "plan_time": "2026-06", "status": "进行中"},
    )
    assert sub2.status_code == 200, sub2.json()

    # owner（有权限）直接变更子任务状态
    done1 = owner.patch(f"/api/subtasks/{sub1.json()['id']}/status", json={"status": "已完成"})
    assert done1.status_code == 200, done1.json()
    assert done1.json().get("status") == "已完成"
    still_running = owner.get(f"/api/tasks/{task_id}")
    assert still_running.json()["status"] == "进行中"

    done2 = owner.patch(f"/api/subtasks/{sub2.json()['id']}/status", json={"status": "已完成"})
    assert done2.status_code == 200, done2.json()
    # 子任务全部完成后，关键任务仍保持"进行中"，不自动关闭
    still_waiting_owner = owner.get(f"/api/tasks/{task_id}")
    assert still_waiting_owner.json()["status"] == "进行中"


def test_paused_subtasks_sync_parent_key_task_to_paused(case_data, client_pool):
    """owner（有权限）直接暂缓子任务后，父级关键任务同步为暂缓。"""
    owner = client_pool(case_data.owner)

    task_resp = owner.post("/api/tasks", json=_task_payload(case_data, status="进行中"))
    assert task_resp.status_code == 200, task_resp.json()
    task_id = task_resp.json()["id"]

    # F: owner 创建子任务
    sub = owner.post(
        f"/api/tasks/{task_id}/subtasks",
        json={"title": "暂停动作", "assignee": case_data.member, "plan_time": "2026-06", "status": "进行中"},
    )
    assert sub.status_code == 200, sub.json()

    # owner 直接设为暂缓（有权限，直接生效）
    paused = owner.patch(f"/api/subtasks/{sub.json()['id']}/status", json={"status": "暂缓"})
    assert paused.status_code == 200, paused.json()
    assert paused.json().get("status") == "暂缓"

    parent = owner.get(f"/api/tasks/{task_id}")
    assert parent.status_code == 200, parent.json()
    assert parent.json()["status"] == "暂缓"


def test_key_task_completion_requires_completed_subtasks(case_data, client_pool):
    """关键任务关闭前必须完成全部子任务（owner 创建 + owner 直接完成子任务）。"""
    owner = client_pool(case_data.owner)

    task_resp = owner.post("/api/tasks", json=_task_payload(case_data))
    assert task_resp.status_code == 200, task_resp.json()
    task_id = task_resp.json()["id"]

    blocked_without_children = owner.patch(f"/api/tasks/{task_id}/status", json={"status": "已完成"})
    assert blocked_without_children.status_code == 409, blocked_without_children.json()

    # F: owner 创建子任务
    sub = owner.post(
        f"/api/tasks/{task_id}/subtasks",
        json={"title": "未完成动作", "assignee": case_data.member, "plan_time": "2026-06", "status": "进行中"},
    )
    assert sub.status_code == 200, sub.json()

    blocked_with_active_child = owner.patch(f"/api/tasks/{task_id}/status", json={"status": "已完成"})
    assert blocked_with_active_child.status_code == 409, blocked_with_active_child.json()

    # owner 直接完成子任务（有权限，直接生效）
    done = owner.patch(f"/api/subtasks/{sub.json()['id']}/status", json={"status": "已完成"})
    assert done.status_code == 200, done.json()
    assert done.json().get("status") == "已完成"

    # A/B: owner 可以关闭关键任务
    allowed = owner.patch(f"/api/tasks/{task_id}/status", json={"status": "已完成"})
    assert allowed.status_code == 200, allowed.json()


def test_coordinator_can_edit_key_task_but_cannot_restore_recycle_bin_item(case_data, client_pool):
    owner = client_pool(case_data.owner)
    coordinator = client_pool(case_data.coordinator)

    task_resp = owner.post("/api/tasks", json=_task_payload(case_data))
    assert task_resp.status_code == 200, task_resp.json()
    task = task_resp.json()
    task_id = task["id"]

    edit_payload = {
        **_task_payload(case_data, status=TS.S_IN_PROGRESS),
        "key_task": "统筹人可编辑的关键任务",
        "key_achievement": task["key_achievement"],
        "completion_standard": task["completion_standard"],
        "coordinator": case_data.coordinator,
        "owner": case_data.owner,
        "collaborators": case_data.member,
        "problem_note": "由统筹人补充进展说明",
    }
    edit_resp = coordinator.put(f"/api/tasks/{task_id}", json=edit_payload)
    assert edit_resp.status_code == 200, edit_resp.json()
    assert edit_resp.json()["key_task"] == "统筹人可编辑的关键任务"

    status_resp = coordinator.patch(f"/api/tasks/{task_id}/status", json={"status": TS.S_PAUSED})
    assert status_resp.status_code == 200, status_resp.json()
    assert status_resp.json()["status"] == TS.S_PAUSED

    coordinator_delete = coordinator.delete(f"/api/tasks/{task_id}")
    assert coordinator_delete.status_code == 403, coordinator_delete.json()

    delete_resp = owner.delete(f"/api/tasks/{task_id}")
    assert delete_resp.status_code == 200, delete_resp.json()

    restore_resp = coordinator.post(f"/api/tasks/{task_id}/restore")
    assert restore_resp.status_code == 403, restore_resp.json()

    owner_restore = owner.post(f"/api/tasks/{task_id}/restore")
    assert owner_restore.status_code == 200, owner_restore.json()


def test_deleting_key_task_moves_children_to_recycle_bin_and_restores_them(case_data, client_pool):
    owner = client_pool(case_data.owner)

    task_resp = owner.post("/api/tasks", json=_task_payload(case_data))
    assert task_resp.status_code == 200, task_resp.json()
    task_id = task_resp.json()["id"]

    # F: owner 创建子任务
    sub = owner.post(
        f"/api/tasks/{task_id}/subtasks",
        json={"title": "将随关键任务删除", "assignee": case_data.member, "plan_time": "2026-06", "status": "进行中"},
    )
    assert sub.status_code == 200, sub.json()

    delete_resp = owner.delete(f"/api/tasks/{task_id}")
    assert delete_resp.status_code == 200, delete_resp.json()

    active_tasks = owner.get("/api/tasks", params={"project_id": case_data.project_id})
    assert active_tasks.status_code == 200, active_tasks.json()
    assert active_tasks.json() == []

    recycle_tasks = owner.get("/api/tasks", params={"project_id": case_data.project_id, "deleted": "true"})
    assert recycle_tasks.status_code == 200, recycle_tasks.json()
    assert len(recycle_tasks.json()) == 1
    assert recycle_tasks.json()[0]["is_deleted"] is True

    subtasks = owner.get(f"/api/tasks/{task_id}/subtasks")
    assert subtasks.status_code == 404, subtasks.json()
    with SessionLocal() as db:
        task_row = db.get(Task, task_id)
        assert task_row is not None
        assert task_row.is_deleted is True
        assert task_row.delete_batch_id
        child_rows = db.query(SubTask).filter_by(task_id=task_id).all()
        assert len(child_rows) == 1
        assert child_rows[0].is_deleted is True
        assert child_rows[0].delete_batch_id == task_row.delete_batch_id
        assert child_rows[0].deleted_by_parent_id == task_id

    restore_resp = owner.post(f"/api/tasks/{task_id}/restore")
    assert restore_resp.status_code == 200, restore_resp.json()

    restored_tasks = owner.get("/api/tasks", params={"project_id": case_data.project_id})
    assert restored_tasks.status_code == 200, restored_tasks.json()
    assert len(restored_tasks.json()) == 1

    restored_subtasks = owner.get(f"/api/tasks/{task_id}/subtasks")
    assert restored_subtasks.status_code == 200, restored_subtasks.json()
    assert len(restored_subtasks.json()) == 1

    with SessionLocal() as db:
        task_row = db.get(Task, task_id)
        assert task_row is not None
        assert task_row.is_deleted is False
        assert task_row.delete_batch_id == ""
        child_rows = db.query(SubTask).filter_by(task_id=task_id).all()
        assert len(child_rows) == 1
        assert child_rows[0].is_deleted is False
        assert child_rows[0].delete_batch_id == ""
        assert child_rows[0].deleted_by_parent_id is None


def test_subtask_soft_delete_and_restore_shows_in_recycle_bin(case_data, client_pool):
    owner = client_pool(case_data.owner)

    task_resp = owner.post("/api/tasks", json=_task_payload(case_data))
    assert task_resp.status_code == 200, task_resp.json()
    task_id = task_resp.json()["id"]

    # F: owner 创建子任务
    sub = owner.post(
        f"/api/tasks/{task_id}/subtasks",
        json={"title": "独立回收的子任务", "assignee": case_data.member, "plan_time": "2026-06", "status": "进行中"},
    )
    assert sub.status_code == 200, sub.json()
    sub_id = sub.json()["id"]

    delete_resp = owner.delete(f"/api/subtasks/{sub_id}")
    assert delete_resp.status_code == 200, delete_resp.json()

    active_subtasks = owner.get(f"/api/tasks/{task_id}/subtasks")
    assert active_subtasks.status_code == 200, active_subtasks.json()
    assert active_subtasks.json() == []

    recycle_subtasks = owner.get(f"/api/tasks/{task_id}/subtasks", params={"deleted": "true"})
    assert recycle_subtasks.status_code == 200, recycle_subtasks.json()
    assert [item["id"] for item in recycle_subtasks.json()] == [sub_id]
    assert recycle_subtasks.json()[0]["is_deleted"] is True

    restore_resp = owner.post(f"/api/subtasks/{sub_id}/restore")
    assert restore_resp.status_code == 200, restore_resp.json()

    active_after_restore = owner.get(f"/api/tasks/{task_id}/subtasks")
    assert active_after_restore.status_code == 200, active_after_restore.json()
    assert [item["id"] for item in active_after_restore.json()] == [sub_id]

    recycle_after_restore = owner.get(f"/api/tasks/{task_id}/subtasks", params={"deleted": "true"})
    assert recycle_after_restore.status_code == 200, recycle_after_restore.json()
    assert recycle_after_restore.json() == []
