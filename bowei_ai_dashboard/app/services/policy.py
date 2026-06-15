"""
Submission-level permission policy.

All public functions are side-effect-free predicates.
Routers import from here instead of duplicating logic.
"""
from sqlalchemy.orm import Session

from .. import crud, models
from ..permissions import (
    PROJECT_ROLE_COLLABORATOR,
    PROJECT_ROLE_COORDINATOR,
    PROJECT_ROLE_OWNER,
    can_ceo_decide_by_project,
    can_confirm_submission_by_project,
    can_coordinator_feedback_by_project,
    can_escalate_to_ceo_by_project,
    can_view_submission_in_confirmation_by_project,
    get_all_project_roles,
)


# ── Project-ID resolution ──────────────────────────────────────

def project_id_of(row: models.UpdateSubmission) -> int | None:
    """Single authority: always returns row.project_id directly."""
    return row.project_id


# ── Role lookup ────────────────────────────────────────────────

def user_roles_in_project(
    context: dict,
    project_id: int | None,
    db: Session,
) -> set[str]:
    """
    Current user's roles in a project.
    Returns {"super_admin"} for tech_admin; empty set when no record found.
    """
    if context.get("is_tech_admin"):
        return {"super_admin"}

    person_id = context.get("person_id")
    if person_id and project_id:
        db_roles = get_all_project_roles(person_id, project_id, db)
        if db_roles:
            return set(db_roles)

    # Fallback: legacy string field
    if project_id:
        proj_name = crud.get_project_name_by_id(project_id, db)
        if proj_name:
            old_role = context.get("project_roles", {}).get(proj_name)
            if old_role == PROJECT_ROLE_OWNER:
                return {"owner"}
            if old_role == PROJECT_ROLE_COORDINATOR:
                return {"coordinator"}
            if old_role == PROJECT_ROLE_COLLABORATOR:
                return {"member"}

    if context.get("is_ceo"):
        return {"project_ceo"}

    return set()


# ── Per-submission checks (handle project_id=NULL guard) ───────

def can_confirm(context: dict, row: models.UpdateSubmission, db: Session) -> bool:
    proj_id = project_id_of(row)
    if proj_id is None:
        return bool(context.get("is_tech_admin"))
    return can_confirm_submission_by_project(context, proj_id, db)


def can_coordinate(context: dict, row: models.UpdateSubmission, db: Session) -> bool:
    proj_id = project_id_of(row)
    if proj_id is None:
        return bool(context.get("is_tech_admin"))
    return can_coordinator_feedback_by_project(context, proj_id, db)


def can_escalate(context: dict, row: models.UpdateSubmission, db: Session) -> bool:
    proj_id = project_id_of(row)
    if proj_id is None:
        return bool(context.get("is_tech_admin"))
    return can_escalate_to_ceo_by_project(context, proj_id, db)


def can_ceo_decide(context: dict, row: models.UpdateSubmission, db: Session) -> bool:
    proj_id = project_id_of(row)
    if proj_id is None:
        return bool(context.get("is_tech_admin"))
    return can_ceo_decide_by_project(context, proj_id, db)


def can_view_in_center(
    context: dict, row: models.UpdateSubmission, db: Session
) -> bool:
    proj_id = project_id_of(row)
    return can_view_submission_in_confirmation_by_project(
        context, proj_id, row.submitter or "", db
    )


def role_allows_pending_view(
    context: dict,
    row: models.UpdateSubmission,
    db: Session,
    *,
    proj_id: int | None = None,
) -> bool:
    """
    Role-based visibility filter on top of base visibility.
    owner / super_admin → unrestricted;
    coordinator → only waiting-coordinator items;
    project_ceo → only waiting-CEO items;
    member / none → own submissions only.
    """
    if context.get("is_tech_admin"):
        return True
    if proj_id is None:
        proj_id = project_id_of(row)
    roles = user_roles_in_project(context, proj_id, db)
    if "owner" in roles or "super_admin" in roles:
        return True
    # Deferred import to avoid circular dependency with workflow
    from .workflow import submission_status
    from ..domain import submission_status as SS
    if "coordinator" in roles:
        return submission_status(row) in SS.WAITING_COORDINATOR_FEEDBACK
    if "project_ceo" in roles:
        return submission_status(row) in SS.WAITING_CEO_DECISION
    return (row.submitter or "") == context.get("name", "")


# ── Project-level capability checks (no row needed) ───────────

def can_confirm_for_project(
    context: dict, project_id: int, db: Session
) -> bool:
    return can_confirm_submission_by_project(context, project_id, db)


def can_coordinate_for_project(
    context: dict, project_id: int, db: Session
) -> bool:
    return can_coordinator_feedback_by_project(context, project_id, db)


def can_escalate_for_project(
    context: dict, project_id: int, db: Session
) -> bool:
    return can_escalate_to_ceo_by_project(context, project_id, db)


def can_ceo_decide_for_project(
    context: dict, project_id: int, db: Session
) -> bool:
    return can_ceo_decide_by_project(context, project_id, db)


def can_submit_to_project(
    context: dict, project_id: int, db: Session
) -> bool:
    """Can this user submit a progress update to the project?"""
    if context.get("is_tech_admin"):
        return True
    person_id = context.get("person_id")
    if person_id is not None:
        roles = get_all_project_roles(person_id, project_id, db)
        if roles:
            return any(r in ("owner", "member", "coordinator") for r in roles)
    proj_name = crud.get_project_name_by_id(project_id, db) or ""
    if proj_name:
        old_role = context.get("project_roles", {}).get(proj_name)
        if old_role in (PROJECT_ROLE_OWNER, PROJECT_ROLE_COORDINATOR, PROJECT_ROLE_COLLABORATOR):
            return True
    return False
