"""Cookie configuration regression test."""
from __future__ import annotations

import os
import pathlib
import sys
import tempfile
import json

sys.stdout.reconfigure(encoding="utf-8")

ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

TMP_DIR = tempfile.TemporaryDirectory()
DB_PATH = pathlib.Path(TMP_DIR.name) / "cookie_settings_test.db"
os.environ["DATABASE_URL"] = f"sqlite:///{DB_PATH}"


def _snapshot_env(names: list[str]) -> dict[str, str | None]:
    return {name: os.environ.get(name) for name in names}


def _restore_env(snapshot: dict[str, str | None]) -> None:
    for key, value in snapshot.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


def assert_true(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def _prepare_env(**pairs: str | None) -> dict[str, str | None]:
    keys = ["APP_ENV", "SESSION_COOKIE_SECURE", "SESSION_COOKIE_SAMESITE", "SESSION_TTL_DAYS", "SESSION_COOKIE_NAME"]
    snapshot = _snapshot_env(keys)
    for key in keys:
        os.environ.pop(key, None)
    for key, value in pairs.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value
    return snapshot


def _check_settings(expected_env: str, expected_secure: bool, expected_samesite: str, expected_ttl: int, expected_name: str = "bowei_session") -> None:
    from app.settings import get_settings

    settings = get_settings()
    assert_true(settings.app_env == expected_env, f"unexpected app_env: {settings.app_env!r}")
    assert_true(settings.session_cookie_secure is expected_secure, f"unexpected secure: {settings.session_cookie_secure!r}")
    assert_true(settings.session_cookie_samesite == expected_samesite, f"unexpected samesite: {settings.session_cookie_samesite!r}")
    assert_true(settings.session_ttl_days == expected_ttl, f"unexpected ttl days: {settings.session_ttl_days!r}")
    assert_true(settings.session_cookie_name == expected_name, f"unexpected cookie name: {settings.session_cookie_name!r}")


def _check_login_cookie(expected_secure: bool, expected_samesite: str, expected_name: str = "bowei_session") -> None:
    from fastapi.testclient import TestClient
    from app.auth import hash_password
    from app.database import Base, engine
    from app.main import app
    from app.models import AuthSession  # noqa: F401 - registers model with Base

    auth_snapshot = {
        "BOWEI_AUTH_USERS_JSON": os.environ.get("BOWEI_AUTH_USERS_JSON"),
        "BOWEI_ADMIN_USERNAME": os.environ.get("BOWEI_ADMIN_USERNAME"),
        "BOWEI_ADMIN_PASSWORD_HASH": os.environ.get("BOWEI_ADMIN_PASSWORD_HASH"),
    }
    os.environ["BOWEI_AUTH_USERS_JSON"] = json.dumps({"mowasyadmin": hash_password("admin123")}, ensure_ascii=False)
    os.environ.pop("BOWEI_ADMIN_USERNAME", None)
    os.environ.pop("BOWEI_ADMIN_PASSWORD_HASH", None)

    Base.metadata.create_all(bind=engine)
    try:
        with TestClient(app) as client:
            resp = client.post(
                "/api/auth/login",
                json={"username": "mowasyadmin", "password": "admin123"},
            )
            assert_true(resp.status_code == 200, f"login failed: {resp.status_code}")
            set_cookie = resp.headers.get("set-cookie", "")
            lowered = set_cookie.lower()
            assert_true(expected_name in set_cookie, f"cookie name missing from Set-Cookie: {set_cookie!r}")
            assert_true("httponly" in lowered, f"HttpOnly missing from Set-Cookie: {set_cookie!r}")
            assert_true(f"samesite={expected_samesite}".lower() in lowered, f"SameSite missing from Set-Cookie: {set_cookie!r}")
            assert_true(("secure" in lowered) is expected_secure, f"unexpected Secure flag in Set-Cookie: {set_cookie!r}")
            client.post("/api/auth/logout")
    finally:
        for key, value in auth_snapshot.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def main() -> None:
    from app.settings import parse_bool

    assert_true(parse_bool(None) is False, "parse_bool(None) default failed")
    assert_true(parse_bool("true") is True, "parse_bool(true) failed")
    assert_true(parse_bool("0") is False, "parse_bool(0) failed")
    assert_true(parse_bool("maybe", default=True) is True, "parse_bool fallback failed")

    snapshot = _prepare_env()
    try:
        _check_settings("development", False, "lax", 7)
        _check_login_cookie(False, "lax")

        _restore_env(snapshot)
        snapshot = _prepare_env(APP_ENV="production")
        _check_settings("production", True, "lax", 7)
        _check_login_cookie(True, "lax")

        _restore_env(snapshot)
        snapshot = _prepare_env(APP_ENV="production", SESSION_COOKIE_SECURE="false", SESSION_COOKIE_SAMESITE="strict", SESSION_TTL_DAYS="14")
        _check_settings("production", False, "strict", 14)
        _check_login_cookie(False, "strict")

        _restore_env(snapshot)
        snapshot = _prepare_env(SESSION_TTL_DAYS="abc")
        _check_settings("development", False, "lax", 7)

        _restore_env(snapshot)
        snapshot = _prepare_env(SESSION_COOKIE_NAME="bowei_session_v2")
        _check_settings("development", False, "lax", 7, expected_name="bowei_session_v2")
    finally:
        _restore_env(snapshot)

    print("test_cookie_settings.py passed")


if __name__ == "__main__":
    try:
        main()
    finally:
        from app.database import engine

        engine.dispose()
        TMP_DIR.cleanup()
