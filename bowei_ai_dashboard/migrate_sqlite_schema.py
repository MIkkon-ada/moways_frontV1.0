from __future__ import annotations

import argparse
import re
import shutil
import sqlite3
from datetime import datetime
from pathlib import Path

from seed_permissions import seed_permissions as seed_formal_permissions


BASE_DIR = Path(__file__).resolve().parent
DEFAULT_DB = BASE_DIR / "bowei_ai_dashboard.db"
DEFAULT_SQL = BASE_DIR.parent / "mowayssql.sql"

CREATE_PATTERN = re.compile(r"(?is)(CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+.*?;)")
INDEX_PATTERN = re.compile(r"(?is)(CREATE\s+INDEX\s+IF\s+NOT\s+EXISTS\s+.*?;)")

MIGRATION_COLUMNS: dict[str, list[tuple[str, str]]] = {
    "people": [
        ("employee_code", "ALTER TABLE people ADD COLUMN employee_code VARCHAR(50)"),
        ("system_role", "ALTER TABLE people ADD COLUMN system_role VARCHAR(30) NOT NULL DEFAULT '普通成员'"),
        ("title", "ALTER TABLE people ADD COLUMN title VARCHAR(100)"),
        ("permission_scope", "ALTER TABLE people ADD COLUMN permission_scope VARCHAR(30) DEFAULT 'self'"),
        ("phone", "ALTER TABLE people ADD COLUMN phone VARCHAR(50)"),
        ("email", "ALTER TABLE people ADD COLUMN email VARCHAR(100)"),
        ("is_admin", "ALTER TABLE people ADD COLUMN is_admin BOOLEAN DEFAULT 0"),
    ],
    "tasks": [
        ("project_id", "ALTER TABLE tasks ADD COLUMN project_id INTEGER"),
        ("task_code", "ALTER TABLE tasks ADD COLUMN task_code VARCHAR(50)"),
        ("owner_person_id", "ALTER TABLE tasks ADD COLUMN owner_person_id INTEGER"),
        ("coordinator_person_id", "ALTER TABLE tasks ADD COLUMN coordinator_person_id INTEGER"),
    ],
    "update_submissions": [
        ("project_id", "ALTER TABLE update_submissions ADD COLUMN project_id INTEGER"),
        ("submitter_person_id", "ALTER TABLE update_submissions ADD COLUMN submitter_person_id INTEGER"),
        ("target_owner_person_id", "ALTER TABLE update_submissions ADD COLUMN target_owner_person_id INTEGER"),
        ("current_handler_person_id", "ALTER TABLE update_submissions ADD COLUMN current_handler_person_id INTEGER"),
        ("workflow_status", "ALTER TABLE update_submissions ADD COLUMN workflow_status VARCHAR(30) DEFAULT 'pending_owner'"),
        ("ceo_decision_required", "ALTER TABLE update_submissions ADD COLUMN ceo_decision_required BOOLEAN DEFAULT 0"),
        ("confirmed_by_person_id", "ALTER TABLE update_submissions ADD COLUMN confirmed_by_person_id INTEGER"),
        ("feedback_to_submitter", "ALTER TABLE update_submissions ADD COLUMN feedback_to_submitter TEXT DEFAULT ''"),
        ("parent_submission_id", "ALTER TABLE update_submissions ADD COLUMN parent_submission_id INTEGER"),
    ],
    "achievements": [
        ("project_id", "ALTER TABLE achievements ADD COLUMN project_id INTEGER"),
        ("source_submission_id", "ALTER TABLE achievements ADD COLUMN source_submission_id INTEGER"),
        ("owner_person_id", "ALTER TABLE achievements ADD COLUMN owner_person_id INTEGER"),
        ("approved_by_person_id", "ALTER TABLE achievements ADD COLUMN approved_by_person_id INTEGER"),
        ("approved_at", "ALTER TABLE achievements ADD COLUMN approved_at DATETIME"),
        ("is_desensitized", "ALTER TABLE achievements ADD COLUMN is_desensitized BOOLEAN DEFAULT 0"),
    ],
    "issues": [
        ("project_id", "ALTER TABLE issues ADD COLUMN project_id INTEGER"),
        ("source_submission_id", "ALTER TABLE issues ADD COLUMN source_submission_id INTEGER"),
        ("issue_code", "ALTER TABLE issues ADD COLUMN issue_code VARCHAR(50)"),
        ("owner_person_id", "ALTER TABLE issues ADD COLUMN owner_person_id INTEGER"),
        ("helper_person_id", "ALTER TABLE issues ADD COLUMN helper_person_id INTEGER"),
        ("need_decision_by_person_id", "ALTER TABLE issues ADD COLUMN need_decision_by_person_id INTEGER"),
        ("feedback_required", "ALTER TABLE issues ADD COLUMN feedback_required BOOLEAN DEFAULT 0"),
        ("feedback_result", "ALTER TABLE issues ADD COLUMN feedback_result TEXT DEFAULT ''"),
        ("closed_at", "ALTER TABLE issues ADD COLUMN closed_at DATETIME"),
    ],
    "meetings": [
        ("project_id", "ALTER TABLE meetings ADD COLUMN project_id INTEGER"),
    ],
    "operation_logs": [
        ("project_id", "ALTER TABLE operation_logs ADD COLUMN project_id INTEGER"),
        ("operator_person_id", "ALTER TABLE operation_logs ADD COLUMN operator_person_id INTEGER"),
        ("remark", "ALTER TABLE operation_logs ADD COLUMN remark TEXT DEFAULT ''"),
    ],
}

