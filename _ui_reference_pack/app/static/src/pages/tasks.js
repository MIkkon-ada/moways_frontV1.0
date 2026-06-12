// 工作推进表页面函数
// 依赖：esc, badge, field, textField, selectField, readForm, optionList, openModal, closeModal (components.js)
// 依赖：TASK_STATUS, PROJECTS (components.js / appState.js)
// 依赖：state, _cache (appState.js)
// 依赖：fetchCached, invalidate, api (api/)
// 依赖：getCurrentUserContext, getCurrentUserName, splitPeople, currentUserProjectRelation, rowRelationLabel (permissions/userContext.js)
// 依赖：canWriteProject (permissions/permissions.js)
// 依赖：statusTagClass, statusClass, statusMatches, truncate, linkifyTaskLinks (utils/format.js)
// 依赖：projectBarColor, planTimeRank, isNewTask, ceoPerson (utils/project.js)
// 依赖：normalizeProject (components.js)
// 依赖：switchPage, loadPage, renderIssues (app.js)

function _normTask(t) {
  let s = t.status === "风险" ? "延期" : t.status === "推进中" ? "进行中" : t.status === "未开始" ? "未启动" : t.status;
  return { ...t, special_project: normalizeProject(t.special_project), status: s };
}

function taskIssueTag(text) {
  const value = String(text || "").trim();
  if (!value) return { label: "无", cls: "bg-gray-100 text-gray-500 border-gray-200" };
  if (/延期|超期|逾期|滞后|滞延|未按期|拖延/.test(value)) return { label: "延期", cls: "bg-red-50 text-red-600 border-red-200" };
  if (/决策|审批|拍板|选型|方案|预算|定夺/.test(value)) return { label: "需决策", cls: "bg-orange-50 text-orange-600 border-orange-200" };
  if (/协调|配合|支持|对接|权限|资源|申请|参与/.test(value)) return { label: "需协调", cls: "bg-blue-50 text-blue-600 border-blue-200" };
  if (/风险|问题|异常|障碍|不足|缺少|不稳|卡点/.test(value)) return { label: "风险", cls: "bg-rose-50 text-rose-600 border-rose-200" };
  return { label: "无", cls: "bg-gray-100 text-gray-500 border-gray-200" };
}

function taskIssueBlock(text) {
  const value = String(text || "").trim();
  if (!value) return `<span class="text-gray-300">-</span>`;
  const tag = taskIssueTag(value);
  return `<div class="task-issue-block flex flex-col gap-1.5 min-w-0">
    <span class="task-issue-tag inline-flex items-center w-fit px-2 py-0.5 rounded-full border text-[11px] font-semibold ${tag.cls}">${esc(tag.label)}</span>
    <div class="task-issue-text whitespace-pre-wrap break-words leading-relaxed text-gray-700" title="${esc(value)}">${esc(value)}</div>
  </div>`;
}

