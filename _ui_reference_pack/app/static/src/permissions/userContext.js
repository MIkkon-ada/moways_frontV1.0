// 用户上下文解析与角色计算
// 依赖：state, projectAreas, members, SYSTEM_ADMIN, _sessionUsername (appState.js)
// 依赖：normalizeProject (components.js)
// 依赖：api() (api/client.js)

// ── 工具函数（在此定义后对 app.js 全局可用）────────────────────────────────

function splitPeople(value) {
  return (Array.isArray(value) ? value.join("、") : String(value || ""))
    .split(/[、,，\s]+/)
    .map(item => item.trim())
    .filter(Boolean);
}

function getUserResponsibleArea(name) {
  return members.find(m => m.name === name)?.responsibleArea || [];
}

// ── 当前登录用户名 ────────────────────────────────────────────────────────

function getCurrentUserName() {
  return document.getElementById("roleSwitch")?.value || _sessionUsername || "";
}

// ── 将后端返回的 /api/people/me 规范化为统一结构 ─────────────────────────

function normalizeUserContext(ctx) {
  if (!ctx) return null;
  return {
    name: ctx.name || "",
    role: ctx.role || "",
    isCEO: !!ctx.is_ceo,
    isTechAdmin: !!ctx.is_tech_admin,
    isProcessGuard: !!ctx.is_process_guard,
    isCoordinator: !!ctx.is_coordinator,
    ownedProjects: ctx.owned_projects || [],
    coordinatedProjects: ctx.coordinated_projects || [],
    collaboratedProjects: ctx.collaborated_projects || [],
    visibleProjects: ctx.visible_projects || [],
    canViewAll: !!ctx.can_view_all,
    canMaintainAll: !!ctx.can_confirm_all,
    canAssignAll: !!ctx.can_assign_all,
    canSubmitUpdate: true,
    roleScope: ctx.role_scope || "",
    can_view_settings: !!ctx.can_view_settings,
    can_view_confirmation_center: !!ctx.can_view_confirmation_center,
    can_view_approval_reminders: !!ctx.can_view_approval_reminders,
    can_view_decision_items: !!ctx.can_view_decision_items,
    can_view_risk_items: !!ctx.can_view_risk_items,
    can_view_issue_decisions: !!ctx.can_view_issue_decisions,
    can_view_issue_risks: !!ctx.can_view_issue_risks,
    can_view_progress: ctx.can_view_progress !== false,
  };
}

// ── 从本地数据计算当前用户的权限上下文（未登录 API 时的本地回退）─────────

function getCurrentUserContext() {
  if (state.userContext) return state.userContext;

  const name = getCurrentUserName();
  const member = members.find(item => item.name === name) || {};
  const coordinatedProjects = projectAreas.filter(area => area.coordinator === name).map(area => area.name);
  const ownedProjects = projectAreas.filter(area => splitPeople(area.owner).includes(name)).map(area => area.name);
  const collaboratedProjects = projectAreas.filter(area => splitPeople(area.collaborators).includes(name)).map(area => area.name);
  const isSystemAdmin = name === SYSTEM_ADMIN;
  const isTechAdmin = isSystemAdmin || member.isAdmin === true;
  const isCEO = !isTechAdmin && (member.responsibleArea || []).length === 0 &&
    !["过程保障", "统筹", "负责", "AI应用工程师"].includes(member.role);
  const isProcessGuard = member.role === "过程保障";
  const isCoordinator = member.role === "统筹" && !isCEO && !isTechAdmin && !isProcessGuard;
  const visibleProjects = isCEO || isTechAdmin || isProcessGuard
    ? PROJECTS.slice()
    : isCoordinator
      ? coordinatedProjects
      : [...new Set([...ownedProjects, ...collaboratedProjects])];

  return {
    name,
    role: member.role || "",
    isCEO,
    isTechAdmin,
    isProcessGuard,
    isCoordinator,
    ownedProjects,
    coordinatedProjects,
    collaboratedProjects,
    visibleProjects,
    canViewAll: isCEO || isTechAdmin || isProcessGuard,
    canMaintainAll: isCEO || isTechAdmin,
    canAssignAll: isCEO || isTechAdmin || isProcessGuard,
    canSubmitUpdate: true,
    can_view_settings: isTechAdmin,
    can_view_confirmation_center: isCEO || isTechAdmin || ownedProjects.length > 0 || coordinatedProjects.length > 0,
    can_view_approval_reminders: isCEO || isTechAdmin || ownedProjects.length > 0 || coordinatedProjects.length > 0,
    can_view_decision_items: isCEO || isTechAdmin,
    can_view_risk_items: isCEO || isTechAdmin || isCoordinator || ownedProjects.length > 0,
    can_view_issue_decisions: isCEO || isTechAdmin,
    can_view_issue_risks: isCEO || isTechAdmin || isCoordinator || ownedProjects.length > 0,
    can_view_progress: true,
  };
}

// ── 从后端刷新权限上下文（写入 state.userContext）──────────────────────────

async function refreshUserContext() {
  try {
    state.userContext = normalizeUserContext(await api("/api/people/me"));
  } catch {
    state.userContext = null;
  }
}

// ── 当前用户与专项的关系标签 ──────────────────────────────────────────────

function currentUserProjectRelation(project) {
  const context = getCurrentUserContext();
  const projectName = normalizeProject(project || "");
  if (!projectName) return "";
  const area = projectAreas.find(item => normalizeProject(item.name) === projectName);
  if (!area) return context.visibleProjects.includes(projectName) ? "项目相关" : "";
  if (splitPeople(area.owner).includes(context.name)) return "我负责";
  if (area.coordinator === context.name) return "我统筹";
  if (splitPeople(area.collaborators).includes(context.name)) return "我参与";
  if (area.collaborators.includes("全体顾问") &&
      ["专项负责人", "负责"].includes(members.find(m => m.name === context.name)?.role)) {
    const ownsOtherProject = projectAreas.some(
      item => item.id !== area.id && splitPeople(item.owner).includes(context.name)
    );
    if (!ownsOtherProject) return "我参与";
  }
  return context.visibleProjects.includes(projectName) ? "项目相关" : "";
}

// ── 当前用户与某行数据的关系标签 ─────────────────────────────────────────

function rowRelationLabel(row) {
  const context = getCurrentUserContext();
  const name = context.name;
  if (!name || !row) return "";
  if (splitPeople(row.owner).includes(name)) return "我负责";
  if (splitPeople(row.coordinator).includes(name)) return "我统筹";
  const relatedPeople = [row.collaborators, row.collaborator, row.helper, row.submitter, row.responsible_person]
    .flatMap(value => splitPeople(value));
  if (relatedPeople.includes(name)) return "我参与";
  return currentUserProjectRelation(row.special_project || "");
}