DEFAULT_PROJECTS = [
    ("knowledge-assets", "知识资产AI化", "special", 1),
    ("consultant-work", "顾问作业AI化", "special", 2),
    ("delivery-flow", "交付流程AI化", "special", 3),
    ("service-product", "咨询服务产品化", "special", 4),
    ("tech-platform", "技术底座与平台预研", "special", 5),
]

ADMIN_FLAG_NAMES = {"吴肖", "郭熠彬"}

SYSTEM_ROLE_MAP = {
    "冯海林": "组长CEO",
    "吴肖": "普通成员",
    "郭熠彬": "普通成员",
    "袁金玉": "过程保障",
}

LEGACY_SYSTEM_ROLE_MAP = {
    "ceo": "组长CEO",
    "tech_admin": "普通成员",
    "process_guard": "过程保障",
    "member": "普通成员",
}

WORKFLOW_STATUS_MAP = {
    "待确认": "pending_owner",
    "需修改": "pending_assign",
    "已确认": "confirmed",
    "已退回": "returned",
}


def backup_database(db_path: Path) -> Path:
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = db_path.with_name(f"{db_path.stem}.backup_{timestamp}{db_path.suffix}")
    shutil.copy2(db_path, backup_path)
    return backup_path


def split_schema_statements(sql_text: str) -> tuple[list[str], list[str]]:
    tables = [match.group(1).strip() for match in CREATE_PATTERN.finditer(sql_text)]
    indexes = [match.group(1).strip() for match in INDEX_PATTERN.finditer(sql_text)]
    return tables, indexes


def table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?",
        (table_name,),
    ).fetchone()
    return row is not None


def existing_columns(conn: sqlite3.Connection, table_name: str) -> set[str]:
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table_name})")}


def execute_schema_statements(conn: sqlite3.Connection, statements: list[str]) -> None:
    for statement in statements:
        conn.execute(statement)


def patch_legacy_tables(conn: sqlite3.Connection) -> None:
    for table_name, columns in MIGRATION_COLUMNS.items():
        if not table_exists(conn, table_name):
            continue
        current = existing_columns(conn, table_name)
        for column_name, alter_sql in columns:
            if column_name in current:
                continue
            conn.execute(alter_sql)


def seed_default_projects(conn: sqlite3.Connection) -> None:
    if not table_exists(conn, "projects"):
        return
    columns = existing_columns(conn, "projects")
    has_new_shape = {"project_code", "project_type", "status"}.issubset(columns)
    has_old_shape = {"is_active"}.issubset(columns)

    for project_code, name, project_type, sort_order in DEFAULT_PROJECTS:
        if has_new_shape:
            conn.execute(
                """
                INSERT INTO projects (project_code, name, project_type, status, sort_order)
                VALUES (?, ?, ?, 'active', ?)
                ON CONFLICT(name) DO UPDATE SET
                    project_code = excluded.project_code,
                    project_type = excluded.project_type,
                    sort_order = excluded.sort_order
                """,
                (project_code, name, project_type, sort_order),
            )
            continue

        if has_old_shape:
            conn.execute(
                """
                INSERT INTO projects (name, sort_order, is_active)
                VALUES (?, ?, 1)
                ON CONFLICT(name) DO UPDATE SET
                    sort_order = excluded.sort_order,
                    is_active = 1
                """,
                (name, sort_order),
            )
            continue

        conn.execute(
            """
            INSERT INTO projects (name, sort_order)
            VALUES (?, ?)
            ON CONFLICT(name) DO UPDATE SET
                sort_order = excluded.sort_order
            """,
            (name, sort_order),
        )