async function renderTasks() {
  document.getElementById("tasks").innerHTML = `<div class="page-loading">加载中…</div>`;
  let rawRows;
  try {
    rawRows = await fetchCached("tasks", "/api/tasks");
  } catch (err) {
    document.getElementById("tasks").innerHTML = `<div class="page-error"><strong>工作推进表加载失败</strong><p>${esc(err.message || "网络错误")}</p><button onclick="loadPage('tasks')">重试</button></div>`;
    return;
  }
  const allRows = rawRows.map(_normTask);
  if (!state.taskPage) state.taskPage = 1;
  if (!state.taskPageSize) state.taskPageSize = 20;
  if (state.taskSearch === undefined) state.taskSearch = "";
  if (!state.taskSelected) state.taskSelected = new Set();
  const filters = state.taskFilters || {};
  const owners = [...new Set(allRows.flatMap(t => splitPeople(t.owner || "")).filter(Boolean))].sort();
  const months = [...new Set(allRows.map(t => t.plan_time).filter(Boolean))].sort();
  const ctx = getCurrentUserContext();
  const visibleProjects = ctx.canViewAll ? PROJECTS : PROJECTS.filter(p => ctx.visibleProjects.includes(p));
  const allStats = taskStatusStats(allRows);
  const filtered = filterTaskRows(allRows, filters);
  const searched = state.taskSearch
    ? filtered.filter(t => [t.key_task, t.key_achievement, t.owner, t.coordinator, t.special_project, t.completion_standard].some(v => v && String(v).includes(state.taskSearch)))
    : filtered;
  const STATUS_ORDER = { "进行中": 0, "延期": 1, "未启动": 2, "暂缓": 3, "已完成": 4 };
  const sorted = [...searched].sort((a, b) => {
    const sa = STATUS_ORDER[a.status] ?? 2, sb = STATUS_ORDER[b.status] ?? 2;
    if (sa !== sb) return sa - sb;
    const ua = Date.parse(a.updated_at || a.created_at || 0), ub = Date.parse(b.updated_at || b.created_at || 0);
    if (ub !== ua) return ub - ua;
    return planTimeRank(a.plan_time) - planTimeRank(b.plan_time);
  });
  const total = sorted.length;
  const pageSize = state.taskPageSize;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, state.taskPage), pageCount);
  state.taskPage = page;
  const pageRows = sorted.slice((page - 1) * pageSize, page * pageSize);
  const selSize = state.taskSelected.size;
  const canCreate = ctx.canMaintainAll || ctx.ownedProjects.length > 0;
  document.getElementById("tasks").innerHTML = `
    <div class="flex items-start justify-between mb-6">
      <div>
        <h3 class="text-xl font-bold text-gray-900 mb-1">工作推进表</h3>
        <p class="text-sm text-gray-500">以任务为主数据，承接专项推进、成果关联与问题跟踪</p>
      </div>
      <div class="flex gap-2 flex-shrink-0">
        ${canCreate ? `<button class="bg-blue-600 text-white text-sm font-semibold px-5 py-2.5 rounded-lg border-0 cursor-pointer hover:bg-blue-700 shadow-sm flex items-center gap-1.5" onclick="openNewTaskModal()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> 新增任务</button>` : ""}
        <button class="bg-blue-600 text-white text-sm font-semibold px-5 py-2.5 rounded-lg border-0 cursor-pointer hover:bg-blue-700 shadow-sm flex items-center gap-1.5" onclick="exportTasksCSV()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg> 导出表格</button>
      </div>
    </div>
    <div class="flex gap-3 mb-4">
      ${twStatCard("未启动", allStats.notStarted, "notstarted")}
      ${twStatCard("进行中", allStats.doing, "doing")}
      ${twStatCard("已完成", allStats.done, "done")}
      ${twStatCard("延期", allStats.delayed, "delayed")}
      ${twStatCard("暂缓", allStats.paused, "paused")}
    </div>
    <div class="flex items-center gap-2 mb-3 flex-wrap">
      <label class="inline-flex items-center gap-2 border border-gray-300 rounded-lg px-3 py-2 bg-white cursor-pointer hover:border-blue-400 transition-colors">
        <span class="text-sm text-gray-400 whitespace-nowrap flex-shrink-0">专项筛选</span>
        <select class="text-sm font-medium text-gray-800 border-0 p-0 bg-transparent outline-none cursor-pointer max-w-[120px]" onchange="setTaskProject(this.value)">
          <option value="">全部专项</option>
          ${visibleProjects.map(p => `<option value="${esc(p)}" ${filters.project === p ? "selected" : ""}>${esc(p)}</option>`).join("")}
        </select>
      </label>
      <label class="inline-flex items-center gap-2 border border-gray-300 rounded-lg px-3 py-2 bg-white cursor-pointer hover:border-blue-400 transition-colors">
        <span class="text-sm text-gray-400 whitespace-nowrap flex-shrink-0">负责人</span>
        <select class="text-sm font-medium text-gray-800 border-0 p-0 bg-transparent outline-none cursor-pointer max-w-[100px]" onchange="setTaskFilter('owner', this.value)">
          <option value="">全部负责人</option>${optionList(owners, filters.owner)}
        </select>
      </label>
      <label class="inline-flex items-center gap-2 border border-gray-300 rounded-lg px-3 py-2 bg-white cursor-pointer hover:border-blue-400 transition-colors">
        <span class="text-sm text-gray-400 whitespace-nowrap flex-shrink-0">当前状态</span>
        <select class="text-sm font-medium text-gray-800 border-0 p-0 bg-transparent outline-none cursor-pointer max-w-[90px]" onchange="setTaskFilter('status', this.value)">
          <option value="">全部状态</option>${optionList(["未启动", "进行中", "已完成", "延期", "暂缓"], filters.status)}
        </select>
      </label>
      <label class="inline-flex items-center gap-2 border border-gray-300 rounded-lg px-3 py-2 bg-white cursor-pointer hover:border-blue-400 transition-colors">
        <span class="text-sm text-gray-400 whitespace-nowrap flex-shrink-0">计划时间</span>
        <select class="text-sm font-medium text-gray-800 border-0 p-0 bg-transparent outline-none cursor-pointer max-w-[90px]" onchange="setTaskFilter('month', this.value)">
          <option value="">全部时间</option>${optionList(months, filters.month)}
        </select>
      </label>
      <div class="flex-1 min-w-[200px] border border-gray-300 rounded-lg flex items-center gap-2 px-3 py-2 bg-white hover:border-blue-400 transition-colors">
        <svg class="text-gray-400 flex-shrink-0" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input class="flex-1 text-sm text-gray-700 border-0 outline-none bg-transparent placeholder-gray-400" type="text" placeholder="搜索关键任务、成果或负责人" value="${esc(state.taskSearch || "")}" oninput="setTaskSearch(this.value)">
      </div>
    </div>
    <div class="flex items-center gap-3 bg-blue-50 border border-blue-200 rounded-lg px-4 py-2.5 mb-2 text-sm${selSize > 0 ? "" : " hidden"}" id="taskBulkBar">
      <span class="text-gray-700">已选择 <strong>${selSize}</strong> 项</span>
      <button class="text-blue-600 text-xs hover:underline border-0 bg-transparent cursor-pointer px-0" onclick="clearTaskSelection()">清除选择</button>
      <div class="flex-1"></div>
      <div class="relative">
        <button class="border border-gray-300 bg-white text-gray-700 text-xs px-3 py-1.5 rounded cursor-pointer" onclick="toggleBulkStatusMenu(event)">批量更新状态 ▾</button>
        <div class="absolute top-full left-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg z-10 min-w-[120px] hidden" id="bulkStatusMenu">
          ${["未启动", "进行中", "已完成", "延期", "暂缓"].map(s => `<button class="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 border-0 bg-transparent cursor-pointer" onclick="bulkUpdateTaskStatus('${s}')">${esc(s)}</button>`).join("")}
        </div>
      </div>
      <button class="border border-gray-300 bg-white text-gray-700 text-xs px-3 py-1.5 rounded cursor-pointer" onclick="bulkAssignOwner()">指派负责人</button>
      <button class="border border-gray-300 bg-white text-gray-700 text-xs px-3 py-1.5 rounded cursor-pointer" onclick="bulkExtendDeadline()">批量延期</button>
      <button class="border border-gray-300 bg-white text-gray-700 text-xs px-3 py-1.5 rounded cursor-pointer" onclick="refreshTasks()">↺ 刷新</button>
    </div>
    <div class="border border-gray-200 rounded-xl overflow-hidden mb-4 shadow-sm">
      <table class="w-full text-sm border-collapse">
        <colgroup><col style="width:32px"><col style="width:100px"><col style="width:200px"><col style="width:130px"><col style="width:130px"><col style="width:76px"><col style="width:76px"><col style="width:84px"><col style="width:96px"><col style="width:84px"><col><col style="width:72px"></colgroup>
        <thead class="bg-gray-50 border-b border-gray-200">
          <tr>
            <th class="py-3 px-2 text-center font-medium text-gray-500 text-xs"><input type="checkbox" id="twSelectAll" onchange="selectAllTasks(this.checked)" ${selSize > 0 && selSize === pageRows.length ? "checked" : ""}></th>
            <th class="py-3 px-3 text-left font-semibold text-gray-500 text-xs">专项</th>
            <th class="py-3 px-3 text-left font-semibold text-gray-500 text-xs">关键任务</th>
            <th class="py-3 px-3 text-left font-semibold text-gray-500 text-xs">关键成果</th>
            <th class="py-3 px-3 text-left font-semibold text-gray-500 text-xs">完成标准</th>
            <th class="py-3 px-3 text-left font-semibold text-gray-500 text-xs">统筹人</th>
            <th class="py-3 px-3 text-left font-semibold text-gray-500 text-xs">负责人</th>
            <th class="py-3 px-3 text-left font-semibold text-gray-500 text-xs">协同成员</th>
            <th class="py-3 px-3 text-left font-semibold text-gray-500 text-xs">计划时间</th>
            <th class="py-3 px-3 text-left font-semibold text-gray-500 text-xs">完成时间</th>
            <th class="py-3 px-3 text-left font-semibold text-gray-500 text-xs">当前状态</th>
            <th class="py-3 px-3 text-left font-semibold text-gray-500 text-xs">问题与需协调事项</th>
            <th class="py-3 px-3 text-left font-semibold text-gray-500 text-xs">操作</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-gray-100">${pageRows.length ? pageRows.map(taskTableRow).join("") : `<tr><td colspan="12" class="py-12 text-center text-gray-400 text-sm">暂无匹配任务</td></tr>`}</tbody>
      </table>
    </div>
    <div class="flex items-center gap-3 text-sm text-gray-500 py-2">
      <span>共 ${total} 条</span>
      <select class="border border-gray-200 rounded px-2 py-1 text-sm text-gray-600 bg-white" onchange="setTaskPageSize(Number(this.value))">
        ${[10, 20, 50].map(n => `<option value="${n}" ${pageSize === n ? "selected" : ""}>${n}条/页</option>`).join("")}
      </select>
      <div class="flex items-center gap-1">
        <button class="w-7 h-7 flex items-center justify-center rounded border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-40" onclick="setTaskPage(${page - 1})" ${page <= 1 ? "disabled" : ""}>‹</button>
        ${twPageButtons(page, pageCount)}
        <button class="w-7 h-7 flex items-center justify-center rounded border border-gray-200 text-gray-500 hover:bg-gray-50 disabled:opacity-40" onclick="setTaskPage(${page + 1})" ${page >= pageCount ? "disabled" : ""}>›</button>
      </div>
      <span class="ml-auto flex items-center gap-1.5">前往 <input class="border border-gray-200 rounded w-12 px-2 py-1 text-sm text-center" type="number" min="1" max="${pageCount}" value="${page}" onchange="setTaskPage(Number(this.value))"> 页</span>
    </div>`;
  ensureTaskDrawer();
}

function taskTableRow(t) {
  const delayed = t.status === "延期";
  const selected = state.taskSelected && state.taskSelected.has(t.id);
  const shortProject = (t.special_project || "").replace("与平台预研", "").replace("AI化", "");
  const rowBg = selected ? "bg-blue-50" : delayed ? "bg-red-50" : "bg-white hover:bg-gray-50";
  return `<tr class="${rowBg} transition-colors" data-task-id="${t.id}">
    <td class="py-4 px-2 text-center"><input type="checkbox" ${selected ? "checked" : ""} onchange="toggleTaskSelect(${t.id}, this.checked)"></td>
    <td class="py-4 px-3">
      <div class="flex items-center gap-1.5">
        <span class="w-2 h-2 rounded-full flex-shrink-0" style="background:${projectBarColor(t.special_project)}"></span>
        <span class="text-sm text-gray-700 truncate" title="${esc(t.special_project || "")}">${esc(shortProject || "-")}</span>
      </div>
    </td>
    <td class="py-4 px-3">
      <div class="flex items-center gap-1 flex-wrap">
        <span class="text-sm text-gray-800" title="${esc(t.key_task)}">${esc(t.key_task)}</span>
        ${isNewTask(t) ? `<span class="new-tag">新</span>` : ""}
      </div>
    </td>
    <td class="py-4 px-3 text-sm text-gray-600 truncate max-w-[120px]" title="${esc(t.key_achievement || "")}">${esc(truncate(t.key_achievement, 18) || "-")}</td>
    <td class="py-4 px-3 text-sm text-gray-600 truncate max-w-[120px]" title="${esc(t.completion_standard || "")}">${esc(truncate(t.completion_standard, 18) || "-")}</td>
    <td class="py-4 px-3 text-sm text-gray-700">${esc(t.coordinator || "-")}</td>
    <td class="py-4 px-3 text-sm text-gray-700">${esc(t.owner || "-")}</td>
    <td class="py-4 px-3 text-sm text-gray-600 truncate max-w-[78px]" title="${esc(t.collaborators || "")}">${esc(truncate(t.collaborators, 10) || "-")}</td>
    <td class="py-4 px-3 text-sm whitespace-nowrap${delayed ? " text-red-600 font-semibold" : " text-gray-600"}">${esc(t.plan_time || "-")}${delayed ? `<br><span class="text-red-500 text-xs">已超期</span>` : ""}</td>
    <td class="py-4 px-3 text-sm whitespace-nowrap text-gray-500">${t.confirmed_at ? formatWaitText(t.confirmed_at) : "-"}</td>
    <td class="py-4 px-3">${badge(t.status || "未启动")}</td>
    <td class="py-4 px-3 align-top">${taskIssueBlock(t.problem_note || "")}</td>
    <td class="py-4 px-3 whitespace-nowrap">
      <button class="text-blue-600 text-sm hover:underline border-0 bg-transparent cursor-pointer px-0 mr-1.5" onclick="openTaskDrawer(${t.id})">查看</button>
      ${canWriteProject(t.special_project) ? `<button class="text-gray-400 text-lg border-0 bg-transparent cursor-pointer px-0 leading-none" onclick="openTaskEdit(event,${t.id})">…</button>` : ""}
    </td>
  </tr>`;
}

function twStatCard(label, count, type) {
  const cfg = {
    notstarted: { bg: "bg-gray-50 border-gray-200", icon: "text-gray-400", iconBg: "bg-gray-100", num: "text-gray-800" },
    doing:      { bg: "bg-blue-50 border-blue-200", icon: "text-blue-500", iconBg: "bg-blue-100", num: "text-blue-700" },
    done:       { bg: "bg-green-50 border-green-200", icon: "text-green-500", iconBg: "bg-green-100", num: "text-green-700" },
    delayed:    { bg: "bg-red-50 border-red-200", icon: "text-red-500", iconBg: "bg-red-100", num: "text-red-700" },
    paused:     { bg: "bg-amber-50 border-amber-200", icon: "text-amber-500", iconBg: "bg-amber-100", num: "text-amber-700" },
  };
  const c = cfg[type] || cfg.notstarted;
  const svgs = {
    notstarted: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="6 3 20 12 6 21 6 3" fill="currentColor" stroke="none"/></svg>`,
    doing:      `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="6 3 20 12 6 21 6 3" fill="currentColor" stroke="none"/></svg>`,
    done:       `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
    delayed:    `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
    paused:     `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="8" y1="5" x2="8" y2="19"/><line x1="16" y1="5" x2="16" y2="19"/></svg>`,
  };
  return `<div class="flex-1 flex items-center gap-5 bg-white border border-gray-200 rounded-xl px-5 py-4 min-w-0 shadow-sm">
    <div class="w-14 h-14 rounded-full ${c.iconBg} ${c.icon} flex items-center justify-center flex-shrink-0">${svgs[type] || ""}</div>
    <div class="flex flex-col min-w-0">
      <span class="text-sm text-gray-500 mb-1">${esc(label)}</span>
      <strong class="text-4xl font-bold ${c.num} leading-none">${count}</strong>
    </div>
  </div>`;
}

