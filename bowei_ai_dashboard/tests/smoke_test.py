"""
博维AI驾驶舱 · 核心业务链路 smoke test

覆盖：创建项目 → 配置成员 → member 提交 → owner 确认 →
       transfer-coordinator → coordinator-feedback →
       escalate-ceo → ceo-decide → dashboard 统计 → 归档

运行：
  python tests/smoke_test.py

环境变量覆盖：
  BASE_URL=http://127.0.0.1:8000
  ADMIN_USERNAME=mowasyadmin
  ADMIN_PASSWORD=admin123

注意：
  - 测试项目名称含 TEST_ 前缀，测试结束后自动归档
  - 使用 people 表现有账号，不创建新账号
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

BASE_URL       = os.environ.get("BASE_URL",        "http://127.0.0.1:8000").rstrip("/")
ADMIN_USER     = os.environ.get("ADMIN_USERNAME",  "mowasyadmin")
ADMIN_PASS     = os.environ.get("ADMIN_PASSWORD",  "admin123")
MEMBER_PASS    = os.environ.get("MEMBER_PASSWORD", "bowei2024")

# 测试角色映射（使用现有 people 账号）
# owner=许明良(7), member=彭超凡(8), coordinator=郭熠彬(9), project_ceo=吴肖(10)
ROLE_ACCOUNTS = {
    "owner":       {"name": "许明良", "id": 7,  "pwd": MEMBER_PASS},
    "member":      {"name": "彭超凡", "id": 8,  "pwd": MEMBER_PASS},
    "coordinator": {"name": "郭熠彬", "id": 9,  "pwd": MEMBER_PASS},
    "project_ceo": {"name": "吴肖",   "id": 10, "pwd": MEMBER_PASS},
}

TS = datetime.now().strftime("%Y%m%d_%H%M%S")
TEST_PROJECT_NAME = f"TEST_闭环_{TS}"

PASS_COUNT = 0
FAIL_COUNT = 0
_failures: list[str] = []


# ── API 客户端 ────────────────────────────────────────────────

class ApiClient:
    def __init__(self, base: str = BASE_URL):
        self.base = base
        jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(jar)
        )

    def _send(self, method: str, path: str, data=None, params=None) -> tuple[int, dict]:
        url = self.base + path
        if params:
            url += "?" + urllib.parse.urlencode(params, quote_via=urllib.parse.quote)
        body = json.dumps(data).encode() if data is not None else None
        hdrs = {"Content-Type": "application/json"} if body else {}
        req = urllib.request.Request(url, data=body, headers=hdrs, method=method)
        try:
            resp = self.opener.open(req, timeout=15)
            return resp.status, json.loads(resp.read() or b"{}")
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read() or b"{}")
            except Exception:
                return e.code, {}

    def login(self, username: str, password: str) -> bool:
        code, body = self._send("POST", "/api/auth/login",
                                {"username": username, "password": password})
        return code == 200 and body.get("ok")

    def get(self, path: str, params=None): return self._send("GET",    path, params=params)
    def post(self, path: str, data=None):  return self._send("POST",   path, data)
    def patch(self, path: str, data=None): return self._send("PATCH",  path, data)
    def delete(self, path: str):           return self._send("DELETE", path)


# ── 断言工具 ─────────────────────────────────────────────────

def check(label: str, cond: bool, detail: str = "") -> bool:
    global PASS_COUNT, FAIL_COUNT
    if cond:
        PASS_COUNT += 1
        print(f"  [PASS] {label}")
    else:
        FAIL_COUNT += 1
        msg = f"  [FAIL] {label}" + (f" | {detail}" if detail else "")
        print(msg)
        _failures.append(msg)
    return cond


def assert_status(label: str, code: int, expected: int, body=None) -> bool:
    detail = f"got {code}, expected {expected}"
    if body and code != expected:
        detail += f" | body={str(body)[:120]}"
    return check(label, code == expected, detail)


# ── 测试步骤 ─────────────────────────────────────────────────

def run_smoke():
    print("=" * 60)
    print(f"  博维AI驾驶舱 · Smoke Test")
    print(f"  BASE_URL : {BASE_URL}")
    print(f"  项目名称 : {TEST_PROJECT_NAME}")
    print("=" * 60)

    admin   = ApiClient()
    owner   = ApiClient()
    member  = ApiClient()
    coord   = ApiClient()
    ceo     = ApiClient()

    proj_id: int | None = None

    # ── Step 1: 登录 ────────────────────────────────────────
    print("\n[Step 1] 登录")
    check("admin login",       admin.login(ADMIN_USER,                      ADMIN_PASS))
    check("owner login",       owner.login(ROLE_ACCOUNTS["owner"]["name"],       ROLE_ACCOUNTS["owner"]["pwd"]))
    check("member login",      member.login(ROLE_ACCOUNTS["member"]["name"],     ROLE_ACCOUNTS["member"]["pwd"]))
    check("coordinator login", coord.login(ROLE_ACCOUNTS["coordinator"]["name"], ROLE_ACCOUNTS["coordinator"]["pwd"]))
    check("project_ceo login", ceo.login(ROLE_ACCOUNTS["project_ceo"]["name"],   ROLE_ACCOUNTS["project_ceo"]["pwd"]))

    # ── Step 2: 创建测试项目 ──────────────────────────────────
    print("\n[Step 2] 创建测试项目")
    code, body = admin.post("/api/projects", {
        "name":        TEST_PROJECT_NAME,
        "code":        "SMOKE",
        "description": "Smoke test project — auto-archived after test",
        "status":      "active",
    })
    if not assert_status("create project", code, 200, body):
        print("  ABORT: cannot create project")
        return False
    proj_id = body.get("id")
    check("project has id", bool(proj_id), str(proj_id))

    # ── Step 3: 添加成员 ─────────────────────────────────────
    print("\n[Step 3] 添加项目成员")
    for role, acc in ROLE_ACCOUNTS.items():
        code, body = admin.post(f"/api/projects/{proj_id}/members",
                                {"person_id": acc["id"], "role": role})
        assert_status(f"add {role} ({acc['name']})", code, 200, body)

    # ── Step 4: 验证成员列表 ──────────────────────────────────
    print("\n[Step 4] 验证项目成员列表")
    code, members = admin.get(f"/api/projects/{proj_id}/members")
    assert_status("GET /api/projects/{id}/members", code, 200)
    if code == 200:
        roles_found = {m["role"] for m in members}
        for r in ("owner", "member", "coordinator", "project_ceo"):
            check(f"  {r} exists in members", r in roles_found, str(roles_found))

    # ── Step 5: member 提交进展 ───────────────────────────────
    print("\n[Step 5] member 提交进展")
    sub_text = f"Smoke test submission for {TEST_PROJECT_NAME} at {TS}"
    code, body = member.post("/api/updates", {
        "project_id":      proj_id,
        "source_type":     "文字汇报",
        "transcript_text": sub_text,
        "submitter":       ROLE_ACCOUNTS["member"]["name"],
    })
    assert_status("member POST /api/updates", code, 200, body)
    sub1_id = body.get("submission", {}).get("id") if code == 200 else None
    check("submission has id", bool(sub1_id), str(sub1_id))

    # ── Step 6: owner 查看确认中心 ───────────────────────────
    print("\n[Step 6] owner 查看确认中心")
    code, pending = owner.get("/api/confirmations/pending", {"project_id": proj_id})
    assert_status("owner GET /api/confirmations/pending", code, 200)
    if code == 200:
        ids = [r.get("id") for r in pending]
        check("submission visible in pending", sub1_id in ids, f"sub1={sub1_id}, ids={ids}")

    # ── Step 7: owner 确认入库 ───────────────────────────────
    print("\n[Step 7] owner 确认入库")
    if sub1_id:
        code, body = owner.post(f"/api/confirmations/{sub1_id}/confirm",
                                {"operator": ROLE_ACCOUNTS["owner"]["name"]})
        assert_status("owner confirm", code, 200, body)
        if code == 200:
            confirmed_status = body.get("submission", {}).get("confirm_status", "")
            check("status is 已入库", confirmed_status in ("已入库", "已确认入库", "stored"),
                  f"status={confirmed_status!r}")

    # ── Step 8: transfer-coordinator → coordinator-feedback ──
    print("\n[Step 8] transfer-coordinator → coordinator-feedback")
    # 新建第二条提交
    code, body = member.post("/api/updates", {
        "project_id":      proj_id,
        "source_type":     "文字汇报",
        "transcript_text": f"Smoke test sub2 for coordinator {TS}",
        "submitter":       ROLE_ACCOUNTS["member"]["name"],
    })
    assert_status("member POST sub2", code, 200, body)
    sub2_id = body.get("submission", {}).get("id") if code == 200 else None

    if sub2_id:
        # owner transfer
        code, _ = owner.post(f"/api/confirmations/{sub2_id}/transfer-coordinator",
                             {"note": "请统筹人给意见", "operator": ROLE_ACCOUNTS["owner"]["name"]})
        assert_status("owner transfer-coordinator", code, 200)

        # coordinator only sees transferred items in 流转中 tab
        code, coord_pending = coord.get("/api/confirmations/pending",
                                        {"project_id": proj_id, "tab": "流转中"})
        assert_status("coordinator GET pending 流转中", code, 200)
        if code == 200:
            coord_statuses = {r.get("confirm_status") for r in coord_pending}
            unexpected = coord_statuses - {"已转交统筹人", "transferred_to_coordinator"}
            check("coordinator only sees transferred items",
                  len(unexpected) == 0, f"unexpected statuses={unexpected}")
            check("coordinator sees sub2", sub2_id in [r.get("id") for r in coord_pending])

        # coordinator feedback
        code, _ = coord.post(f"/api/confirmations/{sub2_id}/coordinator-feedback",
                             {"note": "统筹意见反馈", "operator": ROLE_ACCOUNTS["coordinator"]["name"]})
        assert_status("coordinator-feedback", code, 200)

    # ── Step 9: escalate-ceo → ceo-decide ───────────────────
    print("\n[Step 9] escalate-ceo → ceo-decide")
    # 新建第三条提交
    code, body = member.post("/api/updates", {
        "project_id":      proj_id,
        "source_type":     "文字汇报",
        "transcript_text": f"Smoke test sub3 for CEO {TS}",
        "submitter":       ROLE_ACCOUNTS["member"]["name"],
    })
    assert_status("member POST sub3", code, 200, body)
    sub3_id = body.get("submission", {}).get("id") if code == 200 else None

    if sub3_id:
        # owner escalate
        code, _ = owner.post(f"/api/confirmations/{sub3_id}/escalate-ceo",
                             {"note": "需CEO决策", "operator": ROLE_ACCOUNTS["owner"]["name"]})
        assert_status("owner escalate-ceo", code, 200)

        # project_ceo only sees CEO-decision items in 流转中 tab
        code, ceo_pending = ceo.get("/api/confirmations/pending",
                                    {"project_id": proj_id, "tab": "流转中"})
        assert_status("project_ceo GET pending 流转中", code, 200)
        if code == 200:
            ceo_statuses = {r.get("confirm_status") for r in ceo_pending}
            unexpected = ceo_statuses - {"待CEO决策", "pending_ceo_decision"}
            check("project_ceo only sees CEO-decision items",
                  len(unexpected) == 0, f"unexpected statuses={unexpected}")
            check("project_ceo sees sub3", sub3_id in [r.get("id") for r in ceo_pending])

        # ceo-decide
        code, _ = ceo.post(f"/api/confirmations/{sub3_id}/ceo-decide",
                           {"note": "CEO批示通过", "operator": ROLE_ACCOUNTS["project_ceo"]["name"]})
        assert_status("project_ceo ceo-decide", code, 200)

    # ── Step 10: dashboard 统计 ──────────────────────────────
    print("\n[Step 10] dashboard 项目统计")
    code, dash = admin.get("/api/dashboard/overview", {"project_id": proj_id})
    assert_status("GET /api/dashboard/overview?project_id={id}", code, 200)
    if code == 200:
        check("project.id correct",     dash.get("project", {}).get("id") == proj_id)
        check("task_stats exists",      "task_stats" in dash)
        check("submission_stats exists", "submission_stats" in dash)
        check("ceo_decision_stats exists", "ceo_decision_stats" in dash)
        check("summary exists",         "summary" in dash)
        st = dash.get("submission_stats", {})
        check("total_submissions >= 1", (st.get("total_submissions") or 0) >= 1,
              f"total={st.get('total_submissions')}")

    # ── Step 11: 归档测试项目 ─────────────────────────────────
    print("\n[Step 11] 归档测试项目")
    code, body = admin.post(f"/api/projects/{proj_id}/archive", {})
    assert_status("archive test project", code, 200, body)
    check("status=archived", body.get("status") == "archived",
          f"body={body}")

    return True


def main():
    try:
        run_smoke()
    except Exception as exc:
        print(f"\n[ERROR] Unhandled exception: {exc}")
        import traceback; traceback.print_exc()
        global FAIL_COUNT
        FAIL_COUNT += 1

    print("\n" + "=" * 60)
    print(f"  RESULT: {PASS_COUNT} passed, {FAIL_COUNT} failed")
    if _failures:
        print("\n  Failed items:")
        for f in _failures:
            print(f"   {f.strip()}")
    print("=" * 60)
    sys.exit(0 if FAIL_COUNT == 0 else 1)


if __name__ == "__main__":
    main()
