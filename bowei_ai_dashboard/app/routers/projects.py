import json
import re
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import text
from sqlalchemy.orm import Session

from .. import crud, models, schemas
from ..database import get_db
from ..permissions import (
    PROJECT_ROLE_COLLABORATOR,
    PROJECT_ROLE_COORDINATOR,
    PROJECT_ROLE_OWNER,
    get_current_user_name,
    get_user_context_from_db,
)

router = APIRouter(prefix="/api/projects", tags=["projects"])

_VALID_ROLES = {"project_ceo", "owner", "coordinator", "member"}

# 旧展示常量 → 新 role key（用于 transition period 回落）
_OLD_ROLE_TO_KEY = {
    PROJECT_ROLE_OWNER:       "owner",
    PROJECT_ROLE_COORDINATOR: "coordinator",
    PROJECT_ROLE_COLLABORATOR: "member",
}


# ── 内部工具 ─────────────────────────────────────────────────

def _split_names(value) -> list[str]:
    source = str(value or "").strip()
    if not source:
        return []
    return [s.strip() for s in re.split(r"[,，、/;\n]+", source) if s.strip()]


def _join_names(names) -> str:
    seen: list[str] = []
    for n in names:
        n = str(n or "").strip()
        if n and n not in seen:
            seen.append(n)
    return "、".join(seen)


def _require_super_admin(current_user: str, db: Session):
    ctx = get_user_context_from_db(current_user, db)
    if not ctx.get("is_tech_admin"):
        raise HTTPException(403, "仅超级管理员可执行此操作")


def _person_name(member: models.ProjectMember, db: Session) -> str:
    name = (member.person_name_snapshot or "").strip()
    if not name:
        person = db.get(models.Person, member.person_id)
        name = person.name if person else ""
    return name


def _rebuild_person_duties(db: Session):
    projects = db.query(models.Project).filter_by(is_active=True).all()
    person_projects: dict[str, set[str]] = {}
    for p in projects:
        for name in [
            *_split_names(p.coordinator),
            *_split_names(p.owners),
            *_split_names(p.collaborators),
        ]:
            if name:
                person_projects.setdefault(name, set()).add(p.name)
    for person in db.query(models.Person).all():
        assigned = sorted(person_projects.get(person.name, set()))
        person.special_project_duty = "、".join(assigned) if assigned else ""


def _sync_project_old_fields(
    project_id: int,
    db: Session,
    exclude_names: set[str] | None = None,
):
    """
    根据 project_members 重建旧字符串字段（smart merge）。
    exclude_names: DELETE 时传入被删人名，防止其被回填为历史数据。
    """
    project = db.get(models.Project, project_id)
    if not project:
        return

    members = (
        db.query(models.ProjectMember)
        .filter(models.ProjectMember.project_id == project_id)
        .all()
    )

    pm_owners:        set[str] = set()
    pm_coordinators:  set[str] = set()
    pm_collaborators: set[str] = set()
    pm_all:           set[str] = set()

    for m in members:
        name = _person_name(m, db)
        if not name:
            continue
        pm_all.add(name)
        if m.role == "owner":
            pm_owners.add(name)
        elif m.role == "coordinator":
            pm_coordinators.add(name)
        elif m.role == "member":
            pm_collaborators.add(name)

    legacy_owners        = set(_split_names(project.owners))        - pm_all
    legacy_coordinators  = set(_split_names(project.coordinator))   - pm_all
    legacy_collaborators = set(_split_names(project.collaborators)) - pm_all

    if exclude_names:
        legacy_owners        -= exclude_names
        legacy_coordinators  -= exclude_names
        legacy_collaborators -= exclude_names

    project.owners        = _join_names(sorted(pm_owners        | legacy_owners))
    project.coordinator   = _join_names(sorted(pm_coordinators  | legacy_coordinators))
    project.collaborators = _join_names(sorted(pm_collaborators | legacy_collaborators))

    _rebuild_person_duties(db)


def _member_to_dict(m: models.ProjectMember) -> dict:
    return {
        "id":                   m.id,
        "project_id":           m.project_id,
        "person_id":            m.person_id,
        "person_name_snapshot": m.person_name_snapshot or "",
        "role":                 m.role,
        "note":                 m.note or "",
        "joined_at":            m.joined_at.isoformat() if m.joined_at else None,
    }


