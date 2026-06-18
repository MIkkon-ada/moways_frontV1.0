"""
First-time system initialization.
Provides setup status check and admin account creation.
Only works when the people table is empty (uninitialized system).
"""
import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from sqlalchemy.orm import Session

from .. import models
from ..auth import hash_password
from ..database import get_db
from ..settings import _PASSWORDS_FILE, _read_json_file

router = APIRouter(prefix="/api/setup", tags=["setup"])


def _is_initialized(db: Session) -> bool:
    return db.query(models.Person).first() is not None


@router.get("/status")
def status(db: Session = Depends(get_db)):
    return {"initialized": _is_initialized(db)}


class InitRequest(BaseModel):
    username: str
    password: str

    @field_validator("username", "password")
    @classmethod
    def not_empty(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("不能为空")
        return v.strip()

    @field_validator("password")
    @classmethod
    def min_length(cls, v: str) -> str:
        if len(v) < 6:
            raise ValueError("密码至少 6 位")
        return v


@router.post("/init")
def init(payload: InitRequest, db: Session = Depends(get_db)):
    if _is_initialized(db):
        raise HTTPException(400, "系统已初始化，不可重复执行")

    # 写入 people 表：name 必须与登录账号一致，系统用 name 做身份匹配
    person = models.Person(
        name=payload.username,
        system_role="超级管理员",
        is_admin=True,
        permission="管理",
        is_active=True,
    )
    db.add(person)
    db.flush()
    db.add(models.Account(
        username=payload.username,
        password_hash=hash_password(payload.password),
        person_id=person.id,
        status="active",
        is_tech_admin=True,
        last_password_changed_at=person.created_at,
    ))

    # 覆盖写入 passwords.json，只保留这一个新管理员，清除所有旧账号
    _PASSWORDS_FILE.write_text(
        json.dumps({payload.username: hash_password(payload.password)}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    db.commit()
    return {"ok": True}
