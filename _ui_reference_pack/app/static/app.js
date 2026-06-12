// ── 以下全局变量已迁移至 src/appState.js：
// pages, adminPages, state, projectAreas, members, SYSTEM_ADMIN, _sessionUsername, PROJECTS
// ── API 层已迁移至 src/api/client.js 和 src/api/cache.js：
// _impersonatedUser, api, logout, _cache, _cacheTs, _CACHE_TTL, invalidate, fetchCached
// ── 权限层已迁移至 src/permissions/userContext.js 和 src/permissions/permissions.js：
// splitPeople, getUserResponsibleArea, getCurrentUserName, normalizeUserContext,
// getCurrentUserContext, refreshUserContext, currentUserProjectRelation, rowRelationLabel,
// submissionProject, canView*, canWrite*, canManage*, canAssign*, isPageAllowed, can()
// ── 日期工具已迁移至 src/utils/date.js：
// formatWaitText, formatIssueDateTime, formatSeconds
// ── 格式化工具已迁移至 src/utils/format.js：
// statusTagClass, achievementTagClass, achievementStatusClass, statusClass, statusMatches,
// truncate, linkifyTaskLinks, labelOf, splitEditedList, projRelationChip
// ── 项目工具已迁移至 src/utils/project.js：
// projectBarColor, projectTone, shortProjectName, planTimeRank, isNewTask, getProjectCode,
// achievementDisplayId, achievementWarnings, groupByProject, sortByPlanTime,
// sortByAchievementTime, projectOwner, ceoPerson
// ── 通用组件已迁移至 src/components/common.js：
// toast, renderAccessDenied, EmptyState, LoadingState, ErrorState, NoPermissionState, StatusTag
// ── 首页驾驶舱已迁移至 src/pages/dashboard.js：
// renderDashboard, setDashboardFilter, setDashboardProject, clearDashboardProject,
// sanitizeDashboardFilters, filterDashboardTasks, filterDashboardRecords,
// buildDonutGradient, svgKpiIcon, dbKpi, dbProgressRow, dbLegendRow, _dbTaskRow, _dbIssueRow,
// decisionListItem, approvalListItem, riskListItem, signalCard, actionRow, statusSummaryCard,
// projectProgressCard, weeklyListItem, achievementListItem, projectCard,
// compactAchievement, focusTask, delayedTask, riskItem
// ── 组织与分工已迁移至 src/pages/people.js：
// renderPeople, setOrgViewMode, toggleOrgProject, toggleOrgMember,
// hoverOrgProject, hoverOrgMember, paintOrgHover, projectAreaCard, memberCard,
// projectProgressRate, projectRoleForMember, relationClass, roleClass, setupOrgInteractions
// ── 系统设置已迁移至 src/pages/settings.js：
// renderSettings, settingsTabButton, switchSettingsTab, settingsProjectsPanel,
// settingsPeoplePanel, settingsImportPanel, settingsProjectCard, settingsPersonCard,
// openProjectModal, saveProject, deleteProject, openPersonModal, savePerson,
// deletePerson, handleExcelUpload, refreshSettingsData, llmConfigCard,
// openLlmConfigModal, saveLlmConfig, testLlmConfig
// ── 问题与决策已迁移至 src/pages/issues.js：
// renderIssues, setIssueTab, setIssueFilter, setIssuePage, setIssueProject, clearIssueProject,
// createIssueDraft, submitNewIssue, issueTabButton, normalizeIssueRecord, issueStatCard,
// issueTableRow, issueDecisionPanelItem, issueTrackTimeline, issueReviewRow,
// filterIssueRows, sanitizeIssueFilters, issueRecordCard,
// openIssueDetail, saveIssueDetail, deleteIssue, mockIssueRows
// ── 提交更新已迁移至 src/pages/updates.js：
// updateSummaryItem, renderUpdates, updateModeTab, setUpdateMode, setLlmProvider,
// guideQuestions, modeInputArea, toggleRecording, stopRecordingTimer, stopSpeechRecognition,
// refreshRecordingUI, markMeetingReviewed, publishMeeting, extractUpdate,
// renderSuggestionPanel, extractProjectRow, extractRow, extractStatusChip, _ownerOptions,
// editExtractRow, toggleExtractEdit, saveAsDraft, aiField, aiProjectField,
// _projectInfoCard, onProjectSelectChange, insight, discardPreview,
// readEditedSuggestion, submitPreview
// ── AI确认中心已迁移至 src/pages/confirmations.js：
// sourceTypeMeta, renderConfirmations, confirmTabBtn, setConfirmationTab, confirmationCard,
// openConfirmation, confirmField, confirmWrite, rejectConfirmation, doRejectConfirmation,
// openResubmitModal, doResubmit, doInlineResubmit, withdrawSubmission, transferToCoordinator,
// doTransferToCoordinator, coordinatorFeedback, doCoordinatorFeedback, escalateToCeo,
// doEscalateToCeo, ceoDecide, doCeoDecide, confirmAssign
// ── 成果库已迁移至 src/pages/achievements.js：
// renderAchievements, setAchievementProject, clearAchievementProject, setAchievementFilter,
// achievementProjectGroup, achievementCard, achievementRow, assetMetric, achievementProjectTab,
// filterAchievementRows, jumpToTask, uploadAssetLink, saveAssetLink,
// openAchievementEdit, saveAchievementEdit, deleteAchievement
// ── 工作推进表已迁移至 src/pages/tasks.js：
// _normTask, renderTasks, setTaskFilter, setTaskProject, clearTaskProject,
// sanitizeTaskFilters, filterTasks, projectSelectBar, taskProjectGroup, taskCard,
// openTaskEdit, saveTaskEdit, deleteTask, onTaskToggle, _LOG_FIELD_NAMES, renderLogItem,
// taskProjectTab, filterTaskRows, taskStatusStats, upgradeTaskIssue, submitUpgradedIssue,
// setTaskPage, setTaskPageSize, setTaskSearch, toggleTaskSelect, selectAllTasks,
// clearTaskSelection, toggleBulkStatusMenu, bulkUpdateTaskStatus, bulkAssignOwner,
// doAssignOwner, bulkExtendDeadline, doExtendDeadline, refreshTasks,
// openNewTaskModal, submitNewTask, exportTasksCSV,
// openTaskDrawer, closeTaskDrawer, twTimelineItem, twUpdateItem