def backfill_people_roles(conn: sqlite3.Connection) -> None:
    if not table_exists(conn, "people"):
        return
    for old_value, new_value in LEGACY_SYSTEM_ROLE_MAP.items():
        conn.execute(
            "UPDATE people SET system_role = ? WHERE system_role = ?",
            (new_value, old_value),
        )
    for name, system_role in SYSTEM_ROLE_MAP.items():
        conn.execute(
            "UPDATE people SET system_role = ? WHERE name = ?",
            (system_role, name),
        )
    if "is_admin" in existing_columns(conn, "people"):
        conn.execute("UPDATE people SET is_admin = 0 WHERE is_admin IS NULL")
        for name in ADMIN_FLAG_NAMES:
            conn.execute(
                "UPDATE people SET is_admin = 1 WHERE name = ?",
                (name,),
            )


def backfill_submission_status(conn: sqlite3.Connection) -> None:
    if not table_exists(conn, "update_submissions"):
        return
    for confirm_status, workflow_status in WORKFLOW_STATUS_MAP.items():
        conn.execute(
            """
            UPDATE update_submissions
            SET workflow_status = ?
            WHERE confirm_status = ?
              AND (workflow_status IS NULL OR workflow_status = '' OR workflow_status = 'pending_owner')
            """,
            (workflow_status, confirm_status),
        )


def backfill_project_ids(conn: sqlite3.Connection, table_name: str, source_column: str = "special_project") -> None:
    if not table_exists(conn, table_name) or not table_exists(conn, "projects"):
        return
    columns = existing_columns(conn, table_name)
    if "project_id" not in columns or source_column not in columns:
        return
    conn.execute(
        f"""
        UPDATE {table_name}
        SET project_id = (
            SELECT projects.id
            FROM projects
            WHERE projects.name = {table_name}.{source_column}
        )
        WHERE (project_id IS NULL OR project_id = '')
          AND {source_column} IS NOT NULL
          AND TRIM({source_column}) <> ''
        """
    )


def backfill_person_ids(conn: sqlite3.Connection, table_name: str, name_column: str, id_column: str) -> None:
    if not table_exists(conn, table_name) or not table_exists(conn, "people"):
        return
    columns = existing_columns(conn, table_name)
    if name_column not in columns or id_column not in columns:
        return
    conn.execute(
        f"""
        UPDATE {table_name}
        SET {id_column} = (
            SELECT people.id
            FROM people
            WHERE people.name = {table_name}.{name_column}
        )
        WHERE ({id_column} IS NULL OR {id_column} = '')
          AND {name_column} IS NOT NULL
          AND TRIM({name_column}) <> ''
        """
    )


def backfill_issue_closed_at(conn: sqlite3.Connection) -> None:
    if not table_exists(conn, "issues"):
        return
    columns = existing_columns(conn, "issues")
    if "closed_at" not in columns or "status" not in columns or "updated_at" not in columns:
        return
    closed_statuses = {"已关闭", "已决策", "已解决", "关闭"}
    rows = conn.execute(
        "SELECT id, status, updated_at, closed_at FROM issues"
    ).fetchall()
    updates = [
        (row[2], row[0])
        for row in rows
        if row[1] in closed_statuses and not row[3] and row[2]
    ]
    if updates:
        conn.executemany("UPDATE issues SET closed_at = ? WHERE id = ?", updates)