# ── 6A：active 项目最后 owner 保护 ────────────────────────────

def _is_active_project(project: models.Project) -> bool:
    """
    项目是否为 active 状态。
    is_active=True → active；is_active=False → 已归档。
    is_active 与 status 扩展列始终保持同步（见 archive_project / update_project）。
    """
    return bool(project.is_active)


def _count_project_owners(db: Session, project_id: int) -> int:
    """统计 project_members 中该项目 role='owner' 的记录数。"""
    return (
        db.query(models.ProjectMember)
        .filter_by(project_id=project_id, role="owner")
        .count()
    )


def _ensure_not_removing_last_owner(
    db: Session,
    project: models.Project,
    member: models.ProjectMember,
) -> None:
    """
    如果该操作会移除 active 项目的最后一个 owner，抛出 409。
    归档项目不强制要求保留 owner；非 owner 角色操作直接跳过。
    """
    if not _is_active_project(project):
        return
    if member.role != "owner":
        return
    owner_count = _count_project_owners(db, project.id)
    if owner_count <= 1:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "该项目至少需要保留一名负责人，请先指定新负责人后再移除当前负责人",
                "project_id": project.id,
                "member_id": member.id,
                "role": member.role,
                "owner_count": owner_count,
            },
        )


# ── 新增：项目主数据读取辅助 ──────────────────────────────────

def _read_project_raw(project_id: int, db: Session) -> dict | None:
    """
    用 raw SQL 读取项目所有字段（含 4B 新扩展列）。
    COALESCE 兼容旧数据库（新列可能为 NULL）。
    """
    try:
        row = db.execute(
            text("""
                SELECT id, name,
                       COALESCE(code, '')        AS code,
                       COALESCE(description, '') AS description,
                       COALESCE(status,
                           CASE WHEN is_active = 1 THEN 'active' ELSE 'archived' END
                       ) AS status,
                       COALESCE(start_date, '') AS start_date,
                       COALESCE(end_date,   '') AS end_date,
                       COALESCE(coordinator, '') AS coordinator,
                       COALESCE(owners,      '') AS owners,
                       COALESCE(collaborators,'') AS collaborators,
                       sort_order, is_active,
                       created_at, updated_at
                FROM projects WHERE id = :id
            """),
            {"id": project_id},
        ).fetchone()
    except Exception:
        return None
    if not row:
        return None
    return dict(row._mapping)


def _get_user_roles(project_id: int, proj_name: str, context: dict, db: Session) -> list[str]:
    """返回当前用户在指定项目中的角色列表。"""
    if context["can_view_all"]:
        return ["super_admin"]

    person_id = context.get("person_id")
    if person_id:
        rows = db.execute(
            text("SELECT role FROM project_members WHERE person_id = :pid AND project_id = :proj"),
            {"pid": person_id, "proj": project_id},
        ).fetchall()
        if rows:
            return [r[0] for r in rows]

    # 回落旧字符串逻辑（project_members 未迁移）
    old_role = context.get("project_roles", {}).get(proj_name)
    if old_role:
        key = _OLD_ROLE_TO_KEY.get(old_role)
        return [key] if key else []

    return []


def _can_view_project(project_id: int, proj_name: str, context: dict, db: Session) -> bool:
    return bool(_get_user_roles(project_id, proj_name, context, db))


def _member_summary(project_id: int, db: Session) -> dict:
    """项目成员数量摘要（按角色）。"""
    rows = db.execute(
        text("SELECT role, COUNT(*) FROM project_members WHERE project_id = :pid GROUP BY role"),
        {"pid": project_id},
    ).fetchall()
    counts: dict[str, int] = {r: 0 for r in _VALID_ROLES}
    for role, cnt in rows:
        if role in counts:
            counts[role] = cnt
    return counts


