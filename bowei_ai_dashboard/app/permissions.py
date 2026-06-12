import re
from urllib.parse import unquote

from fastapi import Header, HTTPException, Request
from sqlalchemy import text

from .auth import IMPERSONATE_ALLOWED, get_session_user

# ── 全局系统角色常量（仅4个，不含项目级身份）────────────────────
ROLE_CEO           = "组长CEO"
ROLE_PROCESS_GUARD = "过程保障"
ROLE_SUPER_ADMIN   = "超级管理员"
ROLE_NORMAL        = "普通成员"   # 默认，项目内角色由 project_members 表决定

# 项目内身份展示常量（用于兼容旧 project_roles 字段格式，不存入 DB）
PROJECT_ROLE_OWNER        = "项目负责人"
PROJECT_ROLE_COORDINATOR  = "统筹人"
PROJECT_ROLE_COLLABORATOR = "协同成员"

# project_members.role 存储的英文枚举键（存入 DB）
PROJECT_ROLE_CEO_KEY           = "project_ceo"
PROJECT_ROLE_OWNER_KEY         = "owner"
PROJECT_ROLE_COORD_KEY         = "coordinator"
PROJECT_ROLE_MEMBER_KEY        = "member"
PROJECT_ROLE_PROCESS_GUARD_KEY = "process_guard"

# DB 角色键 → 展示常量（用于兼容旧 context["project_roles"] 字段格式）
_DB_ROLE_TO_PROJECT_ROLE: dict[str, str] = {
    PROJECT_ROLE_OWNER_KEY:         PROJECT_ROLE_OWNER,
    PROJECT_ROLE_COORD_KEY:         PROJECT_ROLE_COORDINATOR,
    PROJECT_ROLE_MEMBER_KEY:        PROJECT_ROLE_COLLABORATOR,
    PROJECT_ROLE_PROCESS_GUARD_KEY: "过程保障",
}

# 角色优先级：owner > coordinator > member > process_guard > project_ceo
_ROLE_PRIORITY: dict[str, int] = {
    PROJECT_ROLE_OWNER_KEY:         4,
    PROJECT_ROLE_COORD_KEY:         3,
    PROJECT_ROLE_MEMBER_KEY:        2,
    PROJECT_ROLE_PROCESS_GUARD_KEY: 2,
    PROJECT_ROLE_CEO_KEY:           1,
}

# 系统账号（非人名，兜底用）
SYSTEM_ACCOUNTS = {"mowasyadmin"}

# 全局能力表：system_role → 能力集
_GLOBAL_CAPS = {
    ROLE_SUPER_ADMIN:   dict(can_view_all=True,  can_confirm_all=True,  can_assign_all=True,  can_view_settings=True,  is_ceo=False, is_process_guard=False),
    ROLE_CEO:           dict(can_view_all=True,  can_confirm_all=True,  can_assign_all=True,  can_view_settings=False, is_ceo=True,  is_process_guard=False),
    ROLE_PROCESS_GUARD: dict(can_view_all=True,  can_confirm_all=False, can_assign_all=True,  can_view_settings=False, is_ceo=False, is_process_guard=True),
    ROLE_NORMAL:        dict(can_view_all=False, can_confirm_all=False, can_assign_all=False, can_view_settings=False, is_ceo=False, is_process_guard=False),
}

# 默认专项列表（projects 表为空时兜底）
PROJECT_AREAS = [
    {"name": "知识资产AI化",       "coordinator": "刘万超", "owners": ["杨宇帆"],          "collaborators": ["袁金玉", "郭熠彬", "吴肖"]},
    {"name": "顾问作业AI化",       "coordinator": "刘万超", "owners": ["许明良"],          "collaborators": ["郭熠彬", "吴肖"]},
    {"name": "交付流程AI化",       "coordinator": "刘万超", "owners": ["温会林"],          "collaborators": ["郭熠彬", "吴肖", "袁金玉"]},
    {"name": "咨询服务产品化",     "coordinator": "邹奇敏", "owners": ["彭超凡"],          "collaborators": ["刘万超", "温会林"]},
    {"name": "技术底座与平台预研", "coordinator": "冯海林", "owners": ["吴肖", "郭熠彬"], "collaborators": ["刘万超", "邹奇敏"]},
]


