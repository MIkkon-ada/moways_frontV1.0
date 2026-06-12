// 成果库页面模块
// 依赖（均在本文件之前加载）：
//   components.js      : esc, badge, field, textField, selectField, optionList, openModal, closeModal, emptyState, ACHIEVEMENT_TYPES, REUSE_TAGS, PROJECTS
//   src/appState.js    : state, members
//   src/api/client.js  : api
//   src/api/cache.js   : fetchCached, invalidate, _cache
//   src/permissions/permissions.js : canWriteProject, canManageAchievement, currentUserProjectRelation, rowRelationLabel, getCurrentUserContext
//   src/utils/format.js   : achievementStatusClass, projRelationChip
//   src/utils/project.js  : normalizeProject, groupByProject, sortByAchievementTime, achievementWarnings, achievementDisplayId
//   src/utils/date.js     : formatWaitText
//   app.js             : toast, switchPage, myProjectPills (调用时已加载)

async function renderAchievements() {
  document.getElementById("achievements").innerHTML = `<div class="page-loading">加载中…</div>`;
  let rawRows;
  try {
    rawRows = await fetchCached("achievements", "/api/achievements");
  } catch (err) {
    document.getElementById("achievements").innerHTML = `<div class="page-error"><strong>成果库加载失败</strong><p>${esc(err.message || "网络错误")}</p><button onclick="loadPage('achievements')">重试</button></div>`;
    return;
  }
  const rows = rawRows.map(a => ({ ...a, special_project: normalizeProject(a.special_project) }));
  const filters = state.achievementFilters || {};
  const visibleRows = filterAchievementRows(rows, filters);
  const groups = groupByProject(visibleRows);
  const reusable = rows.filter(a => ["已形成", "可复用", "已归档"].includes(a.status)).length;
  const planned = rows.filter(a => a.status === "计划中").length;
  const formed = rows.filter(a => ["已形成", "可复用"].includes(a.status)).length;
  const archived = rows.filter(a => ["已归档", "可复用"].includes(a.status)).length;
  const archiveWarnings = rows.reduce((sum, a) => sum + achievementWarnings(a).length, 0);
  const types = [...new Set(rows.map(a => a.achievement_type).filter(Boolean))];
  const owners = members.filter(m => m.is_active !== false).map(m => m.name).filter(Boolean);
  const reuseTags = REUSE_TAGS;
  const context = getCurrentUserContext();
  const visibleProjects = context.canViewAll ? PROJECTS : PROJECTS.filter(p => context.visibleProjects.includes(p));
  document.getElementById("achievements").innerHTML = `
    <div class="asset-library-head">
      <div>
        <h3>成果库</h3>
        <p>所有阶段性成果必须关联任务，重要成果必须标记版本，客户资料需脱敏后入库。</p>
      </div>
      <div class="asset-metrics">
        ${assetMetric("成果总数（计划）", rows.length)}
        ${assetMetric("计划中", planned)}
        ${assetMetric("已形成", formed)}
        ${assetMetric("已归档/可复用", archived)}
        ${assetMetric("归档提醒", archiveWarnings)}
      </div>
    </div>
    <div class="asset-filter-grid">
      ${myProjectPills(filters.project, 'setAchievementProject', 'clearAchievementProject')}
      <label><select onchange="setAchievementProject(this.value)">
        <option value="">全部专项</option>
        ${visibleProjects.map(p => `<option value="${esc(p)}" ${filters.project === p ? "selected" : ""}>${esc(p)}</option>`).join("")}
      </select></label>
      <label><select onchange="setAchievementFilter('type', this.value)"><option value="">成果类型</option>${optionList(types, filters.type)}</select></label>
      <label><select onchange="setAchievementFilter('reuse', this.value)"><option value="">复用场景</option>${optionList(reuseTags, filters.reuse)}</select></label>
      <label><select onchange="setAchievementFilter('owner', this.value)"><option value="">负责人</option>${optionList(owners, filters.owner)}</select></label>
    </div>
    <div class="asset-project-groups">${groups.map(([project, items], index) => achievementProjectGroup(project, sortByAchievementTime(items), index)).join("") || emptyState("暂无成果", "确认写入后出现成果。")}</div>`;
}

function setAchievementProject(project) {
  state.achievementFilters = { ...(state.achievementFilters || {}), project };
  renderAchievements();
}
function clearAchievementProject() { setAchievementProject(''); }

function setAchievementFilter(name, value) {
  state.achievementFilters = { ...(state.achievementFilters || {}), [name]: value };
  renderAchievements();
}