function twPageButtons(page, total) {
  const btn = (p) => `<button class="w-7 h-7 flex items-center justify-center rounded text-sm cursor-pointer border ${p === page ? "bg-blue-600 text-white border-blue-600" : "border-gray-200 text-gray-600 hover:bg-gray-50 bg-white"}" onclick="setTaskPage(${p})">${p}</button>`;
  if (total <= 7) return Array.from({length: total}, (_, i) => btn(i+1)).join("");
  const pages = [1];
  if (page > 3) pages.push("…");
  for (let i = Math.max(2, page-1); i <= Math.min(total-1, page+1); i++) pages.push(i);
  if (page < total-2) pages.push("…");
  pages.push(total);
  return pages.map(p => p === "…" ? `<span class="px-1 text-gray-400 text-sm">…</span>` : btn(p)).join("");
}

function setTaskPage(n) {
  const allRows = (_cache["tasks"] || []).map(_normTask);
  const filtered = filterTaskRows(allRows, state.taskFilters || {});
  const searched = state.taskSearch ? filtered.filter(t => [t.key_task, t.key_achievement, t.owner, t.coordinator].some(v => v && String(v).includes(state.taskSearch))) : filtered;
  const pageCount = Math.max(1, Math.ceil(searched.length / (state.taskPageSize || 20)));
  state.taskPage = Math.min(Math.max(1, n), pageCount);
  renderTasks();
}