function currentPageId() {
  return document.querySelector(".page.active")?.id || "dashboard";
}

function refreshCurrentPage() {
  loadPage(currentPageId());
}

function visiblePageEntries() {
  const result = pages.filter(([id]) => {
    if (id === "confirmations") return canViewConfirmationCenter();
    if (id === "issues") return canViewIssuePage();
    return true;
  });
  if (canViewSettings()) {
    result.push(["settings", "系统设置"]);
  }
  return result;
}


function switchPage(id) {
  if (!isPageAllowed(id)) {
    toast("当前身份没有权限访问该页面");
    return;
  }
  syncPageChrome(id);
  loadPage(id);
}

function syncPageChrome(id) {
  document.querySelectorAll(".page").forEach(p => p.classList.toggle("active", p.id === id));
  const currentMode = state.updateInputMode || "voice";
  document.querySelectorAll(".nav-item").forEach(b => {
    const navId = b.dataset.id;
    const navTab = b.dataset.tab;
    let isActive = navId === id;
    if (isActive && navId === "updates" && navTab) isActive = navTab === currentMode;
    b.classList.toggle("active", isActive);
  });
}

function _navSvg(icon) {
  const icons = {
    home: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
    mic: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`,
    doc: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`,
    check: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
    table: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="9" x2="9" y2="21"/></svg>`,
    trophy: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="8 21 12 17 16 21"/><line x1="12" y1="17" x2="12" y2="9"/><path d="M6 4H4a2 2 0 0 0-2 2v2a3 3 0 0 0 3 3h1.5"/><path d="M18 4h2a2 2 0 0 1 2 2v2a3 3 0 0 1-3 3h-1.5"/><path d="M6 4h12v8a6 6 0 0 1-12 0V4"/></svg>`,
    alert: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
    people: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
    settings: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  };
  return icons[icon] || "";
}

function navClick(el) {
  const id = el.dataset.id;
  const tab = el.dataset.tab;
  if (tab) {
    if (tab === "meeting" && !canUseMeetingMode()) {
      toast("当前身份不能使用会议纪要导入");
      return;
    }
    state.updateInputMode = tab;
  }
  switchPage(id);
}

