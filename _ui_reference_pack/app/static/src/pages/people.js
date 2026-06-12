// 组织与分工页面模块
// 依赖：
//   components.js        : esc, badge, emptyState, progress
//   src/appState.js      : state, members, projectAreas
//   src/api/cache.js     : fetchCached
//   src/components/common.js / utils/project.js / permissions/userContext.js
//     : normalizeProject, currentUserProjectRelation, getCurrentUserContext, splitPeople
//   app.js               : loadPage, renderPeople 的调用者已在 app.js 中加载

async function renderPeople() {
  document.getElementById("people").innerHTML = `<div class="page-loading">加载中…</div>`;
  let rawTasks;
  try {
    rawTasks = await fetchCached("tasks", "/api/tasks");
  } catch (err) {
    document.getElementById("people").innerHTML = `<div class="page-error"><strong>组织页加载失败</strong><p>${esc(err.message || "网络错误")}</p><button onclick="loadPage('people')">重试</button></div>`;
    return;
  }
  const context = getCurrentUserContext();
  const tasks = rawTasks.map(t => ({ ...t, special_project: normalizeProject(t.special_project) }));
  const gridActive = state.selectedOrgProjectId || state.selectedOrgMember;
  const visibleProjectAreas = context.canViewAll ? projectAreas : projectAreas.filter(area => context.visibleProjects.includes(area.name));
  const relatedMembers = context.canViewAll
    ? members
    : members.filter(member => (
        visibleProjectAreas.some(area => projectRoleForMember(area, member.name)) ||
        member.name === context.name
      ));
  document.getElementById("people").innerHTML = `
    <div class="org-toolbar">
      <div>
        <h3>组织与分工</h3>
        <p>${state.orgViewMode === "project" ? "点击专项查看相关人员，再次点击取消。" : "点击人员查看参与专项及角色。"}</p>
      </div>
      <div class="segmented">
        <button class="${state.orgViewMode === "project" ? "active" : ""}" onclick="setOrgViewMode('project')">专项视角</button>
        <button class="${state.orgViewMode === "member" ? "active" : ""}" onclick="setOrgViewMode('member')">人员视角</button>
      </div>
    </div>
    <h3 class="org-section-title">五个专项</h3>
    <div class="org-area-grid task-grid ${gridActive ? "has-active" : ""}">${visibleProjectAreas.map((area, i) => projectAreaCard(area, i, tasks)).join("") || emptyState("暂无可见专项", "当前身份没有可查看的专项。")}</div>
    <h3 class="org-section-title">相关成员</h3>
    <div class="org-core-row">${relatedMembers.map(member => memberCard(member)).join("") || emptyState("暂无相关成员", "当前身份没有可查看的成员范围。")}</div>`;
}

function projectAreaCard(area, index, tasks = []) {
  const selfRelation = currentUserProjectRelation(area.name);
  const relation = state.selectedOrgMember ? projectRoleForMember(area, state.selectedOrgMember) : "";
  const selected = state.selectedOrgProjectId === area.id;
  const relatedToMember = state.orgViewMode === "member" && state.selectedOrgMember && relation;
  const dimmed = state.orgViewMode === "member" && state.selectedOrgMember && !relation;
  const dimmedByProjectSelection = state.orgViewMode === "project" && state.selectedOrgProjectId && !selected;
  const hoverHint = state.hoveredOrgMember && projectRoleForMember(area, state.hoveredOrgMember);
  const classes = ["project-card", "org-project-card", `project-tone-${index % 5}`, selected ? "selected active" : "", relatedToMember ? `related ${relationClass(relation)}` : "", dimmed || dimmedByProjectSelection ? "dimmed" : "", hoverHint ? "hover-linked" : ""].filter(Boolean).join(" ");
  const rate = projectProgressRate(area.name, tasks);
  return `<article class="${classes}" data-project="${area.id}">
    <h3>${esc(area.name)}</h3>
    <p class="org-project-meta"><strong>${esc(area.coordinator)}</strong> 统筹 <span>•</span> <strong>${esc(area.owner)}</strong> 负责</p>
    <div class="org-relation-row">
      ${selfRelation ? `<span class="project-role-mark self">${esc(selfRelation)}</span>` : ""}
      ${relation ? `<span class="project-role-mark">${esc(relation)}</span>` : ""}
    </div>
    <div class="org-progress-line">
      ${progress(rate)}
      <strong>${rate}%</strong>
    </div>
  </article>`;
}

