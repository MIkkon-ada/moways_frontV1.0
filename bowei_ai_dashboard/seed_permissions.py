from __future__ import annotations

import argparse
import shutil
import sqlite3
from datetime import datetime
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
DEFAULT_DB = BASE_DIR / "bowei_ai_dashboard.db"

DEFAULT_PROJECTS = [
    ("knowledge-assets", "知识资产AI化", "special", 1),
    ("consultant-work", "顾问作业AI化", "special", 2),
    ("delivery-flow", "交付流程AI化", "special", 3),
    ("service-product", "咨询服务产品化", "special", 4),
    ("tech-platform", "技术底座与平台预研", "special", 5),
]

PEOPLE_SEED = [
    {
        "name": "冯海林",
        "employee_code": "feng-hailin",
        "system_role": "组长CEO",
        "is_admin": False,
        "role": "组长",
        "department": "管理层",
        "special_project_duty": "全项目",
        "permission": "确认",
        "permission_scope": "all",
        "title": "CEO / 大项目负责人",
    },
    {
        "name": "吴肖",
        "employee_code": "wu-xiao",
        "system_role": "普通成员",
        "is_admin": True,
        "role": "AI应用工程师",
        "department": "技术支持",
        "special_project_duty": "技术底座与平台预研",
        "permission": "确认",
        "permission_scope": "all",
        "title": "AI应用工程师",
    },
    {
        "name": "郭熠彬",
        "employee_code": "guo-yibin",
        "system_role": "普通成员",
        "is_admin": True,
        "role": "AI应用工程师",
        "department": "技术支持",
        "special_project_duty": "技术底座与平台预研",
        "permission": "确认",
        "permission_scope": "all",
        "title": "AI应用工程师",
    },
    {
        "name": "袁金玉",
        "employee_code": "yuan-jinyu",
        "system_role": "过程保障",
        "is_admin": False,
        "role": "过程保障",
        "department": "项目保障",
        "special_project_duty": "项目统筹与复盘",
        "permission": "查看",
        "permission_scope": "all",
        "title": "过程保障",
    },
    {
        "name": "刘万超",
        "employee_code": "liu-wanchao",
        "system_role": "普通成员",
        "is_admin": False,
        "role": "统筹",
        "department": "咨询部",
        "special_project_duty": "知识资产AI化、顾问作业AI化、交付流程AI化",
        "permission": "查看",
        "permission_scope": "project",
        "title": "专项统筹人",
    },
    {
        "name": "邹奇敏",
        "employee_code": "zou-qimin",
        "system_role": "普通成员",
        "is_admin": False,
        "role": "统筹",
        "department": "咨询部",
        "special_project_duty": "咨询服务产品化",
        "permission": "查看",
        "permission_scope": "project",
        "title": "专项统筹人",
    },
    {
        "name": "杨宇帆",
        "employee_code": "yang-yufan",
        "system_role": "普通成员",
        "is_admin": False,
        "role": "负责",
        "department": "咨询部",
        "special_project_duty": "知识资产AI化",
        "permission": "确认",
        "permission_scope": "project",
        "title": "专项负责人",
    },
    {
        "name": "许明良",
        "employee_code": "xu-mingliang",
        "system_role": "普通成员",
        "is_admin": False,
        "role": "负责",
        "department": "咨询部",
        "special_project_duty": "顾问作业AI化",
        "permission": "确认",
        "permission_scope": "project",
        "title": "专项负责人",
    },
    {
        "name": "温会林",
        "employee_code": "wen-huilin",
        "system_role": "普通成员",
        "is_admin": False,
        "role": "负责",
        "department": "咨询部",
        "special_project_duty": "交付流程AI化",
        "permission": "确认",
        "permission_scope": "project",
        "title": "专项负责人",
    },
    {
        "name": "彭超凡",
        "employee_code": "peng-chaofan",
        "system_role": "普通成员",
        "is_admin": False,
        "role": "负责",
        "department": "咨询部",
        "special_project_duty": "咨询服务产品化",
        "permission": "确认",
        "permission_scope": "project",
        "title": "专项负责人",
    },
]

PROJECT_MEMBERSHIPS = [
    {
        "project_name": "知识资产AI化",
        "coordinator": "刘万超",
        "owners": ["杨宇帆"],
        "collaborators": ["袁金玉", "郭熠彬", "吴肖"],
    },
    {
        "project_name": "顾问作业AI化",
        "coordinator": "刘万超",
        "owners": ["许明良"],
        "collaborators": ["郭熠彬", "吴肖"],
    },
    {
        "project_name": "交付流程AI化",
        "coordinator": "刘万超",
        "owners": ["温会林"],
        "collaborators": ["郭熠彬", "吴肖", "袁金玉"],
    },
    {
        "project_name": "咨询服务产品化",
        "coordinator": "邹奇敏",
        "owners": ["彭超凡"],
        "collaborators": ["刘万超", "温会林"],
    },
    {
        "project_name": "技术底座与平台预研",
        "coordinator": "冯海林",
        "owners": ["吴肖", "郭熠彬"],
        "collaborators": ["刘万超", "邹奇敏"],
    },
]