def _project_response(raw: dict, user_roles: list[str], db: Session) -> dict:
    """将 raw SQL 行转换为接口响应字典。"""
    project_id = raw["id"]
    member_counts = _member_summary(project_id, db)
    return {
        "id":           raw["id"],
        "name":         raw["name"],
        "code":         raw["code"],
        "description":  raw["description"],
        "status":       raw["status"],
        "start_date":   raw["start_date"],
        "end_date":     raw["end_date"],
        "sort_order":   raw["sort_order"],
        "is_active":    bool(raw["is_active"]),
        "created_at":   str(raw["created_at"] or ""),
        "updated_at":   str(raw["updated_at"] or ""),
        "user_roles":   user_roles,
        "member_counts": member_counts,
        # 旧字段（保留给旧前端）
        "coordinator":  raw["coordinator"],
        "owners":       _split_names(raw["owners"]),
        "collaborators": _split_names(raw["collaborators"]),
    }


def _init_project_members(project_id: int, payload: "schemas.ProjectCreatePayload", db: Session):
    """创建项目时，批量写入 project_members 并同步旧字段。"""
    role_map = {
        "project_ceo": payload.project_ceo_ids,
        "owner":       payload.owner_ids,
        "coordinator": payload.coordinator_ids,
        "member":      payload.member_ids,
    }
    for role, ids in role_map.items():
        for person_id in (ids or []):
            person = db.get(models.Person, person_id)
            if not person:
                continue
            existing = (
                db.query(models.ProjectMember)
                .filter_by(project_id=project_id, person_id=person_id, role=role)
                .first()
            )
            if not existing:
                db.add(models.ProjectMember(
                    project_id=project_id,
                    person_id=person_id,
                    person_name_snapshot=person.name,
                    role=role,
                    joined_at=datetime.utcnow(),
                ))
    db.flush()
    _sync_project_old_fields(project_id, db)


# ── 5A：项目改名前置检查 ───────────────────────────────────────

def _extract_special_project_from_json(raw_json: str | None) -> list[str]:
    """
    从 JSON 字符串中递归提取所有 special_project 字段值。
    支持结构：
      {"special_project": "X"}
      {"task": {"special_project": "X"}}
      数组中每个元素包含 special_project
    解析失败静默返回空列表。
    """
    if not raw_json:
        return []
    try:
        data = json.loads(raw_json)
    except Exception:
        return []

    results: list[str] = []

    def _walk(obj):
        if isinstance(obj, dict):
            val = obj.get("special_project")
            if isinstance(val, str) and val.strip():
                results.append(val.strip())
            for v in obj.values():
                _walk(v)
        elif isinstance(obj, list):
            for item in obj:
                _walk(item)

    _walk(data)
    return results


def _count_legacy_project_name_refs(db: Session, old_name: str) -> dict:
    """
    统计各表中仍以旧项目名为 special_project 且 project_id IS NULL 的记录数。
    update_submissions 使用 Python JSON 解析；其他表使用精确 SQL。
    返回：{"tasks": n, "issues": n, "achievements": n, "meetings": n, "update_submissions": n}
    """
    counts: dict[str, int] = {
        "tasks": 0, "issues": 0, "achievements": 0,
        "meetings": 0, "update_submissions": 0,
    }

    def _sql_count(table: str, col: str) -> int:
        row = db.execute(
            text(f"SELECT COUNT(*) FROM {table} WHERE project_id IS NULL AND {col} = :name"),
            {"name": old_name},
        ).fetchone()
        return int(row[0]) if row else 0

    counts["tasks"]        = _sql_count("tasks",        "special_project")
    counts["issues"]       = _sql_count("issues",       "special_project")
    counts["achievements"] = _sql_count("achievements", "special_project")

    row = db.execute(
        text("SELECT COUNT(*) FROM meetings WHERE project_id IS NULL AND related_special_project = :name"),
        {"name": old_name},
    ).fetchone()
    counts["meetings"] = int(row[0]) if row else 0

    # update_submissions：优先 JSON 解析，逐行检查
    submission_match = 0
    rows = db.execute(
        text("SELECT human_result_json, ai_result_json FROM update_submissions WHERE project_id IS NULL"),
    ).fetchall()
    for human_json, ai_json in rows:
        matched = False
        for raw in (human_json, ai_json):
            if old_name in (_extract_special_project_from_json(raw)):
                matched = True
                break
        if matched:
            submission_match += 1
    counts["update_submissions"] = submission_match

    return counts