function memberCard(member, compact = false) {
  const context = getCurrentUserContext();
  const selectedProject = projectAreas.find(area => area.id === state.selectedOrgProjectId);
  const projectRole = selectedProject ? projectRoleForMember(selectedProject, member.name) : "";
  const showingProjectRole = state.orgViewMode === "project" && selectedProject && projectRole;
  const selected = state.selectedOrgMember === member.name;
  const relatedToProject = state.orgViewMode === "project" && selectedProject && projectRole;
  const dimmed = state.orgViewMode === "project" && selectedProject && !projectRole;
  const dimmedByMemberSelection = state.orgViewMode === "member" && state.selectedOrgMember && !selected;
  const hoverRole = state.hoveredOrgProjectId ? projectRoleForMember(projectAreas.find(area => area.id === state.hoveredOrgProjectId), member.name) : "";
  const selfRelation = member.name === context.name && selectedProject ? projectRole : "";
  const classes = ["person-card", "member-card", compact ? "compact-member" : "core-member", `role-${roleClass(member.role)}`, selected ? "selected" : "", relatedToProject ? `related ${relationClass(projectRole)}` : "", dimmed || dimmedByMemberSelection ? "dimmed" : "", hoverRole ? "hover-lift" : ""].filter(Boolean).join(" ");
  const initial = member.name.slice(0, 1);
  const tagText = showingProjectRole ? projectRole : member.role;
  if (compact) {
    return `<article class="${classes}" data-member="${member.name}">
      <div class="member-avatar">${esc(initial)}</div>
      <div class="compact-member-main">
        <div class="compact-member-title"><h4>${esc(member.name)}</h4><span class="role-tag">${esc(tagText)}</span>${selfRelation ? `<span class="project-role-mark self">${esc(selfRelation)}</span>` : ""}</div>
        <p>${esc(member.responsibleArea)}</p>
      </div>
    </article>`;
  }
  return `<article class="${classes}" data-member="${member.name}">
    <div class="member-head">
      <div class="member-avatar">${esc(initial)}</div>
      <div>
        <h4>${esc(member.name)}</h4>
        <span class="role-tag">${esc(tagText)}</span>
        ${selfRelation ? `<span class="project-role-mark self">${esc(selfRelation)}</span>` : ""}
      </div>
    </div>
    <div class="member-meta ${showingProjectRole ? "hidden" : ""}">
      <p>负责专项：${esc(member.responsibleArea)}</p>
    </div>
    <p class="member-responsibility">${esc(member.responsibility)}</p>
  </article>`;
}

function projectProgressRate(name, tasks = []) {
  const rows = tasks.filter(t => t.special_project === name);
  return rows.length ? Math.round(rows.filter(t => t.status === "已完成").length / rows.length * 100) : 0;
}

function setOrgViewMode(mode) {
  state.orgViewMode = mode;
  state.selectedOrgProjectId = "";
  state.selectedOrgMember = "";
  state.hoveredOrgProjectId = "";
  state.hoveredOrgMember = "";
  renderPeople();
}

function toggleOrgProject(id) {
  if (state.orgViewMode !== "project") state.orgViewMode = "project";
  state.selectedOrgProjectId = state.selectedOrgProjectId === id ? "" : id;
  state.selectedOrgMember = "";
  renderPeople();
}

function toggleOrgMember(name) {
  if (state.orgViewMode !== "member") state.orgViewMode = "member";
  state.selectedOrgMember = state.selectedOrgMember === name ? "" : name;
  state.selectedOrgProjectId = "";
  renderPeople();
}

function hoverOrgProject(id) {
  state.hoveredOrgProjectId = id;
  paintOrgHover();
}

function hoverOrgMember(name) {
  state.hoveredOrgMember = name;
  paintOrgHover();
}

