// 问题与决策页面模块
// 依赖（均在本文件之前加载）：
//   components.js      : esc, badge, field, textField, selectField, optionList, readForm, openModal, closeModal, emptyState, PROJECTS
//   src/appState.js    : state, members
//   src/api/client.js  : api
//   src/api/cache.js   : fetchCached, invalidate
//   src/permissions/permissions.js : canViewIssuePage, canViewDecisionItems, canWriteProject, getCurrentUserContext, getCurrentUserName
//   src/utils/project.js : normalizeProject, ceoPerson
//   src/utils/date.js    : formatWaitText, formatIssueDateTime
//   app.js             : toast, loadPage, closeModal（运行时调用）

async function renderIssues() {
  if (!canViewIssuePage()) {
    document.getElementById("issues").innerHTML = emptyState("无权限访问", "当前身份只能查看项目进展，无法查看问题与决策。");
    return;
  }
  document.getElementById("issues").innerHTML = `<div class="page-loading">加载中…</div>`;
  let rawRows;
  try {
    rawRows = await fetchCached("issues", "/api/issues");
  } catch (err) {
    document.getElementById("issues").innerHTML = `<div class="page-error"><strong>问题列表加载失败</strong><p>${esc(err.message || "网络错误")}</p><button onclick="loadPage('issues')">重试</button></div>`;
    return;
  }
  const rows = rawRows.map(normalizeIssueRecord);
  const projects = [...new Set(rows.map(i => i.special_project).filter(Boolean))];
  const owners = [...new Set(rows.flatMap(i => [i.owner, i.collaborator, i.submitter]).filter(Boolean))];
  const types = [...new Set(rows.map(i => i.issue_type).filter(Boolean))];
  const filters = sanitizeIssueFilters(state.issueFilters || {}, projects, owners, types);
  state.issueFilters = filters;

  const allRows = filterIssueRows(rows, "all", filters);
  const page = Math.max(1, state.issuePage || 1);
  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(allRows.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageRows = allRows.slice((safePage - 1) * pageSize, safePage * pageSize);

  const pendingCount = rows.filter(i => i.status === "待处理").length;
  const inProgressCount = rows.filter(i => i.status === "处理中").length;
  const resolvedCount = rows.filter(i => ["已解决","已关闭","已决策"].includes(i.status)).length;
  const decisionCount = rows.filter(i => i.section === "decision" && !["已决策","已关闭"].includes(i.status)).length;
  const decisionItems = rows.filter(i => i.section === "decision" && !["已决策","已关闭"].includes(i.status));
  const trackIssue = decisionItems[0] || rows.find(i => !["已解决","已关闭","已决策"].includes(i.status)) || rows[0];
  const reviewRows = rows.filter(i => ["已解决","已关闭","已决策"].includes(i.status) && i.conclusion);
  const ceoPerson_ = ceoPerson();
  const addDecisionBtn = canViewDecisionItems() ? `<button class="iss2-add-btn iss2-add-btn-ghost" onclick="createIssueDraft('决策项')">+ 新增决策项</button>` : "";

  const STAT_SVG = {
    q: `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
    clock: `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    check: `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`,
    box: `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>`,
  };

  document.getElementById("issues").innerHTML = `
    <div class="iss2-page">
      <div class="iss2-head">
        <div>
          <h2 class="iss2-title">问题与决策</h2>
          <p class="iss2-subtitle">跟踪项目卡点、风险、协同事项与需${ceoPerson_ ? esc(ceoPerson_) : "决策人"}决策的问题</p>
        </div>
      </div>
      <div class="iss2-filter-bar">
        <div class="iss2-filters">
          <label><span>问题类型</span><select onchange="setIssueFilter('issue_type',this.value)"><option value="">全部</option>${optionList(types, filters.issue_type)}</select></label>
          <label><span>优先级</span><select onchange="setIssueFilter('priority',this.value)"><option value="">全部</option>${optionList(["高","中","低"], filters.priority)}</select></label>
          <label><span>状态</span><select onchange="setIssueFilter('status',this.value)"><option value="">全部</option>${optionList(["待处理","处理中","待决策","已解决","已关闭","已决策"], filters.status)}</select></label>
          <label><span>责任人</span><select onchange="setIssueFilter('owner',this.value)"><option value="">全部</option>${optionList(owners, filters.owner)}</select></label>
          <label><span>关联专项</span><select onchange="setIssueFilter('project',this.value)"><option value="">全部</option>${optionList(projects, filters.project)}</select></label>
        </div>
        <div class="iss2-actions">
          ${addDecisionBtn}
          <button class="iss2-add-btn" onclick="createIssueDraft('问题')"><span class="iss2-add-icon">+</span> 新增问题</button>
        </div>
      </div>
      <div class="iss2-stats">
        ${issueStatCard("待处理问题", pendingCount, "orange", STAT_SVG.q, "较上周 -2")}
        ${issueStatCard("处理中", inProgressCount, "blue", STAT_SVG.clock, "较上周 +1")}
        ${issueStatCard("已解决", resolvedCount, "green", STAT_SVG.check, "较上周 +6")}
        ${issueStatCard("需决策事项", decisionCount, "purple", STAT_SVG.box, "较上周 ±0")}
      </div>
      <div class="iss2-body">
        <div class="iss2-main">
          <div class="iss2-section-title"><span>问题清单</span></div>
          <div class="iss2-table-wrap">
            <table class="iss2-table">
              <thead><tr>
                <th class="iss2-col-desc">问题描述</th>
                <th>问题类型</th>
                <th>关联专项</th>
                <th>责任人</th>
                <th>协同人</th>
                <th>优先级</th>
                <th>状态</th>
                <th>预计解决时间</th>
                <th>需决策人</th>
                <th>操作</th>
              </tr></thead>
              <tbody>
                ${pageRows.map(issueTableRow).join("") || `<tr><td colspan="10" class="iss2-empty">暂无符合条件的数据</td></tr>`}
              </tbody>
            </table>
          </div>
          <div class="iss2-pagination">
            <span class="iss2-total">共 ${allRows.length} 条</span>
            <span class="iss2-page-size-label">10条/页</span>
            <div class="iss2-pager">
              <button ${safePage <= 1 ? "disabled" : ""} onclick="setIssuePage(${safePage-1})">‹</button>
              <span class="iss2-page-num">${safePage}</span>
              <button ${safePage >= totalPages ? "disabled" : ""} onclick="setIssuePage(${safePage+1})">›</button>
            </div>
            <span class="iss2-page-goto">前往 <input type="number" min="1" max="${totalPages}" value="${safePage}" onchange="setIssuePage(+this.value)" style="width:36px;border:1px solid #d1d5db;border-radius:4px;padding:2px 4px;font-size:12px;text-align:center"> 页</span>
          </div>
        </div>
        <div class="iss2-side">
          <div class="iss2-panel">
            <div class="iss2-panel-head">
              <span class="iss2-panel-title">决策事项面板</span>
              <span class="iss2-panel-link" onclick="setIssueFilter('status','待决策')">查看全部 ›</span>
            </div>
            ${decisionItems.slice(0,3).map(issueDecisionPanelItem).join("") || `<p class="iss2-panel-empty">暂无待决策事项</p>`}
          </div>
          <div class="iss2-panel">
            <div class="iss2-panel-head">
              <span class="iss2-panel-title">问题闭环追踪</span>
              ${trackIssue ? `<span class="iss2-panel-id">问题ID：${esc(trackIssue.id)} <span class="iss2-panel-link" onclick="openIssueDetail(${trackIssue.rawId ?? null},'${esc(trackIssue.id).replace(/'/g,"\\'")}')">查看详情 ›</span></span>` : ""}
            </div>
            ${trackIssue ? issueTrackTimeline(trackIssue) : `<p class="iss2-panel-empty">暂无追踪数据</p>`}
          </div>
        </div>
      </div>
      ${reviewRows.length ? `<div class="iss2-review">
        <div class="iss2-section-title"><span>关联复盘结论 <span class="iss2-review-hint">已关闭且有结论的问题</span></span><span class="iss2-panel-link">查看全部复盘 ›</span></div>
        <div class="iss2-table-wrap">
          <table class="iss2-table">
            <thead><tr>
              <th>问题ID</th><th class="iss2-col-desc">问题描述</th><th>关联专项</th>
              <th>问题类型</th><th>关闭时间</th><th>复盘结论</th><th>责任人</th>
            </tr></thead>
            <tbody>${reviewRows.map(issueReviewRow).join("")}</tbody>
          </table>
        </div>
      </div>` : ""}
    </div>`;
}

function setIssueTab(tab) {
  state.issueTab = tab;
  renderIssues();
}

function setIssueFilter(name, value) {
  state.issueFilters = { ...(state.issueFilters || {}), [name]: value };
  state.issuePage = 1;
  renderIssues();
}
function setIssuePage(p) { state.issuePage = Math.max(1, +p || 1); renderIssues(); }
function setIssueProject(project) { setIssueFilter('project', project); }
function clearIssueProject() { setIssueFilter('project', ''); }

function createIssueDraft(type) {
  const isDecision = type === "决策项";
  if (isDecision && !canViewDecisionItems()) {
    toast("当前身份不能创建决策项");
    return;
  }
  const context = getCurrentUserContext();
  const writableProjects = context.canMaintainAll ? PROJECTS : PROJECTS.filter(project => canWriteProject(project));
  if (!writableProjects.length) {
    toast("当前身份没有可创建问题的专项");
    return;
  }
  openModal(`<div class="simple-modal">
    <h3>新增${esc(type)}</h3>
    <form id="newIssueForm">
      ${textField("问题描述", "description", "", 3)}
      ${selectField("所属专项", "special_project", writableProjects, writableProjects[0] || "")}
      ${selectField("责任人", "owner", members.map(m => m.name), getCurrentUserName())}
      ${selectField("优先级", "priority", ["高", "中", "低"], isDecision ? "高" : "中")}
      ${isDecision ? `<label><span>期望决策时间</span><input name="expected_resolve_time" placeholder="如：6月5日前"></label>` : `<label><span>预计解决时间</span><input name="expected_resolve_time" placeholder="如：6月5日"></label>`}
      ${isDecision ? `<label><span>决策人</span><input name="need_decision_by" value="${esc(ceoPerson())}"></label>` : ""}
      <div class="modal-actions">
        <button type="button" onclick="closeModal()">取消</button>
        <button type="button" class="success" onclick="submitNewIssue('${isDecision ? "决策" : "问题"}')">提交</button>
      </div>
    </form>
  </div>`);
}

async function submitNewIssue(issueType) {
  const form = document.getElementById("newIssueForm");
  if (!form) return;
  const v = readForm(form);
  if (!v.description?.trim()) return toast("请填写问题描述");
  if (!v.special_project) return toast("请选择所属专项");
  try {
    await api("/api/issues", {
      method: "POST",
      body: JSON.stringify({
        issue_type: issueType,
        description: v.description,
        owner: v.owner || getCurrentUserName(),
        helper: "",
        priority: v.priority || "中",
        status: "待处理",
        need_decision_by: v.need_decision_by || "",
        expected_resolve_time: v.expected_resolve_time || "",
        resolution: "",
        related_task_id: null,
        special_project: v.special_project,
        source_type: "人工录入",
      }),
    });
    invalidate("issues");
    closeModal();
    toast(`${issueType}已创建`);
    renderIssues();
  } catch (err) {
    toast(`提交失败：${err.message || "请重试"}`);
  }
}

function issueTabButton(id, label, count) {
  return `<button class="${state.issueTab === id ? "active" : ""}" onclick="setIssueTab('${id}')">${esc(label)} <span>${count}</span></button>`;
}

function normalizeIssueRecord(row, index = 0) {
  const type = row.type || row.issue_type || (row.need_decision_by ? "决策" : "风险");
  const status = row.status || "待处理";
  const closed = ["已关闭", "已决策", "已解决", "关闭"].includes(status);
  const numericId = Number(row.id);
  const codePrefix = type.includes("决策") || row.need_decision_by ? "D" : "P";
  return {
    rawId: Number.isFinite(numericId) ? numericId : null,
    id: row.id && Number.isFinite(numericId) ? `#${codePrefix}-${String(row.id).padStart(2, "0")}` : String(row.id || `#P-${String(index + 1).padStart(2, "0")}`),
    section: type.includes("决策") || row.need_decision_by ? "decision" : "problem",
    type: type.includes("决策") ? "决策" : type.includes("风险") ? "风险" : "卡点",
    description: row.description || row.title || "未命名问题",
    owner: row.owner || row.responsible_person || "-",
    collaborator: row.collaborator || row.co_owner || "",
    submitter: row.submitter || row.owner || "",
    special_project: normalizeProject(row.special_project),
    priority: row.priority || "中",
    status: closed && status === "关闭" ? "已关闭" : status,
    expected: row.expected_resolution_time || row.due_date || "",
    expected_resolution_time: row.expected_resolution_time || row.expected_resolve_time || row.due_date || "",
    conclusion: row.resolution || row.solution || row.conclusion || "",
    resolution: row.resolution || row.solution || row.conclusion || "",
    need_decision_by: row.need_decision_by || "",
    issue_type: row.issue_type || type,
    helper: row.helper || row.collaborator || row.co_owner || "",
    related_task_id: row.related_task_id || null,
    source_type: row.source_type || "",
    created_at: row.created_at || "",
    updated_at: row.updated_at || "",
    closed_at: row.closed_at || row.updated_at || "",
  };
}

