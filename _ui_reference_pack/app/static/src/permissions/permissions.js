// 权限门控函数
// 依赖：getCurrentUserContext, currentUserProjectRelation, splitPeople (userContext.js)
// 依赖：normalizeProject (components.js)

// ── 内部辅助 ──────────────────────────────────────────────────────────────

function submissionProject(row) {
  return normalizeProject(row.special_project || row.project || "");
}

// ── 页面级权限 ────────────────────────────────────────────────────────────

function canViewSettings() {
  return !!getCurrentUserContext().can_view_settings;
}

function canViewConfirmationCenter() {
  return !!getCurrentUserContext().can_view_confirmation_center;
}

function canViewDecisionItems() {
  return !!getCurrentUserContext().can_view_decision_items;
}

function canViewRiskItems() {
  return !!getCurrentUserContext().can_view_risk_items;
}

function canViewIssuePage() {
  const ctx = getCurrentUserContext();
  return !!(ctx.can_view_issue_risks || ctx.can_view_issue_decisions);
}

function canUseMeetingMode() {
  return getCurrentUserContext().can_view_progress !== false;
}

function isPageAllowed(id) {
  const ctx = getCurrentUserContext();
  if (id === "confirmations") return !!ctx.can_view_confirmation_center;
  if (id === "issues") return !!(ctx.can_view_issue_risks || ctx.can_view_issue_decisions);
  if (id === "settings") return !!ctx.can_view_settings;
  return true;
}

// ── 数据行级权限 ──────────────────────────────────────────────────────────

function canViewProject(project) {
  const ctx = getCurrentUserContext();
  if (ctx.canViewAll) return true;
  return ctx.visibleProjects.includes(normalizeProject(project));
}

function canWriteProject(project) {
  const ctx = getCurrentUserContext();
  if (ctx.canMaintainAll) return true;
  return !!project && ctx.ownedProjects.includes(normalizeProject(project));
}

function canManageAchievement(project) {
  const ctx = getCurrentUserContext();
  return ctx.canMaintainAll || ctx.isProcessGuard ||
    (!!project && ctx.ownedProjects.includes(normalizeProject(project)));
}

function canViewRow(row) {
  const ctx = getCurrentUserContext();
  const project = normalizeProject(row.special_project || "");
  if (project && canViewProject(project)) return true;
  const relatedPeople = [row.owner, row.coordinator, row.collaborators, row.submitter, row.responsible_person]
    .flatMap(v => splitPeople(v));
  return relatedPeople.includes(ctx.name);
}

function canViewSubmission(row) {
  const ctx = getCurrentUserContext();
  const project = submissionProject(row);
  if (project && canViewProject(project)) return true;
  return [row.submitter, row.assigned_to].some(v => splitPeople(v).includes(ctx.name));
}

function canConfirmSubmission(row) {
  const ctx = getCurrentUserContext();
  if (ctx.canMaintainAll) return true;
  const project = submissionProject(row);
  return !!(project && ctx.ownedProjects.includes(project));
}

function canConfirmProject(project) {
  const ctx = getCurrentUserContext();
  if (ctx.canMaintainAll) return true;
  return !!(project && ctx.ownedProjects.includes(normalizeProject(project)));
}

function canAssignSubmission() {
  return getCurrentUserContext().canAssignAll;
}

// ── 统一权限门控 can(ctx, action, resource?) ──────────────────────────────
// 第一版：包装现有函数，后续各页面逐步迁移到此接口
//
// 支持的 action：
//   page:view:settings | page:view:confirmations | page:view:issues
//   submission:view | submission:approve | submission:return
//   submission:transfer_to_coordinator | submission:ceo_decide
//   task:view | task:update
//   achievement:view | achievement:manage
//   issue:view | issue:decide

function can(ctx, action, resource = null) {
  switch (action) {
    case "page:view:settings":
      return !!ctx.can_view_settings;
    case "page:view:confirmations":
      return !!ctx.can_view_confirmation_center;
    case "page:view:issues":
      return !!(ctx.can_view_issue_risks || ctx.can_view_issue_decisions);

    case "submission:view":
      return resource ? canViewSubmission(resource) : false;
    case "submission:approve":
      return resource ? canConfirmSubmission(resource) : false;
    case "submission:return":
      return resource ? canConfirmSubmission(resource) : false;
    case "submission:transfer_to_coordinator":
      return resource ? canConfirmSubmission(resource) : false;
    case "submission:ceo_decide":
      // 仅 CEO 或技术管理员可批示
      return ctx.isCEO || ctx.canMaintainAll;

    case "task:view":
      return resource ? canViewProject(resource.special_project) : ctx.canViewAll;
    case "task:update":
      return resource ? canWriteProject(resource.special_project) : ctx.canMaintainAll;

    case "achievement:view":
      return resource ? canViewProject(resource.special_project) : ctx.canViewAll;
    case "achievement:manage":
      return resource ? canManageAchievement(resource.special_project) : ctx.canMaintainAll;

    case "issue:view":
      return !!(ctx.can_view_issue_risks || ctx.can_view_issue_decisions);
    case "issue:decide":
      return !!ctx.can_view_issue_decisions;

    default:
      return false;
  }
}
