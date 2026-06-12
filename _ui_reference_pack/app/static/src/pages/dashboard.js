// 首页驾驶舱渲染函数
// 依赖：esc, badge, progress, optionList, currentMonthStr (components.js)
// 依赖：state, projectAreas, SYSTEM_ADMIN (appState.js)
// 依赖：fetchAll (app.js)
// 依赖：getCurrentUserContext, splitPeople, currentUserProjectRelation, rowRelationLabel (permissions/userContext.js)
// 依赖：canViewDecisionItems, canViewRiskItems (permissions/permissions.js)
// 依赖：statusTagClass, achievementTagClass, formatWaitText (utils/)
// 依赖：normalizeProject, projectBarColor, projectTone, projectOwner (utils/)
// 依赖：switchPage, loadPage (app.js)

function buildDonutGradient(segments) {
  const total = segments.reduce((sum, s) => sum + s.value, 0);
  if (!total) return `conic-gradient(#e5e7eb 0deg 360deg)`;
  let angle = 0;
  const parts = segments.map(s => {
    const deg = (s.value / total) * 360;
    const result = `${s.color} ${angle.toFixed(1)}deg ${(angle + deg).toFixed(1)}deg`;
    angle += deg;
    return result;
  });
  return `conic-gradient(${parts.join(", ")})`;
}

function svgKpiIcon(name) {
  const icons = {
    layers: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>`,
    activity: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>`,
    "check-circle": `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
    clock: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    inbox: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>`,
    pause: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`,
    alert: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
    trophy: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="8 21 12 17 16 21"/><line x1="12" y1="17" x2="12" y2="9"/><path d="M6 4H4a2 2 0 0 0-2 2v2a3 3 0 0 0 3 3h1.5M18 4h2a2 2 0 0 1 2 2v2a3 3 0 0 1-3 3h-1.5M6 4h12v8a6 6 0 0 1-12 0V4"/></svg>`,
  };
  return icons[name] || "";
}

function dbKpi(label, value, sub, colorClass, iconHtml) {
  return `<div class="card kpi">
    <div class="kpi-icon ${colorClass}">${iconHtml}</div>
    <div>
      <div class="kpi-title">${esc(label)}</div>
      <div class="kpi-num">${value}</div>
      <div class="kpi-sub">${esc(sub)}</div>
    </div>
  </div>`;
}

function dbProgressRow(project, tasks) {
  const rows = tasks.filter(t => t.special_project === project);
  const done = rows.filter(t => t.status === "已完成").length;
  const rate = rows.length ? Math.round(done / rows.length * 100) : 0;
  const color = projectBarColor(project);
  return `<div class="progress-row">
    <div class="name"><div class="mini-icon" style="background:${color};flex:0 0 auto"></div>${esc(project)}</div>
    <div class="bar"><span style="width:${rate}%;background:${color}"></span></div>
    <span style="text-align:right">${rate}%</span>
  </div>`;
}

function dbLegendRow(label, count, total, colorKey) {
  const colorMap = { green: "var(--green)", blue: "var(--blue-2)", gray: "#94a3b8", red: "var(--red)", orange: "var(--amber)" };
  const pct = total ? Math.round(count / total * 100) : 0;
  return `<div class="legend-row">
    <span style="display:flex;align-items:center"><span class="dot" style="background:${colorMap[colorKey] || "#94a3b8"}"></span>${esc(label)}</span>
    <span style="font-weight:700">${count}</span>
    <span style="color:var(--muted)">${pct}%</span>
  </div>`;
}

function _dbTaskRow(task) {
  const color = statusTagClass(task.status) === "tag-red" ? "var(--red)" : "var(--blue-2)";
  return `<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid #edf1f5">
    <div class="mini-icon" style="background:${color}"></div>
    <div style="flex:1;min-width:0">
      <div style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(task.key_task)}</div>
      <div style="font-size:11px;color:var(--muted);margin-top:1px">${esc(task.owner || "-")} · ${esc(task.special_project || "-")}</div>
    </div>
    <span class="tag ${statusTagClass(task.status)}">${esc(task.status)}</span>
  </div>`;
}

function _dbIssueRow(item) {
  const title = item.description || item.title || "未命名";
  const sub = item.owner || item.submitter || "-";
  return `<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid #edf1f5">
    <div class="mini-icon" style="background:var(--amber)"></div>
    <div style="flex:1;min-width:0">
      <div style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(title)}</div>
      <div style="font-size:11px;color:var(--muted);margin-top:1px">${esc(sub)}</div>
    </div>
  </div>`;
}

