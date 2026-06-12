"""Logging settings regression test."""
from __future__ import annotations

import os
import pathlib
import sys

sys.stdout.reconfigure(encoding="utf-8")

ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def assert_true(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def snapshot_env() -> dict[str, str | None]:
    keys = ["APP_ENV", "LOG_LEVEL"]
    return {key: os.environ.get(key) for key in keys}


def restore_env(snapshot: dict[str, str | None]) -> None:
    for key, value in snapshot.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


def main() -> None:
    from app.settings import get_settings

    snapshot = snapshot_env()
    try:
        restore_env(snapshot)
        os.environ.pop("APP_ENV", None)
        os.environ.pop("LOG_LEVEL", None)
        assert_true(get_settings().log_level == "INFO", "default log level should be INFO")

        restore_env(snapshot)
        os.environ["LOG_LEVEL"] = "DEBUG"
        assert_true(get_settings().log_level == "DEBUG", "LOG_LEVEL=DEBUG should take effect")

        restore_env(snapshot)
        os.environ["LOG_LEVEL"] = "not-a-level"
        assert_true(get_settings().log_level == "INFO", "invalid log level should fall back to INFO")

        restore_env(snapshot)
        os.environ["APP_ENV"] = "production"
        os.environ.pop("LOG_LEVEL", None)
        assert_true(get_settings().log_level == "INFO", "production default log level should be INFO")
    finally:
        restore_env(snapshot)

    print("test_logging_settings.py passed")


if __name__ == "__main__":
    main()