function achievementProjectGroup(project, rows, index = 0) {
  const editable = canWriteProject(project);
  const relation = currentUserProjectRelation(project);
  return `<section class="asset-project-section project-tone-${index % 5}">
    <div class="asset-project-head">
      <h3><i></i>${esc(project)}${projRelationChip(relation)} <span>${rows.length} 项成果</span></h3>
      ${editable ? `<button onclick="switchPage('updates')">新增成果</button>` : `<span class="asset-readonly">只读查看</span>`}
    </div>
    <table class="achievement-table">
      <thead><tr>
        <th class="arow-id-head">ID</th><th>成果名称</th><th>类型</th><th>复用场景</th><th>负责人</th><th>版本</th><th>完成时间</th><th>状态</th><th>文件</th><th>操作</th>
      </tr></thead>
      <tbody>${rows.map(achievementRow).join("")}</tbody>
    </table>
  </section>`;
}

function achievementCard(a) {
  const warnings = achievementWarnings(a);
  const statusClassName = achievementStatusClass(a.status);
  const taskId = a.related_task_id || "";
  const editable = canWriteProject(a.special_project);
  const relation = rowRelationLabel(a);
  return `<article class="asset-card library-card ${statusClassName}">
    <div class="asset-card-top"><h4>${esc(a.name)}</h4><div>${relation ? badge(relation) : ""}${badge(a.status || "计划中")}</div></div>
    <div class="asset-tags">
      <span class="asset-type">${esc(a.achievement_type || "成果")}</span>
      <span class="asset-reuse">${esc(a.reuse_tag || "内部使用")}</span>
      ${warnings.map(w => `<span class="asset-warning">${esc(w)}</span>`).join("")}
    </div>
    <div class="asset-meta">
      <span>□ ${esc(a.owner || "-")}</span>
      <span>□ ${esc(a.version || "未标版本")}</span>
      <span>□ ${esc(a.scenario || "待补充")}</span>
    </div>
    <div class="asset-card-foot">
      <button onclick="jumpToTask(${Number(taskId) || 0})">□ 任务#${esc(taskId || "未关联")}</button>
      ${editable ? `<button onclick="uploadAssetLink(${a.id})">□ ${a.file_link ? "查看链接" : "待上传"}</button>` : `<button disabled title="当前身份没有编辑权限">□ 只读</button>`}
    </div>
  </article>`;
}

function achievementRow(a) {
  const warnings = achievementWarnings(a);
  const taskId = a.related_task_id || "";
  const editable = canWriteProject(a.special_project);
  return `<tr class="achievement-row ${achievementStatusClass(a.status)}">
    <td class="arow-id">${esc(achievementDisplayId(a))}</td>
    <td class="arow-name">
      <span title="${esc(a.name)}">${esc(a.name)}</span>
      ${warnings.map(w => `<span class="asset-warning">${esc(w)}</span>`).join("")}
    </td>
    <td>${esc(a.achievement_type || "-")}</td>
    <td>${esc(a.reuse_tag || "内部使用")}</td>
    <td>${esc(a.owner || "-")}</td>
    <td class="arow-version">${esc(a.version || "-")}</td>
    <td class="arow-time">${a.confirmed_at ? formatWaitText(a.confirmed_at) : "-"}</td>
    <td>${badge(a.status || "计划中")}</td>
    <td>${editable ? `<button class="arow-btn" onclick="uploadAssetLink(${a.id})">${a.file_link ? "查看" : "待上传"}</button>` : `<span class="readonly-chip">只读</span>`}</td>
    <td class="arow-ops">${canManageAchievement(a.special_project) ? `
      <button class="arow-btn" onclick="openAchievementEdit(${a.id})">编辑</button>
      <button class="arow-btn danger-text" onclick="deleteAchievement(${a.id})">删除</button>
    ` : ""}</td>
  </tr>`;
}

function assetMetric(label, value) {
  return `<article><span>${esc(label)}</span><strong>${value}</strong></article>`;
}

function achievementProjectTab(project, label) {
  const selected = (state.achievementFilters?.project || "") === project;
  return `<button class="${selected ? "active" : ""}" onclick="setAchievementProject('${esc(project)}')">${esc(label)}</button>`;
}

function filterAchievementRows(rows, filters) {
  return rows.filter(a => {
    if (filters.project && a.special_project !== filters.project) return false;
    if (filters.type && a.achievement_type !== filters.type) return false;
    if (filters.reuse && (a.reuse_tag || "内部使用") !== filters.reuse) return false;
    if (filters.owner && a.owner !== filters.owner) return false;
    return true;
  });
}

