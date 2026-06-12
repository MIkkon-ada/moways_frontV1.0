"""
Session-based authentication.
Passwords are stored as SHA-256 hex digests in passwords.json (project root).
Sessions are stored in the database so multiple worker processes share the same login state.
"""
import hashlib
import secrets
from datetime import timedelta

from .database import SessionLocal
from .models import AuthSession
from .settings import get_auth_passwords, get_settings

IMPERSONATE_ALLOWED = {"mowasyadmin"}


def _now():
    from datetime import datetime

    return datetime.utcnow()


def _sha256(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def verify_password(username: str, password: str) -> bool:
    store = get_auth_passwords()
    expected = store.get(username)
    if not expected:
        return False
    return secrets.compare_digest(expected, _sha256(password))


def _delete_expired_sessions(db, now=None):
    now = now or _now()
    db.query(AuthSession).filter(AuthSession.expires_at <= now).delete(synchronize_session=False)


def create_session(username: str) -> str:
    sid = secrets.token_hex(32)
    now = _now()
    ttl_seconds = get_settings().session_ttl_seconds
    with SessionLocal() as db:
        _delete_expired_sessions(db, now)
        db.add(
            AuthSession(
                session_id=sid,
                username=username,
                created_at=now,
                expires_at=now + timedelta(seconds=ttl_seconds),
                last_seen_at=now,
            )
        )
        db.commit()
    return sid


def get_session_user(session_id: str) -> str | None:
    if not session_id:
        return None
    now = _now()
    with SessionLocal() as db:
        session = db.get(AuthSession, session_id)
        if not session:
            return None
        if session.expires_at <= now:
            db.delete(session)
            db.commit()
            return None
        session.last_seen_at = now
        db.commit()
        return session.username


def delete_session(session_id: str) -> None:
    if not session_id:
        return
    with SessionLocal() as db:
        session = db.get(AuthSession, session_id)
        if session:
            db.delete(session)
            db.commit()


def hash_password(raw: str) -> str:
    """Utility: generate the hash to store in passwords.json."""
    return _sha256(raw)
