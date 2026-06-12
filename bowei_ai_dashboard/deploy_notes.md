# Deployment Notes

This note captures the current one-click deployment flow for Bowei AI Dashboard.

## One-click startup

Use `run_deploy.bat` in `bowei_ai_dashboard/`:

1. Create or reuse `.venv`
2. Install Python dependencies
3. Run `migrate_sqlite_schema.py` — schema migration + permission seed (内含 seed_permissions 调用)
4. Start `uvicorn app.main:app`

> `seed_permissions.py` is called internally by `migrate_sqlite_schema.py` at the end of every migration run. Do **not** run it again separately.

## Default port

- Default port: `8000`
- Optional override: `run_deploy.bat 8010`

## What it prepares

- Formal schema migration (ALTER TABLE, new columns)
- Legacy field compatibility patching
- Default project seed data (`projects` table)
- Permission seed data and project memberships (`project_memberships` table)
- `people.system_role` backfill for DB-based permission lookup

## Permission data source

The backend now reads permissions from DB first (`people.system_role` + `project_memberships`).  
If a user is not found in the DB or `system_role` is missing, it falls back to the static mapping in `permissions.py`.

## Files involved

- `migrate_sqlite_schema.py` — schema migration + calls seed_permissions at end
- `seed_permissions.py` — seeds projects / people / memberships (also callable standalone)
- `run_deploy.bat` — single entry point
- `mowayssql.sql` — schema SQL for new tables