function toggleSidebar() {
  const sidebar = document.getElementById("sidebar");
  const main = document.getElementById("mainWrap");
  const icon = document.getElementById("collapseIcon");
  if (!sidebar) return;
  const collapsed = sidebar.classList.toggle("collapsed");
  if (main) main.classList.toggle("sidebar-collapsed", collapsed);
  if (icon) {
    icon.innerHTML = collapsed
      ? `<polyline points="9 18 15 12 9 6"/>`
      : `<polyline points="15 18 9 12 15 6"/>`;
  }
}

function bellClick() {
  const context = getCurrentUserContext();
  switchPage(context?.can_view_issue_decisions ? "issues" : "confirmations");
}

function updateTopbarUser() {
  const avatar = document.getElementById("userAvatar");
  if (avatar) avatar.textContent = (_sessionUsername || "?").slice(0, 1);
  const monthEl = document.getElementById("topMonth");
  if (monthEl) {
    const now = new Date();
    monthEl.textContent = `${now.getFullYear()}年${now.getMonth() + 1}月`;
  }
  const roleSelect = document.getElementById("roleSwitch");
  if (roleSelect) roleSelect.style.display = _isAdmin(_sessionUsername) ? "" : "none";
}

function initTabs() {
  const navItems = [
    { id: "dashboard",     label: "首页",       icon: "home"     },
    { id: "updates",       label: "语音更新",   icon: "mic",     tab: "voice" },
    { id: "updates",       label: "会议纪要",   icon: "doc",     tab: "meeting", requireMeeting: true },
    { id: "confirmations", label: "确认中心",   icon: "check",   requireConfirm: true },
    { id: "tasks",         label: "工作推进表", icon: "table"    },
    { id: "achievements",  label: "成果库",     icon: "trophy"   },
    { id: "issues",        label: "问题与决策", icon: "alert",   requireIssue: true },
    { id: "people",        label: "组织分工",   icon: "people"   },
    { id: "settings",      label: "系统设置",   icon: "settings", requireSettings: true },
  ];
  const visible = navItems.filter(item => {
    if (item.requireConfirm && !canViewConfirmationCenter()) return false;
    if (item.requireIssue && !canViewIssuePage()) return false;
    if (item.requireSettings && !canViewSettings()) return false;
    if (item.requireMeeting && !canUseMeetingMode()) return false;
    return true;
  });
  const tabEl = document.getElementById("tabs");
  if (!tabEl) return;
  tabEl.innerHTML = visible.map(item => {
    const tabAttr = item.tab ? ` data-tab="${item.tab}"` : "";
    return `<div class="nav-item" data-id="${item.id}"${tabAttr} onclick="navClick(this)">${_navSvg(item.icon)}<span>${esc(item.label)}</span></div>`;
  }).join("");
}

function _roleSwitchOptions() {
  const inMembers = members.some(m => m.name === _sessionUsername);
  const selfOption = inMembers ? '' : `<option value="${esc(_sessionUsername)}">系统管理员</option>`;
  return selfOption + members.map(m => `<option value="${esc(m.name)}">${esc(m.name)}</option>`).join("");
}

function initRoleSwitch() {
  const node = document.getElementById("roleSwitch");
  if (!node) return;
  node.innerHTML = _roleSwitchOptions();
  node.value = _sessionUsername || "";
  node.addEventListener("change", async () => {
    const switchedTo = node.value;
    state.selectedConfirmationId = null;
    state.dashboardFilters = { project: "", owner: "", status: "", month: currentMonthStr() };
    state.taskFilters = { project: "", status: "", owner: "", month: "" };
    state.achievementFilters = { project: "", type: "", reuse: "", owner: "" };
    state.confirmationTab = "待审核";
    state.issueFilters = { priority: "", project: "", owner: "", status: "" };
    applyDefaultProjectFilters(switchedTo);
    invalidate("tasks", "achievements", "issues", "confirmations");
    await refreshUserContext();
    initTabs();
    updateTopbarUser();
    refreshCurrentPage();
  });
}

function _isAdmin(name) {
  if (name === SYSTEM_ADMIN) return true;
  return members.find(m => m.name === name)?.isAdmin === true;
}

