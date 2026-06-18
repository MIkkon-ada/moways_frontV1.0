import logging
import os

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse, PlainTextResponse, RedirectResponse
from sqlalchemy import text

from . import models
from .auth import create_session, delete_session, get_session_user, login_block_reason, verify_password
from .database import Base, SessionLocal, engine
from .excel_importer import read_project_assignments
from .llm_config import PROVIDERS, load_configs
from .settings import get_settings
from .routers import accounts, achievement_submissions, achievements, admin, confirmations, dashboard, issues, llm_config, logs, meetings, people, platform_settings, projects, setup, subtask_drafts, subtasks, tasks, transcribe, updates
from .seed import EXCEL_SEED, seed

logging.basicConfig(
    level=get_settings().log_level,
    format="%(asctime)s %(levelname)s %(name)s - %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("bowei")

app = FastAPI(title="博维AI升级项目驾驶舱", version="0.3")

_PUBLIC_PREFIXES = ("/api/auth/", "/api/llm-config/enabled", "/api/health", "/api/setup", "/login", "/setup")


@app.exception_handler(Exception)
async def _unhandled_exception_handler(request: Request, exc: Exception):
    logger.exception("Unhandled error %s %s", request.method, request.url.path)
    return JSONResponse({"detail": "服务器内部错误，请稍后重试"}, status_code=500)


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    settings = get_settings()
    path = request.url.path
    if any(path == prefix or path.startswith(prefix) for prefix in _PUBLIC_PREFIXES):
        return await call_next(request)

    session_id = request.cookies.get(settings.session_cookie_name)
    user = get_session_user(session_id) if session_id else None
    if not user:
        if path.startswith("/api/"):
            return JSONResponse({"detail": "未登录，请先登录"}, status_code=401)
        return RedirectResponse("/login", status_code=302)
    return await call_next(request)


@app.on_event("startup")
def startup():
    Base.metadata.create_all(bind=engine)
    # 在线迁移：为 tasks 表补充 submitter 列（旧库升级，仅 SQLite）
    # 先用 PRAGMA 检查列是否存在，再执行 ALTER，避免多 worker 并发启动时的竞态日志噪声
    from .database import _is_sqlite
    if _is_sqlite:
        with engine.connect() as _conn:
            # ── tasks 表在线迁移 ──────────────────────────────────
            tasks_cols = {row[1] for row in _conn.execute(text("PRAGMA table_info(tasks)")).fetchall()}
            if "submitter" not in tasks_cols:
                try:
                    _conn.execute(text("ALTER TABLE tasks ADD COLUMN submitter VARCHAR(50) DEFAULT ''"))
                    _conn.commit()
                except Exception:
                    pass
            if "source_submission_id" not in tasks_cols:
                try:
                    _conn.execute(text("ALTER TABLE tasks ADD COLUMN source_submission_id INTEGER"))
                    _conn.commit()
                except Exception:
                    pass
            if "confirmed_by" not in tasks_cols:
                try:
                    _conn.execute(text("ALTER TABLE tasks ADD COLUMN confirmed_by VARCHAR(50) DEFAULT ''"))
                    _conn.commit()
                except Exception:
                    pass
            if "edit_count" not in tasks_cols:
                try:
                    _conn.execute(text("ALTER TABLE tasks ADD COLUMN edit_count INTEGER DEFAULT 0"))
                    _conn.commit()
                except Exception:
                    pass
            for col, ddl in (
                ("is_deleted", "ALTER TABLE tasks ADD COLUMN is_deleted INTEGER DEFAULT 0"),
                ("deleted_at", "ALTER TABLE tasks ADD COLUMN deleted_at DATETIME"),
                ("deleted_by", "ALTER TABLE tasks ADD COLUMN deleted_by VARCHAR(50) DEFAULT ''"),
                ("delete_reason", "ALTER TABLE tasks ADD COLUMN delete_reason TEXT DEFAULT ''"),
                ("delete_batch_id", "ALTER TABLE tasks ADD COLUMN delete_batch_id VARCHAR(64) DEFAULT ''"),
            ):
                if col not in tasks_cols:
                    try:
                        _conn.execute(text(ddl))
                        _conn.commit()
                    except Exception:
                        pass

            # ── achievements 表在线迁移 ───────────────────────────
            ach_cols = {row[1] for row in _conn.execute(text("PRAGMA table_info(achievements)")).fetchall()}
            if "source_submission_id" not in ach_cols:
                try:
                    _conn.execute(text("ALTER TABLE achievements ADD COLUMN source_submission_id INTEGER"))
                    _conn.commit()
                except Exception:
                    pass
            if "confirmed_by" not in ach_cols:
                try:
                    _conn.execute(text("ALTER TABLE achievements ADD COLUMN confirmed_by VARCHAR(50) DEFAULT ''"))
                    _conn.commit()
                except Exception:
                    pass
            if "edit_count" not in ach_cols:
                try:
                    _conn.execute(text("ALTER TABLE achievements ADD COLUMN edit_count INTEGER DEFAULT 0"))
                    _conn.commit()
                except Exception:
                    pass
            if "source_achievement_submission_id" not in ach_cols:
                try:
                    _conn.execute(text("ALTER TABLE achievements ADD COLUMN source_achievement_submission_id INTEGER"))
                    _conn.commit()
                except Exception:
                    pass

            # ── issues 表在线迁移 ─────────────────────────────────
            issue_cols = {row[1] for row in _conn.execute(text("PRAGMA table_info(issues)")).fetchall()}
            if "source_submission_id" not in issue_cols:
                try:
                    _conn.execute(text("ALTER TABLE issues ADD COLUMN source_submission_id INTEGER"))
                    _conn.commit()
                except Exception:
                    pass
            if "confirmed_by" not in issue_cols:
                try:
                    _conn.execute(text("ALTER TABLE issues ADD COLUMN confirmed_by VARCHAR(50) DEFAULT ''"))
                    _conn.commit()
                except Exception:
                    pass
            if "edit_count" not in issue_cols:
                try:
                    _conn.execute(text("ALTER TABLE issues ADD COLUMN edit_count INTEGER DEFAULT 0"))
                    _conn.commit()
                except Exception:
                    pass

            # ── subtasks 表在线迁移 ───────────────────────────────
            sub_cols = {row[1] for row in _conn.execute(text("PRAGMA table_info(subtasks)")).fetchall()}
            for col, ddl in (
                ("is_deleted", "ALTER TABLE subtasks ADD COLUMN is_deleted INTEGER DEFAULT 0"),
                ("deleted_at", "ALTER TABLE subtasks ADD COLUMN deleted_at DATETIME"),
                ("deleted_by", "ALTER TABLE subtasks ADD COLUMN deleted_by VARCHAR(50) DEFAULT ''"),
                ("delete_reason", "ALTER TABLE subtasks ADD COLUMN delete_reason TEXT DEFAULT ''"),
                ("delete_batch_id", "ALTER TABLE subtasks ADD COLUMN delete_batch_id VARCHAR(64) DEFAULT ''"),
                ("deleted_by_parent_id", "ALTER TABLE subtasks ADD COLUMN deleted_by_parent_id INTEGER"),
                ("source_submission_id", "ALTER TABLE subtasks ADD COLUMN source_submission_id INTEGER"),
            ):
                if col not in sub_cols:
                    try:
                        _conn.execute(text(ddl))
                        _conn.commit()
                    except Exception:
                        pass

            # ── accounts 表在线迁移 ───────────────────────────────
            acc_cols = {row[1] for row in _conn.execute(text("PRAGMA table_info(accounts)")).fetchall()}
            if "must_change_password" not in acc_cols:
                try:
                    _conn.execute(text("ALTER TABLE accounts ADD COLUMN must_change_password INTEGER DEFAULT 0"))
                    _conn.commit()
                except Exception:
                    pass

            # ── operation_logs 表在线迁移 ─────────────────────────
            log_cols = {row[1] for row in _conn.execute(text("PRAGMA table_info(operation_logs)")).fetchall()}
            if "note" not in log_cols:
                try:
                    _conn.execute(text("ALTER TABLE operation_logs ADD COLUMN note TEXT DEFAULT ''"))
                    _conn.commit()
                except Exception:
                    pass

            # ── subtask_drafts 表在线迁移 ─────────────────────────
            draft_cols = {row[1] for row in _conn.execute(text("PRAGMA table_info(subtask_drafts)")).fetchall()}
            if not draft_cols:
                _conn.execute(text(
                    "CREATE TABLE IF NOT EXISTS subtask_drafts ("
                    "id INTEGER PRIMARY KEY, project_id INTEGER, parent_task_id INTEGER, "
                    "title VARCHAR(200) NOT NULL, proposer VARCHAR(50) NOT NULL, "
                    "assignee VARCHAR(50) DEFAULT '', plan_time VARCHAR(20) DEFAULT '', "
                    "status VARCHAR(20) DEFAULT 'pending', reject_reason TEXT DEFAULT '', "
                    "source_submission_id INTEGER, "
                    "created_at DATETIME, updated_at DATETIME)"
                ))
                _conn.commit()

    # 清理过期 session（防止 auth_sessions 表长期无限增长）
    with SessionLocal() as _db:
        from datetime import datetime as _dt
        _db.query(models.AuthSession).filter(
            models.AuthSession.expires_at <= _dt.utcnow()
        ).delete(synchronize_session=False)
        _db.commit()

    if os.getenv("BOWEI_DEV_MODE", "").lower() == "true":
        db = SessionLocal()
        try:
            seed(db)
        finally:
            db.close()

    logger.info("博维AI驾驶舱启动完成")


@app.get("/api/health")
def health_check():
    settings = get_settings()
    try:
        with SessionLocal() as db:
            db.execute(text("SELECT 1"))
        return {
            "status": "ok",
            "app": "bowei-ai-dashboard",
            "env": settings.app_env,
            "database": "ok",
        }
    except Exception:
        logger.warning("health check database probe failed")
        return JSONResponse(
            {
                "status": "error",
                "app": "bowei-ai-dashboard",
                "env": settings.app_env,
                "database": "error",
            },
            status_code=503,
        )


@app.get("/login")
def login_page():
    return PlainTextResponse(
        "Legacy UI removed. Open the new frontend at http://127.0.0.1:5173",
        status_code=200,
    )


@app.post("/api/auth/login")
async def auth_login(request: Request, response: Response):
    settings = get_settings()
    try:
        body = await request.json()
    except Exception:
        return JSONResponse({"detail": "请求格式错误"}, status_code=400)

    username = (body.get("username") or "").strip()
    password = body.get("password") or ""
    if not username or not password:
        return JSONResponse({"detail": "姓名或密码不能为空"}, status_code=400)

    blocked = login_block_reason(username)
    if blocked:
        status_code, detail = blocked
        logger.warning("登录被拒绝: %s status=%s", username, status_code)
        return JSONResponse({"detail": detail}, status_code=status_code)

    if not verify_password(username, password):
        logger.warning("登录失败: %s", username)
        return JSONResponse({"detail": "姓名或密码错误，请重试"}, status_code=401)

    sid = create_session(username)
    logger.info("用户登录: %s", username)
    resp = JSONResponse({"ok": True, "username": username})
    resp.set_cookie(
        settings.session_cookie_name,
        sid,
        httponly=True,
        secure=settings.session_cookie_secure,
        samesite=settings.session_cookie_samesite,
        max_age=settings.session_ttl_seconds,
        path="/",
    )
    return resp


@app.post("/api/auth/logout")
def auth_logout(request: Request):
    settings = get_settings()
    sid = request.cookies.get(settings.session_cookie_name)
    if sid:
        delete_session(sid)
    resp = JSONResponse({"ok": True})
    resp.delete_cookie(
        settings.session_cookie_name,
        path="/",
        secure=settings.session_cookie_secure,
        samesite=settings.session_cookie_samesite,
    )
    return resp


@app.get("/api/auth/me")
def auth_me(request: Request):
    sid = request.cookies.get(get_settings().session_cookie_name)
    user = get_session_user(sid) if sid else None
    if not user:
        return JSONResponse({"detail": "未登录"}, status_code=401)
    return {"username": user}


@app.get("/")
def index():
    return PlainTextResponse(
        "Legacy UI removed. Open the new frontend at http://127.0.0.1:5173",
        status_code=200,
    )


@app.get("/api/llm-config/enabled")
def llm_config_enabled():
    """Public endpoint that returns enabled providers."""
    stored = load_configs()
    return [
        {"provider": provider, "display_name": meta["display"]}
        for provider, meta in PROVIDERS.items()
        if stored.get(provider, {}).get("enabled", False)
    ]


@app.get("/api/project-assignments")
def project_assignments():
    if EXCEL_SEED.exists():
        return read_project_assignments(EXCEL_SEED)
    return []


app.include_router(setup.router)
app.include_router(dashboard.router)
app.include_router(updates.router)
app.include_router(confirmations.router)
app.include_router(tasks.router)
app.include_router(achievements.router)
app.include_router(achievement_submissions.router)
app.include_router(issues.router)
app.include_router(meetings.router)
app.include_router(people.router)
app.include_router(accounts.router)
app.include_router(projects.router)
app.include_router(logs.router)
app.include_router(llm_config.router)
app.include_router(platform_settings.router)
app.include_router(transcribe.router)
app.include_router(subtasks.router)
app.include_router(subtask_drafts.router)
app.include_router(admin.router)