function issueStatCard(label, count, color, icon, trend) {
  const trendHtml = trend
    ? `<div class="iss2-stat-trend">${esc(trend)}</div>`
    : `<div class="iss2-stat-trend">—</div>`;
  return `<div class="iss2-stat iss2-stat-${color}">
    <div class="iss2-stat-icon">${icon}</div>
    <div class="iss2-stat-body">
      <div class="iss2-stat-label">${esc(label)}</div>
      <div class="iss2-stat-num">${count}</div>
      ${trendHtml}
    </div>
  </div>`;
}

function issueTableRow(item) {
  const closed = ["已关闭","已决策","已解决"].includes(item.status);
  const priClass = item.priority === "高" ? "iss2-pri-high" : item.priority === "低" ? "iss2-pri-low" : "iss2-pri-mid";
  const statusClass = closed ? "iss2-status-closed" : item.status === "处理中" ? "iss2-status-active" : item.status === "待决策" ? "iss2-status-decision" : "iss2-status-pending";
  const collaborator = item.collaborator || item.helper || "-";
  const detailCall = `openIssueDetail(${item.rawId ?? null},'${esc(item.id).replace(/'/g,"\\'")}')`;
  const actionHtml = closed
    ? `<button class="iss2-action-btn" onclick="${detailCall}">查看</button>`
    : `<div class="iss2-row-actions"><button class="iss2-action-btn" onclick="${detailCall}">查看</button><button class="iss2-action-btn iss2-action-btn-strong" onclick="${detailCall}">处理</button></div>`;
  return `<tr class="${closed ? "iss2-row-closed" : ""}">
    <td class="iss2-col-desc"><span class="iss2-desc-text" title="${esc(item.description)}">${esc(item.description)}</span></td>
    <td><span class="iss2-type-chip">${esc(item.issue_type || item.type)}</span></td>
    <td class="iss2-col-project" title="${esc(item.special_project || "")}">${esc(item.special_project || "-")}</td>
    <td>${esc(item.owner || "-")}</td>
    <td>${esc(collaborator === "-" ? "-" : collaborator)}</td>
    <td><span class="iss2-priority-chip ${priClass}">${esc(item.priority)}</span></td>
    <td><span class="iss2-status-chip ${statusClass}">${esc(item.status)}</span></td>
    <td>${esc(item.expected_resolution_time || "-")}</td>
    <td>${esc(item.need_decision_by || "-")}</td>
    <td>${actionHtml}</td>
  </tr>`;
}