def backup_database(db_path: Path) -> Path:
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_path = db_path.with_name(f"{db_path.stem}.backup_permissions_{timestamp}{db_path.suffix}")
    shutil.copy2(db_path, backup_path)
    return backup_path


def table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?",
        (table_name,),
    ).fetchone()
    return row is not None


def require_tables(conn: sqlite3.Connection, *tables: str) -> None:
    missing = [table for table in tables if not table_exists(conn, table)]
    if missing:
        raise RuntimeError(
            f"Missing required tables: {', '.join(missing)}. Run the schema migration first."
        )


def existing_columns(conn: sqlite3.Connection, table_name: str) -> set[str]:
    return {row[1] for row in conn.execute(f"PRAGMA table_info({table_name})")}


def fetch_id(conn: sqlite3.Connection, table: str, key_column: str, key_value: str) -> int | None:
    row = conn.execute(
        f"SELECT id FROM {table} WHERE {key_column} = ?",
        (key_value,),
    ).fetchone()
    return int(row[0]) if row else None


def upsert_project(conn: sqlite3.Connection, project_code: str, name: str, project_type: str, sort_order: int) -> int:
    columns = existing_columns(conn, "projects")
    has_new_shape = {"project_code", "project_type", "status"}.issubset(columns)
    has_old_shape = "is_active" in columns
    row = conn.execute("SELECT id FROM projects WHERE name = ?", (name,)).fetchone()
    if row:
        project_id = int(row[0])
        if has_new_shape:
            conn.execute(
                """
                UPDATE projects
                SET project_code = ?,
                    project_type = ?,
                    status = 'active',
                    sort_order = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (project_code, project_type, sort_order, project_id),
            )
        elif has_old_shape:
            conn.execute(
                """
                UPDATE projects
                SET sort_order = ?,
                    is_active = 1,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (sort_order, project_id),
            )
        else:
            conn.execute(
                """
                UPDATE projects
                SET sort_order = ?,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (sort_order, project_id),
            )
        return project_id

    if has_new_shape:
        conn.execute(
            """
            INSERT INTO projects (project_code, name, project_type, status, sort_order)
            VALUES (?, ?, ?, 'active', ?)
            """,
            (project_code, name, project_type, sort_order),
        )
    elif has_old_shape:
        conn.execute(
            """
            INSERT INTO projects (name, sort_order, is_active)
            VALUES (?, ?, 1)
            """,
            (name, sort_order),
        )
    else:
        conn.execute(
            """
            INSERT INTO projects (name, sort_order)
            VALUES (?, ?)
            """,
            (name, sort_order),
        )
    return int(conn.execute("SELECT id FROM projects WHERE name = ?", (name,)).fetchone()[0])


def upsert_person(conn: sqlite3.Connection, person: dict[str, str]) -> int:
    columns = existing_columns(conn, "people")
    has_is_admin = "is_admin" in columns
    row = conn.execute("SELECT id FROM people WHERE name = ?", (person["name"],)).fetchone()
    if row:
        person_id = int(row[0])
        if has_is_admin:
            conn.execute(
                """
                UPDATE people
                SET employee_code = ?,
                    system_role = ?,
                    role = ?,
                    title = ?,
                    department = ?,
                    special_project_duty = ?,
                    permission = ?,
                    permission_scope = ?,
                    contact = COALESCE(contact, ''),
                    phone = COALESCE(phone, ''),
                    email = COALESCE(email, ''),
                    is_admin = ?,
                    is_active = 1,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (
                    person["employee_code"],
                    person["system_role"],
                    person["role"],
                    person["title"],
                    person["department"],
                    person["special_project_duty"],
                    person["permission"],
                    person["permission_scope"],
                    1 if person.get("is_admin") else 0,
                    person_id,
                ),
            )
        else:
            conn.execute(
                """
                UPDATE people
                SET employee_code = ?,
                    system_role = ?,
                    role = ?,
                    title = ?,
                    department = ?,
                    special_project_duty = ?,
                    permission = ?,
                    permission_scope = ?,
                    contact = COALESCE(contact, ''),
                    phone = COALESCE(phone, ''),
                    email = COALESCE(email, ''),
                    is_active = 1,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
                """,
                (
                    person["employee_code"],
                    person["system_role"],
                    person["role"],
                    person["title"],
                    person["department"],
                    person["special_project_duty"],
                    person["permission"],
                    person["permission_scope"],
                    person_id,
                ),
            )
        return person_id

    if has_is_admin:
        conn.execute(
            """
            INSERT INTO people (
                name, employee_code, system_role, role, title, department,
                special_project_duty, permission, permission_scope, contact,
                phone, email, is_admin, is_active
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', '', ?, 1)
            """,
            (
                person["name"],
                person["employee_code"],
                person["system_role"],
                person["role"],
                person["title"],
                person["department"],
                person["special_project_duty"],
                person["permission"],
                person["permission_scope"],
                1 if person.get("is_admin") else 0,
            ),
        )
    else:
        conn.execute(
            """
            INSERT INTO people (
                name, employee_code, system_role, role, title, department,
                special_project_duty, permission, permission_scope, contact,
                phone, email, is_active
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', '', 1)
            """,
            (
                person["name"],
                person["employee_code"],
                person["system_role"],
                person["role"],
                person["title"],
                person["department"],
                person["special_project_duty"],
                person["permission"],
                person["permission_scope"],
            ),
        )
    return int(conn.execute("SELECT id FROM people WHERE name = ?", (person["name"],)).fetchone()[0])