async function renderDashboard() {
  document.getElementById("dashboard").innerHTML = `<div class="page-loading">加载中…</div>`;
  let tasks, achievements, issues, confirmations;
  try {
    ({ tasks, achievements, issues, confirmations } = await fetchAll());
  } catch (err) {
    document.getElementById("dashboard").innerHTML = `<div class="page-error"><strong>驾驶舱加载失败</strong><p>${esc(err.message || "网络错误")}</p><button onclick="loadPage('dashboard')">重试</button></div>`;
    return;
  }
  const context = getCurrentUserContext();
  const allProjects = [...new Set([
    ...projectAreas.map(area => normalizeProject(area.name)).filter(Boolean),
    ...tasks.map(t => normalizeProject(t.special_project)).filter(Boolean),
    ...achievements.map(a => normalizeProject(a.special_project)).filter(Boolean),
    ...issues.map(i => normalizeProject(i.special_project)).filter(Boolean),
  ])];
  const availableProjects = context.canViewAll
    ? allProjects
    : allProjects.filter(project => context.visibleProjects.includes(project));
  const owners = [...new Set(tasks.flatMap(t => splitPeople(t.owner)).filter(n => n && n !== SYSTEM_ADMIN))];
  const curMonth = currentMonthStr();
  const months = [...new Set([curMonth, ...tasks.map(t => t.plan_time).filter(Boolean)])].sort();
  const filters = sanitizeDashboardFilters(state.dashboardFilters || {}, availableProjects, owners, months);
  state.dashboardFilters = filters;
  const visibleTasks = filterDashboardTasks(tasks, filters);
  const visibleAchievements = filterDashboardRecords(achievements, filters);
  const visibleIssues = filterDashboardRecords(issues, filters);
  const canViewDecisions = !!context.can_view_issue_decisions;
  const canViewRisks = !!context.can_view_issue_risks;
  const canViewApprovals = !!context.can_view_confirmation_center;
  const completed = visibleTasks.filter(t => t.status === "已完成").length;
  const notStarted = visibleTasks.filter(t => ["未开始", "未启动"].includes(t.status)).length;
  const doing = visibleTasks.filter(t => ["推进中", "进行中"].includes(t.status)).length;
  const delayed = visibleTasks.filter(t => ["延期", "风险"].includes(t.status));
  const paused = visibleTasks.filter(t => t.status === "暂缓").length;
  const _closedStatuses = ["已解决", "已关闭", "已决策", "关闭"];
  const decisions = canViewDecisions ? visibleIssues.filter(i => i.need_decision_by && !_closedStatuses.includes(i.status)) : [];
  const openRisks = canViewRisks ? visibleIssues.filter(i => !_closedStatuses.includes(i.status)) : [];
  const highRisks = openRisks.filter(i => ["高", "高优先级", "紧急"].includes(i.priority));
  const _activeConfirmStatuses = ["待确认", "需修改", "待负责人审核", "提交人已确认", "已重新提交", "已打回提交人", "已撤回", "已转交统筹人", "待CEO决策", "统筹人已反馈", "CEO已批示"];
  const pending = canViewApprovals ? confirmations.filter(c => _activeConfirmStatuses.includes(c.confirm_status)) : [];
  // 打回给我的提交：任何有确认中心访问权的用户，找到 submitter===自己 且已打回的记录
  const myRejected = confirmations.filter(c => c.confirm_status === "已打回提交人" && c.submitter === context.name);
  const decisionAttentionItems = decisions.length ? decisions : pending;
  const renderDecisionAttentionItem = decisions.length ? decisionListItem : approvalListItem;
  const weeklyFocus = visibleTasks.filter(t => !["已完成", "暂缓"].includes(t.status)).slice(0, 4);
  const displayedProjects = filters.project ? [filters.project] : availableProjects;
  // Update bell badge：pending（负责人视角）+ 自己被打回的条目
  const bellBadge = document.getElementById("bellBadge");
  if (bellBadge) {
    const alertCount = pending.length + decisions.length + myRejected.length;
    bellBadge.style.display = alertCount > 0 ? "" : "none";
    bellBadge.textContent = String(alertCount);
  }

  const doneRate = visibleTasks.length ? Math.round(completed / visibleTasks.length * 100) : 0;
  const donutSegments = [
    { color: "var(--green)",  value: completed,      label: "已完成", key: "green"  },
    { color: "var(--blue-2)", value: doing,           label: "进行中", key: "blue"   },
    { color: "#94a3b8",       value: notStarted,      label: "未启动", key: "gray"   },
    { color: "var(--red)",    value: delayed.length,  label: "延期",   key: "red"    },
    { color: "var(--amber)",  value: paused,          label: "暂缓",   key: "orange" },
  ].filter(s => s.value > 0);
  const donutGradient = buildDonutGradient(donutSegments);

  const decisionItems = (canViewDecisions && decisions.length ? decisions : pending).slice(0, 5);
  const decisionPage = canViewDecisions && decisions.length ? "issues" : "confirmations";

  document.getElementById("dashboard").innerHTML = `
    <div class="page-head">
      <div>
        <h1>首页驾驶舱</h1>
        <div class="subtitle">博维AI升级项目 · ${displayedProjects.length} 个专项 · 共 ${visibleTasks.length} 项任务</div>
      </div>
    </div>
    <div class="db-filters">
      <div class="filter"><select onchange="setDashboardFilter('project', this.value)"><option value="">全部专项</option>${optionList(availableProjects, filters.project)}</select></div>
      <div class="filter"><select onchange="setDashboardFilter('month', this.value)"><option value="">全部时间</option>${optionList(months.map(m => [m, m === curMonth ? `本月 (${m})` : m]), filters.month)}</select></div>
      <div class="filter"><select onchange="setDashboardFilter('status', this.value)"><option value="">全部状态</option>${optionList(["未启动","进行中","已完成","延期","暂缓"], filters.status)}</select></div>
      <div class="filter"><select onchange="setDashboardFilter('owner', this.value)"><option value="">全部负责人</option>${optionList(owners, filters.owner)}</select></div>
    </div>
    ${(canViewRisks && highRisks.length > 0) || (canViewDecisions && decisions.length > 0) || myRejected.length > 0 ? `
    <div class="db-alert-banner">
      ${myRejected.length > 0 ? `
      <div class="db-alert-item" style="background:#fffbeb;border-color:#fbbf24;color:#92400e" onclick="switchPage('confirmations')">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="16 12 12 8 8 12"/><line x1="12" y1="16" x2="12" y2="8"/></svg>
        <div><span class="db-alert-count" style="background:#d97706">${myRejected.length}</span> 条提交已被打回，请补充后重新提交</div>
        <span style="margin-left:auto;font-size:.82rem;opacity:.7">点击查看 &rarr;</span>
      </div>` : ""}
      ${canViewRisks && highRisks.length > 0 ? `
      <div class="db-alert-item risk" onclick="switchPage('issues')">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <div><span class="db-alert-count">${highRisks.length}</span> 项高风险待关注</div>
        <span style="margin-left:auto;font-size:.82rem;opacity:.7">点击查看 &rarr;</span>
      </div>` : ""}
      ${canViewDecisions && decisions.length > 0 ? `
      <div class="db-alert-item decision" onclick="switchPage('issues')">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        <div><span class="db-alert-count">${decisions.length}</span> 项待您决策</div>
        <span style="margin-left:auto;font-size:.82rem;opacity:.7">点击查看 &rarr;</span>
      </div>` : ""}
    </div>` : ""}
    <div class="kpis">
      ${dbKpi("任务总数", visibleTasks.length, "全部可见任务", "blue", svgKpiIcon("layers"))}
      ${dbKpi("进行中", doing, "推进中的任务", "teal", svgKpiIcon("activity"))}
      ${dbKpi("已完成", completed, `完成率 ${doneRate}%`, "green", svgKpiIcon("check-circle"))}
      ${dbKpi("延期", delayed.length, delayed.length > 0 ? "需跟进" : "暂无延期", delayed.length > 0 ? "red" : "green", svgKpiIcon("clock"))}
      ${canViewApprovals ? dbKpi("待确认", pending.length, "进入确认中心", pending.length > 0 ? "orange" : "green", svgKpiIcon("inbox")) : dbKpi("暂缓", paused, "暂缓任务", "orange", svgKpiIcon("pause"))}
      ${canViewRisks ? dbKpi("高风险", highRisks.length, highRisks.length > 0 ? "需关注" : "暂无高风险", highRisks.length > 0 ? "red" : "green", svgKpiIcon("alert")) : dbKpi("成果数", visibleAchievements.length, "已形成成果", "purple", svgKpiIcon("trophy"))}
    </div>
    <div class="db-grid-2">
      <div class="card panel">
        <div class="panel-title">专项进度</div>
        ${displayedProjects.map(p => dbProgressRow(p, visibleTasks)).join("") || `<div class="empty-note">暂无可见专项</div>`}
      </div>
      <div class="card panel">
        <div class="panel-title">任务状态分布</div>
        <div class="status-wrap">
          <div class="donut" style="background:${donutGradient}">
            <div class="donut-center"><strong>${doneRate}%</strong><span>已完成</span></div>
          </div>
          <div class="legend">
            ${donutSegments.map(s => dbLegendRow(s.label, s.value, visibleTasks.length, s.key)).join("")}
          </div>
        </div>
      </div>
    </div>
    <div class="${canViewRisks ? 'db-grid-3' : 'db-grid-2'}">
      <div class="card panel">
        <div class="panel-title">延期任务 <span class="link" onclick="state.taskFilters={...state.taskFilters,status:'延期'}; switchPage('tasks')">跟进 →</span></div>
        ${delayed.slice(0, 5).map(_dbTaskRow).join("") || `<div class="empty-note">暂无延期任务</div>`}
      </div>
      <div class="card panel">
        <div class="panel-title">${canViewDecisions && decisions.length ? "待决策" : "待确认"} <span class="link" onclick="switchPage('${decisionPage}')">处理 →</span></div>
        ${decisionItems.map(_dbIssueRow).join("") || `<div class="empty-note">暂无待处理事项</div>`}
      </div>
      ${canViewRisks ? `<div class="card panel">
        <div class="panel-title">问题与风险 <span class="link" onclick="switchPage('issues')">全部 →</span></div>
        ${openRisks.slice(0, 5).map(i => `<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid #edf1f5">
          <div class="mini-icon" style="background:${i.priority === '高' ? 'var(--red)' : 'var(--amber)'}"></div>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(i.description || "未命名")}</div>
            <div style="font-size:11px;color:var(--muted);margin-top:1px">${esc(i.special_project || "-")} · 责任人：${esc(i.owner || "-")}</div>
          </div>
          <span class="tag ${i.priority === '高' ? 'tag-red' : 'tag-orange'}">${esc(i.priority || "中")}</span>
        </div>`).join("") || `<div class="empty-note">暂无未解决问题</div>`}
      </div>` : ""}
    </div>
    <div class="db-bottom">
      <div class="card panel">
        <div class="panel-title">本周重点 <span class="link" onclick="switchPage('tasks')">全部 →</span></div>
        ${weeklyFocus.map(_dbTaskRow).join("") || `<div class="empty-note">暂无待推进任务</div>`}
      </div>
      <div class="card panel">
        <div class="panel-title">近期成果 <span class="link" onclick="switchPage('achievements')">全部 →</span></div>
        ${visibleAchievements.slice(0, 5).map(a => `<div style="display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid #edf1f5">
          <div class="mini-icon" style="background:var(--purple)"></div>
          <div style="flex:1;min-width:0">
            <div style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.name || "未命名")}</div>
            <div style="font-size:11px;color:var(--muted);margin-top:1px">${esc(a.special_project || "-")} · ${esc(a.achievement_type || "-")}</div>
          </div>
          <span class="tag ${achievementTagClass(a.status)}">${esc(a.status || "计划中")}</span>
        </div>`).join("") || `<div class="empty-note">暂无成果记录</div>`}
      </div>
    </div>`;
}

