"""
系统初始化流程测试 (in-process, no server required)

覆盖：
  - /api/setup/status — 未初始化 / 已初始化两种状态
  - /api/setup/init  — 参数校验（短密码、空账号）、成功路径、重复初始化保护
  - 初始化后可用新账号登录；错误密码 / 未知用户被拒
  - 受保护接口无 session → 401；setup 接口无需 session

运行：
  python -m pytest tests/test_setup_flow.py -v
"""
from __future__ import annotations

import json
import pathlib
import pytest


# ── 公开接口 ──────────────────────────────────────────────────────────────────

def test_setup_status_is_public(app_client):
    """/api/setup/status 无需登录即可访问。"""
    resp = app_client.get("/api/setup/status")
    assert resp.status_code == 200
    assert "initialized" in resp.json()


def test_health_is_public(app_client):
    """/api/health 无需登录即可访问。"""
    resp = app_client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json().get("status") == "ok"


def test_protected_endpoint_without_auth_returns_401():
    """/api/projects 未登录访问 → 401。"""
    from fastapi.testclient import TestClient
    from app.main import app
    fresh = TestClient(app)
    resp = fresh.get("/api/projects")
    assert resp.status_code == 401


# ── 初始化之前的状态 ──────────────────────────────────────────────────────────

def test_status_reports_uninitialized(app_client):
    """全新空库 → initialized=false。"""
    resp = app_client.get("/api/setup/status")
    assert resp.json()["initialized"] is False


# ── 参数校验 ──────────────────────────────────────────────────────────────────

def test_init_rejects_password_too_short(app_client):
    """密码少于 6 位 → 422。"""
    resp = app_client.post("/api/setup/init", json={"username": "admin", "password": "abc"})
    assert resp.status_code == 422


def test_init_rejects_blank_username(app_client):
    """纯空格账号名 → 422。"""
    resp = app_client.post("/api/setup/init", json={"username": "   ", "password": "pass1234"})
    assert resp.status_code == 422


def test_init_rejects_empty_password(app_client):
    """空密码 → 422。"""
    resp = app_client.post("/api/setup/init", json={"username": "admin", "password": ""})
    assert resp.status_code == 422


# ── 成功初始化 ────────────────────────────────────────────────────────────────

def test_init_success(app_client, passwords_file: pathlib.Path):
    """合法参数 → 200，passwords.json 写入新账号哈希。"""
    resp = app_client.post("/api/setup/init", json={
        "username": "testadmin",
        "password": "testpass123",
    })
    assert resp.status_code == 200, resp.json()
    assert resp.json()["ok"] is True

    assert passwords_file.exists(), "passwords.json 未创建"
    pw = json.loads(passwords_file.read_text(encoding="utf-8"))
    assert "testadmin" in pw, f"testadmin 未写入 passwords.json，实际内容：{list(pw.keys())}"
    # 旧账号全被清除（init 应覆盖写入，不追加）
    assert len(pw) == 1, f"passwords.json 应只含一个账号，实际：{list(pw.keys())}"


def test_status_reports_initialized_after_init(app_client):
    """初始化完成后 → initialized=true。"""
    resp = app_client.get("/api/setup/status")
    assert resp.json()["initialized"] is True


# ── 重复初始化保护 ─────────────────────────────────────────────────────────────

def test_init_blocked_when_already_initialized(app_client):
    """重复 POST /api/setup/init → 400。"""
    resp = app_client.post("/api/setup/init", json={
        "username": "otheradmin",
        "password": "otherpass123",
    })
    assert resp.status_code == 400
    assert "已初始化" in resp.json().get("detail", "")


# ── 登录行为 ──────────────────────────────────────────────────────────────────

def test_login_with_created_credentials(app_client):
    """初始化创建的账号可以正常登录。"""
    resp = app_client.post("/api/auth/login", json={
        "username": "testadmin",
        "password": "testpass123",
    })
    assert resp.status_code == 200
    assert resp.json().get("ok") is True
    assert resp.json().get("username") == "testadmin"


def test_login_wrong_password_rejected(app_client):
    """正确账号 + 错误密码 → 401。"""
    resp = app_client.post("/api/auth/login", json={
        "username": "testadmin",
        "password": "wrongpassword",
    })
    assert resp.status_code == 401


def test_login_unknown_user_rejected(app_client):
    """不存在的账号 → 401。"""
    resp = app_client.post("/api/auth/login", json={
        "username": "nobody",
        "password": "anypassword",
    })
    assert resp.status_code == 401


def test_login_empty_fields_rejected(app_client):
    """账号或密码为空 → 400。"""
    resp = app_client.post("/api/auth/login", json={"username": "", "password": ""})
    assert resp.status_code == 400


# ── 登出 ──────────────────────────────────────────────────────────────────────

def test_logout_invalidates_session(app_client):
    """登出后旧 session 访问受保护接口 → 401。"""
    from fastapi.testclient import TestClient
    from app.main import app

    with TestClient(app) as c:
        # 登录
        login = c.post("/api/auth/login", json={
            "username": "testadmin",
            "password": "testpass123",
        })
        assert login.status_code == 200

        # 登录后可访问
        me = c.get("/api/auth/me")
        assert me.status_code == 200

        # 登出
        out = c.post("/api/auth/logout")
        assert out.status_code == 200

        # 登出后不可访问
        me_after = c.get("/api/auth/me")
        assert me_after.status_code == 401