# ── 工具函数 ───────────────────────────────────────────────────

def _split_names(value) -> list[str]:
    if isinstance(value, list):
        source = "、".join(str(v or "").strip() for v in value if str(v or "").strip())
    else:
        source = str(value or "").strip()
    if not source:
        return []
    return [s.strip() for s in re.split(r"[,，、/;\n]+", source) if s.strip()]


def get_project_role_from_area(name: str, project: dict) -> str | None:
    """
    从 project_areas 字典判断某人在某专项的角色（旧逻辑，兼容 project_members 迁移前）。
    迁移完成后本函数仅作回落兜底使用。
    """
    if project.get("coordinator") == name:
        return PROJECT_ROLE_COORDINATOR
    if name in project.get("owners", []):
        return PROJECT_ROLE_OWNER
    if name in project.get("collaborators", []):
        return PROJECT_ROLE_COLLABORATOR
    return None


# ── DB 访问 ────────────────────────────────────────────────────

def _get_project_areas_from_db(db) -> list[dict]:
    try:
        rows = db.execute(
            text(
                "SELECT name, coordinator, COALESCE(owners,'') AS owners, "
                "COALESCE(collaborators,'') AS collaborators "
                "FROM projects WHERE is_active=1 ORDER BY sort_order, id"
            )
        ).fetchall()
    except Exception:
        return PROJECT_AREAS
    if not rows:
        return PROJECT_AREAS
    return [
        {
            "name": row[0],
            "coordinator": row[1] or "",
            "owners": _split_names(row[2]),
            "collaborators": _split_names(row[3]),
        }
        for row in rows
    ]


def _get_project_roles_from_members(person_id: int, db) -> dict[str, list[str]]:
    """
    从 project_members 表查询某人在各活跃项目中的全部角色。
    返回 {project_name: [role, ...]}，表不存在或无数据时返回 {}。
    """
    try:
        rows = db.execute(
            text(
                "SELECT p.name, pm.role "
                "FROM project_members pm "
                "JOIN projects p ON p.id = pm.project_id "
                "WHERE pm.person_id = :pid AND p.is_active = 1"
            ),
            {"pid": person_id},
        ).fetchall()
    except Exception:
        return {}
    result: dict[str, list[str]] = {}
    for proj_name, role in rows:
        if proj_name and role:
            result.setdefault(proj_name, []).append(role)
    return result


def ensure_default_projects(db) -> None:
    try:
        count = db.execute(text("SELECT COUNT(*) FROM projects")).scalar()
        if count and count > 0:
            return  # 表中已有数据，不再自动补充
        existing: set = set()
    except Exception:
        return
    for idx, area in enumerate(PROJECT_AREAS):
        if area["name"] in existing:
            continue
        db.execute(
            text(
                "INSERT INTO projects (name, coordinator, owners, collaborators, sort_order, is_active, created_at, updated_at) "
                "VALUES (:name, :coordinator, :owners, :collaborators, :sort_order, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
            ),
            {
                "name": area["name"],
                "coordinator": area["coordinator"],
                "owners": "、".join(area["owners"]),
                "collaborators": "、".join(area["collaborators"]),
                "sort_order": idx,
            },
        )
    try:
        db.commit()
    except Exception:
        db.rollback()


# ── 上下文构建 ─────────────────────────────────────────────────

