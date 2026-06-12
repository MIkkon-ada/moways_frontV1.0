# SQLite Backup / Restore SOP

## Scope

This SOP applies only to the current SQLite-based internal trial / small-scope trial stage.
It is **not** the production PostgreSQL backup SOP.

## Backup prerequisites

Before backing up:

1. Confirm the service state and prefer a low-write window.
2. Confirm `DB_PATH`.
3. Confirm `BACKUP_DIR`.
4. Make sure the database file is the intended SQLite file.

## Backup

Default paths:

- `DB_PATH` defaults to `./bowei_ai_dashboard.db`
- `BACKUP_DIR` defaults to `./backups/`

Backup command examples:

```bash
scripts/backup_db.sh
```

```bash
DB_PATH=/path/to/bowei_ai_dashboard.db BACKUP_DIR=/path/to/backups scripts/backup_db.sh
```

The backup script uses a SQLite backup snapshot workflow and writes a timestamped file such as:

`bowei_ai_dashboard_YYYYMMDD_HHMMSS.db`

## Restore

Restore command format:

```bash
scripts/restore_db.sh <backup_file> <target_db>
```

Examples:

```bash
scripts/restore_db.sh backups/bowei_ai_dashboard_20260531_030000.db /tmp/test_dashboard.db
```

```bash
scripts/restore_db.sh backups/bowei_ai_dashboard_20260531_030000.db ./bowei_ai_dashboard.db
```

If the target database already exists, the restore script creates a pre-restore backup named like:

`<target_db>.pre_restore_YYYYMMDD_HHMMSS.bak`

## Restore rehearsal

Recommended rehearsal flow:

1. Back up the current database.
2. Restore the backup to a temporary database file.
3. Point `DATABASE_URL` to the temporary database.
4. Start the backend.
5. Verify `GET /api/health`.
6. Do **not** overwrite the formal database during rehearsal.

## Rollback SOP

If a rollback is needed:

1. Stop the service.
2. Back up the current database file first.
3. Restore the chosen backup into the target database path.
4. Start the service again.
5. Verify `GET /api/health`.
6. Verify login / me / logout.

## Risks

- SQLite is not suitable for multi-node production writes.
- Concurrent write pressure can cause locking issues.
- Restoring into the target database overwrites that target.
- Backup consistency is best when the service is stopped or writes are low.
- This SOP does not replace a PostgreSQL production backup strategy.

## Pre-launch checklist

- [ ] Confirm the target database path.
- [ ] Confirm the backup directory.
- [ ] Confirm the service can be stopped safely.
- [ ] Confirm a rollback backup exists.
- [ ] Confirm a temporary restore rehearsal has passed.
- [ ] Confirm `GET /api/health` after restore.
- [ ] Confirm login / me / logout after restore.
