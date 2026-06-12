/**
 * 把后端返回的 UTC 时间字符串（带或不带 Z 后缀）转换为本地时间并格式化。
 * 后端用 datetime.utcnow()，isoformat() 输出如 "2026-06-03T06:13:00" 或 "2026-06-03T06:13:00Z"。
 */

function toDate(s?: string | null): Date | null {
  if (!s) return null
  // 没有时区后缀时，当作 UTC 处理（加 Z）
  const utcStr = /[Z+]/.test(s.slice(-6)) ? s : s.replace(' ', 'T') + 'Z'
  const d = new Date(utcStr)
  return isNaN(d.getTime()) ? null : d
}

function pad(n: number) { return String(n).padStart(2, '0') }

/** 返回 "MM-DD HH:mm"，例如 "06-03 14:13" */
export function fmtShort(s?: string | null): string {
  const d = toDate(s)
  if (!d) return s ? s.replace('T', ' ').slice(5, 16) : '-'
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 返回 "YYYY-MM-DD HH:mm"，例如 "2026-06-03 14:13" */
export function fmtFull(s?: string | null): string {
  const d = toDate(s)
  if (!d) return s ? s.replace('T', ' ').slice(0, 16) : '-'
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 返回 "HH:mm"，例如 "14:13" */
export function fmtTime(s?: string | null): string {
  const d = toDate(s)
  if (!d) return '-'
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 返回 "YYYY-MM-DD"，例如 "2026-06-03" */
export function fmtDate(s?: string | null): string {
  const d = toDate(s)
  if (!d) return s ? s.slice(0, 10) : '-'
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
