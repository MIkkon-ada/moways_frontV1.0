"""Session storage regression test.

This test verifies that authentication sessions are persisted in the database
instead of process memory, so login state survives multiple worker processes.
"""
import os
import pathlib
import tempfile
from datetime import datetime, timedelta

import sys

sys.stdout.reconfigure(encoding="utf-8")

ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

TMP_DIR = tempfile.TemporaryDirectory()
DB_PATH = pathlib.Path(TMP_DIR.name) / "auth_session_test.db"
os.environ["DATABASE_URL"] = f"sqlite:///{DB_PATH}"

from fastapi.testclient import TestClient

from app.auth import create_session, get_session_user, _now
from app.database import Base, SessionLocal, engine
from app.main import app
from app.models import AuthSession  # noqa: F401 - registers model with Base
from app.settings import get_settings


def assert_true(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def main() -> None:
    Base.metadata.create_all(bind=engine)
    cookie_name = get_settings().session_cookie_name

    with TestClient(app) as client:
        login_resp = client.post(
            "/api/auth/login",
            json={"username": "mowasyadmin", "password": "admin123"},
        )
        assert_true(login_resp.status_code == 200, f"login failed: {login_resp.status_code}")

        session_id = client.cookies.get(cookie_name)
        assert_true(bool(session_id), f"login did not set {cookie_name} cookie")

        with SessionLocal() as db:
            row = db.get(AuthSession, session_id)
            assert_true(row is not None, "session row not persisted in DB")
            assert_true(row.username == "mowasyadmin", f"unexpected username: {row.username!r}")

        for idx in range(3):
            me_resp = client.get("/api/auth/me")
            assert_true(me_resp.status_code == 200, f"/api/auth/me failed on attempt {idx + 1}")
            assert_true(me_resp.json().get("username") == "mowasyadmin", "unexpected /api/auth/me payload")

        logout_resp = client.post("/api/auth/logout")
        assert_true(logout_resp.status_code == 200, f"logout failed: {logout_resp.status_code}")

        me_after_logout = client.get("/api/auth/me")
        assert_true(me_after_logout.status_code == 401, "logout did not invalidate session")

        with SessionLocal() as db:
            assert_true(db.get(AuthSession, session_id) is None, "logout did not remove DB session row")

    # Expired session should be rejected even if the row exists.
    expired_sid = create_session("mowasyadmin")
    with SessionLocal() as db:
        row = db.get(AuthSession, expired_sid)
        assert_true(row is not None, "expired-session setup failed")
        row.expires_at = _now() - timedelta(seconds=1)
        row.last_seen_at = row.expires_at
        db.commit()

    assert_true(get_session_user(expired_sid) is None, "expired session should be invalid")

    with SessionLocal() as db:
        assert_true(db.get(AuthSession, expired_sid) is None, "expired session row should be cleaned up")

    print("test_auth_sessions.py passed")


if __name__ == "__main__":
    try:
        main()
    finally:
        from app.database import engine

        engine.dispose()
        TMP_DIR.cleanup()