function issueDecisionPanelItem(item) {
  const STEP_MAP = { "待处理": 0, "待决策": 1, "处理中": 1, "已批示": 2 };
  const stepIdx = STEP_MAP[item.status] ?? 0;
  const progressPct = Math.round(((stepIdx + 1) / 3) * 100);
  const priClass = item.priority === "高" ? "iss2-dec-pri-high" : "iss2-dec-pri-mid";
  return `<div class="iss2-dec-item" onclick="openIssueDetail(${item.rawId ?? null},'${esc(item.id).replace(/'/g,"\\'")}')">
    <div class="iss2-dec-row1">
      <span class="iss2-dec-pri ${priClass}">${esc(item.priority)}</span>
      <span class="iss2-dec-desc">${esc(item.description)}</span>
    </div>
    <div class="iss2-dec-row2">关联专项：${esc(item.special_project || "-")}</div>
    <div class="iss2-dec-row3">
      <span>当前进度</span>
      <div class="iss2-dec-progress">
        <div class="iss2-dec-bar"><div class="iss2-dec-fill" style="width:${progressPct}%"></div></div>
        <span class="iss2-dec-frac">${stepIdx + 1}/3</span>
      </div>
    </div>
  </div>`;
}

function issueTrackTimeline(item) {
  const STATUS_STEP = { "待处理": 0, "待决策": 1, "处理中": 2, "已批示": 3, "已解决": 4, "已关闭": 4, "已决策": 4 };
  const currentStep = STATUS_STEP[item.status] ?? 0;
  const owner = item.owner || "-";
  const submitter = item.submitter || item.owner || "-";
  const decider = item.need_decision_by || "-";
  const steps = [
    { label: "已提交", time: formatIssueDateTime(item.created_at), desc: `提交人：${submitter}`, info: "问题已提交并进入问题库" },
    { label: "已指派", time: formatIssueDateTime(item.updated_at), desc: `责任人：${owner}`, info: "问题已指派给责任人" },
    { label: "处理中", time: formatIssueDateTime(item.updated_at), desc: `负责人：${owner}`, info: item.conclusion ? "已记录处理进展" : "正在定位问题并跟进处理" },
    { label: "已批示", time: formatIssueDateTime(item.closed_at || item.updated_at), desc: `决策人：${decider}`, info: item.conclusion ? item.conclusion.slice(0, 30) + (item.conclusion.length > 30 ? "…" : "") : "等待批示" },
    { label: "待复盘", time: formatIssueDateTime(item.closed_at), desc: "复盘人：待定", info: "待问题关闭后组织复盘" },
  ];
  return `<div class="iss2-track">${steps.map((s, i) => {
    const done = i <= currentStep;
    const active = i === currentStep;
    return `<div class="iss2-track-step ${done ? "done" : ""} ${active ? "active" : ""}">
      <div class="iss2-track-dot"></div>
      <div class="iss2-track-body">
        <div class="iss2-track-headline"><span class="iss2-track-label">${s.label}</span>${s.time ? `<span class="iss2-track-time">${esc(s.time)}</span>` : ""}</div>
        <span class="iss2-track-meta">${esc(s.desc)} · ${esc(s.info)}</span>
      </div>
    </div>`;
  }).join("")}</div>`;
}