def _build_context(
    name: str,
    system_role: str,
    project_areas: list[dict],
    is_admin: bool = False,
    *,
    person_id: int | None = None,
    project_member_roles: dict[str, list[str]] | None = None,
) -> dict:
    """
    构建权限上下文。

    项目内角色来源（两条路径，自动切换）：
    - 新路径：project_member_roles 非空时，从 project_members 表数据构建。
              project_ceo 单独追踪，不混入日常操作角色（owned/coordinated/collaborated）。
    - 旧路径：project_member_roles 为 None 或 {} 时，回落到 project_areas 字符串推导，
              保证 project_members 迁移前旧数据仍可正常运行。
    """
    caps = _GLOBAL_CAPS.get(system_role, _GLOBAL_CAPS[ROLE_NORMAL])

    owned:        list[str] = []
    coordinated:  list[str] = []
    collaborated: list[str] = []
    ceo_projects: list[str] = []
    project_roles: dict[str, str] = {}

    if project_member_roles:
        # ── 新路径：从 project_members 表构建 ──────────────────
        for proj_name, roles in project_member_roles.items():
            # 日常操作角色：按优先级取主角色（project_ceo 不参与此分组）
            if "owner" in roles:
                owned.append(proj_name)
                project_roles[proj_name] = PROJECT_ROLE_OWNER
            elif "coordinator" in roles:
                coordinated.append(proj_name)
                project_roles[proj_name] = PROJECT_ROLE_COORDINATOR
            elif "member" in roles:
                collaborated.append(proj_name)
                project_roles[proj_name] = PROJECT_ROLE_COLLABORATOR
            # project_ceo 单独追踪：不继承 owner 的确认/打回/转交权限
            if "project_ceo" in roles:
                ceo_projects.append(proj_name)
    else:
        # ── 旧路径：从 projects 字符串字段推导（迁移前兼容）────
        for p in project_areas:
            role = get_project_role_from_area(name, p)
            if role == PROJECT_ROLE_OWNER:
                owned.append(p["name"])
                project_roles[p["name"]] = PROJECT_ROLE_OWNER
            elif role == PROJECT_ROLE_COORDINATOR:
                coordinated.append(p["name"])
                project_roles[p["name"]] = PROJECT_ROLE_COORDINATOR
            elif role == PROJECT_ROLE_COLLABORATOR:
                collaborated.append(p["name"])
                project_roles[p["name"]] = PROJECT_ROLE_COLLABORATOR

    # 可见专项：can_view_all 时取全量，否则取本人参与的专项（含 project_ceo 项目）
    if caps["can_view_all"]:
        visible = [p["name"] for p in project_areas]
    else:
        visible = list(dict.fromkeys(owned + coordinated + collaborated + ceo_projects))

    ctx = {
        "name": name,
        "person_id": person_id,
        "system_role": system_role,
        "is_admin": bool(is_admin),
        "project_roles": project_roles,
        "owned_projects": owned,
        "coordinated_projects": coordinated,
        "collaborated_projects": collaborated,
        "ceo_projects": ceo_projects,
        "visible_projects": visible,
        **caps,
    }
    return _decorate_context(ctx)


def _decorate_context(ctx: dict) -> dict:
    can_view_all = ctx["can_view_all"]
    is_ceo       = ctx["is_ceo"]
    has_owned    = bool(ctx["owned_projects"])
    has_ceo_proj = bool(ctx.get("ceo_projects"))
    is_admin     = bool(ctx.get("is_admin"))

    ctx.update({
        "can_view_confirmation_center": can_view_all or is_ceo or has_owned or bool(ctx["coordinated_projects"]) or has_ceo_proj,
        "can_view_approval_reminders":  can_view_all or is_ceo or has_owned or bool(ctx["coordinated_projects"]),
        # project_ceo 可以查看需决策事项和风险（但不能批改日常数据）
        "can_view_decision_items":      can_view_all or is_ceo or has_ceo_proj,
        "can_view_risk_items":          can_view_all or is_ceo or has_owned or bool(ctx["coordinated_projects"]) or has_ceo_proj,
        "can_view_issue_decisions":     can_view_all or is_ceo or has_ceo_proj,
        "can_view_issue_risks":         can_view_all or is_ceo or has_owned or bool(ctx["coordinated_projects"]) or has_ceo_proj,
        "can_view_progress":            True,
        "can_view_settings":            bool(ctx.get("can_view_settings")) or is_admin,
        # 兼容旧字段名
        "is_tech_admin":    ctx["system_role"] == ROLE_SUPER_ADMIN or is_admin,
        "is_coordinator":   bool(ctx["coordinated_projects"]),
        "is_process_guard": ctx["is_process_guard"],
        "can_maintain_all": ctx["can_view_all"],
    })
    return ctx