function setTaskPageSize(n) { state.taskPageSize = n; state.taskPage = 1; renderTasks(); }
function setTaskSearch(v) { state.taskSearch = v; state.taskPage = 1; renderTasks(); }

function toggleTaskSelect(taskId, checked) {
  if (!state.taskSelected) state.taskSelected = new Set();
  if (checked) state.taskSelected.add(taskId); else state.taskSelected.delete(taskId);
  updateBulkBar();
}

function selectAllTasks(checked) {
  if (!state.taskSelected) state.taskSelected = new Set();
  document.querySelectorAll("tr[data-task-id]").forEach(row => {
    const id = Number(row.dataset.taskId);
    if (!id) return;
    if (checked) state.taskSelected.add(id); else state.taskSelected.delete(id);
    const cb = row.querySelector("input[type=checkbox]");
    if (cb) cb.checked = checked;
  });
  updateBulkBar();
}

function clearTaskSelection() { state.taskSelected = new Set(); renderTasks(); }

function updateBulkBar() {
  const bar = document.getElementById("taskBulkBar");
  if (!bar) return;
  const size = state.taskSelected ? state.taskSelected.size : 0;
  bar.classList.toggle("hidden", size === 0);
  const el = bar.querySelector("strong");
  if (el) el.textContent = size;
}

function toggleBulkStatusMenu(e) {
  e.stopPropagation();
  document.getElementById("bulkStatusMenu")?.classList.toggle("hidden");
}
document.addEventListener("click", () => document.getElementById("bulkStatusMenu")?.classList.add("hidden"));

async function bulkUpdateTaskStatus(status) {
  document.getElementById("bulkStatusMenu")?.classList.add("hidden");
  if (!state.taskSelected?.size) return toast("请先选择任务");
  const ids = [...state.taskSelected];
  const tasks = (_cache["tasks"] || []).map(_normTask);
  try {
    for (const id of ids) {
      const t = tasks.find(r => r.id === id);
      if (!t || !canWriteProject(t.special_project)) continue;
      await api(`/api/tasks/${id}`, { method: "PUT", body: JSON.stringify({ ...t, status }) });
    }
    invalidate("tasks"); state.taskSelected = new Set();
    toast(`已将 ${ids.length} 条任务状态更新为"${status}"`);
    renderTasks();
  } catch (err) { toast(`批量更新失败：${err.message || "请重试"}`); }
}

function bulkAssignOwner() {
  if (!state.taskSelected?.size) return toast("请先选择任务");
  openModal(`<div class="simple-modal"><h3>指派负责人</h3><form id="assignOwnerForm">
    ${field("新负责人", "owner", "")}
    <div class="modal-actions"><button type="button" onclick="closeModal()">取消</button><button type="button" class="success" onclick="doAssignOwner()">确认</button></div>
  </form></div>`);
}

async function doAssignOwner() {
  const v = readForm(document.getElementById("assignOwnerForm"));
  if (!v.owner?.trim()) return toast("请输入负责人姓名");
  const ids = [...(state.taskSelected || [])];
  const tasks = (_cache["tasks"] || []).map(_normTask);
  try {
    for (const id of ids) {
      const t = tasks.find(r => r.id === id);
      if (!t || !canWriteProject(t.special_project)) continue;
      await api(`/api/tasks/${id}`, { method: "PUT", body: JSON.stringify({ ...t, owner: v.owner }) });
    }
    invalidate("tasks"); state.taskSelected = new Set(); closeModal();
    toast(`已为 ${ids.length} 条任务指派负责人`); renderTasks();
  } catch (err) { toast(`指派失败：${err.message || "请重试"}`); }
}

function bulkExtendDeadline() {
  if (!state.taskSelected?.size) return toast("请先选择任务");
  openModal(`<div class="simple-modal"><h3>批量延期</h3><form id="extendForm">
    <label><span>新计划时间</span><input name="plan_time" type="month"></label>
    <div class="modal-actions"><button type="button" onclick="closeModal()">取消</button><button type="button" class="success" onclick="doExtendDeadline()">确认</button></div>
  </form></div>`);
}

async function doExtendDeadline() {
  const v = readForm(document.getElementById("extendForm"));
  if (!v.plan_time) return toast("请选择新的计划时间");
  const ids = [...(state.taskSelected || [])];
  const tasks = (_cache["tasks"] || []).map(_normTask);
  try {
    for (const id of ids) {
      const t = tasks.find(r => r.id === id);
      if (!t || !canWriteProject(t.special_project)) continue;
      await api(`/api/tasks/${id}`, { method: "PUT", body: JSON.stringify({ ...t, plan_time: v.plan_time, status: "延期" }) });
    }
    invalidate("tasks"); state.taskSelected = new Set(); closeModal();
    toast(`已为 ${ids.length} 条任务更新计划时间`); renderTasks();
  } catch (err) { toast(`延期失败：${err.message || "请重试"}`); }
}

async function refreshTasks() { invalidate("tasks"); await renderTasks(); toast("已刷新"); }

