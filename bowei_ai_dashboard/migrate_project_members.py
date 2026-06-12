"""
博维AI驾驶舱 · 第一阶段 P0 数据迁移脚本

功能：
  1. 回填各业务表 project_id（从 special_project / related_special_project）
  2. 回填 update_submissions.project_id（从 human_result_json / ai_result_json 解析）
  3. 从 projects.coordinator / owners / collaborators 迁移到 project_members 表
  4. 将全局 CEO 作为旧数据兜底写入已有项目的 project_ceo 角色

用法：
  # 仅输出报告，不修改数据库（先跑这个）
  python migrate_project_members.py --report-only

  # 执行迁移（自动备份后写入）
  python migrate_project_members.py --execute

  # 指定数据库路径，报告输出到文件
  python migrate_project_members.py --report-only --db path/to/db.sqlite --out report.txt

注意：
  - --report-only 和 --execute 必须指定其中一个，且互斥
  - --execute 前务必先跑 --report-only 确认无重大异常
  - 本脚本依赖 migrate_sqlite_schema.py 已执行完毕（project_members 表和各表 project_id 列已存在）
  - 本脚本不会在 FastAPI startup 中自动执行
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sqlite3
from datetime import datetime
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_DB = BASE_DIR / "bowei_ai_dashboard.db"


# ── 工具函数 ──────────────────────────────────────────────────────────────────

def split_names(value: str) -> list[str]:
    """按中英文分隔符拆分姓名字符串。"""
    if not value:
        return []
    return [s.strip() for s in re.split(r"[,，、/;\n]+", value) if s.strip()]


def table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        (table_name,),
    ).fetchone()
    return row is not None


def column_exists(conn: sqlite3.Connection, table_name: str, column_name: str) -> bool:
    cols = {row[1] for row in conn.execute(f"PRAGMA table_info({table_name})")}
    return column_name in cols


# ── Step A：业务表 project_id 回填 ────────────────────────────────────────────

def backfill_project_id_from_name(
    conn: sqlite3.Connection,
    table_name: str,
    source_col: str,
    dry_run: bool,
) -> tuple[int, list[dict]]:
    """
    根据 source_col 字段的字符串值匹配 projects.name，回填 project_id。
    返回 (成功数, 异常列表)。
    """
    if not table_exists(conn, table_name):
        return 0, []

    if not column_exists(conn, table_name, "project_id"):
        return 0, [{
            "id": None,
            "source_value": None,
            "reason": f"{table_name} 缺少 project_id 列，请先执行 migrate_sqlite_schema.py",
        }]

    if not column_exists(conn, table_name, source_col):
        return 0, [{
            "id": None,
            "source_value": None,
            "reason": f"{table_name} 缺少 {source_col} 列，跳过",
        }]

    rows = conn.execute(
        f"SELECT id, {source_col} FROM {table_name} WHERE project_id IS NULL"
    ).fetchall()

    success = 0
    errors: list[dict] = []

    for row_id, raw_value in rows:
        name = (raw_value or "").strip()
        if not name:
            errors.append({"id": row_id, "source_value": raw_value, "reason": "空值，跳过"})
            continue

        project_row = conn.execute(
            "SELECT id FROM projects WHERE name = ?", (name,)
        ).fetchone()

        if not project_row:
            errors.append({
                "id": row_id,
                "source_value": name,
                "reason": f"projects 表中无名称为 '{name}' 的项目",
            })
            continue

        if not dry_run:
            conn.execute(
                f"UPDATE {table_name} SET project_id = ? WHERE id = ?",
                (project_row[0], row_id),
            )
        success += 1

    return success, errors


# ── Step B：update_submissions project_id 回填（从 JSON 解析）────────────────

def _extract_project_name_from_json(json_str: str | None) -> str | None:
    """从 AI/人工结果 JSON 中尝试提取 special_project 字段。"""
    if not json_str:
        return None
    try:
        data = json.loads(json_str)
    except (json.JSONDecodeError, ValueError):
        return None
    # 依次尝试多个可能的键路径
    candidates = [
        data.get("special_project"),
        (data.get("task") or {}).get("special_project"),
        data.get("project"),
    ]
    for v in candidates:
        if v and isinstance(v, str) and v.strip():
            return v.strip()
    return None


def backfill_update_submissions(
    conn: sqlite3.Connection,
    dry_run: bool,
) -> tuple[int, list[dict]]:
    """回填 update_submissions.project_id，来源为 JSON 字段解析。"""
    if not table_exists(conn, "update_submissions"):
        return 0, []

    if not column_exists(conn, "update_submissions", "project_id"):
        return 0, [{
            "id": None,
            "reason": "update_submissions 缺少 project_id 列，请先执行 migrate_sqlite_schema.py",
        }]

    rows = conn.execute(
        "SELECT id, human_result_json, ai_result_json "
        "FROM update_submissions WHERE project_id IS NULL"
    ).fetchall()

    success = 0
    errors: list[dict] = []

    for row_id, human_json, ai_json in rows:
        name = (
            _extract_project_name_from_json(human_json)
            or _extract_project_name_from_json(ai_json)
        )

        if not name:
            errors.append({
                "id": row_id,
                "reason": "human_result_json 和 ai_result_json 中均无 special_project 字段",
            })
            continue

        project_row = conn.execute(
            "SELECT id FROM projects WHERE name = ?", (name,)
        ).fetchone()

        if not project_row:
            errors.append({
                "id": row_id,
                "reason": f"解析到 special_project='{name}'，但 projects 表中无匹配项目",
            })
            continue

        if not dry_run:
            conn.execute(
                "UPDATE update_submissions SET project_id = ? WHERE id = ?",
                (project_row[0], row_id),
            )
        success += 1

    return success, errors


# ── Step C：project_members 迁移（从 projects 字符串字段）───────────────────

def migrate_project_members(
    conn: sqlite3.Connection,
    dry_run: bool,
) -> tuple[int, list[dict]]:
    """
    将 projects.coordinator / owners / collaborators 迁移到 project_members 表。
    找不到 person_id 的记录不写入，只输出到异常报告。
    """
    if not table_exists(conn, "project_members"):
        return 0, [{
            "project": None,
            "person_name": None,
            "role": None,
            "reason": "project_members 表不存在，请先执行 migrate_sqlite_schema.py",
        }]

    projects = conn.execute(
        "SELECT id, name, coordinator, owners, collaborators "
        "FROM projects WHERE is_active = 1"
    ).fetchall()

    success = 0
    errors: list[dict] = []

    for proj_id, proj_name, coordinator, owners_str, collaborators_str in projects:
        # 构建 (person_name, role) 候选列表
        candidates: list[tuple[str, str]] = []

        if coordinator and coordinator.strip():
            candidates.append((coordinator.strip(), "coordinator"))

        for name in split_names(owners_str or ""):
            candidates.append((name, "owner"))

        for name in split_names(collaborators_str or ""):
            # 避免 collaborator 与 owner/coordinator 重复角色
            if not any(name == n for n, _ in candidates):
                candidates.append((name, "member"))
            else:
                # 已是 owner 或 coordinator，不重复加 member
                pass

        for person_name, role in candidates:
            person_row = conn.execute(
                "SELECT id FROM people WHERE name = ? AND is_active = 1",
                (person_name,),
            ).fetchone()

            if not person_row:
                errors.append({
                    "project": proj_name,
                    "person_name": person_name,
                    "role": role,
                    "reason": f"people 表中无 name='{person_name}' 且 is_active=1 的记录",
                })
                continue

            if not dry_run:
                conn.execute(
                    """
                    INSERT OR IGNORE INTO project_members
                        (project_id, person_id, person_name_snapshot, role,
                         joined_at, created_at, updated_at)
                    VALUES (?, ?, ?, ?,
                            CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                    """,
                    (proj_id, person_row[0], person_name, role),
                )
            success += 1

    return success, errors


# ── Step D：全局 CEO → project_ceo（旧数据兜底，需人工确认）──────────────────

def migrate_ceo_to_project_role(
    conn: sqlite3.Connection,
    dry_run: bool,
) -> tuple[list[dict], list[dict]]:
    """
    将 people.system_role='组长CEO' 的人写入所有已有项目的 project_ceo 角色。
    仅作旧数据兜底默认值，报告中标注需人工确认。
    已有 project_ceo 的项目不覆盖。
    """
    if not table_exists(conn, "project_members"):
        return [], [{"reason": "project_members 表不存在，请先执行 migrate_sqlite_schema.py"}]

    ceo_rows = conn.execute(
        "SELECT id, name FROM people WHERE system_role = '组长CEO' AND is_active = 1"
    ).fetchall()

    if not ceo_rows:
        return [], [{"reason": "people 表中无 system_role='组长CEO' 且 is_active=1 的用户"}]

    projects = conn.execute(
        "SELECT id, name FROM projects WHERE is_active = 1"
    ).fetchall()

    written: list[dict] = []
    errors: list[dict] = []

    for ceo_id, ceo_name in ceo_rows:
        for proj_id, proj_name in projects:
            # 如果该项目已有 project_ceo，不覆盖
            existing = conn.execute(
                "SELECT id FROM project_members WHERE project_id = ? AND role = 'project_ceo'",
                (proj_id,),
            ).fetchone()
            if existing:
                continue

            if not dry_run:
                conn.execute(
                    """
                    INSERT OR IGNORE INTO project_members
                        (project_id, person_id, person_name_snapshot, role,
                         joined_at, created_at, updated_at)
                    VALUES (?, ?, ?, 'project_ceo',
                            CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                    """,
                    (proj_id, ceo_id, ceo_name),
                )
            written.append({
                "ceo_name": ceo_name,
                "project_id": proj_id,
                "project_name": proj_name,
            })

    return written, errors


# ── 报告格式化 ────────────────────────────────────────────────────────────────

def _divider(char: str = "─", width: int = 64) -> str:
    return char * width


def format_report(
    mode: str,
    step_a: dict[str, tuple[int, list[dict]]],
    step_b: tuple[int, list[dict]],
    step_c: tuple[int, list[dict]],
    step_d: tuple[list[dict], list[dict]],
) -> str:
    mode_label = "仅报告（未修改数据库）" if mode == "report-only" else "已执行（数据库已修改）"
    lines: list[str] = [
        _divider("═"),
        "  博维AI驾驶舱 · 第一阶段数据迁移报告",
        f"  执行模式：{mode_label}",
        f"  执行时间：{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        _divider("═"),
        "",
        "[A] 业务表 project_id 回填（tasks / issues / achievements / meetings）",
    ]

    total_ok = sum(ok for ok, _ in step_a.values())
    total_err = sum(len(errs) for _, errs in step_a.values())
    for table, (ok, errs) in step_a.items():
        lines.append(f"  {table:<26} [OK] {ok:>3} 条  [NG] {len(errs):>3} 条异常")
    lines.append(f"  {'合计':<26} [OK] {total_ok:>3} 条  [NG] {total_err:>3} 条异常")

    lines.append("")
    b_ok, b_errs = step_b
    lines.append("[B] update_submissions project_id 回填（从 JSON 解析）")
    lines.append(f"  [OK] {b_ok} 条  [NG] {len(b_errs)} 条异常")

    lines.append("")
    c_ok, c_errs = step_c
    lines.append("[C] project_members 迁移（从 projects 字符串字段）")
    lines.append(f"  [OK] 写入 {c_ok} 条  [NG] person_id 解析失败跳过 {len(c_errs)} 条")

    lines.append("")
    d_written, d_errs = step_d
    lines.append("[D] 全局 CEO → project_ceo（旧数据兜底）")
    lines.append(f"  自动写入 {len(d_written)} 条  异常 {len(d_errs)} 条")
    if d_written:
        lines.append("  [!] 以下为自动补默认值，请人工核实是否正确：")
        for item in d_written:
            lines.append(
                f"    · {item['ceo_name']} → "
                f"项目 '{item['project_name']}' (project_id={item['project_id']})  "
                f"role=project_ceo"
            )
    for e in d_errs:
        lines.append(f"  [NG] {e['reason']}")

    # ── 异常详情 ──
    has_errors = (
        any(errs for _, errs in step_a.values())
        or b_errs
        or c_errs
        or d_errs
    )
    if has_errors:
        lines.extend(["", _divider("═"), "  异常详情", _divider("═")])

        for table, (_, errs) in step_a.items():
            if not errs:
                continue
            lines.append(f"\n[A 异常] {table}")
            for e in errs:
                lines.append(
                    f"  row_id={str(e['id']):<6}  "
                    f"值={str(e['source_value'])!r:<32}  "
                    f"{e['reason']}"
                )

        if b_errs:
            lines.append("\n[B 异常] update_submissions")
            for e in b_errs:
                lines.append(f"  row_id={str(e.get('id', '?')):<6}  {e['reason']}")

        if c_errs:
            lines.append("\n[C 异常] project_members — 以下人员未写入（person_id 解析失败）")
            for e in c_errs:
                lines.append(
                    f"  项目={str(e.get('project', '?'))!r:<22}  "
                    f"人员={str(e.get('person_name', '?'))!r:<12}  "
                    f"角色={str(e.get('role', '?')):<14}  "
                    f"{e['reason']}"
                )

        if d_errs:
            lines.append("\n[D 异常] CEO 迁移")
            for e in d_errs:
                lines.append(f"  {e['reason']}")

    # ── 结论 ──
    total_errors = (
        sum(len(errs) for _, errs in step_a.values())
        + len(b_errs)
        + len(c_errs)
        + len(d_errs)
    )
    lines.extend(["", _divider("═"), "  结论", _divider("═")])

    if total_errors == 0 and not d_written:
        conclusion = (
            "  [OK] 无异常，可放心执行 --execute 模式。"
            if mode == "report-only"
            else "  [OK] 迁移完成，无异常。"
        )
    elif total_errors == 0:
        if mode == "report-only":
            conclusion = (
                f"  [OK] 数据异常为零。\n"
                f"    project_ceo 自动补默认 {len(d_written)} 条，请人工确认 [D] 结果后再执行 --execute。"
            )
        else:
            conclusion = (
                f"  [OK] 迁移完成。\n"
                f"    project_ceo 已自动补默认 {len(d_written)} 条，请人工核实上方 [D] 列表。"
            )
    else:
        if mode == "report-only":
            conclusion = (
                f"  [NG] 存在 {total_errors} 条异常，建议先处理上述问题再执行 --execute。\n"
                f"    C 类异常（person_id 解析失败）不阻断迁移，可选择先执行后手动补录。"
            )
        else:
            conclusion = (
                f"  [NG] 迁移完成，但有 {total_errors} 条数据未能自动处理，\n"
                f"    请按异常详情逐条确认，必要时手动补录 project_members 表。"
            )

    lines.append(conclusion)
    lines.append(_divider("═"))
    return "\n".join(lines)


# ── 主流程 ────────────────────────────────────────────────────────────────────

def run(db_path: Path, dry_run: bool, out_path: Path | None) -> None:
    if not db_path.exists():
        raise FileNotFoundError(f"数据库文件不存在: {db_path}")

    if not dry_run:
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup = db_path.with_name(f"{db_path.stem}.premigrate_{ts}{db_path.suffix}")
        shutil.copy2(db_path, backup)
        print(f"[备份] {backup}")

    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA foreign_keys = OFF")

    try:
        if not dry_run:
            conn.execute("BEGIN")

        # Step A：各业务表 project_id 回填
        step_a: dict[str, tuple[int, list[dict]]] = {}
        for table_name, source_col in [
            ("tasks",        "special_project"),
            ("issues",       "special_project"),
            ("achievements", "special_project"),
            ("meetings",     "related_special_project"),
        ]:
            step_a[table_name] = backfill_project_id_from_name(
                conn, table_name, source_col, dry_run
            )

        # Step B：update_submissions project_id 回填
        step_b = backfill_update_submissions(conn, dry_run)

        # Step C：project_members 迁移
        step_c = migrate_project_members(conn, dry_run)

        # Step D：全局 CEO → project_ceo
        step_d = migrate_ceo_to_project_role(conn, dry_run)

        if not dry_run:
            conn.commit()

    except Exception:
        if not dry_run:
            conn.rollback()
        raise
    finally:
        try:
            conn.execute("PRAGMA foreign_keys = ON")
        except Exception:
            pass
        conn.close()

    mode = "report-only" if dry_run else "execute"
    report = format_report(mode, step_a, step_b, step_c, step_d)

    # 先写文件（防止终端编码异常时文件也丢失）
    if out_path:
        out_path.write_text(report, encoding="utf-8")
        print(f"[报告已保存至] {out_path}")

    # 终端输出：编码安全处理
    try:
        print(report)
    except UnicodeEncodeError:
        safe = report.encode("utf-8", errors="replace").decode(
            __import__("sys").stdout.encoding or "ascii", errors="replace"
        )
        print(safe)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="博维AI驾驶舱 · 第一阶段 P0 数据迁移脚本",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--db",
        type=Path,
        default=DEFAULT_DB,
        help=f"SQLite 数据库路径（默认：{DEFAULT_DB}）",
    )
    parser.add_argument(
        "--report-only",
        action="store_true",
        help="仅输出迁移报告，不修改数据库",
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="执行迁移（自动备份数据库后写入）",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="将报告写入指定文件（可选）",
    )
    args = parser.parse_args()

    if args.report_only == args.execute:
        parser.error("必须指定 --report-only 或 --execute 其中一个，且不能同时指定。")

    run(args.db, dry_run=args.report_only, out_path=args.out)


if __name__ == "__main__":
    main()
