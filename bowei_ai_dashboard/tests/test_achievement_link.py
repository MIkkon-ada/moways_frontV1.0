"""
Tests for PUT /api/achievements/{id} — related_task_id linkage.

Verifies:
1. Saving a valid related_task_id updates the field in the response.
2. Setting related_task_id to null clears the association.
"""
from __future__ import annotations

import time


def _unique_name(prefix: str) -> str:
    return f"{prefix}_{time.time_ns()}"


def test_put_saves_and_clears_related_task_id(admin_client):
    proj_name = _unique_name("ACH_LINK_TEST")

    # ── Create project ────────────────────────────────────────────
    proj_resp = admin_client.post("/api/projects", json={
        "name": proj_name,
        "code": "",
        "description": "",
        "status": "active",
        "start_date": "",
        "end_date": "",
    })
    assert proj_resp.status_code == 200, proj_resp.json()
    proj_id = proj_resp.json()["id"]

    # ── Create task ───────────────────────────────────────────────
    task_resp = admin_client.post("/api/tasks", json={
        "project_id": proj_id,
        "special_project": proj_name,
        "key_task": "测试关键任务_关联成果",
        "key_achievement": "",
        "completion_standard": "",
        "coordinator": "",
        "owner": "",
        "collaborators": "",
        "plan_time": "",
        "status": "进行中",
    })
    assert task_resp.status_code == 200, task_resp.json()
    task_id = task_resp.json()["id"]

    # ── Create achievement (no related_task_id) ───────────────────
    ach_payload = {
        "project_id": proj_id,
        "name": "测试成果_关联任务",
        "achievement_type": "方案",
        "special_project": proj_name,
        "owner": "",
        "version": "V0.1",
        "file_link": "",
        "scenario": "",
        "reuse_tag": "",
        "status": "草稿",
        "source_type": "人工录入",
    }
    ach_resp = admin_client.post("/api/achievements", json=ach_payload)
    assert ach_resp.status_code == 200, ach_resp.json()
    ach_id = ach_resp.json()["id"]
    assert ach_resp.json()["related_task_id"] is None

    # ── PUT to link task ──────────────────────────────────────────
    link_resp = admin_client.put(
        f"/api/achievements/{ach_id}",
        json={**ach_payload, "related_task_id": task_id},
    )
    assert link_resp.status_code == 200, link_resp.json()
    assert link_resp.json()["related_task_id"] == task_id

    # ── GET to confirm persisted ──────────────────────────────────
    get_resp = admin_client.get(f"/api/achievements/{ach_id}")
    assert get_resp.status_code == 200
    assert get_resp.json()["related_task_id"] == task_id

    # ── PUT to unlink (set null) ──────────────────────────────────
    unlink_resp = admin_client.put(
        f"/api/achievements/{ach_id}",
        json={**ach_payload, "related_task_id": None},
    )
    assert unlink_resp.status_code == 200, unlink_resp.json()
    assert unlink_resp.json()["related_task_id"] is None
