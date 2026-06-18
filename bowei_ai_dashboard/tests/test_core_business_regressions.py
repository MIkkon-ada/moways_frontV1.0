from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.auth import hash_password
from app.database import SessionLocal
from app.main import app
from app.models import Issue, Person, Project, ProjectMember, SubTask
from app.permissions import ROLE_NORMAL


TEST_PASSWORD = "testpass123"


@dataclass
class CaseData:
    project_id: int
    project_name: str
    owner: str
    owner_id: int
    member: str
    member_id: int
    coordinator: str
    coordinator_id: int
    ceo: str
    ceo_id: int
    outsider: str
    outsider_id: int


@pytest.fixture
def client_pool(passwords_file: Path):
    clients: list[TestClient] = []

    def login(username: str) -> TestClient:
        client = TestClient(app)
        clients.append(client)
        resp = client.post(
            "/api/auth/login",
            json={"username": username, "password": TEST_PASSWORD},
        )
        assert resp.status_code == 200, resp.json()
        return client

    yield login

    for client in clients:
        client.close()


@pytest.fixture
def case_data(admin_client, passwords_file: Path) -> CaseData:
    suffix = str(time.time_ns())
    project_name = f"TEST_CORE_PROJECT_{suffix}"
    names = {
        "owner": f"owner_{suffix}",
        "member": f"member_{suffix}",
        "coordinator": f"coordinator_{suffix}",
        "ceo": f"ceo_{suffix}",
        "outsider": f"outsider_{suffix}",
    }

    raw_passwords = json.loads(passwords_file.read_text(encoding="utf-8"))
    raw_passwords.update({name: hash_password(TEST_PASSWORD) for name in names.values()})
    passwords_file.write_text(
        json.dumps(raw_passwords, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    with SessionLocal() as db:
        people: dict[str, Person] = {}
        for key, name in names.items():
            person = Person(
                name=name,
                system_role=ROLE_NORMAL,
                permission="view",
                is_active=True,
                is_admin=False,
            )
            db.add(person)
            db.flush()
            people[key] = person

        project = Project(
            name=project_name,
            coordinator=names["coordinator"],
            owners=names["owner"],
            collaborators=names["member"],
            sort_order=0,
            is_active=True,
        )
        db.add(project)
        db.flush()

        for key, role in (
            ("owner", "owner"),
            ("member", "member"),
            ("coordinator", "coordinator"),
            ("ceo", "project_ceo"),
        ):
            db.add(
                ProjectMember(
                    project_id=project.id,
                    person_id=people[key].id,
                    person_name_snapshot=people[key].name,
                    role=role,
                )
            )

        db.commit()

        return CaseData(
            project_id=project.id,
            project_name=project.name,
            owner=people["owner"].name,
            owner_id=people["owner"].id,
            member=people["member"].name,
            member_id=people["member"].id,
            coordinator=people["coordinator"].name,
            coordinator_id=people["coordinator"].id,
            ceo=people["ceo"].name,
            ceo_id=people["ceo"].id,
            outsider=people["outsider"].name,
            outsider_id=people["outsider"].id,
        )


def _submit_update(client: TestClient, case: CaseData, tag: str, human_result: dict | None = None) -> dict:
    payload = {
        "project_id": case.project_id,
        "source_type": "text_update",
        "transcript_text": f"{tag} progress text",
        "submitter": case.member,
    }
    if human_result is not None:
        payload["human_result"] = human_result
    resp = client.post("/api/updates", json=payload)
    assert resp.status_code == 200, resp.json()
    return resp.json()["submission"]


def _business_payload(case: CaseData, tag: str) -> dict:
    return {
        "special_project": case.project_name,
        "task": {
            "special_project": case.project_name,
            "key_task": f"{tag} task",
            "key_achievement": f"{tag} task achievement",
            "owner": case.member,
            "status": "not_started",
            "write_task": "true",
        },
        "achievements": [
            {
                "special_project": case.project_name,
                "name": f"{tag} achievement",
                "achievement_type": "document",
                "owner": case.member,
                "write_achievement": "true",
            }
        ],
        "issues": [
            {
                "special_project": case.project_name,
                "description": f"{tag} issue",
                "issue_type": "risk",
                "owner": case.owner,
                "priority": "high",
                "status": "open",
                "write_issue": "true",
            }
        ],
    }


def test_owner_confirmation_writes_selected_business_rows(case_data: CaseData, client_pool):
    member = client_pool(case_data.member)
    owner = client_pool(case_data.owner)

    payload = _business_payload(case_data, "selected-write")
    payload["task"]["write_task"] = "false"
    payload["issues"][0]["write_issue"] = "false"
    submission = _submit_update(member, case_data, "selected-write", payload)

    resp = owner.post(
        f"/api/confirmations/{submission['id']}/confirm",
        json={"operator": case_data.owner, "human_result": payload},
    )

    assert resp.status_code == 200, resp.json()
    assert owner.get("/api/tasks", params={"project_id": case_data.project_id}).json() == []
    achievements = owner.get("/api/achievements", params={"project_id": case_data.project_id}).json()
    assert [item["name"] for item in achievements] == ["selected-write achievement"]
    assert owner.get("/api/issues", params={"project_id": case_data.project_id}).json() == []


def test_confirmation_infers_task_reports_without_frontend_write_mode(case_data: CaseData, client_pool):
    owner = client_pool(case_data.owner)
    member = client_pool(case_data.member)

    task_resp = owner.post(
        "/api/tasks",
        json={
            "project_id": case_data.project_id,
            "special_project": case_data.project_name,
            "key_task": "确认中心结构化进展",
            "key_achievement": "形成可验收交付",
            "completion_standard": "负责人确认后关闭",
            "owner": case_data.owner,
            "plan_time": "2026-06",
            "status": "进行中",
        },
    )
    assert task_resp.status_code == 200, task_resp.json()
    task_id = task_resp.json()["id"]

    # F: only owner/coordinator can directly create subtasks; member role is blocked
    sub_resp = owner.post(
        f"/api/tasks/{task_id}/subtasks",
        json={
            "title": "成员完成联调",
            "assignee": case_data.member,
            "plan_time": "2026-06",
            "status": "进行中",
        },
    )
    assert sub_resp.status_code == 200, sub_resp.json()
    subtask_id = sub_resp.json()["id"]

    submission = _submit_update(
        member,
        case_data,
        "structured-progress",
        {
            "special_project": case_data.project_name,
            "related_task": "确认中心结构化进展",
            "task_reports": [
                {
                    "type": "progress",
                    "matched_subtask_id": subtask_id,
                    "matched_subtask_title": "成员完成联调",
                    "completed": "联调已完成，等待负责人验收",
                    "status_update": "已完成",
                }
            ],
        },
    )

    confirmed = owner.post(
        f"/api/confirmations/{submission['id']}/confirm",
        json={"operator": case_data.owner},
    )
    assert confirmed.status_code == 200, confirmed.json()

    with SessionLocal() as db:
        subtask = db.get(SubTask, subtask_id)
        assert subtask.status == "已完成"
        assert subtask.source_submission_id == submission["id"]

    parent = owner.get(f"/api/tasks/{task_id}")
    assert parent.status_code == 200, parent.json()
    assert parent.json()["status"] == "进行中"


def test_confirmation_writes_key_task_issues_without_task_reports(case_data: CaseData, client_pool):
    member = client_pool(case_data.member)
    owner = client_pool(case_data.owner)

    submission = _submit_update(
        member,
        case_data,
        "structured-issue",
        {
            "special_project": case_data.project_name,
            "related_task": "确认中心问题上报",
            "key_task_issues": [
                {
                    "key_task_title": "确认中心问题上报",
                    "issue_type": "需决策",
                    "description": "需要负责人确认上线窗口",
                    "need_coordination": ["负责人"],
                    "priority": "高",
                }
            ],
        },
    )

    confirmed = owner.post(
        f"/api/confirmations/{submission['id']}/confirm",
        json={"operator": case_data.owner},
    )
    assert confirmed.status_code == 200, confirmed.json()

    with SessionLocal() as db:
        issues = (
            db.query(Issue)
            .filter(Issue.project_id == case_data.project_id)
            .order_by(Issue.id.asc())
            .all()
        )
        assert [item.description for item in issues] == ["需要负责人确认上线窗口"]
        assert issues[0].source_submission_id == submission["id"]


def test_reject_resubmit_confirm_flow(case_data: CaseData, client_pool):
    member = client_pool(case_data.member)
    owner = client_pool(case_data.owner)
    payload = _business_payload(case_data, "resubmit")
    submission = _submit_update(member, case_data, "resubmit", payload)

    rejected = owner.post(
        f"/api/confirmations/{submission['id']}/reject",
        json={"operator": case_data.owner, "reason": "needs more detail"},
    )
    assert rejected.status_code == 200, rejected.json()

    resubmitted = member.post(
        f"/api/confirmations/{submission['id']}/resubmit",
        json={
            "operator": case_data.member,
            "supplement_note": "added detail",
            "human_result": payload,
        },
    )
    assert resubmitted.status_code == 200, resubmitted.json()

    confirmed = owner.post(
        f"/api/confirmations/{submission['id']}/confirm",
        json={"operator": case_data.owner},
    )
    assert confirmed.status_code == 200, confirmed.json()
    tasks = owner.get("/api/tasks", params={"project_id": case_data.project_id}).json()
    assert [item["key_task"] for item in tasks] == ["resubmit task"]


def test_withdraw_only_allows_original_submitter_before_review(case_data: CaseData, client_pool):
    member = client_pool(case_data.member)
    outsider = client_pool(case_data.outsider)
    submission = _submit_update(member, case_data, "withdraw")

    forbidden = outsider.post(f"/api/confirmations/{submission['id']}/withdraw")
    assert forbidden.status_code == 403, forbidden.json()

    withdrawn = member.post(f"/api/confirmations/{submission['id']}/withdraw")
    assert withdrawn.status_code == 200, withdrawn.json()
    assert withdrawn.json()["submission"]["id"] == submission["id"]


def test_project_scope_blocks_cross_project_member_visibility(case_data: CaseData, client_pool):
    member = client_pool(case_data.member)
    outsider = client_pool(case_data.outsider)
    owner = client_pool(case_data.owner)
    payload = _business_payload(case_data, "scope")
    submission = _submit_update(member, case_data, "scope", payload)
    confirmed = owner.post(
        f"/api/confirmations/{submission['id']}/confirm",
        json={"operator": case_data.owner, "human_result": payload},
    )
    assert confirmed.status_code == 200, confirmed.json()

    assert outsider.get("/api/tasks", params={"project_id": case_data.project_id}).json() == []
    pending = outsider.get("/api/confirmations/pending", params={"project_id": case_data.project_id})
    assert pending.status_code in (200, 403)
    if pending.status_code == 200:
        assert pending.json() == []


def test_last_owner_protection_for_active_project(admin_client, case_data: CaseData):
    members = admin_client.get(f"/api/projects/{case_data.project_id}/members")
    assert members.status_code == 200, members.json()
    owner_member_id = next(m["id"] for m in members.json() if m["role"] == "owner")

    delete_resp = admin_client.delete(f"/api/projects/{case_data.project_id}/members/{owner_member_id}")
    assert delete_resp.status_code == 409, delete_resp.json()
    assert delete_resp.json()["detail"]["owner_count"] == 1

    patch_resp = admin_client.patch(
        f"/api/projects/{case_data.project_id}/members/{owner_member_id}",
        json={"role": "member"},
    )
    assert patch_resp.status_code == 409, patch_resp.json()
    assert patch_resp.json()["detail"]["owner_count"] == 1


def test_dashboard_counts_confirmed_submission_and_written_rows(case_data: CaseData, client_pool):
    member = client_pool(case_data.member)
    owner = client_pool(case_data.owner)
    payload = _business_payload(case_data, "dashboard")
    submission = _submit_update(member, case_data, "dashboard", payload)
    confirmed = owner.post(
        f"/api/confirmations/{submission['id']}/confirm",
        json={"operator": case_data.owner, "human_result": payload},
    )
    assert confirmed.status_code == 200, confirmed.json()

    overview = owner.get("/api/dashboard/overview", params={"project_id": case_data.project_id})
    assert overview.status_code == 200, overview.json()
    body = overview.json()
    assert body["task_stats"]["total_tasks"] == 1
    assert body["achievement_stats"]["total_achievements"] == 1
    assert body["issue_stats"]["total_issues"] == 1
    assert body["submission_stats"]["confirmed_submissions"] == 1


def test_legacy_special_project_query_returns_empty_for_unknown_project(case_data: CaseData, client_pool):
    owner = client_pool(case_data.owner)

    tasks = owner.get("/api/tasks", params={"special_project": "UNKNOWN_LEGACY_PROJECT"})
    achievements = owner.get("/api/achievements", params={"special_project": "UNKNOWN_LEGACY_PROJECT"})
    issues = owner.get("/api/issues", params={"special_project": "UNKNOWN_LEGACY_PROJECT"})
    meetings = owner.get("/api/meetings", params={"related_special_project": "UNKNOWN_LEGACY_PROJECT"})

    assert tasks.status_code == 200
    assert achievements.status_code == 200
    assert issues.status_code == 200
    assert meetings.status_code == 200
    assert tasks.json() == []
    assert achievements.json() == []
    assert issues.json() == []
    assert meetings.json() == []


def test_update_deduplicates_same_submitter_text_provider_within_window(case_data: CaseData, client_pool):
    member = client_pool(case_data.member)
    payload = {
        "project_id": case_data.project_id,
        "source_type": "text_update",
        "transcript_text": "same text within dedupe window",
        "submitter": case_data.member,
        "llm_provider": "rules",
    }

    first = member.post("/api/updates", json=payload)
    second = member.post("/api/updates", json=payload)

    assert first.status_code == 200, first.json()
    assert second.status_code == 200, second.json()
    assert first.json()["submission"]["id"] == second.json()["submission"]["id"]
