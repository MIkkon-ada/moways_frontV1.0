// 项目/任务/成果共享工具函数
// 依赖：normalizeProject (components.js), projectAreas + PROJECTS (appState.js), members (appState.js)
// 注意：ceoPerson() 需要兼容 settings.js 未初始化的运行时，因此不要直接假设 _settingsPeople 一定存在。

function projectBarColor(project) {
  return {
    "知识资产AI化": "var(--purple)",
    "顾问作业AI化": "var(--green)",
    "交付流程AI化": "var(--orange)",
    "咨询服务产品化": "var(--teal)",
    "技术底座与平台预研": "var(--blue)",
  }[project] || "var(--blue)";
}

function projectTone(project) {
  return {
    "知识资产AI化": "purple",
    "顾问作业AI化": "green",
    "交付流程AI化": "orange",
    "咨询服务产品化": "pink",
    "技术底座与平台预研": "blue",
  }[project] || "blue";
}

function shortProjectName(project) {
  return {
    "知识资产AI化": "知识资产",
    "顾问作业AI化": "顾问作业",
    "交付流程AI化": "交付流程",
    "咨询服务产品化": "咨询服务",
    "技术底座与平台预研": "技术底座与平台预研",
  }[project] || project;
}

function planTimeRank(value = "") {
  const text = String(value || "");
  const year = Number((text.match(/20\d{2}/) || [0])[0]);
  const month = Number((text.match(/(\d{1,2})\s*月/) || [0, 0])[1]);
  if (year || month) return year * 100 + month;
  return 999999;
}

function isNewTask(task) {
  return !String(task.source_type || "").includes("Excel导入");
}

function getProjectCode(projectName) {
  const area = projectAreas.find(a => a.name === normalizeProject(projectName));
  if (area && area.code) return area.code;
  const chars = (projectName || "").match(/[\u4e00-\u9fa5]/g);
  return chars ? chars.slice(0, 2).join("") : "??";
}

function achievementDisplayId(a) {
  return `${getProjectCode(a.special_project)}-${a.id}`;
}

function achievementWarnings(a) {
  const warnings = [];
  if (!a.related_task_id) warnings.push("需关联任务");
  if (!a.version && a.status !== "计划中") warnings.push("重要成果需标记版本");
  if (a.reuse_tag === "客户交付" || ["案例包", "客户验证记录"].some(key => String(a.name || a.achievement_type || "").includes(key))) warnings.push("需脱敏");
  return warnings;
}

function groupByProject(rows) {
  const grouped = new Map();
  rows.forEach(row => {
    const project = normalizeProject(row.special_project || "未归属项目");
    if (!grouped.has(project)) grouped.set(project, []);
    grouped.get(project).push(row);
  });
  const order = [...PROJECTS, ...[...grouped.keys()].filter(project => !PROJECTS.includes(project)).sort((a, b) => a.localeCompare(b, "zh-Hans-CN"))];
  return order.filter(project => grouped.has(project)).map(project => [project, grouped.get(project)]);
}

function sortByPlanTime(rows) {
  return [...rows].sort((a, b) => planTimeRank(a.plan_time) - planTimeRank(b.plan_time) || String(a.key_task || "").localeCompare(String(b.key_task || ""), "zh-Hans-CN"));
}

function sortByAchievementTime(rows) {
  return [...rows].sort((a, b) => Date.parse(b.updated_at || b.created_at || 0) - Date.parse(a.updated_at || a.created_at || 0) || String(a.name || "").localeCompare(String(b.name || ""), "zh-Hans-CN"));
}

function projectOwner(project) {
  return {
    "知识资产AI化": "杨宇帆",
    "顾问作业AI化": "许明良",
    "交付流程AI化": "温会林",
    "咨询服务产品化": "彭超凡",
    "技术底座与平台预研": "吴肖、郭熠彬",
  }[project] || (projectAreas.find(a => normalizeProject(a.name) === normalizeProject(project))?.owner || "");
}

function ceoPerson() {
  const settingsPeople = typeof _settingsPeople !== "undefined" && Array.isArray(_settingsPeople) ? _settingsPeople : [];
  return settingsPeople.find(p => p.system_role === "组长CEO")?.name
    || members.find(m => m.role === "组长" || m.role === "组长 / CEO")?.name
    || members.find(m => String(m.role || "").includes("CEO"))?.name
    || "";
}
