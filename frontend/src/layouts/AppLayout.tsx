import { useState, type ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useProject } from '../context/ProjectContext'
import { getPostLoginDestination, getProjectsLandingDestination } from '../domain/authFlow'

export function CenterMessage({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-2">
      <div className="text-slate-700 font-semibold">{title}</div>
      {subtitle ? <div className="text-slate-400 text-sm">{subtitle}</div> : null}
    </div>
  )
}

function LoginPanel() {
  const { login, loading, error } = useProject()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    try {
      await login(username.trim(), password)
    } catch {
      // 错误已存入 context.error
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: '#F1F5F9' }}>
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4" style={{ background: 'linear-gradient(135deg,#0EA5E9,#0369A1)' }}>
            <svg style={{ width: 28, height: 28, color: 'white' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
            </svg>
          </div>
          <h1 className="text-xl font-bold text-slate-800 tracking-tight">博维 AI</h1>
          <p className="text-slate-500 text-sm mt-1">升级项目驾驶舱</p>
        </div>

        {/* Login card */}
        <form
          onSubmit={handleSubmit}
          className="bg-white rounded-2xl p-8 space-y-5"
          style={{ border: '1px solid #E9EFF6', boxShadow: '0 4px 20px rgba(15,23,42,0.08)' }}
        >
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1.5">姓名</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              placeholder="请输入姓名"
              className="w-full border border-slate-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:border-blue-400 transition"
              style={{ focusRingColor: 'rgba(14,165,233,0.2)' } as any}
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1.5">密码</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              placeholder="请输入密码"
              className="w-full border border-slate-200 rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:border-blue-400 transition"
            />
          </div>

          {error && (
            <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm" style={{ background: '#FEF2F2', border: '1px solid #FECACA', color: '#DC2626' }}>
              <svg style={{ width: 14, height: 14, flexShrink: 0 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !username || !password}
            className="w-full py-3 rounded-xl text-white text-sm font-bold transition-all hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ background: 'linear-gradient(135deg,#0369A1,#0EA5E9)', boxShadow: '0 2px 8px rgba(3,105,161,0.3)' }}
          >
            {loading ? '登录中…' : '登录'}
          </button>
        </form>

        <p className="text-center text-xs text-slate-400 mt-6">博维管理咨询 · 内部系统</p>
      </div>
    </div>
  )
}

export function LoginRoute() {
  const { authState, getPreferredProjectId, projects } = useProject()

  if (authState === 'authenticated') {
    return <Navigate to={getPostLoginDestination(projects, getPreferredProjectId())} replace />
  }

  return <LoginPanel />
}

export function ProjectsLanding() {
  const { projects } = useProject()
  return <Navigate to={getProjectsLandingDestination(projects)} replace />
}

export function RootRedirect() {
  const { authState, getPreferredProjectId, projects } = useProject()

  if (authState !== 'authenticated') {
    return <Navigate to="/login" replace />
  }

  const pid = getPreferredProjectId()
  return <Navigate to={getPostLoginDestination(projects, pid)} replace />
}

// Kept for backward compatibility
export function AppLayout({ children }: { children: React.ReactNode; showSelector?: boolean }) {
  return <div className="min-h-screen" style={{ background: '#F1F5F9' }}>{children}</div>
}
