"""
项目成员角色切换测试 (in-process, no server required)

覆盖：
  - PATCH /api/projects/{pid}/members/{mid} — 超级管理员可切换角色
  - 切换后 GET 返回新角色（持久化验证）
  - 角色可切换至 owner / coordinator / member / project_ceo
  - 最后一个 owner 无法被降级 → 409
  - 最后一个 owner 无法被删除 → 409
  - 第二个 owner 存在时可正常删除第一个 owner → 200
  - 无 session 的请求 → 401

运行：
  python -m pytest tests/test_member_role.py -v
"""
from __future__ import annotations

from datetime import datetime
import pytest

_TS = datetime.now().strftime("%Y%m%d%H%M%S")


# ── 测试夹具 ──────────────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def project_id(admin_client):
    """创建一个测试专用项目，模块结束后归档。"""
    resp = admin_client.post("/api/projects", json={
        "name": f"TEST_角色切换_{_TS}",
        "status": "active",
    })
    assert resp.status_code == 200, f"创建项目失败: {resp.json()}"
    pid = resp.json()["id"]
    yield pid
    admin_client.post(f"/api/projects/{pid}/archive", json={})


@pytest.fixture(scope="module")
def person_a_id(admin_client):
    """在 people 表中创建测试人员 A（作为项目成员使用）。"""
    from app.database import SessionLocal
    from app import models
    with SessionLocal() as db:
        p = models.Person(name=f"测试成员A_{_TS}", is_active=True)
        db.add(p)
        db.commit()
        db.refresh(p)
        return p.id


@pytest.fixture(scope="module")
def person_b_id(admin_client):
    """在 people 表中创建测试人员 B（用于第二 owner 场景）。"""
    from app.database import SessionLocal
    from app import models
    with SessionLocal() as db:
        p = models.Person(name=f"测试成员B_{_TS}", is_active=True)
        db.add(p)
        db.commit()
        db.refresh(p)
        return p.id


@pytest.fixture(scope="module")
def member_a(admin_client, project_id, person_a_id):
    """将 A 以 member 身份加入项目，返回成员条目 id。"""
    resp = admin_client.post(f"/api/projects/{project_id}/members", json={
        "person_id": person_a_id,
        "role": "member",
    })
    assert resp.status_code == 200, f"添加成员失败: {resp.json()}"
    return resp.json()["id"]


# ── 无鉴权访问 ────────────────────────────────────────────────────────────────

def test_patch_member_without_auth_returns_401(project_id, member_a):
    """未携带 session 的 PATCH → 401。"""
    from fastapi.testclient import TestClient
    from app.main import app
    fresh = TestClient(app)
    resp = fresh.patch(f"/api/projects/{project_id}/members/{member_a}", json={"role": "owner"})
    assert resp.status_code == 401


# ── 角色切换 ──────────────────────────────────────────────────────────────────

def test_change_role_to_coordinator(admin_client, project_id, member_a):
    """管理员可将 member → coordinator。"""
    resp = admin_client.patch(
        f"/api/projects/{project_id}/members/{member_a}",
        json={"role": "coordinator"},
    )
    assert resp.status_code == 200, resp.json()
    assert resp.json()["role"] == "coordinator"


def test_role_change_persists(admin_client, project_id, member_a):
    """PATCH 之后 GET 成员列表仍返回新角色（数据库持久化验证）。"""
    resp = admin_client.get(f"/api/projects/{project_id}/members")
    assert resp.status_code == 200
    entry = next((m for m in resp.json() if m["id"] == member_a), None)
    assert entry is not None, "成员条目不存在"
    assert entry["role"] == "coordinator"


def test_change_role_to_project_ceo(admin_client, project_id, member_a):
    """管理员可将角色切换为 project_ceo。"""
    resp = admin_client.patch(
        f"/api/projects/{project_id}/members/{member_a}",
        json={"role": "project_ceo"},
    )
    assert resp.status_code == 200
    assert resp.json()["role"] == "project_ceo"


def test_change_role_to_owner(admin_client, project_id, member_a):
    """管理员可将角色切换为 owner。"""
    resp = admin_client.patch(
        f"/api/projects/{project_id}/members/{member_a}",
        json={"role": "owner"},
    )
    assert resp.status_code == 200
    assert resp.json()["role"] == "owner"


# ── 最后一个 owner 保护 ───────────────────────────────────────────────────────

def test_cannot_demote_last_owner(admin_client, project_id, member_a):
    """唯一 owner 被降级 → 409。"""
    # 确认此时只有一个 owner
    members = admin_client.get(f"/api/projects/{project_id}/members").json()
    owners = [m for m in members if m["role"] == "owner"]
    if len(owners) != 1 or owners[0]["id"] != member_a:
        pytest.skip("需要恰好 1 个 owner 才能运行此用例")

    resp = admin_client.patch(
        f"/api/projects/{project_id}/members/{member_a}",
        json={"role": "member"},
    )
    assert resp.status_code == 409
    detail = resp.json().get("detail", {})
    assert detail.get("owner_count") == 1


def test_cannot_delete_last_owner(admin_client, project_id, member_a):
    """唯一 owner 被删除 → 409。"""
    resp = admin_client.delete(f"/api/projects/{project_id}/members/{member_a}")
    assert resp.status_code == 409


# ── 两个 owner 时可正常操作 ───────────────────────────────────────────────────

def test_can_delete_one_of_two_owners(admin_client, project_id, member_a, person_b_id):
    """存在两个 owner 时，删除其中一个 → 200。"""
    # 先添加第二个 owner
    add = admin_client.post(f"/api/projects/{project_id}/members", json={
        "person_id": person_b_id,
        "role": "owner",
    })
    assert add.status_code == 200, f"添加第二 owner 失败: {add.json()}"
    member_b_id = add.json()["id"]

    # 确认现在有 2 个 owner
    members = admin_client.get(f"/api/projects/{project_id}/members").json()
    owners = [m for m in members if m["role"] == "owner"]
    assert len(owners) == 2, f"期望 2 个 owner，实际：{len(owners)}"

    # 删除其中一个 → 200
    resp = admin_client.delete(f"/api/projects/{project_id}/members/{member_b_id}")
    assert resp.status_code == 200

    # 确认剩余 1 个 owner
    members_after = admin_client.get(f"/api/projects/{project_id}/members").json()
    remaining_owners = [m for m in members_after if m["role"] == "owner"]
    assert len(remaining_owners) == 1
    assert remaining_owners[0]["id"] == member_a
