"""
博维AI驾驶舱 · projects 表扩展列迁移脚本（批次 5B）

功能：
  为 projects 表补充 4B 阶段新增的五个扩展列：
    code        TEXT DEFAULT ''
    description TEXT DEFAULT ''
    status      TEXT DEFAULT 'active'
    start_date  TEXT DEFAULT ''
    end_date    TEXT DEFAULT ''

用法：
  # 仅检查缺失列，不修改数据库（先跑这个）
  python migrate_project_extended_columns.py --report-only

  # 执行迁移，补齐缺失列
  python migrate_project_extended_columns.py --execute

  # 指定数据库路径
  python migrate_project_extended_columns.py --report-only --db path/to/other.db
  python migrate_project_extended_columns.py --execute  --db path/to/other.db

注意：
  - --report-only 和 --execute 必须指定其中一个，且互斥
  - 本脚本为幂等操作：已存在的列不会重复添加，不会报错
  - 仅支持 SQLite。PostgreSQL 环境请使用 Alembic 或手动执行对应 ALTER TABLE
  - 本脚本不依赖 FastAPI 运行时，可独立执行
  - 依赖前提：projects 表本身必须已存在（由 Base.metadata.create_all 或
    migrate_sqlite_schema.py 创建）
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_DB = BASE_DIR / "bowei_ai_dashboard.db"

# 需要确保存在的扩展列：(列名, SQLite 列定义)
REQUIRED_COLUMNS: list[tuple[str, str]] = [
    ("code",        "TEXT DEFAULT ''"),
    ("description", "TEXT DEFAULT ''"),
    ("status",      "TEXT DEFAULT 'active'"),
    ("start_date",  "TEXT DEFAULT ''"),
    ("end_date",    "TEXT DEFAULT ''"),
]


def _get_existing_columns(conn: sqlite3.Connection) -> set[str]:
    """返回 projects 表当前所有列名（小写）。"""
    rows = conn.execute("PRAGMA table_info(projects)").fetchall()
    return {row[1].lower() for row in rows}


def _check_projects_table(conn: sqlite3.Connection) -> None:
    """确认 projects 表已存在，否则提前退出。"""
    tables = {
        row[0]
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
    }
    if "projects" not in tables:
        print("ERROR: projects 表不存在，请先执行 Base.metadata.create_all 或 migrate_sqlite_schema.py")
        sys.exit(1)


def run_report(db_path: Path) -> list[str]:
    """
    检查缺失列并打印报告。
    返回缺失列名列表（供 run_execute 复用）。
    """
    print(f"[report-only] 数据库: {db_path}")
    print(f"[report-only] 目标表: projects")
    print()

    conn = sqlite3.connect(str(db_path))
    try:
        _check_projects_table(conn)
        existing = _get_existing_columns(conn)

        missing: list[str] = []
        present: list[str] = []

        for col, col_def in REQUIRED_COLUMNS:
            if col.lower() in existing:
                present.append(col)
            else:
                missing.append(col)

        print("已存在的扩展列：")
        if present:
            for col in present:
                print(f"  [OK] {col}")
        else:
            print("  （无）")

        print()
        print("缺失的扩展列（--execute 将补齐）：")
        if missing:
            for col in missing:
                col_def = dict(REQUIRED_COLUMNS)[col]
                print(f"  [MISSING] {col}  [{col_def}]")
        else:
            print("  （无，projects 表已完整，无需迁移）")

        print()
        if missing:
            print(f"结论：发现 {len(missing)} 个缺失列，请运行 --execute 补齐。")
        else:
            print("结论：projects 表扩展列完整，无需迁移。")

        return missing

    finally:
        conn.close()


def run_execute(db_path: Path) -> None:
    """
    补齐缺失列（幂等）。已存在的列跳过，不报错。
    """
    print(f"[execute] 数据库: {db_path}")
    print(f"[execute] 目标表: projects")
    print()

    conn = sqlite3.connect(str(db_path))
    try:
        _check_projects_table(conn)
        existing = _get_existing_columns(conn)

        added: list[str] = []
        skipped: list[str] = []

        for col, col_def in REQUIRED_COLUMNS:
            if col.lower() in existing:
                skipped.append(col)
                print(f"  SKIP  {col}（已存在）")
                continue

            try:
                conn.execute(f"ALTER TABLE projects ADD COLUMN {col} {col_def}")
                conn.commit()
                added.append(col)
                print(f"  ADD   {col}  [{col_def}]")
            except sqlite3.OperationalError as exc:
                # 极少数情况：并发写入或 SQLite 版本限制
                print(f"  WARN  {col}：{exc}")

        print()
        if added:
            print(f"完成：新增 {len(added)} 列：{', '.join(added)}")
        else:
            print("完成：所有扩展列已存在，无需修改。")

        if skipped:
            print(f"跳过（已存在）：{', '.join(skipped)}")

    finally:
        conn.close()


def main() -> None:
    parser = argparse.ArgumentParser(
        description="博维AI驾驶舱 · projects 表扩展列迁移脚本",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例：
  python migrate_project_extended_columns.py --report-only
  python migrate_project_extended_columns.py --execute
  python migrate_project_extended_columns.py --execute --db /data/prod.db
        """,
    )
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument(
        "--report-only",
        action="store_true",
        help="仅检查缺失列，不修改数据库",
    )
    mode.add_argument(
        "--execute",
        action="store_true",
        help="补齐缺失列（幂等，已存在列自动跳过）",
    )
    parser.add_argument(
        "--db",
        type=Path,
        default=DEFAULT_DB,
        metavar="PATH",
        help=f"SQLite 数据库路径（默认：{DEFAULT_DB}）",
    )
    args = parser.parse_args()

    db_path: Path = args.db.resolve()
    if not db_path.exists():
        print(f"ERROR: 数据库文件不存在：{db_path}")
        sys.exit(1)

    if args.report_only:
        run_report(db_path)
    else:
        # execute 模式：先打印报告再执行
        missing = run_report(db_path)
        if missing:
            print("-" * 50)
        run_execute(db_path)


if __name__ == "__main__":
    main()
