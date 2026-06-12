"""Health check regression test."""
from __future__ import annotations

import pathlib
import sys
import tempfile

sys.stdout.reconfigure(encoding="utf-8")

ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

TMP_DIR = tempfile.TemporaryDirectory()


def assert_true(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def main() -> None:
    from fastapi.testclient import TestClient

    from app.database import Base, engine
    from app.main import app
    from app.settings import get_settings

    Base.metadata.create_all(bind=engine)

    with TestClient(app) as client:
        resp = client.get("/api/health")
        assert_true(resp.status_code == 200, f"expected 200, got {resp.status_code}")
        payload = resp.json()
        assert_true(payload.get("status") == "ok", f"unexpected status: {payload!r}")
        assert_true(payload.get("database") == "ok", f"unexpected database: {payload!r}")
        assert_true(payload.get("app") == "bowei-ai-dashboard", f"unexpected app: {payload!r}")
        assert_true(payload.get("env") == get_settings().app_env, f"unexpected env: {payload!r}")
        payload_text = resp.text.lower()
        for needle in ["api_key", "password", "token", "secret", "cookie"]:
            assert_true(needle not in payload_text, f"health payload exposed {needle!r}: {payload_text}")

    print("test_health.py passed")


if __name__ == "__main__":
    try:
        main()
    finally:
        from app.database import engine

        engine.dispose()
        TMP_DIR.cleanup()
