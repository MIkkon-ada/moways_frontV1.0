# DAily

## 目的

这份日志用于记录当前 `bowei_ai_dashboard` 项目在“正式权限模型落地前”的兼容方案，方便后续迁移到云服务器、继续开发数据库迁移、权限收口和服务启动。

当前日期：2026-05-22

---

## 一、当前项目状态

当前项目仍处于“旧表结构 + 新权限骨架 + 过渡兼容字段”并存阶段。

已经完成的方向：

- 前端继续使用原生 `HTML/CSS/JS`
- 使用页面上的 `roleSwitch` 模拟当前用户身份
- 前后端已经接入一套初步统一的权限判断雏形
- AI 提交页支持编辑 AI 提取结果并写入 `human_result_json`
- AI 确认中心确认写入时，优先使用 `human_result_json`
- 问题与决策页已支持查看详情、修改状态、填写结论并写回 SQLite

尚未完成的方向：

- 正式登录系统
- 数据库正式迁移
- 所有业务接口的后端权限过滤
- 云服务器部署脚本和启动流程

---

## 二、当前数据库现状

当前实际使用的数据库文件：

- `D:\moways_ai\bowei_ai_dashboard\bowei_ai_dashboard.db`

已创建的数据库备份：

- `D:\moways_ai\bowei_ai_dashboard\bowei_ai_dashboard.backup_20260522_154113.db`

当前生产代码仍主要依赖旧表结构：

- `people`
- `tasks`
- `update_submissions`
- `achievements`
- `issues`
- `operation_logs`

新设计中的这些表还没有真正执行建表迁移到现有库：

- `projects`
- `project_memberships`
- `decisions`

---

## 三、正式权限模型设计方向

正式模型目标表：

1. `projects`
2. `people`
3. `project_memberships`
4. `tasks`
5. `update_submissions`
6. `achievements`
7. `issues`
8. `decisions`
9. `operation_logs`

当前已经整理好的 SQL 文件：

- `D:\moways_ai\mowayssql.sql`

注意：

- 这份 SQL 目前是“首轮建表兼容稿”
- 它不是完整迁移脚本
- 直接执行 `CREATE TABLE IF NOT EXISTS` 不会给现有旧表自动补字段
- 真正迁移时需要补 `ALTER TABLE` 或新旧表搬迁脚本

---

## 四、当前兼容字段方案

### 1. people

旧字段保留：

- `role`
- `special_project_duty`
- `permission`
- `contact`

新字段设计中：

- `employee_code`
- `system_role`
- `permission_scope`
- `phone`
- `email`

兼容策略：

- 短期继续允许前端和旧代码读取旧字段
- 长期权限判断应逐步转向 `system_role`

### 2. tasks

短期兼容字段保留：

- `special_project`
- `owner`
- `coordinator`
- `collaborators`

正式字段目标：

- `project_id`
- `owner_person_id`
- `coordinator_person_id`

兼容策略：

- 当前前端任务页、驾驶舱、权限过滤仍大量读取字符串字段
- 长期权限判断应改为优先判断 ID 外键字段

### 3. update_submissions

短期兼容字段保留：

- `submitter`
- `confirmed_by`
- `confirm_status`

正式字段目标：

- `project_id`
- `submitter_person_id`
- `target_owner_person_id`
- `current_handler_person_id`
- `workflow_status`
- `confirmed_by_person_id`

兼容策略：

- 当前旧代码和页面文案仍依赖 `confirm_status`
- 新流程设计中建议逐步切换到 `workflow_status`

### 4. achievements

短期兼容字段保留：

- `special_project`
- `owner`

正式字段目标：

- `project_id`
- `owner_person_id`
- `source_submission_id`
- `approved_by_person_id`

兼容策略：

- 当前成果库前端仍直接读取 `special_project` 和 `owner`

### 5. issues

短期兼容字段保留：

- `special_project`
- `owner`
- `helper`
- `need_decision_by`

正式字段目标：

- `project_id`
- `owner_person_id`
- `helper_person_id`
- `need_decision_by_person_id`
- `source_submission_id`

兼容策略：

