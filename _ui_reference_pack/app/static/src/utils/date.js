// 纯日期格式化函数
// 依赖：无

function formatWaitText(value) {
  const text = String(value || "");
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const d = new Date(text + "Z");
    if (!isNaN(d)) {
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      const hh = String(d.getHours()).padStart(2, "0");
      const min = String(d.getMinutes()).padStart(2, "0");
      const ss = String(d.getSeconds()).padStart(2, "0");
      return `${mm}-${dd} ${hh}:${min}:${ss}`;
    }
    return text.slice(5, 19).replace("T", " ");
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(5, 10);
  return text.slice(0, 10);
}

function formatIssueDateTime(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.slice(5, 16).replace("T", " ");
}

function formatSeconds(total = 0) {
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}
