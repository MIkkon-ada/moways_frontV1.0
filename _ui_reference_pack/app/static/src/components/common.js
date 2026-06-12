// 通用 UI 组件
// 依赖：esc (components.js)
// 注意：renderAccessDenied 运行时依赖 currentPageId (app.js)，加载时无依赖

function toast(message) {
  const node = document.createElement("div");
  node.className = "toast";
  node.textContent = message;
  document.getElementById("toast").appendChild(node);
  setTimeout(() => node.remove(), 2600);
}

function renderAccessDenied(message) {
  const current = currentPageId();
  const el = document.getElementById(current);
  if (!el) return;
  el.innerHTML = `<div class="page-error"><strong>无权限访问</strong><p>${esc(message)}</p></div>`;
}

// ── 可选组件（供后续阶段逐步迁移，不强制替换现有代码）────────────────────

function EmptyState(text, hint) {
  return `<div class="empty-state"><p>${esc(text)}</p>${hint ? `<small>${esc(hint)}</small>` : ""}</div>`;
}

function LoadingState(text = "加载中…") {
  return `<div class="page-loading">${esc(text)}</div>`;
}

function ErrorState(title, message, retryFn) {
  return `<div class="page-error"><strong>${esc(title)}</strong><p>${esc(message)}</p>${retryFn ? `<button onclick="${esc(retryFn)}">重试</button>` : ""}</div>`;
}

function NoPermissionState(message) {
  return `<div class="page-error"><strong>无权限访问</strong><p>${esc(message)}</p></div>`;
}

function StatusTag(status) {
  const cls = status === "已完成" ? "tag-green"
    : ["推进中", "进行中"].includes(status) ? "tag-blue"
    : ["延期", "风险"].includes(status) ? "tag-red"
    : status === "暂缓" ? "tag-orange" : "tag-gray";
  return `<span class="tag ${cls}">${esc(status)}</span>`;
}

window.toast = toast;
