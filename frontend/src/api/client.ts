// 统一 API 客户端：所有请求带 cookie 凭证，统一错误处理。
// 后端为 session-cookie 鉴权（bowei_session），必须 credentials: "include"。

export class ApiError extends Error {
  status: number
  body: unknown

  constructor(status: number, message: string, body: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }

  /** 401 未登录，App 层据此跳转登录界面。 */
  get isUnauthorized(): boolean {
    return this.status === 401
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  let payload: BodyInit | undefined

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }

  const response = await fetch(path, {
    method,
    credentials: 'include',
    headers,
    body: payload,
  })

  // 尝试解析响应体（无论成功失败，便于页面提示）
  let parsed: unknown = null
  const text = await response.text()
  if (text) {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
  }

  if (!response.ok) {
    const message = extractMessage(parsed) || `请求失败：${response.status}`
    throw new ApiError(response.status, message, parsed)
  }

  return parsed as T
}

function extractMessage(body: unknown): string {
  if (!body || typeof body !== 'object') return ''
  const detail = (body as { detail?: unknown }).detail
  if (typeof detail === 'string') return detail
  // 后端部分接口 detail 是对象（如 409 last-owner / 422 缺 project_id）
  if (detail && typeof detail === 'object') {
    const msg = (detail as { message?: unknown }).message
    if (typeof msg === 'string') return msg
  }
  return ''
}

export function apiGet<T>(path: string): Promise<T> {
  return request<T>('GET', path)
}

export function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>('POST', path, body)
}

export function apiPatch<T>(path: string, body?: unknown): Promise<T> {
  return request<T>('PATCH', path, body)
}

export async function apiUpload<T>(path: string, formData: FormData): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    body: formData,
  })
  let parsed: unknown = null
  const text = await response.text()
  if (text) { try { parsed = JSON.parse(text) } catch { parsed = text } }
  if (!response.ok) {
    const detail = parsed && typeof parsed === 'object' ? (parsed as { detail?: unknown }).detail : null
    const msg = typeof detail === 'string' ? detail : `上传失败：${response.status}`
    throw new ApiError(response.status, msg, parsed)
  }
  return parsed as T
}

export function apiPut<T>(path: string, body?: unknown): Promise<T> {
  return request<T>('PUT', path, body)
}

export function apiDelete<T>(path: string): Promise<T> {
  return request<T>('DELETE', path)
}