# ── 公开接口 ───────────────────────────────────────────────────

def get_current_user_name(
    request: Request,
    x_current_user: str | None = Header(default=None, alias="X-Current-User"),
) -> str:
    session_id = request.cookies.get("bowei_session")
    session_user = get_session_user(session_id) if session_id else None
    if x_current_user:
        decoded = unquote(x_current_user.strip())
        if session_user and session_user in IMPERSONATE_ALLOWED and decoded:
            return decoded
    return session_user or ""


def get_user_context(name: str) -> dict:
    """无 DB 场景兜底（不查 project_members，仅旧字符串逻辑）。"""
    if name in SYSTEM_ACCOUNTS:
        system_role = ROLE_SUPER_ADMIN
        is_admin = True
    else:
        system_role = ROLE_NORMAL
        is_admin = False
    return _build_context(name, system_role, PROJECT_AREAS, is_admin=is_admin)


def get_user_context_from_db(name: str, db) -> dict:
    if name in SYSTEM_ACCOUNTS:
        return _build_context(
            name, ROLE_SUPER_ADMIN, _get_project_areas_from_db(db),
            is_admin=True, person_id=None, project_member_roles=None,
        )

    person_id_val: int | None = None
    system_role = ROLE_NORMAL
    is_admin = False

    try:
        row = db.execute(
            text(
                "SELECT id, system_role, COALESCE(is_admin, 0) "
                "FROM people WHERE name=:name AND is_active=1"
            ),
            {"name": name},
        ).fetchone()
        if row:
            person_id_val = int(row[0])
            system_role   = row[1] or ROLE_NORMAL
            is_admin      = bool(row[2])
        # 兜底：确保只允许合法的全局角色值
        if system_role not in (ROLE_CEO, ROLE_PROCESS_GUARD, ROLE_SUPER_ADMIN, ROLE_NORMAL):
            system_role = ROLE_NORMAL
    except Exception:
        person_id_val = None
        system_role   = ROLE_NORMAL
        is_admin      = False

    project_areas = _get_project_areas_from_db(db)

    # 从 project_members 表读取项目角色
    # 有数据 → 走新路径；空 dict → 回落旧字符串逻辑（迁移前兼容）
    project_member_roles: dict[str, list[str]] | None = None
    if person_id_val is not None:
        roles_map = _get_project_roles_from_members(person_id_val, db)
        project_member_roles = roles_map if roles_map else None

    return _build_context(
        name, system_role, project_areas, is_admin,
        person_id=person_id_val,
        project_member_roles=project_member_roles,
    )


# ── 权限判断函数（context-based，保持旧接口兼容）─────────────────

def can_view_project(ctx: dict, project: str) -> bool:
    return ctx["can_view_all"] or project in ctx["visible_projects"]


def can_view_confirmation_center(ctx: dict) -> bool:
    return bool(ctx.get("can_view_confirmation_center"))


def can_access_confirmation_center(ctx: dict) -> bool:
    return can_view_confirmation_center(ctx)


def can_view_issue_risks(ctx: dict) -> bool:
    return bool(ctx.get("can_view_issue_risks"))


def can_view_issue_decisions(ctx: dict) -> bool:
    return bool(ctx.get("can_view_issue_decisions"))


def can_view_settings(ctx: dict) -> bool:
    return bool(ctx.get("can_view_settings"))