function openNewTaskModal() {
  const ctx = getCurrentUserContext();
  const myProj = ctx.canMaintainAll ? PROJECTS : PROJECTS.filter(p => ctx.ownedProjects.includes(p));
  if (!myProj.length) return toast("没有可写入的专项");
  openModal(`<div class="simple-modal wide-modal">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px;">
      <div style="min-width:0;">
        <h3 style="margin:0 0 8px;font-size:16px;font-weight:700;color:#0f172a;">新增任务</h3>
        <p class="muted-text">补充项目推进所需的关键任务、成果、标准与协同信息。</p>
      </div>
      <button type="button" class="task-modal-close" onclick="closeModal()" aria-label="关闭" style="width:36px;height:36px;border:0;background:transparent;color:#94a3b8;font-size:22px;line-height:1;cursor:pointer;border-radius:10px;flex:0 0 auto;">×</button>
    </div>
    <form id="newTaskForm">
      ${selectField("所属专项", "special_project", myProj, myProj[0] || "")}
      ${textField("关键任务", "key_task", "", 2)}
      ${field("关键成果", "key_achievement", "")}
      ${textField("完成标准", "completion_standard", "", 3)}
      ${field("统筹人", "coordinator", "")}
      ${field("负责人", "owner", ctx.name || "")}
      ${field("协同成员", "collaborators", "")}
      <label><span>计划时间</span><input name="plan_time" type="month" value="${new Date().toISOString().slice(0, 7)}"></label>
      ${selectField("状态", "status", TASK_STATUS, "进行中")}
      <div class="modal-actions"><button type="button" onclick="closeModal()">取消</button><button type="button" class="success" onclick="submitNewTask()">创建任务</button></div>
    </form>
  </div>`);
}

async function submitNewTask() {


  const v = readForm(document.getElementById("newTaskForm"));
  if (!v.key_task?.trim()) return toast("关键任务不能为空");
  if (!v.special_project) return toast("请选择所属专项");
  try {
    await api("/api/tasks", { method: "POST", body: JSON.stringify({ ...v, source_type: "人工录入" }) });
    invalidate("tasks"); closeModal(); toast("任务已创建"); renderTasks();
  } catch (err) { toast(`创建失败：${err.message || "请重试"}`); }
}

function exportTasksCSV() {
  const rows = (_cache["tasks"] || []).map(_normTask);
  const filtered = filterTaskRows(rows, state.taskFilters || {});
  const headers = ["ID","专项","关键任务","关键成果","完成标准","统筹人","负责人","协同成员","计划时间","当前状态","问题备注"];
  const csv = [headers, ...filtered.map(t => [t.id,t.special_project,t.key_task,t.key_achievement,t.completion_standard,t.coordinator,t.owner,t.collaborators,t.plan_time,t.status,t.problem_note]
    .map(v => `"${String(v||"").replace(/"/g,'""')}"`))].map(r => r.join(",")).join("\r\n");
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob(["﻿"+csv], {type:"text/csv;charset=utf-8"})), download: `工作推进表_${new Date().toISOString().slice(0,10)}.csv` });
  a.click(); URL.revokeObjectURL(a.href);
}

function ensureTaskDrawer() {
  if (document.getElementById("twDrawer")) return;
  const el = document.createElement("div");
  el.id = "twDrawer";
  el.className = "fixed top-0 right-0 h-full w-[440px] bg-white shadow-2xl border-l border-gray-200 z-50 transform translate-x-full transition-transform duration-300 ease-in-out flex flex-col";
  el.innerHTML = `
    <div class="flex items-center justify-between px-6 py-4 border-b border-gray-200 flex-shrink-0">
      <span class="font-semibold text-gray-800 text-base">任务详情</span>
      <button class="text-gray-400 text-2xl leading-none border-0 bg-transparent cursor-pointer hover:text-gray-600 w-8 h-8 flex items-center justify-center rounded hover:bg-gray-100" onclick="closeTaskDrawer()" aria-label="??">?</button>
    </div>
    <div class="flex-1 overflow-y-auto px-6 py-5" id="twDrawerBody"></div>`;
  document.body.appendChild(el);
}

function openTaskDrawer(taskId) {
  state.taskDrawerId = taskId;
  ensureTaskDrawer();
  document.getElementById("twDrawer").classList.remove("translate-x-full");
  fillTaskDrawer(taskId);
}

function closeTaskDrawer() {
  state.taskDrawerId = null;
  document.getElementById("twDrawer")?.classList.add("translate-x-full");
}