function setDashboardFilter(name, value) {
  state.dashboardFilters = { ...(state.dashboardFilters || {}), [name]: value };
  renderDashboard();
}
function setDashboardProject(project) { setDashboardFilter('project', project); }
function clearDashboardProject() { setDashboardFilter('project', ''); }

function sanitizeDashboardFilters(filters, projects = [], owners = [], months = []) {
  const clean = { project: "", owner: "", status: "", month: "", ...(filters || {}) };
  const validProjects = new Set(projects.filter(Boolean));
  const validOwners = new Set(owners.filter(Boolean));
  const validMonths = new Set(months.filter(Boolean));
  const validStatuses = new Set(["未启动", "进行中", "已完成", "延期", "暂缓"]);
  if (clean.project && !validProjects.has(clean.project)) clean.project = "";
  if (clean.owner && !validOwners.has(clean.owner)) clean.owner = "";
  if (clean.month && !validMonths.has(clean.month)) clean.month = "";
  if (clean.status && !validStatuses.has(clean.status)) clean.status = "";
  return clean;
}

function filterDashboardTasks(tasks, filters) {
  return tasks.filter(t => {
    if (filters.project && t.special_project !== filters.project) return false;
    if (filters.owner && ![t.owner, t.coordinator, t.collaborators].some(v => String(v || "").includes(filters.owner))) return false;
    if (filters.status && !statusMatches(t.status, filters.status)) return false;
    if (filters.month && t.plan_time !== filters.month) return false;
    return true;
  });
}