def extract_submission_project(data: dict) -> str:
    return (data.get("special_project") or (data.get("task") or {}).get("special_project") or "").strip()


def can_view_submission(ctx: dict, data: dict, submitter: str = "") -> bool:
    project = extract_submission_project(data)
    if project and can_view_project(ctx, project):
        return True
    return bool(submitter and submitter == ctx["name"])


def can_view_submission_in_confirmation(ctx: dict, data: dict, submitter: str = "") -> bool:
    """确认中心可见：全局管理员、该专项的负责人或统筹人、提交人本人。"""
    if ctx["can_view_all"]:
        return True
    project = extract_submission_project(data)
    if project and ctx["project_roles"].get(project) in (PROJECT_ROLE_OWNER, PROJECT_ROLE_COORDINATOR):
        return True
    return bool(submitter and submitter == ctx["name"])


def can_confirm_submission(ctx: dict, data: dict) -> bool:
    """
    确认入库：超级管理员（全局），或该专项的项目负责人。
    注意：project_ceo 不具备此权限（project_ceo 不在 project_roles 中）。
    """
    if ctx["can_confirm_all"]:
        return True
    project = extract_submission_project(data)
    return bool(project and ctx["project_roles"].get(project) == PROJECT_ROLE_OWNER)


def can_assign_submission(ctx: dict) -> bool:
    """指派责任人：过程保障、超级管理员。"""
    return ctx["can_assign_all"]


def can_write_project(ctx: dict, project: str) -> bool:
    """编辑该专项任务/成果：该专项的项目负责人、超级管理员或过程保障。"""
    if ctx["can_confirm_all"] or ctx.get("is_process_guard"):
        return True
    return ctx["project_roles"].get(project) == PROJECT_ROLE_OWNER


def can_coordinator_feedback(ctx: dict, data: dict) -> bool:
    """统筹人反馈意见：该专项的统筹人。统筹人不做最终审批，只提供参考建议。"""
    project = extract_submission_project(data)
    if not project:
        return False
    return ctx["project_roles"].get(project) == PROJECT_ROLE_COORDINATOR


def can_escalate_to_ceo(ctx: dict, data: dict) -> bool:
    """上报 project_ceo 决策：项目负责人或过程保障。"""
    if ctx["is_process_guard"]:
        return True
    return can_confirm_submission(ctx, data)


def can_ceo_decide(ctx: dict) -> bool:
    """
    CEO批示：全局组长CEO 或 超级管理员。
    第一阶段保留全局判断；第三批接口重构时改为基于 project_members.project_ceo 精细判断。
    """
    return ctx["is_ceo"] or ctx["can_confirm_all"]


# ── 新增：基于 person_id 的项目级权限工具函数 ─────────────────────
#
# 角色边界说明：
#   owner       → 确认 AI 入库、打回成员、转交 coordinator、上报 project_ceo、修改任务状态
#   coordinator → 处理 owner 转交的事项、提交参考建议；不确认入库、不修改任务
#   member      → 提交进展/成果/问题；不确认入库
#   project_ceo → 查看驾驶舱/风险/成果/决策事项、批示决策；不做日常确认操作

def get_person_id(person_name: str, db) -> int | None:
    """
    按姓名从 people 表查 person_id。
    仅作 name-based → id-based 的桥接，不用于正式鉴权。
    """
    if not person_name or not person_name.strip():
        return None
    try:
        row = db.execute(
            text("SELECT id FROM people WHERE name = :name AND is_active = 1"),
            {"name": person_name.strip()},
        ).fetchone()
        return int(row[0]) if row else None
    except Exception:
        return None


def get_all_project_roles(person_id: int, project_id: int, db) -> list[str]:
    """
    从 project_members 表查询某人在某项目的全部角色列表。
    例：["owner", "project_ceo"]（一人可持有多个角色）。
    """
    try:
        rows = db.execute(
            text(
                "SELECT role FROM project_members "
                "WHERE person_id = :pid AND project_id = :proj_id"
            ),
            {"pid": person_id, "proj_id": project_id},
        ).fetchall()
        return [row[0] for row in rows if row[0]]
    except Exception:
        return []