function parseArea(area) {
  if (Array.isArray(area)) return area.filter(Boolean);
  if (!area) return [];
  return area.split(/[,，、\/]/).map(s => s.trim()).filter(Boolean);
}


function myProjectPills(currentProject, selectFn, clearFn) {
  const areas = getUserResponsibleArea(getCurrentUserName());
  if (!areas.length && !currentProject) return '';
  const single = areas.length === 1 ? areas[0] : null;
  return `<span class="qf-pills">${
    single ? `<button class="qf-btn${currentProject === single ? ' active' : ''}" onclick="${selectFn}('${esc(single)}')">我的专项</button>` : ''
  }<button class="qf-btn${!currentProject ? ' active' : ''}" onclick="${clearFn}()">全部</button></span>`;
}


async function fetchAll() {
  const context = getCurrentUserContext();
  const requests = [
    fetchCached("tasks", "/api/tasks"),
    fetchCached("achievements", "/api/achievements"),
    fetchCached("issues", "/api/issues"),
  ];
  if (context.can_view_confirmation_center) {
    requests.push(fetchCached("confirmations", "/api/confirmations/pending"));
  } else {
    // 普通成员：只拉取打回给自己的记录，用于首页提醒和铃铛角标
    requests.push(fetchCached("confirmations", "/api/confirmations/my-rejected").catch(() => []));
  }
  const [tasks, achievements, issues, confirmations = []] = await Promise.all(requests);
  return {
    tasks: tasks.map(t => ({ ...t, special_project: normalizeProject(t.special_project), status: t.status === "风险" ? "延期" : t.status })),
    achievements: achievements.map(a => ({ ...a, special_project: normalizeProject(a.special_project) })),
    issues: issues.map(i => ({ ...i, special_project: normalizeProject(i.special_project), need_decision_by: i.need_decision_by === "请海总" ? (ceoPerson() || i.need_decision_by) : i.need_decision_by })),
    confirmations: confirmations.map(c => ({ ...c, special_project: normalizeProject(c.special_project) })).filter(canViewSubmission),
  };
}

function loadPage(id) {
  syncPageChrome(id);
  if (id === "confirmations" && !canViewConfirmationCenter()) return renderAccessDenied("当前身份无法查看 AI 确认中心");
  if (id === "issues" && !canViewIssuePage()) return renderAccessDenied("当前身份无法查看问题与决策");
  if (id === "settings" && !canViewSettings()) return renderAccessDenied("当前身份无法查看系统设置");
  if (id === "dashboard") return renderDashboard();
  if (id === "updates") return renderUpdates();
  if (id === "confirmations") return renderConfirmations();
  if (id === "tasks") return renderTasks();
  if (id === "achievements") return renderAchievements();
  if (id === "issues") return renderIssues();
  if (id === "people") return renderPeople();
  if (id === "settings") return renderSettings();
}



function orgLine(label, value) {
  return `<div class="org-line"><span>${esc(label)}</span><p>${esc(value || "-")}</p></div>`;
}

