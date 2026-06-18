"""
语音更新候选池角色隔离测试

覆盖：
  - 普通成员只能看到自己负责的子任务（不含同项目其他人的子任务）
  - 关键任务负责人可以看到其关键任务下的所有子任务（含他人 assignee）
  - 项目负责人（owner）可以看到项目下全部子任务

运行：
  python -m pytest tests/test_voice_context_scope.py -v
"""
from __future__ import annotations

from datetime import datetime
import pytest
from fastapi.testclient import TestClient

from app import models
from app.database import SessionLocal
from app.main import app

_TS = datetime.now().strftime("%Y%m%d%H%M%S%f")


# ── 夹具 ─────────────────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def vc_project(admin_client):
    """创建测试专用项目。"""
    resp = admin_client.post("/api/projects", json={
        "name": f"VC测试项目_{_TS}",
        "status": "active",
    })
    assert resp.status_code == 200, resp.json()
    pid = resp.json()["id"]
    yield pid
    admin_client.post(f"/api/projects/{pid}/archive", json={})


def _make_person_and_login(admin_client, name: str, username: str, password: str) -> tuple[int, TestClient]:
    """创建 Person + 账号，返回 (person_id, 登录后的 TestClient)。"""
    with SessionLocal() as db:
        p = models.Person(name=name, system_role="普通成员", is_active=True)
        db.add(p)
        db.commit()
        db.refresh(p)
        person_id = p.id

    admin_client.post("/api/accounts", json={
        "username": username,
        "password": password,
        "person_id": person_id,
    })

    client = TestClient(app)
    login = client.post("/api/auth/login", json={"username": username, "password": password})
    assert login.status_code == 200, f"登录失败: {login.json()}"
    return person_id, client


@pytest.fixture(scope="module")
def user_a(admin_client):
    pid, client = _make_person_and_login(admin_client, f"VC用户A_{_TS}", f"vc_a_{_TS}", "pass123")
    return {"person_id": pid, "client": client, "name": f"VC用户A_{_TS}"}


@pytest.fixture(scope="module")
def user_b(admin_client):
    pid, client = _make_person_and_login(admin_client, f"VC用户B_{_TS}", f"vc_b_{_TS}", "pass123")
    return {"person_id": pid, "client": client, "name": f"VC用户B_{_TS}"}


@pytest.fixture(scope="module")
def user_owner(admin_client):
    pid, client = _make_person_and_login(admin_client, f"VC项目Owner_{_TS}", f"vc_owner_{_TS}", "pass123")
    return {"person_id": pid, "client": client, "name": f"VC项目Owner_{_TS}"}


@pytest.fixture(scope="module")
def vc_setup(admin_client, vc_project, user_a, user_b, user_owner):
    """
    搭建测试数据：
      - 关键任务1：owner = user_a
        - 子任务1-1：assignee = user_a
        - 子任务1-2：assignee = user_b（user_a 以 task_owner 身份应能看到）
      - 关键任务2：owner = user_b
        - 子任务2-1：assignee = user_b
      - user_a 是 project member；user_b 是 project member；user_owner 是 project owner
    """
    pid = vc_project

    # 添加成员
    admin_client.post(f"/api/projects/{pid}/members", json={
        "person_id": user_a["person_id"], "role": "member",
    })
    admin_client.post(f"/api/projects/{pid}/members", json={
        "person_id": user_b["person_id"], "role": "member",
    })
    admin_client.post(f"/api/projects/{pid}/members", json={
        "person_id": user_owner["person_id"], "role": "owner",
    })

    with SessionLocal() as db:
        # 关键任务1：owner = user_a
        t1 = models.Task(
            project_id=pid,
            key_task=f"关键任务A_{_TS}",
            owner=user_a["name"],
            is_deleted=False,
        )
        db.add(t1)
        db.flush()

        # 关键任务2：owner = user_b
        t2 = models.Task(
            project_id=pid,
            key_task=f"关键任务B_{_TS}",
            owner=user_b["name"],
            is_deleted=False,
        )
        db.add(t2)
        db.flush()

        # 子任务1-1：task1, assignee=user_a
        st_a1 = models.SubTask(
            task_id=t1.id,
            title=f"子任务A1_{_TS}",
            assignee=user_a["name"],
            status="进行中",
            is_deleted=False,
        )
        db.add(st_a1)
        # 子任务1-2：task1, assignee=user_b (属于 user_a 的关键任务)
        st_a2 = models.SubTask(
            task_id=t1.id,
            title=f"子任务A2归属UserA关键任务_{_TS}",
            assignee=user_b["name"],
            status="进行中",
            is_deleted=False,
        )
        db.add(st_a2)
        # 子任务2-1：task2, assignee=user_b
        st_b1 = models.SubTask(
            task_id=t2.id,
            title=f"子任务B1_{_TS}",
            assignee=user_b["name"],
            status="进行中",
            is_deleted=False,
        )
        db.add(st_b1)

        db.commit()
        db.refresh(st_a1)
        db.refresh(st_a2)
        db.refresh(st_b1)

        return {
            "task1_id": t1.id,
            "task2_id": t2.id,
            "st_a1_id": st_a1.id,   # user_a 自己的子任务
            "st_a2_id": st_a2.id,   # user_a 关键任务下的子任务（assignee=user_b）
            "st_b1_id": st_b1.id,   # user_b 自己的子任务（在 user_b 的关键任务下）
        }


