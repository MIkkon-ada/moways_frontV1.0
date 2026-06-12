// API client - HTTP 请求基础层
// 依赖：_sessionUsername (appState.js)

function _impersonatedUser() {
  const selected = document.getElementById("roleSwitch")?.value || _sessionUsername || "";
  // Only send X-Current-User when actively impersonating (selected differs from actual session user)
  return selected !== _sessionUsername ? selected : null;
}

async function api(url, options = {}) {
  const impersonate = _impersonatedUser();
  const extraHeaders = impersonate ? { "X-Current-User": encodeURIComponent(impersonate) } : {};
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json", ...extraHeaders, ...(options.headers || {}) },
    ...options,
  });
  if (res.status === 401) {
    window.location.href = "/login";
    throw new Error("未登录");
  }
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function logout() {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } finally {
    window.location.href = "/login";
  }
}

window.logout = logout;
