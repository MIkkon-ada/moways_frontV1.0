async function handleExcelUpload(file, forceReplace) {
  if (!file) return;
  const replace = forceReplace || window._replaceMode || false;
  window._replaceMode = false;
  const statusEl = document.getElementById("importStatus");
  if (statusEl) statusEl.innerHTML = `<span class="import-running">正在导入 ${esc(file.name)}…</span>`;
  const form = new FormData();
  form.append("file", file);
  try {
    const impersonate = _impersonatedUser();
    const uploadHeaders = impersonate ? { "X-Current-User": encodeURIComponent(impersonate) } : {};
    const res = await fetch(`/api/admin/import-excel?replace=${replace}`, {
      method: "POST",
      headers: uploadHeaders,
      body: form,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "导入失败");
    const r = data.imported;
    if (statusEl) statusEl.innerHTML = `<span class="import-ok">✓ 导入成功：专项 ${r.projects||0} 个，人员 ${r.people||0} 人，任务 ${r.tasks||0} 条，成果 ${r.achievements||0} 条，问题 ${r.issues||0} 条</span>`;
    invalidate("tasks", "achievements", "issues", "confirmations");
    await loadDynamicOrgData();
    updateRoleSwitchOptions();
    toast("导入完成，数据已更新");
  } catch (err) {
    if (statusEl) statusEl.innerHTML = `<span class="import-err">✗ ${esc(err.message)}</span>`;
    toast(`导入失败：${err.message}`);
  }
}

async function renderSettings() {
  const el = document.getElementById("settings");
  if (!el) return;
  if (!canViewSettings()) {
    el.innerHTML = emptyState("无权限访问", "当前身份无法查看系统设置。");
    return;
  }
  el.innerHTML = `<div class="page-loading">加载中…</div>`;
  const [configRes, projectRes, peopleRes] = await Promise.allSettled([
    api("/api/llm-config"),
    api("/api/people/projects"),
    api("/api/people"),
  ]);
  const configs = configRes.status === "fulfilled" ? configRes.value : [];
  _settingsProjects = projectRes.status === "fulfilled" ? projectRes.value : [];
  _settingsPeople = peopleRes.status === "fulfilled" ? peopleRes.value.filter(p => p.is_active !== false) : [];
  if (configRes.status !== "fulfilled" && projectRes.status !== "fulfilled" && peopleRes.status !== "fulfilled") {
    el.innerHTML = `<div class="page-error"><strong>加载失败</strong><p>系统设置数据未能加载成功</p><button onclick="renderSettings()">重试</button></div>`;
    return;
  }
  _llmConfigs = {};
  configs.forEach(c => { _llmConfigs[c.provider] = c; });
  const enabledCount = configs.filter(c => c.enabled).length;
  const settingsTab = ["projects", "people", "import"].includes(state.settingsTab) ? state.settingsTab : "projects";
  state.settingsTab = settingsTab;
  el.innerHTML = `
    <div class="settings-wrap">
      <div class="settings-hero">
        <div>
          <p class="settings-kicker">系统设置</p>
          <h3>项目与人员维护</h3>
          <p>这里集中管理模型接入、项目维护、人员关系和 Excel 导入。新增项目与新增人员会直接影响权限、组织页和各模块筛选。</p>
        </div>
        <div class="settings-metrics">
          <div class="settings-metric">
            <span>启用模型</span>
            <strong>${enabledCount}</strong>
          </div>
          <div class="settings-metric">
            <span>当前项目</span>
            <strong>${_settingsProjects.length}</strong>
          </div>
          <div class="settings-metric">
            <span>人员数量</span>
            <strong>${_settingsPeople.length}</strong>
          </div>
        </div>
      </div>
      <div class="settings-layout">
        <section class="settings-panel settings-panel-wide settings-panel-compact">
          <div class="settings-panel-head">
            <div>
              <h3>AI 模型配置</h3>
              <p>配置各 LLM 提供商的 API Key 和接入参数，仅管理员可见。</p>
            </div>
          </div>
          <div class="model-config-list">
            ${configs.map(llmConfigCard).join("")}
          </div>
        </section>
        <section class="settings-panel settings-panel-wide">
          <div class="settings-panel-head settings-panel-head-row">
            <div>
              <h3>项目与人员维护</h3>
              <p>将项目、人员和导入拆成三个工作面，一次只看一类内容，扫起来更清楚。</p>
            </div>
            <div class="settings-btn-row">
              ${settingsTab === "projects" ? `<button class="primary" onclick="openProjectModal()">新增项目</button>` : ""}
              ${settingsTab === "people" ? `<button class="primary" onclick="openPersonModal()">新增人员</button>` : ""}
              ${settingsTab === "import" ? `<button onclick="window._replaceMode=true; document.getElementById('excelFileInput')?.click()">选择文件</button>` : ""}
            </div>
          </div>
          <div class="settings-tabs">
            ${settingsTabButton("projects", "项目列表", _settingsProjects.length, settingsTab)}
            ${settingsTabButton("people", "人员管理", _settingsPeople.length, settingsTab)}
            ${settingsTabButton("import", "批量导入", "", settingsTab)}
          </div>
          <div class="settings-tab-panel">
            ${settingsTab === "projects" ? settingsProjectsPanel() : settingsTab === "people" ? settingsPeoplePanel() : settingsImportPanel()}
          </div>
        </section>
      </div>
    </div>`;
  // Bind drag-and-drop on import zone
  const zone = document.getElementById("importZone");
  if (zone) {
    zone.addEventListener("dragover", e => { e.preventDefault(); zone.classList.add("drag-over"); });
    zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
    zone.addEventListener("drop", e => {
      e.preventDefault(); zone.classList.remove("drag-over");
      const f = e.dataTransfer?.files?.[0];
      if (f) handleExcelUpload(f, false);
    });
  }
}

function settingsTabButton(id, label, count, activeTab) {
  return `<button class="settings-tab ${activeTab === id ? "active" : ""}" onclick="switchSettingsTab('${id}')">${esc(label)}${count !== "" ? `<span class="settings-tab-badge">${count}</span>` : ""}</button>`;
}

function switchSettingsTab(id) {
  state.settingsTab = id;
  renderSettings();
}

function settingsProjectsPanel() {
  return `
    <div class="settings-record-list settings-record-list-compact">
      ${_settingsProjects.length ? _settingsProjects.map(settingsProjectCard).join("") : `<div class="settings-empty">暂无项目</div>`}
    </div>`;
}

function settingsPeoplePanel() {
  return `
    <div class="settings-record-list settings-record-list-compact">
      ${_settingsPeople.length ? _settingsPeople.map(settingsPersonCard).join("") : `<div class="settings-empty">暂无人员</div>`}
    </div>`;
}

function settingsImportPanel() {
  return `
    <div class="import-zone import-zone-plain" id="importZone">
      <div class="import-zone-hint">拖拽 Excel 文件到此处，或点击选择文件</div>
      <input type="file" id="excelFileInput" accept=".xlsx,.xlsm" style="display:none" onchange="handleExcelUpload(this.files[0], false)">
      <div class="import-btns">
        <button class="primary" onclick="document.getElementById('excelFileInput').click()">选择文件</button>
        <button onclick="document.getElementById('excelFileInput').click(); window._replaceMode=true" title="清空现有数据后重新导入">覆盖导入</button>
      </div>
      <div id="importStatus" class="import-status"></div>
    </div>
    <p class="import-note">「增量导入」在现有数据基础上追加新人员和任务；「覆盖导入」清空后重建，适合全新项目启动。</p>
    <button class="guide-toggle" onclick="toggleImportGuide(this)">查看 Excel 格式说明 ▾</button>
    <div class="import-guide" id="importGuide" hidden>${importFormatGuide()}</div>`;
}

function settingsProjectCard(project) {
  return `
    <div class="settings-record">
      <div class="settings-record-body">
        <div class="settings-record-title">
          <strong>${esc(project.name)}</strong>
          <span class="status-chip subtle">项目</span>
        </div>
        <p>统筹：${esc(project.coordinator || "-")}</p>
        <div class="settings-chip-row">
          <span class="assign-chip">负责 ${esc((project.owners || []).join("、") || "-")}</span>
          <span class="assign-chip">协同 ${esc((project.collaborators || []).join("、") || "-")}</span>
        </div>
      </div>
      <button onclick="openProjectModal(${project.id})">编辑</button>
    </div>`;
}

function settingsPersonCard(person) {
  const relation = memberAssignmentState(person.name);
  return `
    <div class="settings-record">
      <div class="settings-record-body">
        <div class="settings-record-title">
          <strong>${esc(person.name)}</strong>
          ${person.is_admin ? `<span class="status-chip subtle">管理员</span>` : ""}
          ${person.system_role && person.system_role !== "普通成员" ? badge(person.system_role) : ""}
        </div>
        <p>${esc(person.role || "未设置角色")}${person.special_project_duty ? ` · ${esc(person.special_project_duty)}` : ""}</p>
        <div class="settings-chip-row">
          ${relation.coordinated.length ? `<span class="assign-chip">统筹 ${esc(relation.coordinated.join("、"))}</span>` : ""}
          ${relation.owned.length ? `<span class="assign-chip">负责 ${esc(relation.owned.join("、"))}</span>` : ""}
          ${relation.collaborated.length ? `<span class="assign-chip">协同 ${esc(relation.collaborated.join("、"))}</span>` : ""}
        </div>
      </div>
      <button onclick="openPersonModal(${person.id})">编辑</button>
    </div>`;
}

function memberAssignmentState(name) {
  return {
    coordinated: projectAreas.filter(area => area.coordinator === name).map(area => area.name),
    owned: projectAreas.filter(area => splitPeople(area.owner).includes(name)).map(area => area.name),
    collaborated: projectAreas.filter(area => splitPeople(area.collaborators).includes(name)).map(area => area.name),
  };
}

function settingsNameOptions(exclude = "") {
  const pool = [...new Set(_settingsPeople.map(person => person.name).filter(Boolean))];
  if (exclude && !pool.includes(exclude)) pool.push(exclude);
  return pool.sort((a, b) => String(a).localeCompare(String(b), "zh-Hans-CN"));
}

function checkboxGroup(name, items, selected = []) {
  const picked = new Set(selected || []);
  if (!items.length) return `<div class="settings-empty compact">暂无可选项</div>`;
  return `<div class="picker-grid">${items.map(item => `
    <label class="picker-option">
      <input type="checkbox" name="${name}" value="${esc(item)}" ${picked.has(item) ? "checked" : ""}>
      <span>${esc(item)}</span>
    </label>`).join("")}</div>`;
}

function checkedValues(form, name) {
  return [...form.querySelectorAll(`input[name="${name}"]:checked`)].map(node => node.value);
}

function toggleImportGuide(button) {
  const guide = document.getElementById("importGuide");
  if (!guide || !button) return;
  const opening = guide.hidden;
  guide.hidden = !opening;
  button.textContent = opening ? "收起 Excel 格式说明 ▴" : "查看 Excel 格式说明 ▾";
}

function importFormatGuide() {
  return `
    <div class="guide-block">
      <strong>组织与分工 sheet</strong>
      <p>上半区维护成员姓名与角色，下半区从"专项 / 统筹人 / 负责人 / 协同成员"四列开始读取项目关系。</p>
    </div>
    <div class="guide-block">
      <strong>工作推进总表 sheet</strong>
      <p>至少保留专项、关键任务、负责人、计划时间、状态几列，系统会自动补到任务与成果数据里。</p>
    </div>
    <div class="guide-block">
      <strong>导入建议</strong>
      <p>增量导入适合补充新项目和新成员；覆盖导入会重建项目、人员与任务数据，适合全量初始化。</p>
    </div>`;
}

function openProjectModal(projectId = null) {
  const project = projectId ? _settingsProjects.find(item => item.id === projectId) : null;
  const peopleNames = settingsNameOptions(project?.coordinator || "");
  openModal(`
    <div class="simple-modal wide-modal">
      <h3>${project ? "编辑项目" : "新增项目"}</h3>
      <form id="projectAdminForm" class="form-grid">
        ${field("项目名称", "name", project?.name || "")}
        ${field("排序", "sort_order", project?.sort_order ?? _settingsProjects.length, "number")}
        <label><span>统筹人</span><select name="coordinator"><option value="">未设置</option>${optionList(peopleNames, project?.coordinator || "")}</select></label>
        <label class="inline-check"><span>启用项目</span><input name="is_active" type="checkbox" ${project?.is_active === false ? "" : "checked"}></label>
        <label class="wide"><span>负责人</span>${checkboxGroup("owners", peopleNames, project?.owners || [])}</label>
        <label class="wide"><span>协同成员</span>${checkboxGroup("collaborators", peopleNames, project?.collaborators || [])}</label>
      </form>
      <div class="modal-actions">
        ${project ? `<button class="danger" onclick="deleteProject(${project.id})">删除项目</button>` : `<span></span>`}
        <button onclick="closeModal()">取消</button>
        <button class="success" onclick="saveProject(${project?.id || "null"})">保存</button>
      </div>
    </div>`);
}

async function saveProject(projectId) {
  const form = document.getElementById("projectAdminForm");
  const values = readForm(form);
  const payload = {
    name: (values.name || "").trim(),
    coordinator: values.coordinator || "",
    owners: checkedValues(form, "owners"),
    collaborators: checkedValues(form, "collaborators"),
    sort_order: Number(values.sort_order || 0),
    is_active: form.querySelector("[name=is_active]").checked,
  };
  if (!payload.name) return toast("请先填写项目名称");
  try {
    await api(projectId ? `/api/people/projects/${projectId}` : "/api/people/projects", {
      method: projectId ? "PUT" : "POST",
      body: JSON.stringify(payload),
    });
    closeModal();
    await refreshSettingsData();
    toast(projectId ? "项目已更新" : "项目已新增");
  } catch (err) {
    toast(`保存失败：${err.message}`);
  }
}

async function deleteProject(projectId) {
  if (!window.confirm("确认删除这个项目吗？")) return;
  try {
    await api(`/api/people/projects/${projectId}`, { method: "DELETE" });
    closeModal();
    await refreshSettingsData();
    toast("项目已删除");
  } catch (err) {
    toast(`删除失败：${err.message}`);
  }
}

function openPersonModal(personId = null) {
  const person = personId ? _settingsPeople.find(item => item.id === personId) : null;
  const assignment = memberAssignmentState(person?.name || "");
  const projects = PROJECTS.slice();
  openModal(`
    <div class="simple-modal wide-modal">
      <h3>${person ? "编辑人员" : "新增人员"}</h3>
      <form id="personAdminForm" class="form-grid">
        ${field("姓名", "name", person?.name || "")}
        ${field("角色", "role", person?.role || "")}
        ${field("部门", "department", person?.department || "")}
        ${field("联系方式", "contact", person?.contact || "")}
        <label><span>全局权限角色</span>
          <select name="system_role">
            ${["普通成员","过程保障","超级管理员","组长CEO"].map(r => `<option value="${r}"${(person?.system_role || "普通成员") === r ? " selected" : ""}>${r}</option>`).join("")}
          </select>
        </label>
        <label class="inline-check"><span>系统管理员</span><input name="is_admin" type="checkbox" ${person?.is_admin ? "checked" : ""}></label>
        <label class="inline-check"><span>启用账号</span><input name="is_active" type="checkbox" ${person?.is_active === false ? "" : "checked"}></label>
        <label class="wide"><span>统筹项目</span>${checkboxGroup("coordinated_projects", projects, assignment.coordinated)}</label>
        <label class="wide"><span>负责项目</span>${checkboxGroup("owned_projects", projects, assignment.owned)}</label>
        <label class="wide"><span>协同项目</span>${checkboxGroup("collaborated_projects", projects, assignment.collaborated)}</label>
      </form>
      <div class="modal-actions">
        ${person ? `<button class="danger" onclick="deletePerson(${person.id})">删除人员</button>` : `<span></span>`}
        <button onclick="closeModal()">取消</button>
        <button class="success" onclick="savePerson(${person?.id || "null"})">保存</button>
      </div>
    </div>`);
}

function permissionForRole(role, coordinated, owned, isAdmin) {
  if (isAdmin || String(role || "").includes("组长") || String(role || "").includes("CEO")) return "确认";
  if ((coordinated || []).length || (owned || []).length) return "维护";
  return "查看";
}

async function savePerson(personId) {
  const form = document.getElementById("personAdminForm");
  const values = readForm(form);
  const coordinated = checkedValues(form, "coordinated_projects");
  const owned = checkedValues(form, "owned_projects").filter(name => !coordinated.includes(name));
  const collaborated = checkedValues(form, "collaborated_projects").filter(name => !coordinated.includes(name) && !owned.includes(name));
  const isAdmin = form.querySelector("[name=is_admin]").checked;
  const payload = {
    name: (values.name || "").trim(),
    role: values.role || "",
    system_role: form.querySelector("[name=system_role]").value || "普通成员",
    department: values.department || "",
    contact: values.contact || "",
    is_active: form.querySelector("[name=is_active]").checked,
    is_admin: isAdmin,
    permission: permissionForRole(values.role, coordinated, owned, isAdmin),
    special_project_duty: [...new Set([...coordinated, ...owned, ...collaborated])].join("、"),
    coordinated_projects: coordinated,
    owned_projects: owned,
    collaborated_projects: collaborated,
  };
  if (!payload.name) return toast("请先填写人员姓名");
  try {
    await api(personId ? `/api/people/${personId}` : "/api/people", {
      method: personId ? "PUT" : "POST",
      body: JSON.stringify(payload),
    });
    closeModal();
    await refreshSettingsData();
    toast(personId ? "人员已更新" : "人员已新增");
  } catch (err) {
    toast(`保存失败：${err.message}`);
  }
}

async function deletePerson(personId) {
  if (!window.confirm("确认删除这位人员吗？")) return;
  try {
    await api(`/api/people/${personId}`, { method: "DELETE" });
    closeModal();
    await refreshSettingsData();
    toast("人员已删除");
  } catch (err) {
    toast(`删除失败：${err.message}`);
  }
}

async function refreshSettingsData() {
  invalidate("tasks", "achievements", "issues", "confirmations");
  await loadDynamicOrgData();
  await refreshUserContext();
  updateRoleSwitchOptions();
  await renderSettings();
}

function llmConfigCard(cfg) {
  const statusClass = cfg.enabled ? "enabled" : "disabled";
  const statusText = cfg.enabled ? "已启用" : "未启用";
  const keyText = cfg.api_key_set ? "已配置 ●●●" : "未配置";
  return `
    <div class="model-config-card">
      <div class="model-config-head">
        <div>
          <strong>${esc(cfg.display_name)}</strong>
        </div>
        <span class="status-chip ${statusClass}">${statusText}</span>
        <button onclick="openLlmConfigModal('${esc(cfg.provider)}')">配置</button>
      </div>
      <div class="model-config-info">
        <span>API Key：${keyText}</span>
        <span>模型：${esc(cfg.model)}</span>
        <span>接口：${esc(cfg.base_url)}</span>
      </div>
    </div>`;
}

function openLlmConfigModal(provider) {
  const cfg = _llmConfigs[provider];
  if (!cfg) return toast("配置数据未加载，请刷新页面");
  openModal(`
    <div class="simple-modal wide-modal">
      <h3>${esc(cfg.display_name)} 配置</h3>
      <form id="llmConfigForm">
        <label><span>API Key</span>
          <input name="api_key" type="password" placeholder="${cfg.api_key_set ? "已配置，留空则保留原值" : "请输入 API Key"}" autocomplete="off">
        </label>
        <label><span>Base URL</span>
          <input name="base_url" type="text" value="${esc(cfg.base_url)}" placeholder="${esc(cfg.default_base_url)}">
        </label>
        <label><span>模型名称</span>
          <input name="model" type="text" value="${esc(cfg.model)}" placeholder="${esc(cfg.default_model)}">
        </label>
        <label class="inline-check">
          <span>启用此提供商</span>
          <input name="enabled" type="checkbox" ${cfg.enabled ? "checked" : ""}>
        </label>
      </form>
      <div class="modal-actions">
        <button onclick="testLlmConfig('${provider}')">测试连接</button>
        <button onclick="closeModal()">取消</button>
        <button class="success" onclick="saveLlmConfig('${provider}')">保存</button>
      </div>
    </div>`);
}

async function saveLlmConfig(provider) {
  const form = document.getElementById("llmConfigForm");
  const v = readForm(form);
  const enabled = form.querySelector("[name=enabled]").checked;
  try {
    await api(`/api/llm-config/${provider}`, {
      method: "PUT",
      body: JSON.stringify({ api_key: v.api_key || "", base_url: v.base_url, model: v.model, enabled }),
    });
    closeModal();
    toast("配置已保存");
    renderSettings();
  } catch (err) {
    toast(`保存失败：${err.message}`);
  }
}

async function testLlmConfig(provider) {
  const form = document.getElementById("llmConfigForm");
  const v = form ? readForm(form) : {};
  toast("正在测试连接…");
  try {
    const res = await api(`/api/llm-config/${provider}/test`, {
      method: "POST",
      body: JSON.stringify({ api_key: v.api_key || "", base_url: v.base_url || "", model: v.model || "" }),
    });
    toast(`✓ ${res.message}`);
  } catch (err) {
    toast(`✗ ${err.message}`);
  }
}