def get_project_role(person_id: int, project_id: int, db) -> str | None:
    """
    从 project_members 查询某人在某项目的最高优先级角色（单值）。
    优先级：owner > coordinator > member > project_ceo

    重要：project_ceo 优先级刻意最低，不继承 owner 的日常操作权限。
    如需判断是否持有 project_ceo，请用 get_all_project_roles。
    """
    roles = get_all_project_roles(person_id, project_id, db)
    if not roles:
        return None
    return max(roles, key=lambda r: _ROLE_PRIORITY.get(r, 0))


def is_project_member(person_id: int, project_id: int, db) -> bool:
    """判断某人是否属于某项目（任意角色均算成员）。"""
    try:
        row = db.execute(
            text(
                "SELECT 1 FROM project_members "
                "WHERE person_id = :pid AND project_id = :proj_id LIMIT 1"
            ),
            {"pid": person_id, "proj_id": project_id},
        ).fetchone()
        return row is not None
    except Exception:
        return False


def require_project_role(
    person_id: int | None,
    project_id: int,
    allowed_roles: list[str],
    db,
) -> None:
    """
    断言某人在某项目中拥有 allowed_roles 中至少一个角色，否则抛出 HTTP 403。

    规则：
    - person_id 为 None → 直接拒绝（未知用户）
    - super_admin（system_role=超级管理员 或 is_admin=True）→ 直接通过，不查 project_members
    - 其余情况 → 查 project_members，role 需在 allowed_roles 中
    """
    if person_id is None:
        raise HTTPException(status_code=403, detail="permission denied")

    # super_admin 绕过所有项目级权限检查
    try:
        row = db.execute(
            text("SELECT system_role, COALESCE(is_admin, 0) FROM people WHERE id = :pid"),
            {"pid": person_id},
        ).fetchone()
        if row and (row[0] == ROLE_SUPER_ADMIN or bool(row[1])):
            return
    except Exception:
        pass

    roles = get_all_project_roles(person_id, project_id, db)
    if not any(r in allowed_roles for r in roles):
        raise HTTPException(status_code=403, detail="permission denied")


def _proj_name_from_id(project_id: int, db) -> str | None:
    """从 projects 表按 id 查项目名（permissions 内部工具）。"""
    try:
        row = db.execute(
            text("SELECT name FROM projects WHERE id = :id"),
            {"id": project_id},
        ).fetchone()
        return row[0] if row else None
    except Exception:
        return None


def _fallback_ctx_role(ctx: dict, project_id: int, db) -> str | None:
    """
    project_members 未迁移时，从 ctx["project_roles"]（旧字符串逻辑）取该项目角色。
    TODO(3C): project_id 全量迁移到 project_members 后可删除。
    """
    proj_name = _proj_name_from_id(project_id, db)
    if not proj_name:
        return None
    return ctx.get("project_roles", {}).get(proj_name)


def can_confirm_submission_by_project(ctx: dict, project_id: int | None, db) -> bool:
    """
    确认入库 / 打回 / 转交：super_admin 或该项目的 owner。
    project_ceo、coordinator 不可确认。

    project_members 未迁移时回落旧字符串逻辑（旧 owner 可用），
    但 project_ceo 单独追踪不在 project_roles 中，因此不会被误授权。
    """
    if ctx["can_confirm_all"]:
        return True
    person_id = ctx.get("person_id")
    if project_id is None or person_id is None:
        return False
    roles = get_all_project_roles(person_id, project_id, db)
    if roles:
        return "owner" in roles
    # TODO(3C): project_members 未迁移，回落旧字符串逻辑
    return _fallback_ctx_role(ctx, project_id, db) == PROJECT_ROLE_OWNER


