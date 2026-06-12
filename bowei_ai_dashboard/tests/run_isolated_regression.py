"""Run smoke and permission regression tests against an isolated SQLite DB.

This runner prevents the default `bowei_ai_dashboard.db` from being touched by:
1. creating a temporary SQLite database file,
2. starting the backend with DATABASE_URL pointing to that file,
3. running the existing write-heavy regression tests against the temporary backend,
4. deleting the temporary database after the run.

The existing `smoke_test.py` and `test_permissions.py` scripts are left intact.
"""
from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
import sqlite3
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FORMAL_DB = ROOT / "bowei_ai_dashboard.db"
SMOKE = ROOT / "tests" / "smoke_test.py"
PERMISSIONS = ROOT / "tests" / "test_permissions.py"
MIGRATE_SQLITE = ROOT / "migrate_sqlite_schema.py"
sys.path.insert(0, str(ROOT))
from app.permissions import ROLE_NORMAL

ISOLATED_COMPAT_COLUMNS: dict[str, list[tuple[str, str]]] = {
    "projects": [
        ("code", "ALTER TABLE projects ADD COLUMN code VARCHAR(50)"),
        ("coordinator", "ALTER TABLE projects ADD COLUMN coordinator TEXT DEFAULT ''"),
        ("owners", "ALTER TABLE projects ADD COLUMN owners TEXT DEFAULT ''"),
        ("collaborators", "ALTER TABLE projects ADD COLUMN collaborators TEXT DEFAULT ''"),
        ("start_date", "ALTER TABLE projects ADD COLUMN start_date VARCHAR(20)"),
        ("end_date", "ALTER TABLE projects ADD COLUMN end_date VARCHAR(20)"),
        ("is_active", "ALTER TABLE projects ADD COLUMN is_active BOOLEAN DEFAULT 1"),
    ],
    "tasks": [
        ("confirmed_at", "ALTER TABLE tasks ADD COLUMN confirmed_at DATETIME"),
    ],
    "achievements": [
        ("confirmed_at", "ALTER TABLE achievements ADD COLUMN confirmed_at DATETIME"),
    ],
    "update_submissions": [
        ("coordinator_note", "ALTER TABLE update_submissions ADD COLUMN coordinator_note TEXT DEFAULT ''"),
        ("ceo_note", "ALTER TABLE update_submissions ADD COLUMN ceo_note TEXT DEFAULT ''"),
    ],
}


@dataclass(frozen=True)
class StepResult:
    name: str
    returncode: int
    stdout: str
    stderr: str


def _pick_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _wait_for_health(base_url: str, timeout_s: int = 180) -> tuple[int, str]:
    deadline = time.time() + timeout_s
    last_err = ""
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(base_url + "/api/health", timeout=2) as resp:
                body = resp.read().decode("utf-8", errors="replace")
                return resp.status, body
        except Exception as exc:  # pragma: no cover - best-effort probe
            last_err = str(exc)
            time.sleep(0.5)
    raise RuntimeError(f"backend did not become healthy: {last_err}")


def _run_step(name: str, args: list[str], env: dict[str, str]) -> StepResult:
    proc = subprocess.run(
        args,
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
    )
    return StepResult(name=name, returncode=proc.returncode, stdout=proc.stdout, stderr=proc.stderr)


def _table_columns(db_path: Path, table_name: str) -> set[str]:
    with sqlite3.connect(db_path) as conn:
        rows = conn.execute(f"PRAGMA table_info({table_name})").fetchall()
    return {row[1] for row in rows}


def _ensure_isolated_columns(db_path: Path) -> None:
    with sqlite3.connect(db_path) as conn:
        for table_name, columns in ISOLATED_COMPAT_COLUMNS.items():
            if not _table_columns(db_path, table_name):
                continue
            current = _table_columns(db_path, table_name)
            for column_name, alter_sql in columns:
                if column_name in current:
                    continue
                conn.execute(alter_sql)
        conn.commit()


def _extract_labeled_name(path: Path, label: str) -> str:
    import re

    text = path.read_text(encoding="utf-8", errors="replace")
    match = re.search(rf'"{re.escape(label)}"\s*:\s*\{{\s*"name"\s*:\s*"([^"]+)"', text)
    if not match:
        raise RuntimeError(f"unable to locate {label!r} name in {path}")
    return match.group(1)


def _sync_isolated_people_names(db_path: Path) -> None:
    name_map = {
        7: _extract_labeled_name(SMOKE, "owner"),
        8: _extract_labeled_name(SMOKE, "member"),
        9: _extract_labeled_name(SMOKE, "coordinator"),
        10: _extract_labeled_name(SMOKE, "project_ceo"),
        5: _extract_labeled_name(PERMISSIONS, "process_guard"),
        4: _extract_labeled_name(PERMISSIONS, "non_member"),
    }
    with sqlite3.connect(db_path) as conn:
        current = {row[0]: row[1] for row in conn.execute("SELECT id, name FROM people")}
        for person_id in current:
            conn.execute(
                "UPDATE people SET name = ? WHERE id = ?",
                (f"__isolated_people_{person_id}__", person_id),
            )
        conn.commit()
        for person_id, name in name_map.items():
            if person_id in current:
                conn.execute(
                    "UPDATE people SET name = ? WHERE id = ?",
                    (name, person_id),
                )
                conn.execute(
                    "UPDATE people SET system_role = ?, is_admin = 0 WHERE id = ?",
                    (ROLE_NORMAL, person_id),
                )
        conn.commit()


