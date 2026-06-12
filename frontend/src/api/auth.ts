import { apiGet, apiPost } from './client'
import type { CurrentUser } from '../types'

// 登录：POST /api/auth/login（公开接口，无需 cookie）
export function login(username: string, password: string): Promise<{ ok: boolean; username: string }> {
  return apiPost('/api/auth/login', { username, password })
}

// 退出：POST /api/auth/logout
export function logout(): Promise<{ ok: boolean }> {
  return apiPost('/api/auth/logout')
}

// 当前用户：GET /api/people/me（返回角色/权限上下文，比 /api/auth/me 更丰富）
export function getCurrentUser(): Promise<CurrentUser> {
  return apiGet<CurrentUser>('/api/people/me')
}