def can_coordinator_feedback_by_project(ctx: dict, project_id: int | None, db) -> bool:
    """统筹人反馈：super_admin 或该项目的 coordinator。"""
    if ctx["can_confirm_all"]:
        return True
    person_id = ctx.get("person_id")
    if project_id is None or person_id is None:
        return False
    roles = get_all_project_roles(person_id, project_id, db)
    if roles:
        return "coordinator" in roles
    # TODO(3C): project_members 未迁移，回落旧字符串逻辑
    return _fallback_ctx_role(ctx, project_id, db) == PROJECT_ROLE_COORDINATOR


def can_escalate_to_ceo_by_project(ctx: dict, project_id: int | None, db) -> bool:
    """上报 CEO：super_admin、process_guard 或该项目的 owner。"""
    if ctx["can_confirm_all"] or ctx.get("is_process_guard"):
        return True
    person_id = ctx.get("person_id")
    if project_id is None or person_id is None:
        return False
    roles = get_all_project_roles(person_id, project_id, db)
    if roles:
        return "owner" in roles
    # TODO(3C): project_members 未迁移，回落旧字符串逻辑
    return _fallback_ctx_role(ctx, project_id, db) == PROJECT_ROLE_OWNER


def can_ceo_decide_by_project(ctx: dict, project_id: int | None, db) -> bool:
    """
    CEO 批示：super_admin 或该项目的 project_ceo。
    回落：project_members 为空时保留全局 is_ceo 判断（历史数据兼容）。
    TODO(3C): project_id 全量回填且 project_members 全量迁移后可移除全局 is_ceo 回落。
    """
    if ctx["can_confirm_all"]:
        return True
    person_id = ctx.get("person_id")
    if project_id is None or person_id is None:
        # TODO(3C): 历史数据兼容，改为严格拒绝
        return bool(ctx.get("is_ceo"))
    roles = get_all_project_roles(person_id, project_id, db)
    if roles:
        return "project_ceo" in roles
    # TODO(3C): project_members 未迁移，全局 is_ceo 回落
    return bool(ctx.get("is_ceo"))


def can_view_submission_in_confirmation_by_project(
    ctx: dict,
    project_id: int | None,
    submitter: str,
    db,
) -> bool:
    """
    确认中心可见性（id-based）。
    owner / coordinator / project_ceo → 可见；member → 不可见。
    project_members 未迁移时回落旧字符串逻辑。
    TODO(3C): project_ceo 只应看 "待CEO决策"；coordinator 只看转交给自己的事项。
    """
    if ctx["can_view_all"]:
        return True
    if submitter and submitter == ctx["name"]:
        return True
    if project_id is None:
        return False
    person_id = ctx.get("person_id")
    if person_id is None:
        return False
    roles = get_all_project_roles(person_id, project_id, db)
    if roles:
        return any(r in ("owner", "coordinator", "project_ceo") for r in roles)
    # TODO(3C): project_members 未迁移，回落旧字符串逻辑
    fallback = _fallback_ctx_role(ctx, project_id, db)
    return fallback in (PROJECT_ROLE_OWNER, PROJECT_ROLE_COORDINATOR)


def resolve_project_id(
    special_project: str | None,
    project_id: int | None,
    db,
) -> int | None:
    """
    将 special_project 字符串或 project_id 解析为 project_id 整数。

    规则：
    - project_id 优先（直接返回）
    - 只有 special_project 时，按 projects.name 精确匹配（仅活跃项目）
    - 匹配失败返回 None；调用方决定是否报 422，本函数不静默放行
    """
    if project_id is not None:
        return project_id
    if not special_project or not special_project.strip():
        return None
    try:
        row = db.execute(
            text("SELECT id FROM projects WHERE name = :name AND is_active = 1"),
            {"name": special_project.strip()},
        ).fetchone()
        return int(row[0]) if row else None
    except Exception:
        return None
