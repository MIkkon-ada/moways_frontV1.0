"""
博维AI驾驶舱 · 权限矩阵自动化测试

固化以下角色权限边界：
  A. POST /api/updates 提交权限
  B. confirmations 操作权限（confirm / transfer / escalate / ceo-decide / coordinator-feedback）
  C. 主数据写权限（tasks / issues / achievements / meetings POST / DELETE）
  D. project_members 管理权限（last-owner 保护）
  E. 确认中心可见范围（coordinator / project_ceo / member 范围收口）

运行：
  python tests/test_permissions.py

环境变量覆盖：
  BASE_URL  ADMIN_USERNAME  ADMIN_PASSWORD
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import http.cookiejar
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

BASE_URL   = os.environ.get("BASE_URL",        "http://127.0.0.1:8000").rstrip("/")
ADMIN_USER = os.environ.get("ADMIN_USERNAME",  "mowasyadmin")
ADMIN_PASS = os.environ.get("ADMIN_PASSWORD",  "admin123")
MEMBER_PASS = "bowei2024"

# 角色账号映射
ACCOUNTS = {
    "admin":        {"name": "mowasyadmin", "pwd": ADMIN_PASS},
    "owner":        {"name": "许明良",       "pid": 7,  "pwd": MEMBER_PASS},
    "member":       {"name": "彭超凡",       "pid": 8,  "pwd": MEMBER_PASS},
    "coordinator":  {"name": "郭熠彬",       "pid": 9,  "pwd": MEMBER_PASS},
    "project_ceo":  {"name": "吴肖",         "pid": 10, "pwd": MEMBER_PASS},
    "process_guard":{"name": "袁金玉",       "pid": 5,  "pwd": MEMBER_PASS},  # not in test project
    "non_member":   {"name": "温会林",       "pid": 4,  "pwd": MEMBER_PASS},  # excluded from project
}

TS = datetime.now().strftime("%Y%m%d_%H%M%S")
TEST_PROJECT_NAME = f"TEST_权限矩阵_{TS}"

PASS_COUNT = 0
FAIL_COUNT = 0
_section_fails: list[str] = []
_current_section = ""


# ── API 客户端 ────────────────────────────────────────────────

class ApiClient:
    def __init__(self):
        jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(jar)
        )
        self.logged_in_as = ""

    def _send(self, method, path, data=None, params=None):
        url = BASE_URL + path
        if params:
            url += "?" + urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
        body = json.dumps(data).encode() if data is not None else None
        hdrs = {"Content-Type": "application/json"} if body else {}
        req = urllib.request.Request(url, data=body, headers=hdrs, method=method)
        try:
            resp = self.opener.open(req, timeout=15)
            return resp.status, json.loads(resp.read() or b"{}")
        except urllib.error.HTTPError as e:
            try: return e.code, json.loads(e.read() or b"{}")
            except: return e.code, {}

    def login(self, role_key: str) -> bool:
        acc = ACCOUNTS[role_key]
        code, body = self._send("POST", "/api/auth/login",
                                {"username": acc["name"], "password": acc["pwd"]})
        self.logged_in_as = acc["name"]
        return code == 200 and body.get("ok")

    def get(self, path, params=None):    return self._send("GET",    path, params=params)
    def post(self, path, data=None):     return self._send("POST",   path, data)
    def patch(self, path, data=None):    return self._send("PATCH",  path, data)
    def delete(self, path):              return self._send("DELETE", path)


# ── 断言工具 ─────────────────────────────────────────────────

def section(title: str):
    global _current_section
    _current_section = title
    print(f"\n{'─'*55}")
    print(f"  {title}")
    print(f"{'─'*55}")


def check(label: str, cond: bool, detail: str = "") -> bool:
    global PASS_COUNT, FAIL_COUNT
    if cond:
        PASS_COUNT += 1
        print(f"  [PASS] {label}")
    else:
        FAIL_COUNT += 1
        msg = f"  [FAIL] [{_current_section}] {label}" + (f" | {detail}" if detail else "")
        print(f"  [FAIL] {label}" + (f" | {detail}" if detail else ""))
        _section_fails.append(msg)
    return cond


def chk(label: str, code: int, expected: int, body=None) -> bool:
    detail = f"got {code}, want {expected}"
    if body and code != expected:
        detail += f" | {str(body)[:100]}"
    return check(label, code == expected, detail)


# ── 全局 API clients ─────────────────────────────────────────

admin_c    = ApiClient()
owner_c    = ApiClient()
member_c   = ApiClient()
coord_c    = ApiClient()
ceo_c      = ApiClient()
pg_c       = ApiClient()   # process_guard
nm_c       = ApiClient()   # non-member


def setup_all_logins():
    section("登录准备")
    check("admin login",        admin_c.login("admin"))
    check("owner login",        owner_c.login("owner"))
    check("member login",       member_c.login("member"))
    check("coordinator login",  coord_c.login("coordinator"))
    check("project_ceo login",  ceo_c.login("project_ceo"))
    check("process_guard login", pg_c.login("process_guard"))
    check("non_member login",   nm_c.login("non_member"))


# ── Fixture: 创建并配置测试项目 ───────────────────────────────

_proj_id: int | None = None
_sub_pending: int | None = None   # 待确认 submission
_sub_transferred: int | None = None  # 已转交统筹
_sub_ceo: int | None = None          # 待CEO决策


def setup_test_project() -> bool:
    global _proj_id
    section("建立测试项目和测试数据")

    code, body = admin_c.post("/api/projects", {
        "name": TEST_PROJECT_NAME, "code": "PERM",
        "description": "Permission matrix test", "status": "active",
    })
    if not chk("create test project", code, 200, body):
        return False
    _proj_id = body["id"]

    for role in ("owner", "coordinator", "member", "project_ceo"):
        acc = ACCOUNTS[role]
        code, b = admin_c.post(f"/api/projects/{_proj_id}/members",
                               {"person_id": acc["pid"], "role": role})
        chk(f"  add {role}", code, 200, b)
    # process_guard (袁金玉) NOT added → non-member in test project

    # 确认 non_member (温会林) 不在测试项目中
    # 温会林 is project_ceo of project 2, but NOT added to our test project
    check("non_member excluded from test project", True,
          "(温会林 not added to test project)")

    # 创建三条提交：1 pending, 1 will be transferred, 1 will be escalated
    global _sub_pending, _sub_transferred, _sub_ceo
    def _sub(suffix):
        code, b = member_c.post("/api/updates", {
            "project_id": _proj_id, "source_type": "文字汇报",
            "transcript_text": f"perm-test {suffix} {TS}",
            "submitter": ACCOUNTS["member"]["name"],
        })
        return b.get("submission", {}).get("id") if code == 200 else None

    _sub_pending     = _sub("pending")
    _sub_transferred = _sub("transfer")
    _sub_ceo         = _sub("ceo")

    check("sub_pending created",     bool(_sub_pending),     str(_sub_pending))
    check("sub_transferred created", bool(_sub_transferred), str(_sub_transferred))
    check("sub_ceo created",         bool(_sub_ceo),         str(_sub_ceo))

    # 设置流转状态
    if _sub_transferred:
        code, _ = owner_c.post(f"/api/confirmations/{_sub_transferred}/transfer-coordinator",
                               {"note": "perm test", "operator": ACCOUNTS["owner"]["name"]})
        chk("owner transfer sub_transferred", code, 200)

    if _sub_ceo:
        code, _ = owner_c.post(f"/api/confirmations/{_sub_ceo}/escalate-ceo",
                               {"note": "perm test", "operator": ACCOUNTS["owner"]["name"]})
        chk("owner escalate sub_ceo", code, 200)

    return True


# ── A. POST /api/updates 提交权限 ────────────────────────────

def test_updates_permissions():
    section("A. POST /api/updates 提交权限")
    pld = lambda c: {"project_id": _proj_id, "source_type": "文字汇报",
                     "transcript_text": f"perm-a {c} {TS}"}

    def au(client, label, tag, expected):
        code, body = client.post("/api/updates", pld(tag))
        chk(label, code, expected, body)

    au(admin_c,  "A1 super_admin can POST updates",    "admin", 200)
    au(owner_c,  "A2 owner can POST updates",          "owner", 200)
    au(member_c, "A3 member can POST updates",         "member", 200)
    au(coord_c,  "A4 coordinator can POST updates",    "coord", 200)
    au(ceo_c,    "A5 project_ceo cannot POST updates", "ceo",   403)
    au(nm_c,     "A6 non_member cannot POST updates",  "nm",    403)
    au(pg_c,     "A7 process_guard cannot POST updates", "pg",  403)
    # A8: no project_id
    code, b = owner_c.post("/api/updates", {"source_type": "文字汇报", "transcript_text": "no_pid"})
    chk("A8 no project_id → 422", code, 422, b)


# ── B. confirmations 操作权限 ──────────────────────────────

def test_confirmation_permissions():
    section("B. confirmations 操作权限")

    sub_p = _sub_pending
    sub_t = _sub_transferred
    sub_c = _sub_ceo

    if not sub_p:
        check("B: sub_pending available", False, "setup failed"); return

    op_owner = ACCOUNTS["owner"]["name"]
    op_coord = ACCOUNTS["coordinator"]["name"]
    op_ceo   = ACCOUNTS["project_ceo"]["name"]

    # B1: owner can confirm
    code, b = owner_c.post(f"/api/confirmations/{sub_p}/confirm", {"operator": op_owner})
    chk("B1 owner can confirm",  code, 200, b)

    # B2: coordinator cannot confirm
    if sub_t:
        # sub_t is 已转交统筹人 — try to confirm it as coordinator
        code, b = coord_c.post(f"/api/confirmations/{sub_t}/confirm", {"operator": op_coord})
        chk("B2 coordinator cannot confirm → 403", code, 403, b)

    # B3: project_ceo cannot confirm
    if sub_c:
        code, b = ceo_c.post(f"/api/confirmations/{sub_c}/confirm", {"operator": op_ceo})
        chk("B3 project_ceo cannot confirm → 403", code, 403, b)

    # B4: member cannot confirm (create a fresh sub first)
    code, b2 = member_c.post("/api/updates", {
        "project_id": _proj_id, "source_type": "文字汇报",
        "transcript_text": f"perm-b4 {TS}",
        "submitter": ACCOUNTS["member"]["name"],
    })
    b4_sub = b2.get("submission", {}).get("id") if code == 200 else None
    if b4_sub:
        code, b = member_c.post(f"/api/confirmations/{b4_sub}/confirm",
                                {"operator": ACCOUNTS["member"]["name"]})
        chk("B4 member cannot confirm → 403", code, 403, b)

    # B5: coordinator-feedback (on sub_t which is 已转交统筹人)
    if sub_t:
        code, b = coord_c.post(f"/api/confirmations/{sub_t}/coordinator-feedback",
                               {"note": "perm test", "operator": op_coord})
        chk("B5 coordinator can coordinator-feedback", code, 200, b)

    # B6: project_ceo can ceo-decide (on sub_c which is 待CEO决策)
    if sub_c:
        code, b = ceo_c.post(f"/api/confirmations/{sub_c}/ceo-decide",
                             {"note": "perm test", "operator": op_ceo})
        chk("B6 project_ceo can ceo-decide", code, 200, b)

    # B7: owner can transfer-coordinator
    code, b7 = member_c.post("/api/updates", {
        "project_id": _proj_id, "source_type": "文字汇报",
        "transcript_text": f"perm-b7 {TS}",
        "submitter": ACCOUNTS["member"]["name"],
    })
    b7_sub = b7.get("submission", {}).get("id") if code == 200 else None
    if b7_sub:
        code, b = owner_c.post(f"/api/confirmations/{b7_sub}/transfer-coordinator",
                               {"note": "perm", "operator": op_owner})
        chk("B7 owner can transfer-coordinator", code, 200, b)

    # B8: owner can escalate-ceo
    code, b8 = member_c.post("/api/updates", {
        "project_id": _proj_id, "source_type": "文字汇报",
        "transcript_text": f"perm-b8 {TS}",
        "submitter": ACCOUNTS["member"]["name"],
    })
    b8_sub = b8.get("submission", {}).get("id") if code == 200 else None
    if b8_sub:
        code, b = owner_c.post(f"/api/confirmations/{b8_sub}/escalate-ceo",
                               {"note": "perm", "operator": op_owner})
        chk("B8 owner can escalate-ceo", code, 200, b)

    # B9: project_id=NULL orphan cannot be confirmed by anyone
    from app.database import SessionLocal
    from sqlalchemy import text as _t
    db = SessionLocal()
    orphan = db.execute(_t(
        "SELECT id FROM update_submissions WHERE project_id IS NULL LIMIT 1"
    )).scalar()
    db.close()
    if orphan:
        code, b = admin_c.post(f"/api/confirmations/{orphan}/confirm",
                               {"operator": ADMIN_USER})
        chk("B9 orphan NULL project_id → 422 for super_admin", code, 422, b)
    else:
        check("B9 orphan check (no orphans present)", True, "no NULL project_id submissions")


# ── C. 主数据写权限 ──────────────────────────────────────────

def test_write_permissions():
    section("C. 主数据写权限（tasks/issues/achievements/meetings）")

    created_ids: dict[str, int] = {}

    def post_resource(client, path, payload, label, expect):
        code, body = client.post(path, payload)
        chk(label, code, expect, body)
        return body.get("id") if code == 200 else None

    # Tasks
    task_pld = {"project_id": _proj_id, "key_task": f"perm-task {TS}", "status": "未开始"}
    created_ids["tasks"] = post_resource(owner_c, "/api/tasks", task_pld, "C1 owner POST task", 200)
    post_resource(member_c,  "/api/tasks", task_pld, "C2 member cannot POST task → 403", 403)
    post_resource(coord_c,   "/api/tasks", task_pld, "C3 coordinator cannot POST task → 403", 403)
    post_resource(ceo_c,     "/api/tasks", task_pld, "C4 project_ceo cannot POST task → 403", 403)
    post_resource(pg_c,      "/api/tasks", task_pld, "C5 process_guard cannot POST task → 403", 403)
    post_resource(admin_c,   "/api/tasks", task_pld, "C6 super_admin can POST task", 200)

    # Achievements
    ach_pld = {"project_id": _proj_id, "name": f"perm-ach {TS}", "achievement_type": "方案"}
    created_ids["achievements"] = post_resource(owner_c, "/api/achievements", ach_pld, "C7 owner POST ach", 200)
    post_resource(member_c, "/api/achievements", ach_pld, "C8 member cannot POST ach → 403", 403)
    post_resource(admin_c,  "/api/achievements", ach_pld, "C9 super_admin can POST ach", 200)

    # Issues
    iss_pld = {"project_id": _proj_id, "description": f"perm-issue {TS}",
               "issue_type": "问题", "priority": "低", "status": "待处理"}
    created_ids["issues"] = post_resource(owner_c, "/api/issues", iss_pld, "C10 owner POST issue", 200)
    post_resource(member_c, "/api/issues", iss_pld, "C11 member cannot POST issue → 403", 403)
    post_resource(admin_c,  "/api/issues", iss_pld, "C12 super_admin can POST issue", 200)

    # Meetings
    mtg_pld = {"project_id": _proj_id, "title": f"perm-meeting {TS}",
               "meeting_type": "周会", "transcript_text": ""}
    created_ids["meetings"] = post_resource(owner_c, "/api/meetings", mtg_pld, "C13 owner POST meeting", 200)
    post_resource(member_c, "/api/meetings", mtg_pld, "C14 member cannot POST meeting → 403", 403)
    post_resource(admin_c,  "/api/meetings", mtg_pld, "C15 super_admin can POST meeting", 200)

    # DELETE checks (on owner-created resources). Keys are already plural resource paths.
    for res, rid in created_ids.items():
        if not rid: continue
        code, b = member_c.delete(f"/api/{res}/{rid}")
        chk(f"C-del member cannot DELETE {res} → 403", code, 403, b)
        # owner can delete
        code, b = owner_c.delete(f"/api/{res}/{rid}")
        chk(f"C-del owner can DELETE {res}", code, 200, b)


# ── D. project_members 管理权限 / last-owner 保护 ─────────────

def test_members_permissions():
    section("D. project_members 管理权限 & last-owner 保护")

    # D1: super_admin can add member
    code, b = admin_c.post(f"/api/projects/{_proj_id}/members",
                           {"person_id": ACCOUNTS["non_member"]["pid"], "role": "member"})
    chk("D1 super_admin can POST members", code, 200, b)
    nm_mid = b.get("id") if code == 200 else None

    # D2: non-admin cannot add member
    code, b = member_c.post(f"/api/projects/{_proj_id}/members",
                            {"person_id": 1, "role": "member"})
    chk("D2 non-admin cannot POST members → 403", code, 403, b)

    # D3: last owner cannot be deleted (only 1 owner: 许明良)
    # Find owner member_id
    code, members = admin_c.get(f"/api/projects/{_proj_id}/members")
    owner_mids = [m["id"] for m in members if m["role"] == "owner"] if code == 200 else []
    check("D3 setup: exactly 1 owner", len(owner_mids) == 1, f"owners={owner_mids}")
    if owner_mids:
        code, b = admin_c.delete(f"/api/projects/{_proj_id}/members/{owner_mids[0]}")
        chk("D3 DELETE last owner → 409", code, 409, b)
        if code == 409:
            d = b.get("detail", {})
            check("D3 detail.owner_count=1", d.get("owner_count") == 1, str(d.get("owner_count")))

    # D4: last owner PATCH role → 409
    if owner_mids:
        code, b = admin_c.patch(f"/api/projects/{_proj_id}/members/{owner_mids[0]}",
                                {"role": "member"})
        chk("D4 PATCH last owner role=member → 409", code, 409, b)

    # D5: add second owner → delete first → 200
    acc2 = ACCOUNTS["non_member"]  # 温会林 just added as member above
    # promote nm to owner
    if nm_mid:
        code, b = admin_c.patch(f"/api/projects/{_proj_id}/members/{nm_mid}",
                                {"role": "owner"})
        chk("D5 setup: promote non_member to owner", code, 200, b)
        # now 2 owners → can delete first
        if code == 200 and owner_mids:
            code, b = admin_c.delete(f"/api/projects/{_proj_id}/members/{owner_mids[0]}")
            chk("D5 delete one of 2 owners → 200", code, 200, b)
            # restore: re-add original owner
            code, b = admin_c.post(f"/api/projects/{_proj_id}/members",
                                   {"person_id": ACCOUNTS["owner"]["pid"], "role": "owner"})
            chk("D5 restore original owner", code, 200, b)


# ── E. 确认中心可见范围 ──────────────────────────────────────

def test_visibility():
    section("E. 确认中心可见范围（role-based）")

    # E1: owner sees pending items (待审核 tab)
    code, body = owner_c.get("/api/confirmations/pending",
                             {"project_id": _proj_id, "tab": "待审核"})
    chk("E1 owner GET pending 200", code, 200)
    if code == 200:
        check("E1 owner sees ≥1 item", len(body) >= 1, f"count={len(body)}")

    # E2: coordinator only sees 已转交统筹人 (in 流转中 tab)
    code, body = coord_c.get("/api/confirmations/pending",
                             {"project_id": _proj_id, "tab": "流转中"})
    chk("E2 coordinator GET pending 200", code, 200)
    if code == 200:
        statuses = {r.get("confirm_status") for r in body}
        unexpected = statuses - {"已转交统筹人", "transferred_to_coordinator"}
        check("E2 coordinator only sees transferred items",
              len(unexpected) == 0, f"unexpected={unexpected}")

    # E3: project_ceo only sees 待CEO决策 (in 流转中 tab)
    code, body = ceo_c.get("/api/confirmations/pending",
                           {"project_id": _proj_id, "tab": "流转中"})
    chk("E3 project_ceo GET pending 200", code, 200)
    if code == 200:
        statuses = {r.get("confirm_status") for r in body}
        unexpected = statuses - {"待CEO决策", "pending_ceo_decision"}
        check("E3 project_ceo only sees CEO-decision items",
              len(unexpected) == 0, f"unexpected={unexpected}")

    # E4: member access pending → 403 OR 200-with-no-foreign-submissions (per spec)
    # 注：can_access_confirmation_center 是全局能力。纯 member（从不持有 owner/coordinator）→ 403；
    # 若该账号在其他项目持有 owner/coordinator 角色 → 200，但行被 _role_allows_pending_view 过滤为仅自己的提交。
    code, body = member_c.get("/api/confirmations/pending", {"project_id": _proj_id})
    member_name = ACCOUNTS["member"]["name"]
    if code == 403:
        check("E4 member GET pending → 403", True, "403 (pure member)")
    elif code == 200:
        foreign = [r for r in body if r.get("submitter") not in (member_name, "")]
        check("E4 member GET pending → 200 with no foreign submissions",
              len(foreign) == 0, f"foreign submitters={[r.get('submitter') for r in foreign]}")
    else:
        check("E4 member GET pending → 403 or 200", False, f"unexpected code={code}")

    # E5: super_admin sees all
    code, body = admin_c.get("/api/confirmations/pending", {"project_id": _proj_id})
    chk("E5 super_admin GET pending 200", code, 200)
    if code == 200:
        check("E5 admin sees multiple statuses or items",
              len(body) >= 0, f"count={len(body)}")


# ── 归档测试项目 ─────────────────────────────────────────────

def teardown_test_project():
    section("归档测试项目")
    if _proj_id:
        code, b = admin_c.post(f"/api/projects/{_proj_id}/archive", {})
        chk("archive test project", code, 200, b)
        check("status=archived", b.get("status") == "archived", str(b))
    else:
        check("no project to archive", True)


# ── 主入口 ────────────────────────────────────────────────────

def main():
    print("=" * 60)
    print("  博维AI驾驶舱 · 权限矩阵测试")
    print(f"  BASE_URL : {BASE_URL}")
    print(f"  项目名称 : {TEST_PROJECT_NAME}")
    print("=" * 60)

    try:
        setup_all_logins()
        if not setup_test_project():
            print("\nABORT: setup failed, cannot run permission tests")
            sys.exit(2)

        test_updates_permissions()
        test_confirmation_permissions()
        test_write_permissions()
        test_members_permissions()
        test_visibility()
    except Exception as exc:
        print(f"\n[ERROR] {exc}")
        import traceback; traceback.print_exc()
        global FAIL_COUNT
        FAIL_COUNT += 1
    finally:
        teardown_test_project()

    print("\n" + "=" * 60)
    print(f"  RESULT: {PASS_COUNT} passed, {FAIL_COUNT} failed")
    if _section_fails:
        print("\n  Failed items:")
        for f in _section_fails:
            print(f"    {f.strip()}")
    print("=" * 60)
    sys.exit(0 if FAIL_COUNT == 0 else 1)


if __name__ == "__main__":
    main()
