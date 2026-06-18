from __future__ import annotations

from datetime import datetime, timedelta

from fastapi.testclient import TestClient

from app.auth import hash_password
from app.database import SessionLocal
from app.main import app
from app.models import Account


def _account(username: str, status: str = "active", locked: bool = False) -> None:
    with SessionLocal() as db:
        row = db.query(Account).filter(Account.username == username).first()
        if row:
            db.delete(row)
            db.commit()
        db.add(
            Account(
                username=username,
                password_hash=hash_password("testpass123"),
                status=status,
                locked_until=datetime.utcnow() + timedelta(minutes=10) if locked else None,
            )
        )
        db.commit()


def test_login_returns_distinct_status_for_disabled_and_locked_accounts():
    _account("disabled_user", status="disabled")
    _account("locked_user", locked=True)

    with TestClient(app) as client:
        disabled = client.post(
            "/api/auth/login",
            json={"username": "disabled_user", "password": "testpass123"},
        )
        locked = client.post(
            "/api/auth/login",
            json={"username": "locked_user", "password": "testpass123"},
        )
        wrong = client.post(
            "/api/auth/login",
            json={"username": "locked_user", "password": "wrongpass"},
        )

    assert disabled.status_code == 403
    assert disabled.json()["detail"] == "账号已禁用，请联系管理员"
    assert locked.status_code == 423
    assert locked.json()["detail"] == "密码错误次数过多，请稍后再试"
    assert wrong.status_code == 423