function issueReviewRow(item) {
  return `<tr>
    <td style="white-space:nowrap">${esc(item.id)}</td>
    <td class="iss2-col-desc"><span class="iss2-desc-text">${esc(item.description)}</span></td>
    <td>${esc(item.special_project || "-")}</td>
    <td>${esc(item.issue_type || item.type)}</td>
    <td>${esc(item.closed_at ? formatWaitText(item.closed_at) : "-")}</td>
    <td style="max-width:240px;white-space:normal">${esc(item.conclusion)}</td>
    <td>${esc(item.owner || "-")}</td>
  </tr>`;
}

function filterIssueRows(rows, tab, filters) {
  return rows.filter(row => {
    if (tab === "problem" && row.section === "decision") return false;
    if (tab === "decision" && row.section !== "decision") return false;
    if (tab === "closed" && !["已关闭", "已决策", "已解决"].includes(row.status)) return false;
    if (filters.priority && row.priority !== filters.priority) return false;
    if (filters.project && row.special_project !== filters.project) return false;
    if (filters.owner && ![row.owner, row.collaborator, row.submitter].some(v => String(v || "").includes(filters.owner))) return false;
    if (filters.issue_type && row.issue_type !== filters.issue_type) return false;
    if (filters.status && row.status !== filters.status) return false;
    return true;
  });
}

