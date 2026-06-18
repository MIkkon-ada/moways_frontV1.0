from app import models
from app.auth import hash_password
from app.database import SessionLocal
from app.main import app
from fastapi.testclient import TestClient


def test_admin_can_create_account_and_user_can_login(admin_client):
    with SessionLocal() as db:
        person = models.Person(name="account_user_a", system_role="普通成员", is_active=True)
        db.add(person)
        db.commit()
        db.refresh(person)
        person_id = person.id

    created = admin_client.post("/api/accounts", json={
        "username": "account_user_a",
        "password": "secret123",
        "person_id": person_id,
    })
    assert created.status_code == 200, created.json()
    assert created.json()["username"] == "account_user_a"
    assert created.json()["person_id"] == person_id
    assert "password_hash" not in created.json()

    login = TestClient(app).post("/api/auth/login", json={
        "username": "account_user_a",
        "password": "secret123",
    })
    assert login.status_code == 200, login.json()


def test_disabled_account_cannot_login(admin_client):
    with SessionLocal() as db:
        person = models.Person(name="account_user_b", system_role="普通成员", is_active=True)
        db.add(person)
        db.commit()
        db.refresh(person)
        person_id = person.id

    created = admin_client.post("/api/accounts", json={
        "username": "account_user_b",
        "password": "secret123",
        "person_id": person_id,
    })
    account_id = created.json()["id"]

    disabled = admin_client.patch(f"/api/accounts/{account_id}/status", json={"status": "disabled"})
    assert disabled.status_code == 200, disabled.json()
    assert disabled.json()["status"] == "disabled"

    assert created.status_code == 200, created.json()
    login = TestClient(app).post("/api/auth/login", json={
        "username": "account_user_b",
        "password": "secret123",
    })
    assert login.status_code == 403
    assert login.json()["detail"] == "账号已禁用，请联系管理员"


def test_reset_password_reactivates_account(admin_client):
    with SessionLocal() as db:
        person = models.Person(name="account_user_c", system_role="普通成员", is_active=True)
        db.add(person)
        db.commit()
        db.refresh(person)
        person_id = person.id

    created = admin_client.post("/api/accounts", json={
        "username": "account_user_c",
        "password": "secret123",
        "person_id": person_id,
    })
    account_id = created.json()["id"]

    admin_client.patch(f"/api/accounts/{account_id}/status", json={"status": "disabled"})
    reset = admin_client.post(f"/api/accounts/{account_id}/reset-password", json={"password": "newpass123"})
    assert reset.status_code == 200, reset.json()

    assert created.status_code == 200, created.json()
    login = TestClient(app).post("/api/auth/login", json={
        "username": "account_user_c",
        "password": "newpass123",
    })
    assert login.status_code == 200, login.json()


def test_account_username_can_differ_from_person_name(admin_client):
    with SessionLocal() as db:
        person = models.Person(name="真实姓名D", system_role="普通成员", is_active=True)
        db.add(person)
        db.commit()
        db.refresh(person)
        person_id = person.id

    created = admin_client.post("/api/accounts", json={
        "username": "login_alias_d",
        "password": "secret123",
        "person_id": person_id,
    })
    assert created.status_code == 200, created.json()

    with TestClient(app) as client:
        login = client.post("/api/auth/login", json={
            "username": "login_alias_d",
            "password": "secret123",
        })
        assert login.status_code == 200, login.json()
        me = client.get("/api/people/me")
        assert me.status_code == 200, me.json()
        assert me.json()["username"] == "login_alias_d"
        assert me.json()["name"] == "真实姓名D"
        assert me.json()["person_id"] == person_id


def test_legacy_password_login_can_be_disabled(monkeypatch, passwords_file):
    monkeypatch.setenv("ALLOW_FILE_SECRET_FALLBACK", "true")
    monkeypatch.setenv("ALLOW_LEGACY_PASSWORD_LOGIN", "false")
    passwords_file.write_text(
        '{"legacy_disabled_user": "%s"}' % hash_password("secret123"),
        encoding="utf-8",
    )

    login = TestClient(app).post("/api/auth/login", json={
        "username": "legacy_disabled_user",
        "password": "secret123",
    })
    assert login.status_code == 401


def test_admin_can_audit_legacy_password_accounts(admin_client, passwords_file):
    passwords_file.write_text(
        '{"legacy_only_user": "%s", "testadmin": "%s"}'
        % (hash_password("legacy123"), hash_password("123456")),
        encoding="utf-8",
    )

    resp = admin_client.get("/api/accounts/legacy-audit")
    assert resp.status_code == 200, resp.json()
    body = resp.json()
    assert "legacy_password_login_enabled" in body
    rows = {item["username"]: item for item in body["legacy_accounts"]}
    assert rows["legacy_only_user"]["has_account"] is False
    assert rows["testadmin"]["has_account"] is True
