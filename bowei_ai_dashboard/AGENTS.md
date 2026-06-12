# AGENTS.md｜博维 AI 升级项目驾驶舱前端重构说明

## 项目背景

这是“博维 AI 升级项目驾驶舱”的前端项目。系统用于管理 AI 升级专项，核心流程是：

用户通过语音/会议/文本提交进度
→ AI 提取任务、成果、问题、风险
→ 提交人确认
→ 项目负责人审核入库
→ 必要时转交统筹人或上报 CEO
→ 写入工作推进表、成果库、问题库
→ 首页驾驶舱更新。

## 当前技术状态

当前前端仍是普通 script 加载方式，不是 ES Module。

不要贸然改成 import/export，因为大量 HTML 模板中存在 onclick="xxx()" 调用，依赖全局函数。

index.html 当前加载顺序必须保持：

components.js
appState.js
api/client.js
api/cache.js
permissions/userContext.js
permissions/permissions.js
utils/date.js
utils/format.js
utils/project.js
components/common.js
pages/dashboard.js
pages/tasks.js
pages/achievements.js
pages/updates.js
pages/issues.js
app.js

后续新增 page 文件时，必须放在 app.js 之前加载。

## 已完成拆分

app.js 原始约 4807 行，目前已降至约 1674 行。

已完成：

- src/appState.js
- src/api/client.js
- src/api/cache.js
- src/permissions/userContext.js
- src/permissions/permissions.js
- src/utils/date.js
- src/utils/format.js
- src/utils/project.js
- src/components/common.js
- src/pages/dashboard.js
- src/pages/tasks.js
- src/pages/achievements.js
- src/pages/updates.js
- src/pages/issues.js

## 拆分原则

1. 不要重写业务逻辑。
2. 不要改变接口路径。
3. 不要改变现有页面结构和样式。
4. 不要改变数据库字段名。
5. 不要改变现有状态值。
6. 每次只拆一个页面或一个模块。
7. 拆完必须做回归检查。
8. 所有 onclick 会调用的函数必须保持全局可访问。
9. 如果函数被多个页面共用，不要强行移动。
10. 不确定的函数先保留在 app.js，并在报告里说明。

## 权限原则

所有权限最终以后端为准，前端隐藏按钮只是辅助。

角色包括：

- 协同成员
- 项目负责人
- 统筹人
- 过程保障
- 组长/CEO
- 超级管理员

关键规则：

- 所有人都能使用语音写入、会议写入、文本写入。
- 协同成员只能确认自己的提交，不能审核入库。
- 项目负责人负责本项目提交内容的审核入库。
- 统筹人只能查看负责人转交的信息并反馈意见，不能入库。
- 过程保障负责会议纪要校对、问题闭环、资料归档，不能业务入库。
- 组长/CEO可以查看全部业务信息和决策事项，但不能进入系统设置。
- 超级管理员可以进入系统设置。

## 当前下一步任务

下一步请只拆 people 页面。

目标：

把组织与分工相关函数从 app.js 移动到：

src/pages/people.js

不要拆 settings。
不要拆 confirmations。
不要改已拆页面。

优先移动：

- renderPeople()
- setOrgViewMode()
- setSelectedOrgProject()
- setSelectedOrgMember()
- clearSelectedOrgProject()
- clearSelectedOrgMember()
- 与组织架构、成员台账、项目分工、角色说明、权限矩阵相关的函数

如果函数名与上述不一致，请按 app.js 里的实际函数名迁移。

完成后输出报告：

1. 移动了哪些函数
2. app.js 行数从多少降到多少
3. people.js 行数
4. 哪些函数保留在 app.js
5. 是否有不确定点
6. 回归检查结果

## 中文文案与编码规则

1. 禁止把中文文案替换为 ?、????、拼音、英文占位符或乱码。
2. 所有用户可见文案必须保持中文。
3. 如果当前终端或写入链路会污染中文，必须使用 Unicode escape 写法保存中文字符串。
4. 修改 JS 文件后必须执行：
   node --check <file>
5. 修改用户界面文案后必须检查页面是否出现 ????。
6. 如果发现文件已编码损坏，不要继续补丁修复，应先备份坏文件，再从干净版本重建。