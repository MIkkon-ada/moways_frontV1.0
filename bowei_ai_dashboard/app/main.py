import logging
import os

from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse, PlainTextResponse, RedirectResponse
from sqlalchemy import text

from . import models
from .auth import create_session, delete_session, get_session_user, verify_password
from .database import Base, SessionLocal, engine
from .excel_importer import read_project_assignments
from .llm_config import PROVIDERS, load_configs
from .permissions import ensure_default_projects
from .settings import get_settings
from .routers import achievements, admin, confirmations, dashboard, issues, llm_config, logs, meetings, people, platform_settings, projects, subtasks, tasks, transcribe, updates
from .seed import EXCEL_SEED, seed

logging.basicConfig(
    level=get_settings().log_level,
    format="%(asctime)s %(levelname)s %(name)s - %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("bowei")

app = FastAPI(title="博维AI升级项目驾驶舱", version="0.3")

_PUBLIC_PREFIXES = ("/api/auth/", "/api/llm-config/enabled", "/api/health", "/login")


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
            existing = {row[1] for row in _conn.execute(text("PRAGMA table_info(tasks)")).fetchall()}
            if "submitter" not in existing:
                try:
                    _conn.execute(text("ALTER TABLE tasks ADD COLUMN submitter VARCHAR(50) DEFAULT ''"))
                    _conn.commit()
                except Exception:
                    pass  # 另一个 worker 抢先写入，忽略

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

    db = SessionLocal()
    try:
        ensure_default_projects(db)
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


app.include_router(dashboard.router)
app.include_router(updates.router)
app.include_router(confirmations.router)
app.include_router(tasks.router)
app.include_router(achievements.router)
app.include_router(issues.router)
app.include_router(meetings.router)
app.include_router(people.router)
app.include_router(projects.router)
app.include_router(logs.router)
app.include_router(llm_config.router)
app.include_router(platform_settings.router)
app.include_router(transcribe.router)
app.include_router(subtasks.router)
app.include_router(admin.router)
