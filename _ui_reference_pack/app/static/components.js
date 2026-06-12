const PROJECT_ALIASES = {
  "知识资产AI问答": "知识资产AI化",
  "作业AI质检": "顾问作业AI化",
  "流程AI助手": "交付流程AI化",
  "AI咨询产品化": "咨询服务产品化",
  "AI能力平台预研": "技术底座与平台预研",
};
const TASK_STATUS = ["未开始", "推进中", "已完成", "延期", "风险", "暂缓"];
const ISSUE_STATUS = ["待处理", "处理中", "待决策", "已决策", "暂缓", "关闭"];
const ACHIEVEMENT_TYPES = ["方案", "表格", "模板", "SOP", "Prompt", "Agent原型", "会议纪要", "复盘报告", "案例包", "产品材料"];
const REUSE_TAGS = ["内部使用", "项目复用", "产品材料", "客户交付"];

function normalizeProject(value) {
  return PROJECT_ALIASES[value] || value || "";
}

function currentMonthStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, s => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[s]));
}

function optionList(items, value = "") {
  return items.map(item => {
    const val = Array.isArray(item) ? item[0] : item;
    const label = Array.isArray(item) ? item[1] : item;
    return `<option value="${esc(val)}" ${String(val) === String(value) ? "selected" : ""}>${esc(label)}</option>`;
  }).join("");
}

function field(label, name, value = "", type = "text") {
  return `<label><span>${label}</span><input name="${name}" type="${type}" value="${esc(value)}"></label>`;
}

function textField(label, name, value = "", rows = 4) {
  return `<label class="wide"><span>${label}</span><textarea name="${name}" rows="${rows}">${esc(value)}</textarea></label>`;
}

function selectField(label, name, items, value = "") {
  return `<label><span>${label}</span><select name="${name}">${optionList(items, value)}</select></label>`;
}

function checkboxField(label, name, checked = true) {
  return `<label><span>${label}</span><select name="${name}"><option value="true" ${checked ? "selected" : ""}>是</option><option value="false" ${!checked ? "selected" : ""}>否</option></select></label>`;
}

function readForm(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function readContainer(node) {
  const data = {};
  node.querySelectorAll("input, select, textarea").forEach(el => data[el.name] = el.value);
  return data;
}

function badge(value) {
  const text = value || "未标记";
  let tone = "";
  if (["已完成", "已确认", "已入库", "已确认入库", "可复用", "已解决", "已归档"].includes(text)) tone = "green";
  else if (["推进中", "进行中", "待确认", "待负责人审核", "提交人已确认", "已重新提交", "统筹人已反馈", "CEO已批示", "处理中"].includes(text)) tone = "blue";
  else if (["延期", "风险", "高", "待处理", "已退回", "不入库"].includes(text)) tone = "red";
  else if (["暂缓", "需修改", "已修改", "待决策", "优化中", "已打回提交人", "已转交统筹人", "待CEO决策"].includes(text)) tone = "amber";
  else if (["决策", "客户资料", "产品资料"].includes(text)) tone = "violet";
  return `<span class="badge ${tone}">${esc(text)}</span>`;
}

function progress(percent) {
  const safe = Math.max(0, Math.min(100, Number(percent || 0)));
  return `<div class="progress"><i style="width:${safe}%"></i></div>`;
}

function emptyState(title, body, action = "") {
  return `<div class="empty"><strong>${esc(title)}</strong><p>${esc(body)}</p>${action}</div>`;
}

function openModal(html) {
  document.getElementById("modalBody").innerHTML = html;
  document.getElementById("modal").classList.remove("hidden");
}

function closeModal() {
  document.getElementById("modal").classList.add("hidden");
}