- 当前问题页和驾驶舱仍直接读取这些字符串字段
- 后续决策直达机制建议再引入 `decisions` 表

### 6. operation_logs

短期兼容字段保留：

- `operator`

正式字段目标：

- `operator_person_id`

兼容策略：

- 旧日志继续可读
- 新日志应逐步写入人员 ID

---

## 五、当前权限兼容方案

### 当前用户来源

当前没有登录系统，用户身份来源于页面上的：

- `roleSwitch`

前端会把当前人员名称通过请求头传到后端：

- Header: `X-Current-User`

为兼容中文姓名：

- 前端发送前使用 `encodeURIComponent`
- 后端读取时进行 URL 解码

### 当前已实现的前端权限函数

在 `app/static/app.js` 中已经加入了这类函数：

- `getCurrentUserContext()`
- `canViewProject()`
- `canViewRow()`
- `canViewSubmission()`
- `canConfirmSubmission()`
- `canAssignSubmission()`

### 当前后端权限骨架

新增文件：

- `app/permissions.py`

里面维护了当前过渡期的权限映射逻辑，包括：

- 全局领导：冯海林
- 技术支持全权限：吴肖、郭熠彬
- 过程保障：袁金玉
- 项目统筹 / 负责人 / 协同成员：通过预置专项映射判断

### 当前权限规则落地情况

已实现：

- 冯海林：全局查看、全局处理
- 吴肖 / 郭熠彬：全局查看、全局维护
- 统筹人：看自己统筹专项，只读，不确认
- 负责人：看自己负责专项，可确认自己负责范围
- 协同成员：可提交更新，不可确认
- 袁金玉：可看全局流程，可处理待分配，不替负责人确认

未完全实现：

- `tasks / achievements / issues` 后端接口级权限过滤
- 全站完全依赖数据库角色表，而不是预置常量

---

## 六、当前前端受权限影响的页面

已经接入前端过滤的页面：

- 驾驶舱
- 工作推进表
- 成果库
- 问题与决策
- AI 确认中心

说明：

- 当前是“前端过滤 + 确认中心后端关键动作校验”的组合
- 还不是全接口后端强校验

AI 确认中心当前后端已做权限拦截的动作：

- 查看待办列表
- 查看详情
- 确认写入
- 退回
- 转交袁金玉
- 分配负责人

---

## 七、AI 提交与确认中心兼容方案

### 1. 提交页

当前“提交进度更新”页已支持：

- AI 提取建议展示
- 提交人直接编辑右侧结构化字段
- 提交时把编辑结果作为 `human_result` / `edited_suggestion` 一起发给后端

### 2. update_submissions 保存策略

当前规则：

- `ai_result_json`：保存原始 AI 提取结果
- `human_result_json`：保存用户编辑后的结构化结果

### 3. 确认写入策略

当前规则：

- 确认写入业务表时，优先使用 `human_result_json`
- 若没有 `human_result_json`，才退回 `ai_result_json`

这条规则已经在后端确认中心逻辑中落地。

---

## 八、问题与决策页兼容方案

当前问题页已支持：

- 列表展示
- “查看/处理”按钮
- 右侧抽屉详情
- 修改状态
- 修改优先级
- 修改预计解决时间
- 修改处理结论 / 决策结论
- 写回 SQLite

当前复用接口：

- `GET /api/issues/{id}`
- `PUT /api/issues/{id}`
- `PATCH /api/issues/{id}/status`

兼容策略：

- 仍保留现有 `issues` 表结构使用方式
- 未引入独立 `decisions` 表的实际业务写入

---

## 九、mowayssql.sql 当前调整内容

已完成的调整：

- 按既定顺序重排建表
- 拆掉首轮循环外键
- 补齐兼容字段
- 保留正式 ID 字段方向

当前这份 SQL 的定位：

- 可以作为“正式表结构首版设计稿”
- 适合新库初始化
- 不适合直接当作现有 SQLite 的完整迁移脚本

原因：

- 现有库中的表已经存在
- `CREATE TABLE IF NOT EXISTS` 不会自动补列
- 真正迁移还需要：
  - `ALTER TABLE ADD COLUMN`
  - 或建新表 + 数据搬迁 + 重命名