def _ensure_project_can_rename(db: Session, project, new_name: str) -> None:
    """
    检查改名是否安全：若任意表存在 project_id IS NULL 且 special_project = 旧名 的记录，
    抛出 HTTP 409，响应体包含各表残留数量和操作建议。
    """
    old_name = project.name
    legacy = _count_legacy_project_name_refs(db, old_name)
    total = sum(legacy.values())
    if total == 0:
        return

    raise HTTPException(
        status_code=409,
        detail={
            "message": "该项目还有未迁移的历史数据，请先执行 project_id 回填后再修改项目名称",
            "project_id": project.id,
            "old_name": old_name,
            "new_name": new_name,
            "legacy_counts": legacy,
            "suggestion": (
                "请先执行 migrate_project_members.py --report-only 和 --execute，"
                "确认历史数据已回填 project_id 后再改名"
            ),
        },
    )


# ── 端点：项目主数据 ───────────────────────────────────────────

@router.get("")
def list_projects(
    include_archived: bool = False,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    """
    列出当前用户可见的项目。
    - super_admin：全部项目
    - 其余角色：仅在 project_members 中参与的项目（+ 旧字段过渡兼容）
    """
    context = get_user_context_from_db(current_user, db)

    # 构建基础 ORM 查询（is_active 过滤）
    q = db.query(models.Project)
    if not include_archived:
        q = q.filter(models.Project.is_active == True)
    q = q.order_by(models.Project.sort_order, models.Project.id)

    if not context["can_view_all"]:
        person_id = context.get("person_id")

        # 从 project_members 取可见 project_id
        pm_ids: set[int] = set()
        if person_id:
            rows = db.execute(
                text("SELECT DISTINCT project_id FROM project_members WHERE person_id = :pid"),
                {"pid": person_id},
            ).fetchall()
            pm_ids = {r[0] for r in rows}

        # 过渡期：旧 visible_projects（从旧字符串字段推导）
        old_names = context.get("visible_projects") or []
        old_ids: set[int] = set()
        if old_names:
            old_rows = (
                db.query(models.Project.id)
                .filter(models.Project.name.in_(old_names))
                .all()
            )
            old_ids = {r[0] for r in old_rows}

        visible_ids = pm_ids | old_ids
        if not visible_ids:
            return []
        q = q.filter(models.Project.id.in_(visible_ids))

    projects = q.all()
    result = []
    for p in projects:
        raw = _read_project_raw(p.id, db)
        if not raw:
            continue
        user_roles = _get_user_roles(p.id, p.name, context, db)
        result.append(_project_response(raw, user_roles, db))
    return result


@router.post("")
def create_project(
    payload: schemas.ProjectCreatePayload,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    """创建项目。仅 super_admin。可选传入初始成员。"""
    _require_super_admin(current_user, db)

    name = (payload.name or "").strip()
    if not name:
        raise HTTPException(422, "name 不能为空")
    if db.query(models.Project).filter_by(name=name).first():
        raise HTTPException(409, f"项目名称 '{name}' 已存在")

    # ORM 建行（处理 timestamps）
    project = models.Project(
        name=name,
        sort_order=0,
        is_active=(payload.status or "active") != "archived",
    )
    db.add(project)
    db.flush()  # 获取 project.id

    # 写入扩展列（raw SQL，因为 models.Project 无这些映射字段）
    db.execute(
        text("""
            UPDATE projects SET
                code        = :code,
                description = :description,
                status      = :status,
                start_date  = :start_date,
                end_date    = :end_date
            WHERE id = :id
        """),
        {
            "id":          project.id,
            "code":        (payload.code or "").strip(),
            "description": (payload.description or "").strip(),
            "status":      (payload.status or "active").strip(),
            "start_date":  (payload.start_date or "").strip(),
            "end_date":    (payload.end_date or "").strip(),
        },
    )

    # 写入初始成员并同步旧字段
    _init_project_members(project.id, payload, db)

    crud.log(db, current_user, "create_project", "project", project.id, {}, {"name": name})
    db.commit()

    raw = _read_project_raw(project.id, db)
    return _project_response(raw, ["super_admin"], db)


@router.post("/batch-import")
def batch_import_projects(
    payload: schemas.ProjectBatchImportPayload,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    """
    批量导入：从 Excel 粘贴的结构化数据创建专项+关键任务+问题。
    专项已存在则复用，关键任务逐行创建，问题有内容则写入问题库。
    """
    _require_super_admin(current_user, db)

    projects_created = 0
    projects_matched = 0
    tasks_created = 0
    issues_created = 0
    skipped_rows = 0

    # 缓存本次已处理的项目，避免重复查库
    project_cache: dict[str, models.Project] = {}

    for row in payload.rows:
        proj_name = (row.project_name or "").strip()
        task_name = (row.key_task or "").strip()
        if not proj_name or not task_name:
            skipped_rows += 1
            continue

        # 找或建专项
        if proj_name not in project_cache:
            existing = db.query(models.Project).filter_by(name=proj_name).first()
            if existing:
                project_cache[proj_name] = existing
                projects_matched += 1
            else:
                proj = models.Project(name=proj_name, is_active=True, sort_order=0)
                if row.coordinator:
                    proj.coordinator = row.coordinator.strip()
                if row.owner:
                    proj.owners = row.owner.strip()
                if row.collaborators:
                    proj.collaborators = row.collaborators.strip()
                db.add(proj)
                db.flush()
                project_cache[proj_name] = proj
                projects_created += 1
                crud.log(db, current_user, "批量导入建项", "project", proj.id, {}, {"name": proj_name})

        proj = project_cache[proj_name]

        # 创建关键任务
        task = models.Task(
            project_id=proj.id,
            special_project=proj_name,
            key_task=task_name[:200],
            key_achievement=(row.key_achievement or "")[:200],
            completion_standard=row.completion_standard or "",
            coordinator=row.coordinator or "",
            owner=row.owner or "",
            collaborators=row.collaborators or "",
            plan_time=row.plan_time or "",
            status=row.status or "未开始",
            source_type="批量导入",
            submitter=current_user,
        )
        db.add(task)
        db.flush()
        tasks_created += 1
        crud.log(db, current_user, "批量导入建任务", "task", task.id, {}, {"key_task": task_name})

        # 创建问题（如有）
        issue_text = (row.issue or "").strip()
        if issue_text:
            issue = models.Issue(
                project_id=proj.id,
                special_project=proj_name,
                related_task_id=task.id,
                description=issue_text,
                owner=row.owner or "",
                source_type="批量导入",
                status="待处理",
                priority="中",
            )
            db.add(issue)
            issues_created += 1

    db.commit()
    return {
        "ok": True,
        "projects_created": projects_created,
        "projects_matched": projects_matched,
        "tasks_created": tasks_created,
        "issues_created": issues_created,
        "skipped_rows": skipped_rows,
    }


@router.get("/{project_id}/members")
def list_members(
    project_id: int,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    """列出项目成员。super_admin 或项目内成员可查看。"""
    project = db.get(models.Project, project_id)
    if not project:
        raise HTTPException(404, "project not found")

    context = get_user_context_from_db(current_user, db)
    if not _can_view_project(project_id, project.name, context, db):
        raise HTTPException(403, "permission denied — 仅项目成员可查看")

    members = (
        db.query(models.ProjectMember)
        .filter(models.ProjectMember.project_id == project_id)
        .order_by(models.ProjectMember.joined_at)
        .all()
    )
    return [_member_to_dict(m) for m in members]


@router.post("/{project_id}/members")
def add_member(
    project_id: int,
    payload: schemas.ProjectMemberPayload,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    """新增项目成员角色。仅 super_admin。"""
    _require_super_admin(current_user, db)

    project = db.get(models.Project, project_id)
    if not project:
        raise HTTPException(404, "project not found")
    person = db.get(models.Person, payload.person_id)
    if not person:
        raise HTTPException(404, f"person id={payload.person_id} not found")
    if payload.role not in _VALID_ROLES:
        raise HTTPException(422, f"role 必须是 {sorted(_VALID_ROLES)} 之一")

    existing = (
        db.query(models.ProjectMember)
        .filter_by(project_id=project_id, person_id=payload.person_id, role=payload.role)
        .first()
    )
    if existing:
        raise HTTPException(409, f"{person.name} 在该项目已持有角色 {payload.role}")

    row = models.ProjectMember(
        project_id=project_id,
        person_id=payload.person_id,
        person_name_snapshot=person.name,
        role=payload.role,
        note=payload.note or "",
        joined_at=datetime.utcnow(),
    )
    db.add(row)
    db.flush()
    _sync_project_old_fields(project_id, db)
    crud.log(db, current_user, "add_project_member", "project_member", row.id, {}, _member_to_dict(row))
    db.commit()
    db.refresh(row)
    return _member_to_dict(row)


@router.patch("/{project_id}/members/{member_id}")
def update_member(
    project_id: int,
    member_id: int,
    payload: schemas.ProjectMemberPatchPayload,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    """修改成员角色或备注。仅 super_admin。"""
    _require_super_admin(current_user, db)

    row = db.get(models.ProjectMember, member_id)
    if not row or row.project_id != project_id:
        raise HTTPException(404, "project member not found")

    before = _member_to_dict(row)
    if payload.role is not None:
        if payload.role not in _VALID_ROLES:
            raise HTTPException(422, f"role 必须是 {sorted(_VALID_ROLES)} 之一")
        if payload.role != row.role:
            # 6A: 当前是 owner 且要改成非 owner → 检查是否最后一个 owner
            if row.role == "owner":
                project = db.get(models.Project, project_id)
                if project:
                    _ensure_not_removing_last_owner(db, project, row)

            dup = (
                db.query(models.ProjectMember)
                .filter_by(project_id=project_id, person_id=row.person_id, role=payload.role)
                .first()
            )
            if dup:
                raise HTTPException(409, f"该成员在该项目已持有角色 {payload.role}")
        row.role = payload.role
    if payload.note is not None:
        row.note = payload.note

    _sync_project_old_fields(project_id, db)
    crud.log(db, current_user, "update_project_member", "project_member", row.id, before, _member_to_dict(row))
    db.commit()
    return _member_to_dict(row)


@router.delete("/{project_id}/members/{member_id}")
def remove_member(
    project_id: int,
    member_id: int,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    """移除项目成员角色。仅 super_admin。"""
    _require_super_admin(current_user, db)

    row = db.get(models.ProjectMember, member_id)
    if not row or row.project_id != project_id:
        raise HTTPException(404, "project member not found")

    before = _member_to_dict(row)

    # 6A: 删除前检查是否最后一个 owner
    project = db.get(models.Project, project_id)
    if project:
        _ensure_not_removing_last_owner(db, project, row)

    person_name = _person_name(row, db)
    db.delete(row)
    db.flush()

    _sync_project_old_fields(
        project_id, db,
        exclude_names={person_name} if person_name else None,
    )
    crud.log(db, current_user, "remove_project_member", "project_member", member_id, before, {})
    db.commit()
    return {"ok": True}


@router.get("/{project_id}")
def get_project(
    project_id: int,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    """项目详情。super_admin 或项目内成员可查看。"""
    project = db.get(models.Project, project_id)
    if not project:
        raise HTTPException(404, "project not found")

    context = get_user_context_from_db(current_user, db)
    if not _can_view_project(project_id, project.name, context, db):
        raise HTTPException(403, "permission denied — 仅项目成员可查看")

    raw = _read_project_raw(project_id, db)
    user_roles = _get_user_roles(project_id, project.name, context, db)
    return _project_response(raw, user_roles, db)


@router.patch("/{project_id}")
def update_project(
    project_id: int,
    payload: schemas.ProjectPatchPayload,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    """修改项目基本信息（name/code/description/status/start_date/end_date）。仅 super_admin。"""
    _require_super_admin(current_user, db)

    project = db.get(models.Project, project_id)
    if not project:
        raise HTTPException(404, "project not found")

    warnings: list[str] = []

    # name 变更：先做 legacy 检查，再做重名检查
    if payload.name is not None:
        new_name = payload.name.strip()
        if new_name and new_name != project.name:
            # P0-04：存在未迁移旧数据时拒绝改名（409）
            _ensure_project_can_rename(db, project, new_name)

            dup = db.query(models.Project).filter(
                models.Project.name == new_name,
                models.Project.id != project_id,
            ).first()
            if dup:
                raise HTTPException(409, f"项目名称 '{new_name}' 已被其他项目使用")
            project.name = new_name

    # is_active 与 status 双写
    if payload.status is not None:
        if payload.status == "archived":
            project.is_active = False
        elif payload.status == "active":
            project.is_active = True

    # 扩展列用 raw SQL 更新
    updates: dict = {}
    if payload.code        is not None: updates["code"]        = payload.code.strip()
    if payload.description is not None: updates["description"] = payload.description.strip()
    if payload.status      is not None: updates["status"]      = payload.status.strip()
    if payload.start_date  is not None: updates["start_date"]  = payload.start_date.strip()
    if payload.end_date    is not None: updates["end_date"]    = payload.end_date.strip()

    if updates:
        set_clause = ", ".join(f"{k} = :{k}" for k in updates)
        updates["id"] = project_id
        db.execute(text(f"UPDATE projects SET {set_clause} WHERE id = :id"), updates)

    crud.log(db, current_user, "update_project", "project", project_id, {}, payload.model_dump(exclude_none=True))
    db.commit()

    raw = _read_project_raw(project_id, db)
    return {**_project_response(raw, ["super_admin"], db), "warnings": warnings}


@router.post("/{project_id}/archive")
def archive_project(
    project_id: int,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    """
    归档项目。仅 super_admin。
    - is_active 设为 False
    - status 设为 archived
    - 不删除关联数据
    """
    _require_super_admin(current_user, db)

    project = db.get(models.Project, project_id)
    if not project:
        raise HTTPException(404, "project not found")

    if not project.is_active:
        raise HTTPException(409, "项目已归档，无需重复操作")

    project.is_active = False
    db.execute(
        text("UPDATE projects SET status = 'archived' WHERE id = :id"),
        {"id": project_id},
    )
    crud.log(db, current_user, "archive_project", "project", project_id, {"is_active": True}, {"is_active": False})
    db.commit()

    return {"ok": True, "project_id": project_id, "status": "archived"}


@router.get("/{project_id}/capabilities")
def project_capabilities(
    project_id: int,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    """
    返回当前用户在该项目的能力标志位。
    前端直接消费，无需自行推算角色 → 权限逻辑。

    Fields:
      roles            当前用户在项目中的角色列表
      canSubmit        可提交进展更新
      canConfirm       可确认/打回/转交提交
      canCoordinate    可作为统筹人提供反馈
      canEscalateToCEO 可上报 CEO 决策
      canCeoDecide     可作为项目CEO批示
      canViewCenter    可进入确认中心
      pendingCount     待处理（ALL_ACTIVE）提交数
    """
    from ..permissions import (
        can_access_confirmation_center,
        can_confirm_submission_by_project,
        can_coordinator_feedback_by_project,
        can_escalate_to_ceo_by_project,
        can_ceo_decide_by_project,
    )
    from ..services.policy import (
        user_roles_in_project,
        can_submit_to_project,
    )
    from ..domain import submission_status as SS

    context = get_user_context_from_db(current_user, db)

    project = db.get(models.Project, project_id)
    if not project:
        raise HTTPException(404, "project not found")

    roles = sorted(user_roles_in_project(context, project_id, db))

    pending_count = (
        db.query(models.UpdateSubmission)
        .filter(
            models.UpdateSubmission.project_id == project_id,
            models.UpdateSubmission.confirm_status.in_(list(SS.ALL_ACTIVE)),
        )
        .count()
    )

    return {
        "roles": roles,
        "canSubmit":        can_submit_to_project(context, project_id, db),
        "canConfirm":       can_confirm_submission_by_project(context, project_id, db),
        "canCoordinate":    can_coordinator_feedback_by_project(context, project_id, db),
        "canEscalateToCEO": can_escalate_to_ceo_by_project(context, project_id, db),
        "canCeoDecide":     can_ceo_decide_by_project(context, project_id, db),
        "canViewCenter":    can_access_confirmation_center(context),
        "pendingCount":     pending_count,
    }