async function fillTaskDrawer(taskId) {
  const body = document.getElementById("twDrawerBody");
  if (!body) return;
  body.innerHTML = `<div class="page-loading">加载中…</div>`;
  try {
    const tasks = await fetchCached("tasks", "/api/tasks");
    const raw = tasks.find(r => r.id === taskId);
    if (!raw) { body.innerHTML = `<div class="page-error">任务不存在</div>`; return; }
    const t = _normTask(raw);
    const achievements = await fetchCached("achievements", "/api/achievements");
    const related = achievements.filter(a => a.related_task_id === taskId);
    const canEdit = canWriteProject(t.special_project);
    const sectionTitle = (text) => `<h4 class="text-sm font-semibold text-gray-700 mb-3 pb-2 border-b border-gray-100">${text}</h4>`;
    body.innerHTML = `
      <div class="mb-5">
        ${sectionTitle("基本信息")}
        <div class="flex flex-col gap-0">
          ${[
            ["专项", esc(t.special_project || "-")],
            ["关键任务", `<span class="font-medium text-gray-900">${esc(t.key_task || "-")}</span>`],
            ["负责人", esc(t.owner || "-")],
            ["统筹人", esc(t.coordinator || "-")],
            ["当前状态", badge(t.status || "-")],
            ["计划时间", `<span class="${t.status==="延期"?"text-red-600 font-semibold":""}">${esc(t.plan_time || "-")}${t.status==="延期"?" · 已超期":""}</span>`],
            ["完成标准", `<span class="text-xs leading-relaxed">${esc(t.completion_standard || "-")}</span>`],
          ].map(([label, val]) => `<div class="flex gap-3 py-2 border-b border-gray-50">
            <span class="text-sm text-gray-400 w-16 flex-shrink-0 pt-0.5">${label}</span>
            <span class="text-sm text-gray-800 flex-1">${val}</span>
          </div>`).join("")}
        </div>
        ${canEdit ? `<div class="flex gap-2 mt-4">
          <button class="border border-gray-300 text-gray-700 text-sm px-4 py-1.5 rounded-lg cursor-pointer bg-white hover:bg-gray-50" onclick="openTaskEdit(event,${t.id})">编辑任务</button>
          <button class="border border-gray-300 text-gray-700 text-sm px-4 py-1.5 rounded-lg cursor-pointer bg-white hover:bg-gray-50" onclick="upgradeTaskIssue(event,${t.id})">升级为问题</button>
        </div>` : ""}
      </div>
      ${t.problem_note ? `<div class="mb-5">
        ${sectionTitle("问题与需协调事项")}
        <p class="text-sm text-gray-700 bg-amber-50 border-l-4 border-amber-400 rounded-r-lg px-4 py-3 leading-relaxed">${esc(t.problem_note)}</p>
      </div>` : ""}
      <div id="twDrawerLogs" class="mb-4">
        ${sectionTitle("任务时间线")}
        <div class="text-sm text-gray-400 py-2">加载中…</div>
      </div>
      ${related.length ? `<div class="mb-5">
        ${sectionTitle("关联成果")}
        <div class="flex flex-col gap-1">${related.map(a => `<div class="flex items-center justify-between py-2.5 border-b border-gray-100 last:border-0">
          <div class="flex items-center gap-2 min-w-0">
            <svg class="text-blue-400 flex-shrink-0" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            <span class="text-sm text-blue-600 truncate">${esc(a.name)}</span>
          </div>
          ${badge(a.status || "计划中")}
        </div>`).join("")}</div>
      </div>` : ""}`;
    api(`/api/logs?target_type=task&target_id=${taskId}`).then(logs => {
      const el = document.getElementById("twDrawerLogs");
      if (!el) return;
      const timelineHtml = (Array.isArray(logs) && logs.length)
        ? `<div class="flex flex-col mb-5">${[...logs].reverse().map(twTimelineItem).join("")}</div>`
        : `<p class="text-sm text-gray-400 py-2 mb-5">暂无操作记录</p>`;
      const updateHtml = (Array.isArray(logs) && logs.length)
        ? `<div class="flex flex-col">${logs.slice(0, 5).map(twUpdateItem).join("")}</div>`
        : `<p class="text-sm text-gray-400 py-2">暂无更新记录</p>`;
      el.innerHTML = `${sectionTitle("任务时间线")}${timelineHtml}${sectionTitle("最近更新记录")}${updateHtml}`;
    }).catch(() => {
      const el = document.getElementById("twDrawerLogs");
      if (el) el.innerHTML = `${sectionTitle("任务时间线")}<p class="text-sm text-gray-400 py-2">日志加载失败</p>`;
    });
  } catch (err) { body.innerHTML = `<div class="page-error">加载失败：${esc(err.message || "请重试")}</div>`; }
}

function twTimelineItem(log) {
  const mmdd = (log.created_at || "").slice(5, 10);
  let action = esc(log.action || "操作");
  try {
    const a = JSON.parse(log.after_json || "{}"), b = JSON.parse(log.before_json || "{}");
    if (log.action === "更新任务状态") action = `状态：${esc(b.status||"?")} → ${esc(a.status||"?")}`;
    else if (log.action === "修改任务") { const ch = Object.keys(a).filter(k => _LOG_FIELD_NAMES[k] && String(a[k])!==String(b[k])); if (ch.length) action = `修改：${esc(ch.map(k=>_LOG_FIELD_NAMES[k]).join("、"))}`; }
  } catch(e) {}
  const dotColor = log.action?.includes("完成") ? "bg-green-500" : log.action?.includes("延期") ? "bg-red-400" : "bg-blue-500";
  return `<div class="flex gap-0 group">
    <div class="flex flex-col items-center w-8 flex-shrink-0">
      <div class="w-3 h-3 rounded-full ${dotColor} ring-2 ring-white flex-shrink-0 mt-1 z-10"></div>
      <div class="flex-1 w-0.5 bg-gray-200 mt-0.5 group-last:hidden"></div>
    </div>
    <div class="flex-1 pb-4 min-w-0">
      <div class="flex items-start gap-2">
        <span class="text-xs text-gray-400 font-mono w-10 flex-shrink-0 pt-0.5">${esc(mmdd)}</span>
        <div class="flex flex-col gap-0.5">
          <span class="text-sm text-gray-800 leading-snug">${action}</span>
          <span class="text-xs text-gray-400">${esc(log.operator||"系统")}</span>
        </div>
      </div>
    </div>
  </div>`;
}

function twUpdateItem(log) {
  const dt = (log.created_at || "").slice(0, 16).replace("T", " ");
  let detail = esc(log.action || "");
  try {
    const a = JSON.parse(log.after_json || "{}"), b = JSON.parse(log.before_json || "{}");
    if (log.action === "更新任务状态") detail = `状态：${esc(b.status||"?")} → ${esc(a.status||"?")}`;
    else if (log.action === "修改任务") { const ch = Object.keys(a).filter(k => _LOG_FIELD_NAMES[k] && String(a[k])!==String(b[k])); if (ch.length) detail = `修改：${esc(ch.map(k=>_LOG_FIELD_NAMES[k]).join("、"))}`; }
  } catch(e) {}
  return `<div class="flex items-start gap-3 py-3 border-b border-gray-100 last:border-0">
    <span class="text-xs text-gray-400 font-mono w-[88px] flex-shrink-0 pt-0.5">${esc(dt)}</span>
    <span class="text-sm font-medium text-gray-700 w-14 flex-shrink-0">${esc(log.operator||"系统")}</span>
    <span class="text-sm text-gray-600 flex-1 leading-snug">${detail}</span>
  </div>`;
}

function setTaskProject(project) {
  state.taskFilters = { ...(state.taskFilters || {}), project };
  renderTasks();
}
function clearTaskProject() { setTaskProject(''); }

function setTaskFilter(name, value) {
  state.taskFilters = { ...(state.taskFilters || {}), [name]: value };
  renderTasks();
}

function projectSelectBar(label, projects, selected, handlerName, hint) {
  return `<div class="project-select-bar">
    <label><span>${esc(label)}</span><select onchange="${handlerName}(this.value)">${optionList(projects, selected)}</select></label>
    <p>${esc(hint)}</p>
  </div>`;
}

function taskProjectGroup(project, rows, index = 0) {
  const stats = taskStatusStats(rows);
  const relation = currentUserProjectRelation(project);
  return `<section class="task-project-section project-tone-${index % 5}">
    <div class="task-project-head">
      <div><h3><i></i>${esc(project)}${relation ? ` ${badge(relation)}` : ""}</h3></div>
      <div class="task-status-pills">
        ${stats.done ? `<span class="done">完成 ${stats.done}</span>` : ""}
        ${stats.doing ? `<span class="doing">进行中 ${stats.doing}</span>` : ""}
        ${stats.delayed ? `<span class="delayed">延期 ${stats.delayed}</span>` : ""}
        ${stats.notStarted ? `<span class="neutral">未启动 ${stats.notStarted}</span>` : ""}
        ${stats.paused ? `<span class="neutral">暂缓 ${stats.paused}</span>` : ""}
      </div>
    </div>
    <div class="task-card-list">${rows.map(taskCard).join("")}</div>
  </section>`;
}