function filterDashboardRecords(rows, filters) {
  return rows.filter(row => {
    if (filters.project && row.special_project !== filters.project) return false;
    if (filters.owner && ![row.owner, row.responsible_person, row.coordinator].some(v => String(v || "").includes(filters.owner))) return false;
    return true;
  });
}

function signalCard(label, value, help) {
  return `<article class="signal-card"><span>${label}</span><strong>${value}</strong><p>${help}</p></article>`;
}

function actionRow(label, value, actionLabel, page, tone) {
  return `<div class="action-row ${tone}"><div><strong>${label}</strong><p>${value ? `还有 ${value} 项需要处理` : "当前无需处理"}</p></div><button onclick="switchPage('${page}')">${actionLabel}</button></div>`;
}

function statusSummaryCard(label, value, tone) {
  return `<article class="status-summary ${tone}"><span>${esc(label)}</span><strong>${value}</strong></article>`;
}

function decisionListItem(item, badgeText = "待决策") {
  const title = item.description || item.title || item.key_task || "待确认事项";
  const owner = item.owner || item.submitter || "负责人待确认";
  const days = item.expected_resolution_time || item.submitted_at || "";
  return `<article class="attention-item">
    <div><strong>${esc(title)}</strong><p>提交人：${esc(owner)}${days ? ` · 等待 ${esc(formatWaitText(days))}` : ""}</p></div>
    ${badge(badgeText)}
  </article>`;
}