function jumpToTask(taskId) {
  if (!taskId) return toast("该成果尚未关联任务，请先补充关联任务。");
  switchPage("tasks");
  setTimeout(() => {
    const el = document.querySelector(`[data-task-id="${taskId}"]`);
    if (!el) { toast(`未找到任务 #${taskId}`); return; }
    el.open = true;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, 350);
}

function uploadAssetLink(id) {
  const cached = (_cache["achievements"] || []).find(a => a.id === id);
  const existing = cached?.file_link || "";
  if (cached && !canWriteProject(cached.special_project)) {
    toast("当前身份没有修改成果链接的权限");
    return;
  }
  openModal(`<div class="simple-modal">
    <h3>${existing ? "查看 / 修改文件链接" : "补充文件链接"}</h3>
    <p class="muted-text">填写腾讯文档、飞书、GitHub 等可访问链接。</p>
    <input id="assetLinkInput" type="url" value="${esc(existing)}" placeholder="https://..." style="width:100%;margin-top:8px">
    <div class="modal-actions">
      <button type="button" onclick="closeModal()">取消</button>
      <button type="button" class="success" onclick="saveAssetLink(${id})">保存</button>
    </div>
  </div>`);
}

async function saveAssetLink(id) {
  const link = document.getElementById("assetLinkInput")?.value.trim();
  if (!link) return toast("请输入有效链接");
  try {
    const row = (_cache["achievements"] || []).find(a => a.id === id) || await api(`/api/achievements/${id}`);
    await api(`/api/achievements/${id}`, {
      method: "PUT",
      body: JSON.stringify({ ...row, file_link: link }),
    });
    invalidate("achievements");
    closeModal();
    toast("链接已保存");
    renderAchievements();
  } catch (err) {
    toast(`保存失败：${err.message || "请重试"}`);
  }
}

async function openAchievementEdit(id) {
  const a = (_cache["achievements"] || []).find(r => r.id === id) || await api(`/api/achievements/${id}`);
  if (!canManageAchievement(a.special_project)) return toast("当前身份没有编辑权限");
  openModal(`<div class="simple-modal wide-modal">
    <h3>编辑成果</h3>
    <form id="achievementEditForm">
      ${field("成果名称", "name", a.name || "")}
      ${selectField("类型", "achievement_type", ACHIEVEMENT_TYPES, a.achievement_type || "")}
      ${selectField("所属专项", "special_project", PROJECTS, a.special_project || "")}
      ${selectField("复用场景", "reuse_tag", REUSE_TAGS, a.reuse_tag || "")}
      ${field("负责人", "owner", a.owner || "")}
      ${field("版本", "version", a.version || "V0.1")}
      ${selectField("状态", "status", ["草稿","计划中","补充成果","已形成","已归档"], a.status || "草稿")}
      ${textField("应用场景", "scenario", a.scenario || "", 2)}
      ${field("文件链接", "file_link", a.file_link || "", "url")}
    </form>
    <div class="modal-actions">
      <button type="button" onclick="closeModal()">取消</button>
      <button type="button" class="success" onclick="saveAchievementEdit(${id})">保存</button>
    </div>
  </div>`);
}

async function saveAchievementEdit(id) {
  const form = document.getElementById("achievementEditForm");
  if (!form) return;
  const v = readForm(form);
  if (!v.name?.trim()) return toast("成果名称不能为空");
  try {
    await api(`/api/achievements/${id}`, { method: "PUT", body: JSON.stringify(v) });
    invalidate("achievements");
    closeModal();
    toast("成果已更新");
    renderAchievements();
  } catch (err) {
    toast(`保存失败：${err.message || "请重试"}`);
  }
}

async function deleteAchievement(id) {
  const a = (_cache["achievements"] || []).find(r => r.id === id);
  const name = a?.name || `成果#${id}`;
  if (!confirm(`确认删除「${name}」？此操作不可撤销。`)) return;
  try {
    await api(`/api/achievements/${id}`, { method: "DELETE" });
    invalidate("achievements");
    toast("成果已删除");
    renderAchievements();
  } catch (err) {
    toast(`删除失败：${err.message || "请重试"}`);
  }
}

window.renderAchievements = renderAchievements;
window.setAchievementProject = setAchievementProject;
window.clearAchievementProject = clearAchievementProject;
window.setAchievementFilter = setAchievementFilter;
window.achievementProjectTab = achievementProjectTab;
window.jumpToTask = jumpToTask;
window.uploadAssetLink = uploadAssetLink;
window.saveAssetLink = saveAssetLink;
window.openAchievementEdit = openAchievementEdit;
window.saveAchievementEdit = saveAchievementEdit;
window.deleteAchievement = deleteAchievement;
