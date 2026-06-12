#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

DB_PATH="${DB_PATH:-$ROOT_DIR/bowei_ai_dashboard.db}"
BACKUP_DIR="${BACKUP_DIR:-$ROOT_DIR/backups}"
DATE="$(date +%Y%m%d_%H%M%S)"
DB_BASENAME="$(basename "$DB_PATH")"
DB_STEM="${DB_BASENAME%.*}"
BACKUP_FILE="$BACKUP_DIR/${DB_STEM}_${DATE}.db"

if [[ ! -f "$DB_PATH" ]]; then
  echo "[backup] source database not found: $DB_PATH" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

python - "$DB_PATH" "$BACKUP_FILE" <<'PY'
from __future__ import annotations

import os
import sqlite3
import sys

src, dst = sys.argv[1:3]
os.makedirs(os.path.dirname(dst), exist_ok=True)

with sqlite3.connect(src) as source, sqlite3.connect(dst) as target:
    source.backup(target)

if not os.path.exists(dst) or os.path.getsize(dst) <= 0:
    raise SystemExit("[backup] backup file was not created correctly")
PY

if [[ ! -s "$BACKUP_FILE" ]]; then
  echo "[backup] backup file is missing or empty: $BACKUP_FILE" >&2
  exit 1
fi

echo "$(date '+%Y-%m-%d %H:%M:%S') backup completed: $BACKUP_FILE"
