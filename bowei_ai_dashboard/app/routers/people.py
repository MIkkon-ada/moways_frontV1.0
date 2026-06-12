import re

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from .. import crud, models, schemas
from ..database import get_db
from ..permissions import PROJECT_AREAS, ROLE_CEO, ROLE_NORMAL, ROLE_PROCESS_GUARD, ROLE_SUPER_ADMIN, ensure_default_projects, get_current_user_name, get_user_context_from_db

_VALID_SYSTEM_ROLES = {ROLE_CEO, ROLE_PROCESS_GUARD, ROLE_SUPER_ADMIN, ROLE_NORMAL}

router = APIRouter(prefix="/api/people", tags=["people"])


def _require_admin(current_user: str, db: Session):
    ctx = get_user_context_from_db(current_user, db)
    if not ctx["is_tech_admin"]:
        raise HTTPException(403, "浠呮妧鏈鐞嗗憳鍙墽琛屾鎿嶄綔")


def _split_names(value) -> list[str]:
    if isinstance(value, list):
        source = "、".join(str(item or "").strip() for item in value if str(item or "").strip())
    else:
        source = str(value or "").strip()
    if not source:
        return []
    return [item.strip() for item in re.split(r"[,，、/;\n]+", source) if item.strip()]


def _join_names(names: list[str]) -> str:
    seen = []
    for name in names:
        text = str(name or "").strip()
        if text and text not in seen:
            seen.append(text)
    return "、".join(seen)


def _payload_project_sets(payload: schemas.PersonPayload) -> tuple[list[str], list[str], list[str]]:
    coordinated = list(dict.fromkeys(payload.coordinated_projects or []))
    owned = [name for name in dict.fromkeys(payload.owned_projects or []) if name not in coordinated]
    collaborated = [
        name for name in dict.fromkeys(payload.collaborated_projects or [])
        if name not in coordinated and name not in owned
    ]
    return coordinated, owned, collaborated


def _all_assigned_projects(coordinated: list[str], owned: list[str], collaborated: list[str]) -> str:
    return "、".join(dict.fromkeys([*coordinated, *owned, *collaborated]))


def _rebuild_person_duties(db: Session):
    projects = db.query(models.Project).filter_by(is_active=True).all()
    person_projects: dict[str, set[str]] = {}
    for project in projects:
        for name in [project.coordinator, *_split_names(project.owners), *_split_names(project.collaborators)]:
            if name:
                person_projects.setdefault(name, set()).add(project.name)

    for person in db.query(models.Person).all():
        assigned = sorted(person_projects.get(person.name, set()))
        person.special_project_duty = "、".join(assigned) if assigned else ""


def _sync_person_assignments(
    db: Session,
    person_name: str,
    coordinated_projects: list[str],
    owned_projects: list[str],
    collaborated_projects: list[str],
):
    projects = db.query(models.Project).all()
    for project in projects:
        if project.coordinator == person_name:
            project.coordinator = ""

        owners = [name for name in _split_names(project.owners) if name != person_name]
        collaborators = [name for name in _split_names(project.collaborators) if name != person_name]

        if project.name in coordinated_projects:
            project.coordinator = person_name
        if project.name in owned_projects:
            owners.append(person_name)
        if project.name in collaborated_projects:
            collaborators.append(person_name)

        project.owners = _join_names(owners)
        project.collaborators = _join_names(collaborators)

    _rebuild_person_duties(db)


def _detach_person_from_projects(db: Session, person_name: str):
    projects = db.query(models.Project).all()
    for project in projects:
        if project.coordinator == person_name:
            project.coordinator = ""
        project.owners = _join_names([name for name in _split_names(project.owners) if name != person_name])
        project.collaborators = _join_names([name for name in _split_names(project.collaborators) if name != person_name])
    _rebuild_person_duties(db)