---

## 十、云服务器启动前必须补的事情

### 1. 数据库迁移

必须补：

- 正式迁移脚本，而不是只靠建表 SQL
- 明确旧字段到新字段的映射
- 初始化 `projects`、`project_memberships`、`people.system_role`

### 2. 后端统一权限

必须补：

- `tasks` 列表后端按权限过滤
- `achievements` 列表后端按权限过滤
- `issues` 列表后端按权限过滤
- `people` 和 `projects` 从数据库驱动，而不是前端常量驱动

### 3. 前端 roleSwitch

当前 `roleSwitch` 仅用于本地模拟，云端正式部署时：

- 可以保留作开发调试开关
- 但正式环境应替换为登录态 + 当前用户接口

### 4. decisions 表落地

要支撑“问题直达冯海林批示并返回提交者”，必须真正落地：

- `decisions` 表
- 决策创建接口
- 决策批示接口
- 提交者反馈接口

---

## 十一、建议的下一步实施顺序

1. 先写 SQLite 迁移脚本
   - 给旧表补正式字段
   - 创建 `projects / project_memberships / decisions`

2. 初始化基础数据
   - 人员
   - 五个专项
   - 项目成员关系

3. 后端接口改为优先读 ID 字段判断权限

4. 再逐步把前端页面从字符串字段切到正式字段

5. 最后再准备云服务器启动
   - 配置环境变量
   - 数据库文件路径
   - uvicorn/gunicorn 启动方式
   - 静态资源与反向代理

---

## 十二、关键文件清单

当前已涉及的关键文件：

- `D:\moways_ai\bowei_ai_dashboard\app\static\app.js`
- `D:\moways_ai\bowei_ai_dashboard\app\routers\confirmations.py`
- `D:\moways_ai\bowei_ai_dashboard\app\permissions.py`
- `D:\moways_ai\mowayssql.sql`
- `D:\moways_ai\bowei_ai_dashboard\bowei_ai_dashboard.db`

---

## 十三、结论

当前项目不是“正式权限模型已落库”，而是：

- 旧表仍在运行
- 新权限规则已有前后端雏形
- SQL 设计稿已整理
- 数据库正式迁移尚未执行

这套兼容方案适合继续本地推进功能，也适合后续迁到云服务器前做一轮正式数据库迁移。

---

## 十四、一键部署口令

当前已经补齐一条更适合后续云服务器使用的启动链路：

- `D:\moways_ai\bowei_ai_dashboard\run_deploy.bat`

它会依次执行：

1. `migrate_sqlite_schema.py`
2. `seed_permissions.py`
3. `uvicorn app.main:app --host 0.0.0.0 --port 8000`

如需临时改端口，可直接传参，例如：

- `run_deploy.bat 8010`

配套说明文档：

- `D:\moways_ai\bowei_ai_dashboard\deploy_notes.md`
- `D:\moways_ai\bowei_ai_dashboard\README.md`

这条链路的目标是让后续部署时不再手工拆分“迁移、初始化、启动”三步，而是直接跑一个统一入口。

---

## 十五、后端当前收口状态

截至目前，后端已经基本完成这一轮架构收口：

- `main.py` 已经用环境变量区分开发模式和生产模式
- `migrate_sqlite_schema.py` 已支持全新部署和旧库迁移
- `tasks / achievements / issues` 的写操作已补齐审计日志
- 权限判断已切到 DB 优先，并保留静态映射作为兜底
- `tests/test_permissions.py` 已覆盖主要权限矩阵
- 部署级验证已通过，关键接口与角色权限结果符合预期

当前仍建议继续关注的收尾点：

- 权限数据源最终是否完全切到数据库唯一真相
- `confirm_status` 与 `workflow_status` 的长期收口
- `confirmations / people / decisions` 等关键路径的日志一致性再复核
- 云服务器上的真实冷启动再跑一次，确认空库与迁移库都能稳定拉起

整体判断：

- 如果目标是“稳定推进云端部署和后续业务开发”，当前后端已经足够可用
- 如果目标是“架构永久封版”，还差最后一小段收口，但已经接近完成
