"""Secret configuration regression test."""
from __future__ import annotations

import json
import os
import pathlib
import sys
import tempfile

sys.stdout.reconfigure(encoding="utf-8")

ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def assert_true(cond: bool, msg: str) -> None:
    if not cond:
        raise AssertionError(msg)


def snapshot_env(names: list[str]) -> dict[str, str | None]:
    return {name: os.environ.get(name) for name in names}


def restore_env(snapshot: dict[str, str | None]) -> None:
    for key, value in snapshot.items():
        if value is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = value


def main() -> None:
    from app.auth import hash_password, verify_password
    import app.settings as settings
    import app.llm_config as llm_config

    env_keys = [
        "APP_ENV",
        "ALLOW_FILE_SECRET_FALLBACK",
        "BOWEI_AUTH_USERS_JSON",
        "BOWEI_ADMIN_USERNAME",
        "BOWEI_ADMIN_PASSWORD_HASH",
        "LLM_API_KEY",
        "LLM_BASE_URL",
        "LLM_MODEL",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_MODEL",
    ]
    snapshot = snapshot_env(env_keys)
    original_llm_file = settings._LLM_CONFIG_FILE  # type: ignore[attr-defined]
    try:
        # Auth: env JSON should override file fallback.
        restore_env(snapshot)
        os.environ["BOWEI_AUTH_USERS_JSON"] = json.dumps({"env_user": hash_password("env-pass")}, ensure_ascii=False)
        assert_true(verify_password("env_user", "env-pass"), "env auth user should verify")

        # Auth: production without env secret should not silently use file fallback when disabled.
        restore_env(snapshot)
        os.environ["APP_ENV"] = "production"
        os.environ["ALLOW_FILE_SECRET_FALLBACK"] = "false"
        assert_true(not verify_password("mowasyadmin", "admin123"), "production without env secret should not fall back to file")

        # LLM: env vars should override file config.
        restore_env(snapshot)
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = pathlib.Path(tmp) / "llm_configs.json"
            tmp_path.write_text(
                json.dumps(
                    {
                        "anthropic": {
                            "api_key": "file-key",
                            "base_url": "file-base",
                            "model": "file-model",
                            "enabled": True,
                        }
                    },
                    ensure_ascii=False,
                    indent=2,
                ),
                encoding="utf-8",
            )
            settings._LLM_CONFIG_FILE = tmp_path  # type: ignore[attr-defined]
            os.environ["APP_ENV"] = "development"
            os.environ["LLM_API_KEY"] = "env-key"
            os.environ["LLM_BASE_URL"] = "env-base"
            os.environ["LLM_MODEL"] = "env-model"
            cfg = llm_config.get_provider_config("anthropic")
            assert_true(cfg["api_key"] == "env-key", "LLM env api_key should win")
            assert_true(cfg["base_url"] == "env-base", "LLM env base_url should win")
            assert_true(cfg["model"] == "env-model", "LLM env model should win")
            assert_true(cfg["api_key"] != "file-key", "LLM api_key should not expose file secret")

        print("test_secret_settings.py passed")
    finally:
        settings._LLM_CONFIG_FILE = original_llm_file  # type: ignore[attr-defined]
        restore_env(snapshot)


if __name__ == "__main__":
    main()
