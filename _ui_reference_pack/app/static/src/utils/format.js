// 纯展示格式化函数（返回 CSS 类名或 HTML 字符串，无 DOM 操作）
// 依赖：esc (components.js)

function statusTagClass(status) {
  if (["推进中", "进行中"].includes(status)) return "tag-blue";
  if (status === "已完成") return "tag-green";
  if (["延期", "风险"].includes(status)) return "tag-red";
  if (status === "暂缓") return "tag-orange";
  return "tag-gray";
}

function achievementTagClass(status) {
  if (["已归档", "可复用"].includes(status)) return "tag-purple";
  if (["已形成", "已完成"].includes(status)) return "tag-green";
  return "tag-gray";
}

function achievementStatusClass(status = "") {
  if (["已归档", "可复用"].includes(status)) return "archived";
  if (["已形成", "已完成"].includes(status)) return "formed";
  return "planned";
}

function statusClass(status = "") {
  if (["推进中", "进行中"].includes(status)) return "doing";
  if (status === "已完成") return "done";
  if (status === "暂缓") return "paused";
  return "neutral";
}

function statusMatches(status, selected) {
  const map = { "未启动": ["未启动", "未开始"], "进行中": ["进行中", "推进中"] };
  return (map[selected] || [selected]).includes(status);
}

function truncate(str, len) {
  if (!str) return "";
  const s = String(str);
  return s.length > len ? s.slice(0, len) + "…" : s;
}

function linkifyTaskLinks(links, fallback) {
  const text = String(links || "").trim();
  if (!text) return esc(fallback);
  return text.split(/[；;\n]+/).filter(Boolean).map(link => {
    const url = link.trim();
    return `<a href="${esc(url)}" target="_blank" rel="noreferrer">${esc(url)}</a>`;
  }).join("<br>");
}

function labelOf(k) {
  return { special_project: "专项", key_task: "关键任务", owner: "负责人", coordinator: "统筹人", plan_time: "计划时间", status: "状态" }[k] || k;
}

function splitEditedList(value) {
  return String(value || "").split(/[；;\n]+/).map(item => item.trim()).filter(Boolean);
}

function projRelationChip(relation) {
  if (!relation) return "";
  if (relation === "我负责") return `<span class="proj-rel-chip owner">负责</span>`;
  if (relation === "我统筹") return `<span class="proj-rel-chip coord">统筹</span>`;
  if (relation === "我参与" || relation === "项目相关") return `<span class="proj-rel-chip member">${relation === "我参与" ? "参与" : "相关"}</span>`;
  return "";
}