function simpleTable(rows, keys) {
  return `<div class="table-wrap"><table><thead><tr>${keys.map(k => `<th>${labelOf(k)}</th>`).join("")}</tr></thead><tbody>${rows.map(r => `<tr>${keys.map(k => `<td>${k === "status" ? badge(r[k]) : esc(r[k])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}

function updateRoleSwitchOptions() {
  const node = document.getElementById("roleSwitch");
  if (!node) return;
  const currentValue = node.value;
  node.innerHTML = _roleSwitchOptions();
  node.value = currentValue || _sessionUsername || "";
}

const PROJECT_NAME_TO_ID = {
  "知识资产AI化": "knowledge-assets",
  "顾问作业AI化": "consultant-work",
  "交付流程AI化": "delivery-flow",
  "咨询服务产品化": "service-product",
  "技术底座与平台预研": "tech-platform",
};

async function loadDynamicOrgData() {
  const [projRes, peopleRes, llmRes] = await Promise.allSettled([
    api("/api/people/projects"),
    api("/api/people"),
    fetch("/api/llm-config/enabled").then(r => r.ok ? r.json() : []),
  ]);
  const apiProjects = projRes.status === "fulfilled" ? projRes.value : null;
  const apiPeople = peopleRes.status === "fulfilled" ? peopleRes.value : null;
  const enabledLlm = llmRes.status === "fulfilled" ? llmRes.value : [];

  if (Array.isArray(enabledLlm)) _enabledProviders = enabledLlm;
  if (Array.isArray(apiProjects) && apiProjects.length) {
    const prevCodeMap = new Map(projectAreas.map(a => [a.name, a.code]));
    projectAreas = apiProjects.map(p => ({
      id: PROJECT_NAME_TO_ID[p.name] || p.name,
      name: p.name,
      code: prevCodeMap.get(p.name) || null,
      coordinator: p.coordinator,
      owner: (p.owners || []).join("、"),
      collaborators: p.collaborators || [],
    }));
  }
  if (Array.isArray(apiPeople) && apiPeople.length) {
    const staticLookup = new Map(members.map(m => [m.name, m]));
    members = apiPeople
      .filter(p => p.is_active !== false)
      .map(p => {
        const s = staticLookup.get(p.name) || {};
        const rawArea = p.special_project_duty || "";
        const parsedArea = parseArea(rawArea);
        return {
          id: s.id || p.name,
          name: p.name,
          role: s.role || p.role || "",
          isAdmin: p.is_admin === true || p.is_admin === 1 || s.isAdmin === true,
          responsibleArea: parsedArea.length ? parsedArea : (s.responsibleArea || []),
          responsibility: s.responsibility || "",
        };
      });
  }
}

function memberAssignmentState(name) {
  return {
    coordinated: projectAreas.filter(area => area.coordinator === name).map(area => area.name),
    owned: projectAreas.filter(area => splitPeople(area.owner).includes(name)).map(area => area.name),
    collaborated: projectAreas.filter(area => splitPeople(area.collaborators).includes(name)).map(area => area.name),
  };
}
async function initApp() {
  try {
    const me = await fetch("/api/auth/me").then(r => r.ok ? r.json() : null);
    if (!me) { window.location.href = "/login"; return; }
    _sessionUsername = me.username;
  } catch {
    window.location.href = "/login";
    return;
  }

  initRoleSwitch();
  await refreshUserContext();
  initTabs();
  updateTopbarUser();
  setupOrgInteractions();
  await loadDynamicOrgData();
  updateRoleSwitchOptions();
  applyDefaultProjectFilters(getCurrentUserName());
  switchPage("dashboard");
}

function applyDefaultProjectFilters(userName) {
  const context = getCurrentUserContext();
  if (context?.canViewAll) return;
  const areas = getUserResponsibleArea(userName);
  if (areas.length === 0 || areas.length > 1) return;
  const project = areas[0];
  state.dashboardFilters = { ...state.dashboardFilters, project };
  state.taskFilters = { ...state.taskFilters, project };
  state.achievementFilters = { ...state.achievementFilters, project };
  state.issueFilters = { ...state.issueFilters, project };
}

function assertBootDependencies() {
  const required = [
    ["state",                  typeof state !== "undefined"],
    ["api",                    typeof api === "function"],
    ["fetchCached",            typeof fetchCached === "function"],
    ["invalidate",             typeof invalidate === "function"],
    ["getCurrentUserContext",  typeof getCurrentUserContext === "function"],
    ["refreshUserContext",     typeof refreshUserContext === "function"],
    ["canViewSettings",        typeof canViewSettings === "function"],
    ["canViewConfirmationCenter", typeof canViewConfirmationCenter === "function"],
    ["canViewIssuePage",       typeof canViewIssuePage === "function"],
    ["isPageAllowed",          typeof isPageAllowed === "function"],
  ];
  const missing = required.filter(([, ok]) => !ok).map(([name]) => name);
  if (missing.length) {
    const msg = `[启动失败] 缺少依赖，请检查 script 加载顺序：${missing.join(", ")}`;
    console.error(msg);
    document.body.innerHTML = `<div style="padding:32px;font-family:monospace;color:#dc2626;background:#fff;font-size:14px"><strong>驾驶舱启动失败</strong><br><br>${msg}</div>`;
    throw new Error(msg);
  }
}

assertBootDependencies();
initApp();