@router.get("/me")
def me(current_user: str = Depends(get_current_user_name), db: Session = Depends(get_db)):
    context = get_user_context_from_db(current_user, db)
    return {
        "name": context["name"],
        "is_ceo": context["is_ceo"],
        "is_tech_admin": context["is_tech_admin"],
        "is_process_guard": context["is_process_guard"],
        "is_coordinator": context["is_coordinator"],
        "role_scope": context.get("role_scope", ""),
        "can_view_all": context["can_view_all"],
        "can_confirm_all": context["can_confirm_all"],
        "can_assign_all": context["can_assign_all"],
        "can_view_settings": context.get("can_view_settings", False),
        "can_view_confirmation_center": context.get("can_view_confirmation_center", False),
        "can_view_approval_reminders": context.get("can_view_approval_reminders", False),
        "can_view_decision_items": context.get("can_view_decision_items", False),
        "can_view_risk_items": context.get("can_view_risk_items", False),
        "can_view_issue_decisions": context.get("can_view_issue_decisions", False),
        "can_view_issue_risks": context.get("can_view_issue_risks", False),
        "can_view_progress": context.get("can_view_progress", True),
        "visible_projects": context["visible_projects"],
        "owned_projects": context["owned_projects"],
        "coordinated_projects": context["coordinated_projects"],
        "collaborated_projects": context["collaborated_projects"],
        "project_roles": context.get("project_roles", {}),
        "system_role": context["system_role"],
    }


@router.get("/projects")
def list_projects(db: Session = Depends(get_db)):
    ensure_default_projects(db)
    projects = db.query(models.Project).filter_by(is_active=True).order_by(models.Project.sort_order, models.Project.id).all()
    if not projects:
        return [
            {
                "id": index + 1,
                "name": area["name"],
                "coordinator": area["coordinator"],
                "owners": area["owners"],
                "collaborators": area["collaborators"],
                "sort_order": index,
                "is_active": True,
            }
            for index, area in enumerate(PROJECT_AREAS)
        ]
    return [
        {
            "id": row.id,
            "name": row.name,
            "coordinator": row.coordinator or "",
            "owners": _split_names(row.owners),
            "collaborators": _split_names(row.collaborators),
            "sort_order": row.sort_order or 0,
            "is_active": row.is_active,
        }
        for row in projects
    ]