def create_project_members_table(conn: sqlite3.Connection) -> None:
    """创建 project_members 表（幂等，已存在则跳过）。"""
    if table_exists(conn, "project_members"):
        return
    conn.execute(
        """
        CREATE TABLE project_members (
            id                   INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id           INTEGER NOT NULL,
            person_id            INTEGER NOT NULL,
            person_name_snapshot VARCHAR(50) NOT NULL DEFAULT '',
            role                 VARCHAR(30) NOT NULL,
            note                 TEXT DEFAULT '',
            joined_at            DATETIME DEFAULT CURRENT_TIMESTAMP,
            created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (project_id) REFERENCES projects(id),
            FOREIGN KEY (person_id)  REFERENCES people(id),
            UNIQUE (project_id, person_id, role)
        )
        """
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS ix_pm_project_id ON project_members(project_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS ix_pm_person_id ON project_members(person_id)"
    )
    conn.execute(
        "CREATE INDEX IF NOT EXISTS ix_pm_role ON project_members(role)"
    )
    print("[schema] project_members 表已创建")


def bootstrap_base_tables(db_path: Path) -> None:
    """全新部署时先用 SQLAlchemy create_all 建立 models.py 中定义的基础表。"""
    import sys
    sys.path.insert(0, str(db_path.parent))
    try:
        from app.database import Base, engine
        Base.metadata.create_all(bind=engine)
        print("[bootstrap] base tables created via SQLAlchemy")
    except Exception as e:
        print(f"[bootstrap] skipped: {e}")
    finally:
        if str(db_path.parent) in sys.path:
            sys.path.remove(str(db_path.parent))


def run_migration(db_path: Path, sql_path: Path, make_backup: bool = True) -> None:
    if not sql_path.exists():
        raise FileNotFoundError(f"SQL file not found: {sql_path}")
    is_fresh = not db_path.exists()
    if is_fresh:
        print(f"[info] database not found at {db_path}, bootstrapping fresh install")
        bootstrap_base_tables(db_path)

    if make_backup and not is_fresh:
        backup_path = backup_database(db_path)
        print(f"[backup] {backup_path}")

    sql_text = sql_path.read_text(encoding="utf-8")
    table_statements, index_statements = split_schema_statements(sql_text)
    if not table_statements:
        raise RuntimeError("No CREATE TABLE statements found in SQL file.")

    conn = sqlite3.connect(db_path)
    try:
        conn.execute("PRAGMA foreign_keys = OFF")
        conn.execute("BEGIN")

        execute_schema_statements(conn, table_statements)
        patch_legacy_tables(conn)
        create_project_members_table(conn)
        seed_default_projects(conn)
        backfill_people_roles(conn)
        backfill_submission_status(conn)

        backfill_project_ids(conn, "tasks")
        backfill_project_ids(conn, "achievements")
        backfill_project_ids(conn, "issues")
        backfill_project_ids(conn, "update_submissions", "special_project")

        backfill_person_ids(conn, "tasks", "owner", "owner_person_id")
        backfill_person_ids(conn, "tasks", "coordinator", "coordinator_person_id")
        backfill_person_ids(conn, "achievements", "owner", "owner_person_id")
        backfill_person_ids(conn, "issues", "owner", "owner_person_id")
        backfill_person_ids(conn, "issues", "helper", "helper_person_id")
        backfill_person_ids(conn, "issues", "need_decision_by", "need_decision_by_person_id")
        backfill_person_ids(conn, "update_submissions", "submitter", "submitter_person_id")
        backfill_person_ids(conn, "update_submissions", "confirmed_by", "confirmed_by_person_id")
        backfill_person_ids(conn, "operation_logs", "operator", "operator_person_id")
        backfill_issue_closed_at(conn)

        execute_schema_statements(conn, index_statements)

        conn.commit()
        seed_formal_permissions(db_path, make_backup=False)
        print("[done] migration completed")
    except Exception:
        conn.rollback()
        raise
    finally:
        if conn:
            try:
                conn.execute("PRAGMA foreign_keys = ON")
            except Exception:
                pass
            conn.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Migrate Bowei SQLite schema safely.")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help="Path to sqlite database file")
    parser.add_argument("--sql", type=Path, default=DEFAULT_SQL, help="Path to schema sql file")
    parser.add_argument("--no-backup", action="store_true", help="Skip database backup before migration")
    args = parser.parse_args()

    run_migration(args.db, args.sql, make_backup=not args.no_backup)


if __name__ == "__main__":
    main()