function paintOrgHover() {
  document.querySelectorAll(".member-card").forEach(card => card.classList.remove("hover-lift"));
  document.querySelectorAll(".org-project-card").forEach(card => card.classList.remove("hover-linked"));
  if (state.hoveredOrgProjectId) {
    const area = projectAreas.find(item => item.id === state.hoveredOrgProjectId);
    members.forEach(member => {
      if (projectRoleForMember(area, member.name)) document.querySelector(`[data-member="${member.name}"]`)?.classList.add("hover-lift");
    });
  }
  if (state.hoveredOrgMember) {
    projectAreas.forEach(area => {
      if (projectRoleForMember(area, state.hoveredOrgMember)) document.querySelector(`[data-project="${area.id}"]`)?.classList.add("hover-linked");
    });
  }
}

function projectRoleForMember(area, name) {
  if (!area || !name) return "";
  if (name === area.coordinator) return "统筹";
  if (splitPeople(area.owner).includes(name)) return "负责";
  if (splitPeople(area.collaborators).includes(name)) return "协同";
  // "全体顾问"规则：只对非其他专项负责人的成员生效，避免把其他专项负责人误判为协同
  if (area.collaborators.includes("全体顾问") && ["专项负责人", "负责"].includes(members.find(m => m.name === name)?.role)) {
    const ownsOtherProject = projectAreas.some(a => a.id !== area.id && splitPeople(a.owner).includes(name));
    if (!ownsOtherProject) return "协同";
  }
  return "";
}

function relationClass(role = "") {
  return { "统筹": "relation-coordinator", "负责": "relation-owner", "协同": "relation-collaborator" }[role] || "";
}

function roleClass(role = "") {
  if (role === "组长") return "leader";
  if (role === "专项统筹人" || role === "统筹") return "coordinator";
  if (role === "专项负责人" || role === "负责") return "owner";
  if (role === "过程保障") return "support";
  if (role === "AI应用工程师") return "engineer";
  return "member";
}

function setupOrgInteractions() {
  const page = document.getElementById("people");
  if (!page || page.dataset.orgBound === "true") return;
  page.dataset.orgBound = "true";

  // 使用事件委托：组织页内容会反复重渲染，绑定在父容器上更稳定。
  page.addEventListener("click", event => {
    if (event.target.closest(".segmented")) return;
    const projectCard = event.target.closest(".org-project-card");
    if (projectCard && page.contains(projectCard)) {
      // 点击未激活专项：激活当前；点击已激活专项：取消选中。
      toggleOrgProject(projectCard.dataset.project);
      return;
    }
    const memberCard = event.target.closest(".member-card");
    if (memberCard && page.contains(memberCard)) {
      toggleOrgMember(memberCard.dataset.member);
    }
  });

  page.addEventListener("mouseover", event => {
    const projectCard = event.target.closest(".org-project-card");
    if (projectCard && page.contains(projectCard)) {
      hoverOrgProject(projectCard.dataset.project);
      return;
    }
    const memberCard = event.target.closest(".member-card");
    if (memberCard && page.contains(memberCard)) {
      hoverOrgMember(memberCard.dataset.member);
    }
  });

  page.addEventListener("mouseout", event => {
    const projectCard = event.target.closest(".org-project-card");
    if (projectCard && page.contains(projectCard) && !projectCard.contains(event.relatedTarget)) {
      hoverOrgProject("");
      return;
    }
    const memberCard = event.target.closest(".member-card");
    if (memberCard && page.contains(memberCard) && !memberCard.contains(event.relatedTarget)) {
      hoverOrgMember("");
    }
  });
}

window.renderPeople = renderPeople;
window.setOrgViewMode = setOrgViewMode;
window.toggleOrgProject = toggleOrgProject;
window.toggleOrgMember = toggleOrgMember;
window.hoverOrgProject = hoverOrgProject;
window.hoverOrgMember = hoverOrgMember;
window.paintOrgHover = paintOrgHover;
window.projectAreaCard = projectAreaCard;
window.memberCard = memberCard;
window.projectProgressRate = projectProgressRate;
window.projectRoleForMember = projectRoleForMember;
window.relationClass = relationClass;
window.roleClass = roleClass;
window.setupOrgInteractions = setupOrgInteractions;