@router.post("/projects")
def create_project(
    payload: schemas.ProjectPayload,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    _require_admin(current_user, db)
    if db.query(models.Project).filter_by(name=payload.name.strip()).first():
        raise HTTPException(400, "涓撻」鍚嶇О宸插瓨鍦?")
    row = models.Project(
        name=payload.name.strip(),
        coordinator=payload.coordinator.strip(),
        owners=_join_names(payload.owners),
        collaborators=_join_names(payload.collaborators),
        sort_order=payload.sort_order,
        is_active=payload.is_active,
    )
    db.add(row)
    db.flush()
    _rebuild_person_duties(db)
    crud.log(db, current_user, "create", "project", row.id, after=crud.to_dict(row))
    db.commit()
    db.refresh(row)
    return {
        "id": row.id,
        "name": row.name,
        "coordinator": row.coordinator,
        "owners": _split_names(row.owners),
        "collaborators": _split_names(row.collaborators),
        "sort_order": row.sort_order,
        "is_active": row.is_active,
    }


@router.put("/projects/{project_id}")
def update_project(
    project_id: int,
    payload: schemas.ProjectPayload,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    _require_admin(current_user, db)
    row = db.get(models.Project, project_id)
    if not row:
        raise HTTPException(404, "project not found")
    duplicate = db.query(models.Project).filter(models.Project.name == payload.name.strip(), models.Project.id != project_id).first()
    if duplicate:
        raise HTTPException(400, "涓撻」鍚嶇О宸插瓨鍦?")
    before = crud.to_dict(row)
    row.name = payload.name.strip()
    row.coordinator = payload.coordinator.strip()
    row.owners = _join_names(payload.owners)
    row.collaborators = _join_names(payload.collaborators)
    row.sort_order = payload.sort_order
    row.is_active = payload.is_active
    _rebuild_person_duties(db)
    crud.log(db, current_user, "update", "project", row.id, before=before, after=crud.to_dict(row))
    db.commit()
    return {
        "id": row.id,
        "name": row.name,
        "coordinator": row.coordinator,
        "owners": _split_names(row.owners),
        "collaborators": _split_names(row.collaborators),
        "sort_order": row.sort_order,
        "is_active": row.is_active,
    }


@router.delete("/projects/{project_id}")
def delete_project(
    project_id: int,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    _require_admin(current_user, db)
    row = db.get(models.Project, project_id)
    if not row:
        raise HTTPException(404, "project not found")
    before = crud.to_dict(row)
    db.delete(row)
    _rebuild_person_duties(db)
    crud.log(db, current_user, "delete", "project", project_id, before=before)
    db.commit()
    return {"ok": True}


@router.get("")
def list_people(db: Session = Depends(get_db)):
    rows = db.query(models.Person).order_by(models.Person.is_active.desc(), models.Person.id.asc()).all()
    return [crud.to_dict(row) for row in rows]


@router.post("")
def create_person(
    payload: schemas.PersonPayload,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    _require_admin(current_user, db)
    if db.query(models.Person).filter_by(name=payload.name.strip()).first():
        raise HTTPException(400, "浜哄憳宸插瓨鍦?")
    coordinated, owned, collaborated = _payload_project_sets(payload)
    system_role = payload.system_role if payload.system_role in _VALID_SYSTEM_ROLES else ROLE_NORMAL
    row = models.Person(
        name=payload.name.strip(),
        role=payload.role,
        system_role=system_role,
        department=payload.department,
        special_project_duty=_all_assigned_projects(coordinated, owned, collaborated) or payload.special_project_duty,
        permission=payload.permission,
        contact=payload.contact,
        is_active=payload.is_active,
        is_admin=payload.is_admin,
    )
    db.add(row)
    db.flush()
    _sync_person_assignments(db, row.name, coordinated, owned, collaborated)
    crud.log(db, current_user, "create", "person", row.id, after=crud.to_dict(row))
    db.commit()
    db.refresh(row)
    return crud.to_dict(row)


@router.get("/{row_id}")
def get_person(row_id: int, db: Session = Depends(get_db)):
    row = db.get(models.Person, row_id)
    if not row:
        raise HTTPException(404, "person not found")
    return crud.to_dict(row)


@router.put("/{row_id}")
def update_person(
    row_id: int,
    payload: schemas.PersonPayload,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    _require_admin(current_user, db)
    row = db.get(models.Person, row_id)
    if not row:
        raise HTTPException(404, "person not found")
    duplicate = db.query(models.Person).filter(models.Person.name == payload.name.strip(), models.Person.id != row_id).first()
    if duplicate:
        raise HTTPException(400, "浜哄憳鍚嶇О宸插瓨鍦?")
    before = crud.to_dict(row)
    old_name = row.name
    coordinated, owned, collaborated = _payload_project_sets(payload)
    row.name = payload.name.strip()
    row.role = payload.role
    row.system_role = payload.system_role if payload.system_role in _VALID_SYSTEM_ROLES else ROLE_NORMAL
    row.department = payload.department
    row.permission = payload.permission
    row.contact = payload.contact
    row.is_active = payload.is_active
    row.is_admin = payload.is_admin
    row.special_project_duty = _all_assigned_projects(coordinated, owned, collaborated) or payload.special_project_duty
    if old_name != row.name:
        _detach_person_from_projects(db, old_name)
    _sync_person_assignments(db, row.name, coordinated, owned, collaborated)
    crud.log(db, current_user, "update", "person", row.id, before=before, after=crud.to_dict(row))
    db.commit()
    return crud.to_dict(row)


@router.delete("/{row_id}")
def delete_person(
    row_id: int,
    current_user: str = Depends(get_current_user_name),
    db: Session = Depends(get_db),
):
    _require_admin(current_user, db)
    row = db.get(models.Person, row_id)
    if not row:
        raise HTTPException(404, "person not found")
    before = crud.to_dict(row)
    _detach_person_from_projects(db, row.name)
    db.delete(row)
    crud.log(db, current_user, "delete", "person", row_id, before=before)
    db.commit()
    return {"ok": True}