function sanitizeIssueFilters(filters, projects = [], owners = [], types = []) {
  const clean = { priority: "", project: "", owner: "", status: "", issue_type: "", ...(filters || {}) };
  const validPriorities = new Set(["高", "中", "低"]);
  const validProjects = new Set(projects.filter(Boolean));
  const validOwners = new Set(owners.filter(Boolean));
  const validTypes = new Set(types.filter(Boolean));
  const validStatuses = new Set(["待处理","处理中","待决策","已解决","已关闭","已决策"]);
  if (clean.priority && !validPriorities.has(clean.priority)) clean.priority = "";
  if (clean.project && !validProjects.has(clean.project)) clean.project = "";
  if (clean.owner && !validOwners.has(clean.owner)) clean.owner = "";
  if (clean.issue_type && !validTypes.has(clean.issue_type)) clean.issue_type = "";
  if (clean.status && !validStatuses.has(clean.status)) clean.status = "";
  return clean;
}

function issueRecordCard(item) {
  const closed = ["已关闭", "已决策", "已解决"].includes(item.status);
  const decision = item.section === "decision";
  const actionLabel = closed ? "查看" : "处理";
  return `<article class="issue-record ${decision ? "decision" : ""} ${closed ? "closed" : ""}">
    <div class="issue-record-main">
      <span class="issue-code">${esc(item.id)}</span>
      <div>
        <h4>${esc(item.description)}</h4>
        <div class="issue-meta-line">
          <span>责任人：${esc(item.owner || "-")}</span>
          ${item.collaborator ? `<span>协同：${esc(item.collaborator)}</span>` : ""}
          <span>${esc(item.special_project || "-")}</span>
          <span>${closed ? "关闭于" : decision ? "期望决策" : "预计解决"}：${esc(item.expected || "-")}</span>
        </div>
      </div>
    </div>
    <div class="issue-record-side">
      <div class="issue-tags">
        <span class="issue-tag ${decision ? "decision" : item.type === "风险" ? "risk" : "block"}">${esc(item.type)}</span>
        <span class="issue-tag priority-${item.priority === "高" ? "high" : "mid"}">${esc(item.priority)}</span>
        <span class="issue-tag status">${esc(item.status)}</span>
      </div>
      <button class="issue-action-btn" onclick="openIssueDetail(${item.rawId ?? null}, '${esc(item.id).replace(/'/g, "\\'")}')">${actionLabel}</button>
    </div>
    ${item.conclusion ? `<div class="issue-conclusion"><strong>${decision ? "决策结论" : "复盘结论"}</strong><p>${esc(item.conclusion)}</p></div>` : ""}
  </article>`;
}