def _print_step(step: StepResult) -> None:
    print(f"\n[{step.name}] returncode={step.returncode}")
    if step.stdout:
        print("--- stdout ---")
        print(step.stdout.rstrip())
    if step.stderr:
        print("--- stderr ---")
        print(step.stderr.rstrip())


def _print_log_tail(path: Path, lines: int = 80) -> None:
    if not path.exists():
        print(f"[isolated] log missing: {path}")
        return
    content = path.read_text(encoding="utf-8", errors="replace").splitlines()
    tail = content[-lines:]
    print(f"[isolated] log tail ({len(tail)} lines) from {path}:")
    for line in tail:
        print(line.encode("unicode_escape").decode("ascii"))


def main() -> int:
    if not FORMAL_DB.exists():
        print(f"[ERROR] formal database not found: {FORMAL_DB}")
        return 2

    formal_mtime_before = FORMAL_DB.stat().st_mtime
    port = _pick_free_port()
    exit_code = 0

    with tempfile.TemporaryDirectory(prefix="bowei-isolated-db-", ignore_cleanup_errors=True) as tmp_dir:
        tmp_dir_path = Path(tmp_dir)
        isolated_db = tmp_dir_path / "isolated.db"
        backend_log = tmp_dir_path / "backend.log"

        migrate_result = subprocess.run(
            [
                sys.executable,
                str(MIGRATE_SQLITE),
                "--db",
                str(isolated_db),
            ],
            cwd=ROOT,
            env=os.environ.copy(),
            text=True,
            capture_output=True,
        )
        print(f"[isolated] migrate_sqlite_schema.py returncode={migrate_result.returncode}")
        if migrate_result.stdout:
            print(migrate_result.stdout.rstrip())
        if migrate_result.stderr:
            print(migrate_result.stderr.rstrip())
        if migrate_result.returncode != 0:
            return 1

        _ensure_isolated_columns(isolated_db)
        _sync_isolated_people_names(isolated_db)

        env = os.environ.copy()
        env["DATABASE_URL"] = f"sqlite:///{isolated_db.as_posix()}"
        # Keep startup seed logic disabled so the isolated DB stays under runner control.
        env.pop("BOWEI_DEV_MODE", None)
        env.setdefault("PYTHONUNBUFFERED", "1")

        print(f"[isolated] formal db   : {FORMAL_DB}")
        print(f"[isolated] formal mtime: {formal_mtime_before}")
        print(f"[isolated] temp db     : {isolated_db}")
        print(f"[isolated] base url    : http://127.0.0.1:{port}")

        with backend_log.open("w", encoding="utf-8") as log_fh:
            backend = subprocess.Popen(
                [
                    sys.executable,
                    "-m",
                    "uvicorn",
                    "app.main:app",
                    "--host",
                    "127.0.0.1",
                    "--port",
                    str(port),
                    "--workers",
                    "1",
                ],
                cwd=ROOT,
                env=env,
                stdout=log_fh,
                stderr=subprocess.STDOUT,
                text=True,
            )

            try:
                try:
                    status, body = _wait_for_health(f"http://127.0.0.1:{port}")
                except Exception as exc:
                    print(f"[isolated] health probe failed: {exc}")
                    exit_code = 1
                    _print_log_tail(backend_log)
                    return exit_code
                print(f"[isolated] health probe -> {status}")
                print(body)

                test_env = env.copy()
                test_env["BASE_URL"] = f"http://127.0.0.1:{port}"
                test_env["ADMIN_USERNAME"] = test_env.get("ADMIN_USERNAME", "mowasyadmin")
                test_env["ADMIN_PASSWORD"] = test_env.get("ADMIN_PASSWORD", "admin123")

                smoke = _run_step(
                    "smoke_test",
                    [sys.executable, str(SMOKE)],
                    test_env,
                )
                _print_step(smoke)

                permissions = _run_step(
                    "test_permissions",
                    [sys.executable, str(PERMISSIONS)],
                    test_env,
                )
                _print_step(permissions)

                ok = smoke.returncode == 0 and permissions.returncode == 0
                if ok:
                    print("\n[isolated] smoke / permission regression tests passed against isolated DB")
                else:
                    print("\n[isolated] smoke / permission regression tests failed")
                    _print_log_tail(backend_log)
                    exit_code = 1
            finally:
                backend.terminate()
                try:
                    backend.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    backend.kill()
                    backend.wait(timeout=10)

                print(f"[isolated] backend log: {backend_log}")
                print(f"[isolated] isolated db existed during run: {isolated_db.exists()}")

    formal_mtime_after = FORMAL_DB.stat().st_mtime
    print(f"[formal] mtime before: {formal_mtime_before}")
    print(f"[formal] mtime after : {formal_mtime_after}")
    print(f"[formal] unchanged   : {formal_mtime_before == formal_mtime_after}")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