function taskCard(t) {
  const ctx = getCurrentUserContext();
  const canEdit = canWriteProject(t.special_project);
  const canDelete = ctx.canMaintainAll;
  const delayed = ["延期", "风险"].includes(t.status);
  const relation = rowRelationLabel(t);
  return `<details class="task-master-card ${delayed ? "delayed" : statusClass(t.status)}" data-task-id="${t.id}" ontoggle="onTaskToggle(event)">
    <summary>
      <div class="task-summary-main">
        <div class="task-title-line"><strong>${esc(t.key_task)}</strong>${relation ? badge(relation) : ""}${isNewTask(t) ? `<span class="new-tag">新增</span>` : ""}</div>
        <div class="task-people-line">
          <span>${esc(t.owner || "-")}</span>
          <span>统筹：${esc(t.coordinator || "-")}</span>
          ${t.collaborators ? `<span>协同：${esc(t.collaborators)}</span>` : ""}
          <span>${esc(t.plan_time || "-")}${delayed ? ` · <b>已超期</b>` : ""}</span>
        </div>
      </div>
      <div class="task-summary-status">${badge(t.status)}<span class="expand-mark">□</span></div>
    </summary>
    <div class="task-detail-grid">
      <section>
        <h4>关键成果</h4>
        <p>${linkifyTaskLinks(t.achievement_links, t.key_achievement || "待确认关键成果")}</p>
      </section>
      <section>
        <h4>完成标准</h4>
        <p>${esc(t.completion_standard || "待负责人补充完成标准")}</p>
      </section>
    </div>
    ${t.problem_note ? `<div class="task-problem-box">
      <div><h4>当前问题与需协调事项</h4><p>${esc(t.problem_note)}</p></div>
      ${canEdit ? `<button onclick="upgradeTaskIssue(event, ${t.id})">升级为问题/决策项</button>` : `<span class="readonly-chip">只读</span>`}
    </div>` : ""}
    ${canEdit ? `<div class="task-card-actions">
      <button onclick="openTaskEdit(event,${t.id})">编辑任务</button>
      ${canDelete ? `<button class="danger-outline" onclick="deleteTask(event,${t.id})">删除</button>` : ""}
    </div>` : ""}
    <div class="task-log-panel" id="task-log-${t.id}"></div>
  </details>`;
}

async function openTaskEdit(event, taskId) {
  event.preventDefault();
  event.stopPropagation();
  const t = (_cache["tasks"] || []).find(r => r.id === taskId) || await api(`/api/tasks/${taskId}`);
  if (!canWriteProject(t.special_project)) {
    toast("当前身份没有编辑该任务的权限");
    return;
  }
  openModal(`<div class="simple-modal wide-modal">
    <h3>编辑任务</h3>
    <form id="taskEditForm">
      ${textField("关键任务", "key_task", t.key_task || "", 2)}
      ${field("关键成果", "key_achievement", t.key_achievement || "")}
      ${textField("完成标准", "completion_standard", t.completion_standard || "", 3)}
      ${selectField("所属专项", "special_project", PROJECTS, normalizeProject(t.special_project || ""))}
      ${field("统筹人", "coordinator", t.coordinator || "")}
      ${field("负责人", "owner", t.owner || "")}
      ${field("协同成员", "collaborators", t.collaborators || "")}
      <label><span>计划时间</span><input name="plan_time" type="month" value="${esc(t.plan_time || "")}"></label>
      ${selectField("状态", "status", TASK_STATUS, t.status || "推进中")}
      ${textField("问题备注", "problem_note", t.problem_note || "", 3)}
      ${textField("成果链接", "achievement_links", t.achievement_links || "", 2)}
      <div class="modal-actions">
        <button type="button" onclick="closeModal()">取消</button>
        <button type="button" class="success" onclick="saveTaskEdit(${taskId})">保存</button>
      </div>
    </form>
  </div>`);
}

async function saveTaskEdit(taskId) {
  const form = document.getElementById("taskEditForm");
  if (!form) return;
  const v = readForm(form);
  if (!v.key_task?.trim()) return toast("关键任务不能为空");
  try {
    await api(`/api/tasks/${taskId}`, {
      method: "PUT",
      body: JSON.stringify({ ...v, source_type: "人工录入" }),
    });
    invalidate("tasks");
    closeModal();
    toast("任务已保存");
    renderTasks();
  } catch (err) {
    toast(`保存失败：${err.message || "请重试"}`);
  }
}

async function deleteTask(event, taskId) {
  event.preventDefault();
  event.stopPropagation();
  if (!confirm(`确认删除任务 #${taskId}？此操作不可恢复。`)) return;
  try {
    await api(`/api/tasks/${taskId}`, { method: "DELETE" });
    invalidate("tasks");
    closeModal();
    toast("任务已删除");
    renderTasks();
  } catch (err) {
    toast(`删除失败：${err.message || "请重试"}`);
  }
}

function onTaskToggle(event) {
  if (!event.target.open) return;
  const taskId = event.target.dataset.taskId;
  if (!taskId) return;
  const container = document.getElementById(`task-log-${taskId}`);
  if (!container || container.dataset.loaded === "1") return;
  container.dataset.loaded = "1";
  container.innerHTML = `<div class="log-loading">加载中…</div>`;
  api(`/api/logs?target_type=task&target_id=${taskId}`)
    .then(logs => {
      if (!Array.isArray(logs) || !logs.length) {
        container.innerHTML = `<div class="log-empty">暂无操作记录</div>`;
        return;
      }
      container.innerHTML = `<div class="log-list-title">操作日志</div>` + logs.map(renderLogItem).join("");
    })
    .catch(() => {
      container.dataset.loaded = "";
      container.innerHTML = `<div class="log-empty">日志加载失败</div>`;
    });
}

const _LOG_FIELD_NAMES = {
  key_task: "关键任务", key_achievement: "关键成果", completion_standard: "完成标准",
  coordinator: "统筹人", owner: "负责人", collaborators: "协同成员",
  plan_time: "计划时间", status: "状态", problem_note: "问题备注",
  achievement_links: "成果链接",
};