function approvalListItem(item) {
  return decisionListItem(item, "待审批");
}

function riskListItem(item) {
  const title = item.description || item.key_task || "风险事项";
  const project = item.special_project || "未归属专项";
  const decisionVisible = !!getCurrentUserContext().can_view_issue_decisions;
  const level = item.priority || (["延期", "风险"].includes(item.status) ? "中" : item.status || "中");
  const badgeText = item.need_decision_by && decisionVisible ? "待决策" : level;
  const relation = currentUserProjectRelation(project);
  return `<article class="attention-item">
    <div><strong>${esc(title)}</strong><p>影响专项：${esc(project)}${relation ? ` · ${esc(relation)}` : ""}</p></div>
    ${badge(badgeText)}
  </article>`;
}

function projectProgressCard(project, tasks, achievements, issues) {
  const rows = tasks.filter(t => t.special_project === project);
  const done = rows.filter(t => t.status === "已完成").length;
  const delayed = rows.filter(t => ["延期", "风险"].includes(t.status)).length;
  const doing = rows.filter(t => ["推进中", "进行中"].includes(t.status)).length;
  const notStarted = rows.filter(t => ["未开始", "未启动"].includes(t.status)).length;
  const rate = rows.length ? Math.round(done / rows.length * 100) : 0;
  const tone = projectTone(project);
  const relation = currentUserProjectRelation(project);
  return `<article class="home-project-card ${tone}">
    <div class="home-project-title"><h3>${esc(project)}</h3><div>${relation ? badge(relation) : ""}<strong>${rate}%</strong></div></div>
    ${progress(rate)}
    <div class="project-chip-row">
      ${done ? `<span class="chip green">完成 ${done}</span>` : ""}
      ${doing ? `<span class="chip blue">进行 ${doing}</span>` : ""}
      ${notStarted ? `<span class="chip neutral">未启动 ${notStarted}</span>` : ""}
      ${delayed ? `<span class="chip red">延期 ${delayed}</span>` : ""}
      ${achievements.filter(a => a.special_project === project).length ? `<span class="chip neutral">成果 ${achievements.filter(a => a.special_project === project).length}</span>` : ""}
    </div>
  </article>`;
}

