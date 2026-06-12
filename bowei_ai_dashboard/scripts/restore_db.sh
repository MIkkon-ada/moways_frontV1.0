#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: $0 <backup_file> <target_db>" >&2
}

if [[ $# -ne 2 ]]; then
  usage
  exit 1
fi

BACKUP_FILE="$1"
TARGET_DB="$2"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"

if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "[restore] backup file not found: $BACKUP_FILE" >&2
  exit 1
fi

if [[ ! -s "$BACKUP_FILE" ]]; then
  echo "[restore] backup file is empty: $BACKUP_FILE" >&2
  exit 1
fi

TARGET_DIR="$(dirname "$TARGET_DB")"
mkdir -p "$TARGET_DIR"

if [[ -e "$TARGET_DB" ]]; then
  PRE_RESTORE_BACKUP="${TARGET_DB}.pre_restore_${TIMESTAMP}.bak"
  cp -p "$TARGET_DB" "$PRE_RESTORE_BACKUP"
  if [[ ! -s "$PRE_RESTORE_BACKUP" ]]; then
    echo "[restore] failed to create pre-restore backup: $PRE_RESTORE_BACKUP" >&2
    exit 1
  fi
  echo "[restore] existing target preserved as: $PRE_RESTORE_BACKUP"
fi

python - "$BACKUP_FILE" "$TARGET_DB" <<'PY'
from __future__ import annotations

import os
import shutil
import sys

src, dst = sys.argv[1:3]
os.makedirs(os.path.dirname(dst) or ".", exist_ok=True)
shutil.copy2(src, dst)

if not os.path.exists(dst) or os.path.getsize(dst) <= 0:
    raise SystemExit("[restore] restored database missing or empty")
PY

if [[ ! -s "$TARGET_DB" ]]; then
  echo "[restore] restored target database missing or empty: $TARGET_DB" >&2
  exit 1
fi

echo "[restore] restore completed: $TARGET_DB"
