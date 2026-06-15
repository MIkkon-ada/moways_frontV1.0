"""
Shared pytest configuration.

Bootstraps an isolated SQLite DB and passwords file before any test module is
imported, so all in-process tests share a clean, reproducible environment.

test_auth_sessions.py / test_health.py etc. are standalone scripts (main() only)
and are not collected by pytest — they don't interfere with these fixtures.
"""
from __future__ import annotations

import os
import sys
import pathlib
import tempfile

import pytest

sys.stdout.reconfigure(encoding="utf-8")

ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ── Temp directory for this pytest session ─────────────────────────────────
_TMP = tempfile.mkdtemp(prefix="bowei_pytest_")
_DB  = pathlib.Path(_TMP) / "pytest.db"
_PW  = pathlib.Path(_TMP) / "passwords.json"

# Set DATABASE_URL BEFORE app.database is first imported.
# conftest.py is always loaded before any test module, so this is safe.
os.environ.setdefault("DATABASE_URL", f"sqlite:///{_DB}")
os.environ["ALLOW_FILE_SECRET_FALLBACK"] = "true"

# Patch passwords-file pointers in both the settings module and the setup router
import app.settings as _settings
import app.routers.setup as _setup_router
_settings._PASSWORDS_FILE = _PW
_setup_router._PASSWORDS_FILE = _PW

# Force engine creation now (locks in the DATABASE_URL above)
from app.database import Base, engine as _engine
Base.metadata.create_all(bind=_engine)


# ── Session-scoped fixtures ─────────────────────────────────────────────────

@pytest.fixture(scope="session")
def passwords_file() -> pathlib.Path:
    return _PW


@pytest.fixture(scope="session")
def app_client():
    """Unauthenticated TestClient, shared for the whole session."""
    from fastapi.testclient import TestClient
    from app.main import app
    with TestClient(app) as client:
        yield client


@pytest.fixture(scope="session")
def admin_client(app_client):
    """
    Authenticated TestClient logged in as super admin.
    Runs /api/setup/init if the DB is still uninitialized.
    """
    from fastapi.testclient import TestClient
    from app.main import app

    resp = app_client.get("/api/setup/status")
    if not resp.json().get("initialized"):
        init = app_client.post("/api/setup/init", json={
            "username": "testadmin",
            "password": "testpass123",
        })
        assert init.status_code == 200, f"Setup init failed: {init.json()}"

    with TestClient(app) as client:
        login = client.post("/api/auth/login", json={
            "username": "testadmin",
            "password": "testpass123",
        })
        assert login.status_code == 200, f"Admin login failed: {login.json()}"
        yield client
