#!/bin/bash
# Production deployment script for Linux (Ubuntu/Debian)
# Run once on initial setup, or after pulling code updates.
set -euo pipefail

APP_DIR="/opt/bowei_ai_dashboard"
VENV="$APP_DIR/.venv"

echo "=== 更新依赖 ==="
"$VENV/bin/pip" install -q -r "$APP_DIR/requirements.txt"

echo "=== 数据库迁移 ==="
cd "$APP_DIR"
"$VENV/bin/python" migrate_sqlite_schema.py 2>/dev/null || true

echo "=== 重启服务 ==="
systemctl restart bowei

echo "=== 部署完成 ==="
systemctl status bowei --no-pager