# ── 测试 ──────────────────────────────────────────────────────────────────────

def test_regular_member_sees_own_subtask_only(vc_setup, user_a, user_b, vc_project):
    """
    user_b 作为普通成员：
      - 能看到 st_b1（自己的子任务，在自己的关键任务下）
      - 能看到 st_a2（自己是 assignee，但在 user_a 的关键任务下）
      - 不能看到 st_a1（assignee=user_a，关键任务 owner 也是 user_a）
    """
    ids = vc_setup
    resp = user_b["client"].get(f"/api/updates/voice-context?project_id={vc_project}")
    assert resp.status_code == 200, resp.json()
    returned_ids = {item["id"] for item in resp.json()}

    assert ids["st_b1_id"] in returned_ids, "user_b 应能看到自己的子任务 st_b1"
    assert ids["st_a2_id"] in returned_ids, "user_b 应能看到自己是 assignee 的 st_a2（即使在他人关键任务下）"
    assert ids["st_a1_id"] not in returned_ids, "user_b 不应看到 assignee=user_a 的 st_a1"


def test_task_owner_sees_subtasks_under_own_key_task(vc_setup, user_a, vc_project):
    """
    user_a 是关键任务1的 owner：
      - 能看到 st_a1（自己 assignee + 自己的关键任务）
      - 能看到 st_a2（关键任务 owner 是 user_a，即使 assignee=user_b）
      - 不能看到 st_b1（关键任务 owner 是 user_b，user_a 不是其 assignee）
    """
    ids = vc_setup
    resp = user_a["client"].get(f"/api/updates/voice-context?project_id={vc_project}")
    assert resp.status_code == 200, resp.json()
    returned_ids = {item["id"] for item in resp.json()}

    assert ids["st_a1_id"] in returned_ids, "user_a 应能看到自己的子任务 st_a1"
    assert ids["st_a2_id"] in returned_ids, "user_a 作为关键任务 owner 应能看到其任务下的 st_a2"
    assert ids["st_b1_id"] not in returned_ids, "user_a 不应看到 user_b 关键任务下的 st_b1"


def test_project_owner_sees_all_subtasks(vc_setup, user_owner, vc_project):
    """项目 owner 应能看到项目下全部子任务。"""
    ids = vc_setup
    resp = user_owner["client"].get(f"/api/updates/voice-context?project_id={vc_project}")
    assert resp.status_code == 200, resp.json()
    returned_ids = {item["id"] for item in resp.json()}

    assert ids["st_a1_id"] in returned_ids, "项目 owner 应能看到 st_a1"
    assert ids["st_a2_id"] in returned_ids, "项目 owner 应能看到 st_a2"
    assert ids["st_b1_id"] in returned_ids, "项目 owner 应能看到 st_b1"


def test_user_relation_field_present(vc_setup, user_a, user_owner, vc_project):
    """返回结果中必须包含 user_relation 字段，且值合法。"""
    ids = vc_setup
    valid_relations = {"owner", "coordinator", "task_owner", "subtask_assignee"}

    for client, label in [(user_a["client"], "user_a"), (user_owner["client"], "user_owner")]:
        resp = client.get(f"/api/updates/voice-context?project_id={vc_project}")
        assert resp.status_code == 200, f"{label}: {resp.json()}"
        for item in resp.json():
            assert "user_relation" in item, f"{label}: 缺少 user_relation 字段"
            assert item["user_relation"] in valid_relations, (
                f"{label}: user_relation={item['user_relation']!r} 不是合法值"
            )


def test_no_completed_subtasks_returned(vc_project, user_owner, admin_client):
    """已完成的子任务不应出现在候选池中。"""
    with SessionLocal() as db:
        # 创建一个已完成的子任务
        t = db.query(models.Task).filter_by(project_id=vc_project, is_deleted=False).first()
        if t is None:
            pytest.skip("测试项目下没有关键任务，跳过")
        st = models.SubTask(
            task_id=t.id,
            title=f"已完成子任务_{_TS}",
            assignee=user_owner["name"],
            status="已完成",
            is_deleted=False,
        )
        db.add(st)
        db.commit()
        db.refresh(st)
        st_id = st.id

    resp = user_owner["client"].get(f"/api/updates/voice-context?project_id={vc_project}")
    assert resp.status_code == 200, resp.json()
    returned_ids = {item["id"] for item in resp.json()}
    assert st_id not in returned_ids, "已完成的子任务不应出现在候选池中"
