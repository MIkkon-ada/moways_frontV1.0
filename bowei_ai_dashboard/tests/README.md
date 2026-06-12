# 博维AI驾驶舱 · 自动化测试

本目录包含核心业务链路与权限边界的回归测试，用于防止前端项目化、权限收口、旧字段清理过程中发生回归。

## 测试文件

| 文件 | 类型 | 覆盖范围 |
|---|---|---|
| `smoke_test.py` | 端到端业务链路 | 创建项目 → 配成员 → member 提交 → owner 确认 → 转交统筹 → 上报CEO → CEO批示 → dashboard 统计 → 归档 |
| `test_permissions.py` | 权限矩阵 | updates 提交权限 / confirmations 操作权限 / 主数据写权限 / 成员管理 last-owner 保护 / 确认中心可见范围 |
| `test_extractor.py` | 单元（既有） | AI 提取引擎 |
| `test_visibility_policy.py` | 单元（既有） | 可见性策略 |

## 前置条件

1. 后端服务已启动（默认 `http://127.0.0.1:8000`）。
2. 数据库已执行 `migrate_project_members.py`，project_members 已回填。
3. 测试账号存在于 `people` 表且 `passwords.json` 中有对应密码：
   - 超级管理员：`mowasyadmin` / `admin123`
   - 业务账号默认密码：`bowei2024`
   - 角色映射（smoke_test / test_permissions 共用）：
     - owner = 许明良 (id=7)
     - member = 彭超凡 (id=8)
     - coordinator = 郭熠彬 (id=9)
     - project_ceo = 吴肖 (id=10)
     - process_guard = 袁金玉 (id=5)
     - non_member = 温会林 (id=4)

## 运行方式

```bash
# 默认连本地 8000
python tests/smoke_test.py
python tests/test_permissions.py

# 指定其他端口/地址
BASE_URL=http://127.0.0.1:8001 python tests/smoke_test.py
BASE_URL=http://127.0.0.1:8001 python tests/test_permissions.py

# 覆盖管理员账号
ADMIN_USERNAME=mowasyadmin ADMIN_PASSWORD=admin123 python tests/smoke_test.py
```

退出码：全部通过返回 `0`，有失败返回 `1`，setup 失败返回 `2`。

## 测试数据隔离

- 每次运行创建唯一名称的测试项目：`TEST_闭环_{timestamp}` / `TEST_权限矩阵_{timestamp}`。
- 所有测试数据（成员、提交、任务、成果、问题、会议）挂在测试项目下。
- 测试结束后调用 `POST /api/projects/{id}/archive` 归档测试项目（不物理删除）。
- 不修改正式项目的成员配置，不删除正式数据。
- DELETE 验证只在测试自己创建的资源上执行。

## 注意

- `can_access_confirmation_center` 是**全局能力**：若测试账号在其他项目持有 owner/coordinator 角色，
  访问 `/api/confirmations/pending` 会返回 200（但行被按角色过滤为仅自己的提交），而非 403。
  E4 用例已按规范同时接受「403」与「200 且无他人提交」两种结果。
- 测试会在数据库累积归档的 `TEST_*` 项目，属预期行为，不影响正式数据。