function renderLogItem(log) {
  const time = log.created_at ? log.created_at.slice(0, 16).replace("T", " ") : "";
  let detail = esc(log.action || "");
  try {
    const after = JSON.parse(log.after_json || "{}");
    const before = JSON.parse(log.before_json || "{}");
    if (log.action === "AI确认写入") {
      const taskTitle = after?.task?.key_task || after?.task?.title || after?.title || "任务更新";
      const parts = [
        `任务：${esc(taskTitle)}`,
        after.source ? `来源：${esc(after.source)}` : "",
        after.submitter ? `提交人：${esc(after.submitter)}` : "",
        after.confirmed_by ? `确认人：${esc(after.confirmed_by)}` : "",
        after.source_type ? `来源类型：${esc(after.source_type)}` : "",
        after.project ? `专项：${esc(after.project)}` : "",
      ].filter(Boolean);
      detail = parts.join(" · ");
    }
    if (log.action === "更新任务状态") {
      detail = `状态：<span class="log-before">${esc(before.status || "?")}</span> → <span class="log-after">${esc(after.status || "?")}</span>`;
    } else if (log.action === "修改任务") {
      const changed = Object.keys(after).filter(k => _LOG_FIELD_NAMES[k] && String(after[k]) !== String(before[k]));
      if (changed.length) detail = `修改：${esc(changed.map(k => _LOG_FIELD_NAMES[k]).join("、"))}`;
    }
  } catch (e) { /* keep default detail */ }
  const isStatus = log.action === "更新任务状态";
  return `<div class="task-log-item${isStatus ? " log-status-change" : ""}">
    <span class="log-time">${esc(time)}</span>
    <span class="log-op">${esc(log.operator || "系统")}</span>
    <span class="log-action">${detail}</span>
  </div>`;
}

function taskProjectTab(project, label) {
  const selected = (state.taskFilters?.project || "") === project;
  return `<button class="${selected ? "active" : ""}" onclick="setTaskProject('${esc(project)}')">${esc(label)}</button>`;
}

function filterTaskRows(rows, filters) {
  return rows.filter(t => {
    if (filters.project && t.special_project !== filters.project) return false;
    if (filters.status && !statusMatches(t.status, filters.status)) return false;
    if (filters.owner && ![t.owner, t.coordinator, t.collaborators].some(v => String(v || "").includes(filters.owner))) return false;
    if (filters.month && t.plan_time !== filters.month) return false;
    return true;
  });
}

function taskStatusStats(rows) {
  return {
    done: rows.filter(t => t.status === "已完成").length,
    doing: rows.filter(t => ["推进中", "进行中"].includes(t.status)).length,
    delayed: rows.filter(t => ["延期", "风险"].includes(t.status)).length,
    notStarted: rows.filter(t => ["未开始", "未启动"].includes(t.status)).length,
    paused: rows.filter(t => t.status === "暂缓").length,
  };
}

function upgradeTaskIssue(event, taskId) {
  event.preventDefault();
  event.stopPropagation();
  const task = (_cache["tasks"] || []).find(t => t.id === taskId) || {};
  if (task.special_project && !canWriteProject(task.special_project)) {
    toast("当前身份没有升级该任务问题的权限");
    return;
  }
  switchPage("issues");
  setTimeout(() => {
    openModal(`<div class="simple-modal">
      <h3>升级为问题 / 决策项</h3>
      <form id="newIssueForm">
        ${textField("问题描述", "description", task.problem_note || task.key_task || "", 3)}
        ${selectField("所属专项", "special_project", PROJECTS, normalizeProject(task.special_project || ""))}
        <label><span>责任人</span><input name="owner" value="${esc(task.owner || "")}"></label>
        ${selectField("优先级", "priority", ["高", "中", "低"], "高")}
        ${selectField("类型", "issue_type_sel", ["问题", "风险", "决策"], "问题")}
        <label><span>预计解决时间</span><input name="expected_resolve_time" placeholder="如：6月5日"></label>
        <input type="hidden" name="_task_id" value="${taskId}">
        <div class="modal-actions">
          <button type="button" onclick="closeModal()">取消</button>
          <button type="button" class="success" onclick="submitUpgradedIssue()">提交</button>
        </div>
      </form>
    </div>`);
  }, 200);
}

async function submitUpgradedIssue() {
  const form = document.getElementById("newIssueForm");
  if (!form) return;
  const v = readForm(form);
  if (!v.description?.trim()) return toast("请填写问题描述");
  if (!v.special_project) return toast("请选择所属专项");
  if (!canWriteProject(v.special_project)) return toast("当前身份没有在该专项下创建问题的权限");
  const issueType = v.issue_type_sel || "问题";
  try {
    await api("/api/issues", {
      method: "POST",
      body: JSON.stringify({
        issue_type: issueType,
        description: v.description,
        owner: v.owner || getCurrentUserName(),
        helper: "",
        priority: v.priority || "高",
        status: "待处理",
        need_decision_by: issueType === "决策" ? ceoPerson() : "",
        expected_resolve_time: v.expected_resolve_time || "",
        resolution: "",
        related_task_id: Number(v._task_id) || null,
        special_project: v.special_project,
        source_type: "任务升级",
      }),
    });
    invalidate("issues");
    closeModal();
    toast("问题已创建并关联原任务");
    renderIssues();
  } catch (err) {
    toast(`提交失败：${err.message || "请重试"}`);
  }
}

// ── window 挂载（供 HTML onchange/onclick 调用）──────────────────────────
window.renderTasks = renderTasks;
window.setTaskFilter = setTaskFilter;
window.setTaskProject = setTaskProject;
window.clearTaskProject = clearTaskProject;
window.setTaskPage = setTaskPage;
window.setTaskPageSize = setTaskPageSize;
window.setTaskSearch = setTaskSearch;
window.toggleTaskSelect = toggleTaskSelect;
window.selectAllTasks = selectAllTasks;
window.clearTaskSelection = clearTaskSelection;
window.toggleBulkStatusMenu = toggleBulkStatusMenu;
window.bulkUpdateTaskStatus = bulkUpdateTaskStatus;
window.bulkAssignOwner = bulkAssignOwner;
window.doAssignOwner = doAssignOwner;
window.bulkExtendDeadline = bulkExtendDeadline;
window.doExtendDeadline = doExtendDeadline;
window.refreshTasks = refreshTasks;
window.openNewTaskModal = openNewTaskModal;
window.submitNewTask = submitNewTask;
window.exportTasksCSV = exportTasksCSV;
window.openTaskDrawer = openTaskDrawer;
window.closeTaskDrawer = closeTaskDrawer;
window.openTaskEdit = openTaskEdit;
window.saveTaskEdit = saveTaskEdit;
window.deleteTask = deleteTask;
window.onTaskToggle = onTaskToggle;
window.upgradeTaskIssue = upgradeTaskIssue;
window.submitUpgradedIssue = submitUpgradedIssue;
