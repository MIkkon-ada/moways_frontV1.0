#!/usr/bin/env python3
"""Read-only data governance dry-run for project_id / TEST_* cleanup.

This script only inspects the database and prints a JSON report.
It never performs UPDATE / DELETE / INSERT / ALTER / DROP operations.
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB = ROOT / "bowei_ai_dashboard.db"
DEFAULT_OUTPUT = ROOT / "_local_archive" / "data_governance_report.json"

TRACKED_TABLES = ("tasks", "achievements", "issues", "meetings", "update_submissions")


@dataclass(frozen=True)
class GovernanceRecord:
    table: str
    id: int
    classification: str
    recommendation: str
    reason: str
    payload: dict[str, Any]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a read-only data governance report.")
    parser.add_argument("--db", type=Path, default=DEFAULT_DB, help="Path to the SQLite database file.")
    parser.add_argument(
        "--format",
        choices=("json", "text"),
        default="json",
        help="Output format. JSON is the default and recommended format.",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=None,
        help="Optional path to write the report file. No database changes are made.",
    )
    return parser.parse_args()


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def open_readonly_db(db_path: Path) -> sqlite3.Connection:
    if not db_path.exists():
        raise FileNotFoundError(f"database not found: {db_path}")
    uri = db_path.resolve().as_uri() + "?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def fetch_all(conn: sqlite3.Connection, sql: str, params: dict[str, Any] | tuple[Any, ...] = ()) -> list[sqlite3.Row]:
    return conn.execute(sql, params).fetchall()


def fetch_one(conn: sqlite3.Connection, sql: str, params: dict[str, Any] | tuple[Any, ...] = ()) -> sqlite3.Row | None:
    return conn.execute(sql, params).fetchone()


def normalize_text(value: Any) -> str:
    return "" if value is None else str(value).strip()


def project_name_set(conn: sqlite3.Connection) -> set[str]:
    rows = fetch_all(conn, "SELECT name FROM projects")
    return {normalize_text(row["name"]) for row in rows if normalize_text(row["name"])}


def table_has_column(conn: sqlite3.Connection, table: str, column: str) -> bool:
    rows = fetch_all(conn, f"PRAGMA table_info({table})")
    return any(normalize_text(row["name"]) == column for row in rows)


def list_columns(conn: sqlite3.Connection, table: str) -> set[str]:
    rows = fetch_all(conn, f"PRAGMA table_info({table})")
    return {normalize_text(row["name"]) for row in rows}


def column_or_default(row: sqlite3.Row, column: str, default: Any = "") -> Any:
    try:
        value = row[column]
    except (IndexError, KeyError):
        return default
    return default if value is None else value


def count_where(conn: sqlite3.Connection, table: str, where_clause: str, params: dict[str, Any] | tuple[Any, ...] = ()) -> int:
    row = fetch_one(conn, f"SELECT COUNT(*) AS count FROM {table} WHERE {where_clause}", params)
    return int(row["count"]) if row else 0


def safe_json_loads(raw: Any) -> Any:
    if raw is None:
        return None
    text = normalize_text(raw)
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def extract_special_project_values(raw: Any) -> list[str]:
    """Recursively collect project-name-like values from JSON payloads."""

    collected: list[str] = []

    def walk(value: Any) -> None:
        if isinstance(value, dict):
            for key, inner in value.items():
                if key in {"special_project", "related_special_project"} and isinstance(inner, str):
                    candidate = inner.strip()
                    if candidate and candidate not in collected:
                        collected.append(candidate)
                else:
                    walk(inner)
        elif isinstance(value, list):
            for item in value:
                walk(item)

    data = safe_json_loads(raw)
    if data is not None:
        walk(data)
    return collected


def looks_like_test_data(*values: Any) -> bool:
    text = " ".join(normalize_text(v).lower() for v in values if normalize_text(v))
    if not text:
        return False
    needles = (
        "test",
        "mowasyadmin",
        "localhost",
        "127.0.0.1",
        "admin123",
        "bowei2024",
        "测试",
        "验收",
        "回归",
    )
    return any(needle in text for needle in needles)


def classify_null_record(
    table: str,
    row: sqlite3.Row,
    project_names: set[str],
) -> GovernanceRecord:
    row_id = int(row["id"])
    payload: dict[str, Any] = {
        "table": table,
        "id": row_id,
        "project_id": None,
        "created_at": normalize_text(column_or_default(row, "created_at", "")),
        "updated_at": normalize_text(column_or_default(row, "updated_at", "")),
    }

    recommendation = "人工确认"
    reason = "project_id 为空，未能自动确认归属"
    classification = "C"

    if table == "tasks":
        special_project = normalize_text(column_or_default(row, "special_project", ""))
        payload.update(
            {
                "title": normalize_text(column_or_default(row, "key_task", "")),
                "special_project": special_project,
                "owner": normalize_text(column_or_default(row, "owner", "")),
                "status": normalize_text(column_or_default(row, "status", "")),
            }
        )
        if special_project and special_project in project_names:
            classification = "A"
            recommendation = "可自动回填"
            reason = f"special_project='{special_project}' 可唯一匹配现有项目"
        elif not special_project and looks_like_test_data(payload["title"], payload["owner"]):
            classification = "D"
            recommendation = "删除候选"
            reason = "special_project 为空且提交者/内容呈现测试数据特征"
        elif special_project:
            classification = "C"
            recommendation = "人工确认"
            reason = f"special_project='{special_project}' 未匹配到现有项目"
        else:
            classification = "C"
            recommendation = "人工确认"
            reason = "special_project 为空但仍需人工确认"

    elif table == "achievements":
        special_project = normalize_text(column_or_default(row, "special_project", ""))
        payload.update(
            {
                "title": normalize_text(column_or_default(row, "name", "")),
                "special_project": special_project,
                "owner": normalize_text(column_or_default(row, "owner", "")),
                "status": normalize_text(column_or_default(row, "status", "")),
            }
        )
        if special_project and special_project in project_names:
            classification = "A"
            recommendation = "可自动回填"
            reason = f"special_project='{special_project}' 可唯一匹配现有项目"
        elif special_project:
            classification = "C"
            recommendation = "人工确认"
            reason = f"special_project='{special_project}' 未匹配到现有项目"
        elif looks_like_test_data(payload["title"], payload["owner"]):
            classification = "D"
            recommendation = "删除候选"
            reason = "special_project 为空且内容呈现测试数据特征"
        else:
            classification = "C"
            recommendation = "人工确认"
            reason = "special_project 为空但仍需人工确认"

    elif table == "issues":
        special_project = normalize_text(column_or_default(row, "special_project", ""))
        payload.update(
            {
                "title": normalize_text(column_or_default(row, "description", "")),
                "special_project": special_project,
                "owner": normalize_text(column_or_default(row, "owner", "")),
                "status": normalize_text(column_or_default(row, "status", "")),
            }
        )
        if special_project and special_project in project_names:
            classification = "A"
            recommendation = "可自动回填"
            reason = f"special_project='{special_project}' 可唯一匹配现有项目"
        elif special_project:
            classification = "C"
            recommendation = "人工确认"
            reason = f"special_project='{special_project}' 未匹配到现有项目"
        elif looks_like_test_data(payload["title"], payload["owner"]):
            classification = "D"
            recommendation = "删除候选"
            reason = "special_project 为空且内容呈现测试数据特征"
        else:
            classification = "C"
            recommendation = "人工确认"
            reason = "special_project 为空但仍需人工确认"

    elif table == "meetings":
        related_special_project = normalize_text(column_or_default(row, "related_special_project", ""))
        payload.update(
            {
                "title": normalize_text(column_or_default(row, "title", "")),
                "related_special_project": related_special_project,
                "meeting_type": normalize_text(column_or_default(row, "meeting_type", "")),
                "host": normalize_text(column_or_default(row, "host", "")),
            }
        )
        if related_special_project and related_special_project in project_names:
            classification = "A"
            recommendation = "可自动回填"
            reason = f"related_special_project='{related_special_project}' 可唯一匹配现有项目"
        elif related_special_project:
            classification = "C"
            recommendation = "人工确认"
            reason = f"related_special_project='{related_special_project}' 未匹配到现有项目"
        elif looks_like_test_data(payload["title"], payload["host"]):
            classification = "D"
            recommendation = "删除候选"
            reason = "related_special_project 为空且内容呈现测试数据特征"
        else:
            classification = "C"
            recommendation = "人工确认"
            reason = "related_special_project 为空但仍需人工确认"

    elif table == "update_submissions":
        parsed_special_projects: list[str] = []
        for raw_json in (column_or_default(row, "ai_result_json", ""), column_or_default(row, "human_result_json", "")):
            for name in extract_special_project_values(raw_json):
                if name not in parsed_special_projects:
                    parsed_special_projects.append(name)
        payload.update(
            {
                "title": normalize_text(column_or_default(row, "title", "")),
                "submitter": normalize_text(column_or_default(row, "submitter", "")),
                "confirm_status": normalize_text(column_or_default(row, "confirm_status", "")),
                "parsed_special_projects": parsed_special_projects,
            }
        )
        matched = [name for name in parsed_special_projects if name in project_names]
        if matched:
            classification = "A"
            recommendation = "可自动回填"
            reason = f"JSON 中 special_project 可匹配现有项目: {matched[0]}"
        elif parsed_special_projects:
            classification = "C"
            recommendation = "人工确认"
            reason = f"JSON 中 special_project 未匹配到现有项目: {', '.join(parsed_special_projects)}"
        elif looks_like_test_data(payload["title"], payload["submitter"]):
            classification = "D"
            recommendation = "删除候选"
            reason = "JSON special_project 为空且提交者/标题呈现测试数据特征"
        else:
            classification = "D"
            recommendation = "删除候选"
            reason = "JSON special_project 为空，且无法确认业务归属"

    else:
        reason = "未定义的表"

    payload["reason"] = reason
    payload["recommendation"] = recommendation
    return GovernanceRecord(
        table=table,
        id=row_id,
        classification=classification,
        recommendation=recommendation,
        reason=reason,
        payload=payload,
    )


def get_null_records(conn: sqlite3.Connection, project_names: set[str]) -> dict[str, list[dict[str, Any]]]:
    records: dict[str, list[dict[str, Any]]] = {key: [] for key in TRACKED_TABLES}
    for table in TRACKED_TABLES:
        rows = fetch_all(conn, f"SELECT * FROM {table} WHERE project_id IS NULL ORDER BY id")
        for row in rows:
            record = classify_null_record(table, row, project_names)
            record_payload = dict(record.payload)
            record_payload["classification"] = record.classification
            records[table].append(record_payload)
    return records


def get_test_projects(conn: sqlite3.Connection) -> list[dict[str, Any]]:
    rows = fetch_all(
        conn,
        """
        SELECT id, name, is_active, created_at, updated_at
        FROM projects
        WHERE name LIKE 'TEST_%'
        ORDER BY id
        """,
    )
    projects: list[dict[str, Any]] = []
    for row in rows:
        project_id = int(row["id"])
        project_name = normalize_text(row["name"])
        related_counts = {
            "project_members": count_where(conn, "project_members", "project_id = :pid", {"pid": project_id}),
            "tasks": count_where(conn, "tasks", "project_id = :pid", {"pid": project_id}),
            "achievements": count_where(conn, "achievements", "project_id = :pid", {"pid": project_id}),
            "issues": count_where(conn, "issues", "project_id = :pid", {"pid": project_id}),
            "meetings": count_where(conn, "meetings", "project_id = :pid", {"pid": project_id}),
            "update_submissions": count_where(conn, "update_submissions", "project_id = :pid", {"pid": project_id}),
        }
        projects.append(
            {
                "project_id": project_id,
                "name": project_name,
                "status": "active" if int(row["is_active"] or 0) else "archived",
                "is_active": bool(row["is_active"]),
                "created_at": normalize_text(row["created_at"]),
                "updated_at": normalize_text(row["updated_at"]),
                **related_counts,
                "recommendation": "保留归档",
                "reason": "TEST_* 归档样例，适合作为审计/回归参考",
            }
        )
    return projects


def summarize_project_id_null_counts(conn: sqlite3.Connection) -> dict[str, int]:
    return {table: count_where(conn, table, "project_id IS NULL") for table in TRACKED_TABLES}


def summarize_null_classification(records: dict[str, list[dict[str, Any]]]) -> dict[str, int]:
    counts = {"A": 0, "B": 0, "C": 0, "D": 0}
    for table_records in records.values():
        for record in table_records:
            cls = normalize_text(record.get("classification", ""))
            if cls in counts:
                counts[cls] += 1
    return counts


def collect_orphan_special_projects(records: dict[str, list[dict[str, Any]]], project_names: set[str]) -> list[str]:
    orphaned: OrderedDict[str, None] = OrderedDict()
    for table_records in records.values():
        for record in table_records:
            for key in ("special_project", "related_special_project"):
                raw = normalize_text(record.get(key, ""))
                if raw and raw not in project_names:
                    orphaned.setdefault(raw, None)
            for raw in record.get("parsed_special_projects", []) or []:
                raw_text = normalize_text(raw)
                if raw_text and raw_text not in project_names:
                    orphaned.setdefault(raw_text, None)
    return list(orphaned.keys())


def build_report(conn: sqlite3.Connection, db_path: Path) -> dict[str, Any]:
    project_names = project_name_set(conn)
    null_records = get_null_records(conn, project_names)
    test_projects = get_test_projects(conn)
    null_counts = summarize_project_id_null_counts(conn)
    null_class_counts = summarize_null_classification(null_records)
    orphan_project_names = collect_orphan_special_projects(null_records, project_names)

    summary = {
        "project_id_null_counts": null_counts,
        "project_id_null_total": sum(null_counts.values()),
        "null_class_counts": null_class_counts,
        "test_projects_count": len(test_projects),
        "active_test_projects_count": sum(1 for row in test_projects if row["is_active"]),
        "archived_test_projects_count": sum(1 for row in test_projects if not row["is_active"]),
        "orphan_special_project_names_count": len(orphan_project_names),
    }

    classes: dict[str, list[dict[str, Any]]] = {
        "A_auto_backfill_candidates": [],
        "B_archive_keep": [],
        "C_manual_review": [],
        "D_delete_candidates": [],
    }

    for table_rows in null_records.values():
        for record in table_rows:
            cls = normalize_text(record.get("classification"))
            if cls == "A":
                classes["A_auto_backfill_candidates"].append(record)
            elif cls == "B":
                classes["B_archive_keep"].append(record)
            elif cls == "D":
                classes["D_delete_candidates"].append(record)
            else:
                classes["C_manual_review"].append(record)

    classes["B_archive_keep"].extend(test_projects)

    summary["governance_class_counts"] = {
        "A": len(classes["A_auto_backfill_candidates"]),
        "B": len(classes["B_archive_keep"]),
        "C": len(classes["C_manual_review"]),
        "D": len(classes["D_delete_candidates"]),
    }

    risks = [
        {
            "risk_id": "P0-DATA-1",
            "name": "无法自动确认归属的数据不能直接回填",
            "current_state": "存在 project_id=NULL 记录和无法映射的 special_project",
            "impact": "误回填会污染历史数据和统计口径",
            "blocking": True,
            "recommendation": "仅在人工确认后处理 C 类记录",
            "batch": "L3-1D/L3-1E",
            "acceptance": "所有不确定记录完成人工确认或明确保留策略",
        },
        {
            "risk_id": "P1-DATA-1",
            "name": "project_id=NULL 残留影响统计",
            "current_state": f"tasks/achievements/update_submissions 共 {summary['project_id_null_total']} 条残留",
            "impact": "报表和权限相关视图可能存在口径偏差",
            "blocking": False,
            "recommendation": "建立治理流程，逐步收敛 NULL 数据",
            "batch": "L3-1D",
            "acceptance": "残留数量下降且每条记录有明确归类",
        },
        {
            "risk_id": "P1-DATA-2",
            "name": "TEST_* 归档数据影响统计口径",
            "current_state": f"{summary['test_projects_count']} 个 TEST_* 项目仍保留",
            "impact": "若统计未排除 archived 项目，可能影响正式报表",
            "blocking": False,
            "recommendation": "默认排除 archived TEST_* 项目，保留审计样本",
            "batch": "L3-1D",
            "acceptance": "正式统计不纳入 archived TEST_*",
        },
        {
            "risk_id": "P2-DATA-1",
            "name": "special_project 兼容层退场",
            "current_state": "仍存在 special_project / related_special_project 过渡字段",
            "impact": "迁移和权限逻辑复杂",
            "blocking": False,
            "recommendation": "后续逐步收口到 project_id 主线",
            "batch": "L3-2/L5",
            "acceptance": "新数据以 project_id 为主，兼容层可逐步收缩",
        },
    ]

    next_steps = [
        "先人工确认 C 类记录：tasks 1-4、achievements 1-4",
        "将 D 类候选纳入备份后再执行删除/清理流程",
        "保持 TEST_* 归档样例，仅在正式统计中默认排除",
        "下一批建议做 dry-run 执行器，不直接写库",
    ]

    return {
        "generated_at": utc_now_iso(),
        "database": str(db_path.resolve()),
        "read_only": True,
        "summary": summary,
        "project_id_null_records": null_records,
        "test_projects": test_projects,
        "classes": classes,
        "orphan_special_project_names": orphan_project_names,
        "risks": risks,
        "next_steps": next_steps,
    }


def render_text(report: dict[str, Any]) -> str:
    lines = []
    lines.append(f"database: {report['database']}")
    lines.append(f"generated_at: {report['generated_at']}")
    lines.append(f"read_only: {report['read_only']}")
    summary = report["summary"]
    lines.append("project_id NULL counts:")
    for table, count in summary["project_id_null_counts"].items():
        lines.append(f"  - {table}: {count}")
    lines.append(f"test_projects_count: {summary['test_projects_count']}")
    lines.append(f"active_test_projects_count: {summary['active_test_projects_count']}")
    lines.append(f"archived_test_projects_count: {summary['archived_test_projects_count']}")
    lines.append("classification counts:")
    for key, value in summary["governance_class_counts"].items():
        lines.append(f"  - {key}: {value}")
    lines.append("null-record class counts:")
    for key, value in summary["null_class_counts"].items():
        lines.append(f"  - {key}: {value}")
    lines.append("class sizes:")
    for key, value in report["classes"].items():
        lines.append(f"  - {key}: {len(value)}")
    if report["orphan_special_project_names"]:
        lines.append("orphan special_project names:")
        for name in report["orphan_special_project_names"]:
            lines.append(f"  - {name}")
    return "\n".join(lines)


def main() -> int:
    args = parse_args()
    try:
        with open_readonly_db(args.db) as conn:
            report = build_report(conn, args.db)
    except FileNotFoundError as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        return 2
    except sqlite3.Error as exc:
        print(f"[ERROR] unable to read database in read-only mode: {exc}", file=sys.stderr)
        return 3

    if args.format == "text":
        output = render_text(report)
    else:
        output = json.dumps(report, ensure_ascii=False, indent=2, sort_keys=False)

    print(output)

    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(output + ("\n" if not output.endswith("\n") else ""), encoding="utf-8")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