async function openIssueDetail(issueId, fallbackCode = "") {
  if (!issueId) {
    return toast(`示例记录 ${fallbackCode || ""} 仅用于展示，请处理真实台账数据。`);
  }
  const row = normalizeIssueRecord(await api(`/api/issues/${issueId}`));
  const decision = row.section === "decision";
  const canEdit = canWriteProject(row.special_project);
  const actionTitle = decision ? "决策项处理" : "问题处理";
  openModal(`
    <div class="issue-detail-drawer">
      <div class="issue-detail-head">
        <div>
          <span class="issue-code">${esc(row.id)}</span>
          <h3>${esc(actionTitle)}</h3>
          <p>${esc(row.type)} · ${esc(row.special_project || "未归属专项")}</p>
        </div>
      </div>
      <form id="issueDetailForm" class="issue-detail-form" data-id="${issueId}">
        <div class="issue-detail-grid">
          <label class="wide"><span>问题描述</span><textarea name="description" rows="4" readonly>${esc(row.description || "")}</textarea></label>
          <label><span>所属专项</span><input name="special_project" value="${esc(row.special_project || "")}" readonly></label>
          <label><span>责任人</span><input name="owner" value="${esc(row.owner || "")}" readonly></label>
          <label><span>优先级</span><select name="priority" ${canEdit ? "" : "disabled"}>${optionList(["高", "中", "低"], row.priority)}</select></label>
          <label><span>当前状态</span><select name="status" ${canEdit ? "" : "disabled"}>${optionList(["待处理", "处理中", "待决策", "已关闭", "已决策"], row.status)}</select></label>
          <label><span>${decision ? "期望决策时间" : "预计解决时间"}</span><input name="expected_resolution_time" value="${esc(row.expected_resolution_time || "")}" placeholder="${decision ? "如：5月28日前" : "如：6月5日"}" ${canEdit ? "" : "readonly"}></label>
          <label class="wide"><span>${decision ? "决策结论" : "处理结论"}</span><textarea name="resolution" rows="6" placeholder="${decision ? "填写最终决策及执行要求" : "填写处理过程、结论和后续安排"}" ${canEdit ? "" : "readonly"}>${esc(row.resolution || "")}</textarea></label>
        </div>
        <div class="issue-detail-actions">
          <button type="button" onclick="closeModal()">取消</button>
          ${canEdit ? `<button type="button" class="danger-outline" onclick="deleteIssue(${issueId})">删除</button>` : ""}
          ${canEdit ? `<button type="button" class="success" onclick="saveIssueDetail(${issueId})">保存</button>` : ""}
        </div>
      </form>
      ${canEdit ? "" : `<p class="input-hint">当前身份可查看该记录，但不能修改该专项的问题与决策。</p>`}
    </div>`);
}