def upsert_membership(
    conn: sqlite3.Connection,
    project_id: int,
    person_id: int,
    project_role: str,
    can_submit_update: bool,
    can_confirm_submission: bool,
    can_view_project_dashboard: bool = True,
) -> None:
    row = conn.execute(
        """
        SELECT id FROM project_memberships
        WHERE project_id = ? AND person_id = ? AND project_role = ?
        """,
        (project_id, person_id, project_role),
    ).fetchone()
    payload = (
        1 if can_submit_update else 0,
        1 if can_confirm_submission else 0,
        1 if can_view_project_dashboard else 0,
    )
    if row:
        conn.execute(
            """
            UPDATE project_memberships
            SET can_submit_update = ?,
                can_confirm_submission = ?,
                can_view_project_dashboard = ?,
                is_active = 1,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (*payload, int(row[0])),
        )
        return

    conn.execute(
        """
        INSERT INTO project_memberships (
            project_id, person_id, project_role,
            can_submit_update, can_confirm_submission, can_view_project_dashboard,
            is_active
        )
        VALUES (?, ?, ?, ?, ?, ?, 1)
        """,
        (project_id, person_id, project_role, *payload),
    )


def seed_permissions(db_path: Path, make_backup: bool = True) -> None:
    if not db_path.exists():
        raise FileNotFoundError(f"Database not found: {db_path}")

    if make_backup:
        backup_path = backup_database(db_path)
        print(f"[backup] {backup_path}")

    conn = sqlite3.connect(db_path)
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        require_tables(conn, "projects", "people", "project_memberships")

        project_ids: dict[str, int] = {}
        for project_code, name, project_type, sort_order in DEFAULT_PROJECTS:
            project_ids[name] = upsert_project(conn, project_code, name, project_type, sort_order)

        person_ids: dict[str, int] = {}
        for person in PEOPLE_SEED:
            person_ids[person["name"]] = upsert_person(conn, person)

        for item in PROJECT_MEMBERSHIPS:
            project_id = project_ids[item["project_name"]]
            coordinator_id = person_ids[item["coordinator"]]
            upsert_membership(
                conn,
                project_id=project_id,
                person_id=coordinator_id,
                project_role="coordinator",
                can_submit_update=False,
                can_confirm_submission=False,
            )
            for owner_name in item["owners"]:
                upsert_membership(
                    conn,
                    project_id=project_id,
                    person_id=person_ids[owner_name],
                    project_role="owner",
                    can_submit_update=True,
                    can_confirm_submission=True,
                )
            for collaborator_name in item["collaborators"]:
                if collaborator_name not in person_ids:
                    continue
                upsert_membership(
                    conn,
                    project_id=project_id,
                    person_id=person_ids[collaborator_name],
                    project_role="collaborator",
                    can_submit_update=True,
                    can_confirm_submission=False,
                )

        conn.commit()
        print("[done] permissions seed completed")
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed the formal permission model into SQLite.")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help="Path to sqlite database file")
    parser.add_argument("--no-backup", action="store_true", help="Skip database backup before seeding")
    args = parser.parse_args()

    seed_permissions(args.db, make_backup=not args.no_backup)


if __name__ == "__main__":
    main()