function weeklyListItem(t) {
  const relation = rowRelationLabel(t);
  return `<article class="home-list-item">
    <span class="dot blue"></span>
    <div><strong>${esc(t.key_task)}</strong><p>${esc(t.owner || "-")} · ${esc(t.special_project)}</p></div>
    ${relation ? badge(relation) : ""}
  </article>`;
}

function achievementListItem(a) {
  const relation = rowRelationLabel(a);
  return `<article class="home-list-item achievement">
    <span class="asset-icon">□</span>
    <div><strong>${esc(a.name)}</strong><p>${esc(a.special_project)} · ${esc(a.update_date || a.version || "未标日期")}</p></div>
    ${relation ? badge(relation) : ""}
  </article>`;
}

function projectCard(project, tasks, achievements, issues) {
  const rows = tasks.filter(t => t.special_project === project);
  const done = rows.filter(t => t.status === "已完成").length;
  const delayed = rows.filter(t => ["延期", "风险"].includes(t.status)).length;
  const doing = rows.filter(t => t.status === "推进中").length;
  const rate = rows.length ? Math.round(done / rows.length * 100) : 0;
  const projectIssues = issues.filter(i => i.special_project === project && !["已解决", "已关闭", "已决策", "关闭"].includes(i.status));
  const hasDecision = projectIssues.some(i => i.need_decision_by);
  const owner = rows.find(t => t.owner)?.owner || projectOwner(project);
  const relation = currentUserProjectRelation(project);
  const tone = delayed ? "red" : doing ? "blue" : "green";
  const statusText = hasDecision && canViewDecisionItems() ? "需决策" : delayed ? "延期" : "正常";
  const riskText = canViewDecisionItems() && projectIssues[0]?.description
    ? projectIssues[0].description
    : delayed
      ? "存在延期任务，需确认原因"
      : projectIssues.length && canViewRiskItems()
        ? "存在待协调事项"
        : "暂无突出阻塞";
  return `<article class="project-card slim ${tone}">
    <div class="project-top"><div><h3>${project}</h3><p class="muted">负责人：${esc(owner)}</p></div><div class="project-badges">${relation ? badge(relation) : ""}${badge(statusText)}</div></div>
    ${progress(rate)}
    <div class="project-kpis"><span>${rate}%</span><span>${rows.length} 项任务</span><span>${achievements.filter(a => a.special_project === project).length} 个成果</span></div>
    <p class="risk-line">${esc(riskText)}</p>
    <button onclick="state.taskFilters.project='${esc(project)}'; switchPage('tasks')">进入专项</button>
  </article>`;
}

function compactAchievement(a) {
  const relation = rowRelationLabel(a);
  return `<article class="compact-item"><div><strong>${esc(a.name)}</strong><p>${esc(a.achievement_type)}｜${esc(a.special_project)}｜${esc(a.version || "未标版本")}</p></div>${relation ? badge(relation) : ""}${badge(a.status)}</article>`;
}

function focusTask(t) {
  const relation = rowRelationLabel(t);
  return `<article class="compact-item"><div><strong>${esc(t.key_task)}</strong><p>${esc(t.special_project)}｜负责人：${esc(t.owner || "-")}｜计划：${esc(t.plan_time || "-")}</p></div>${relation ? badge(relation) : ""}${badge(t.status)}</article>`;
}

function delayedTask(t) {
  const relation = rowRelationLabel(t);
  return `<article class="compact-item alert"><div><strong>${esc(t.key_task)}</strong><p>${esc(t.problem_note || "需确认延期原因")}｜负责人：${esc(t.owner || "-")}</p></div>${relation ? badge(relation) : ""}<button onclick="switchPage('tasks')">跟进</button></article>`;
}

function riskItem(i) {
  const relation = currentUserProjectRelation(i.special_project);
  const decisionVisible = canViewDecisionItems() && !!i.need_decision_by;
  return `<article class="compact-item ${decisionVisible ? "alert" : ""}"><div><strong>${esc(i.description)}</strong><p>${esc(i.special_project)}｜责任人：${esc(i.owner || "-")}｜${esc(i.need_decision_by && decisionVisible ? `需${i.need_decision_by}决策` : "需协调")}</p></div>${relation ? badge(relation) : ""}${badge(i.priority || i.status)}</article>`;
}

// ── window 挂载（供 HTML onchange/onclick 调用）──────────────────────────
window.setDashboardFilter = setDashboardFilter;
window.setDashboardProject = setDashboardProject;
window.clearDashboardProject = clearDashboardProject;
window.renderDashboard = renderDashboard;