async function saveIssueDetail(issueId) {
  const form = document.getElementById("issueDetailForm");
  if (!form) return;
  const values = readForm(form);
  const row = await api(`/api/issues/${issueId}`);
  const nextStatus = values.status || row.status || "待处理";
  const payload = {
    issue_type: row.issue_type || (row.need_decision_by ? "决策" : "问题"),
    description: row.description || "",
    owner: row.owner || "",
    helper: row.helper || "",
    priority: values.priority || row.priority || "中",
    status: nextStatus,
    need_decision_by: row.need_decision_by || "",
    expected_resolve_time: values.expected_resolution_time || "",
    resolution: values.resolution || "",
    related_task_id: row.related_task_id || null,
    special_project: row.special_project || "",
    source_type: row.source_type || "人工录入",
  };
  await api(`/api/issues/${issueId}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
  closeModal();
  invalidate("issues");
  toast("问题/决策已保存，台账已更新。");
  if (["已关闭", "已决策", "已解决"].includes(nextStatus)) {
    state.issueTab = "closed";
  }
  await renderIssues();
}

async function deleteIssue(issueId) {
  if (!confirm(`确认删除该问题/决策项？此操作不可恢复。`)) return;
  try {
    await api(`/api/issues/${issueId}`, { method: "DELETE" });
    invalidate("issues");
    closeModal();
    toast("已删除");
    renderIssues();
  } catch (err) {
    toast(`删除失败：${err.message || "请重试"}`);
  }
}

function mockIssueRows() {
  return [
    { id: "#P-01", section: "problem", type: "风险", description: "敏感数据提供偏慢，需冯海林协调数据权限", owner: "温会林", collaborator: "冯海林", special_project: "顾问作业AI化", priority: "高", status: "处理中", expected: "5月30日" },
    { id: "#P-02", section: "problem", type: "卡点", description: "顾问参与度不足，场景梳理进度受阻", owner: "刘万超", collaborator: "许明良", special_project: "顾问作业AI化", priority: "高", status: "待处理", expected: "6月5日" },
    { id: "#P-03", section: "problem", type: "风险", description: "技术平台选型延迟，影响后续开发节奏", owner: "郭熠彬", collaborator: "吴肖", special_project: "技术底座与平台预研", priority: "中", status: "待决策", expected: "6月10日" },
    { id: "#P-04", section: "problem", type: "卡点", description: "知识库分类标准不统一，导致入库混乱", owner: "杨宇帆", special_project: "知识资产AI化", priority: "中", status: "已关闭", expected: "5月12日", conclusion: "制定统一的知识分类规范文档，所有入库内容必须先对照规范再提交，由杨宇帆负责审核。" },
    { id: "#D-01", section: "decision", type: "决策", description: "知识库平台工具选型确认（自建 vs 采购）", submitter: "刘万超", special_project: "知识资产AI化", priority: "高", status: "待决策", expected: "5月28日前" },
    { id: "#D-02", section: "decision", type: "决策", description: "训练营方案是否对外推广，预算如何分配", submitter: "邹奇敏", special_project: "咨询服务产品化", priority: "中", status: "待决策", expected: "等待 2 天" },
    { id: "#D-03", section: "decision", type: "决策", description: "Q2 阶段验收标准与时间节点确认", submitter: "袁金玉", special_project: "项目统筹与复盘", priority: "中", status: "已决策", expected: "5月15日", conclusion: "Q2验收定于6月20日，验收标准以五个专项各出一份成果报告为准，冯海林主持评审。" },
  ];
}

window.renderIssues = renderIssues;
window.setIssueTab = setIssueTab;
window.setIssueFilter = setIssueFilter;
window.setIssuePage = setIssuePage;
window.setIssueProject = setIssueProject;
window.clearIssueProject = clearIssueProject;
window.createIssueDraft = createIssueDraft;
window.submitNewIssue = submitNewIssue;
window.openIssueDetail = openIssueDetail;
window.saveIssueDetail = saveIssueDetail;
window.deleteIssue = deleteIssue;
