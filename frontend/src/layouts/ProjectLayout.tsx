import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, Outlet } from 'react-router-dom'
import { Sidebar } from '../components/Sidebar'
import { useProject } from '../context/ProjectContext'
import { getPlatformSettings } from '../api/platformSettings'
import type { AppPage } from '../types'

type PageSegment = 'tasks' | 'achievements' | 'issues' | 'confirm' | 'coordinate' | 'decisions' | 'submit' | 'meeting' | 'settings'

const PATH_TO_PAGE: Record<PageSegment, AppPage> = {
  tasks: 'table',
  achievements: 'achievements',
  issues: 'issues',
  confirm: 'confirm',
  coordinate: 'coordinate',
  decisions: 'decisions',
  submit: 'voice',
  meeting: 'meeting',
  settings: 'settings',
}

const PAGE_TO_PATH: Record<AppPage, string> = {
  dashboard: '',
  table: 'tasks',
  achievements: 'achievements',
  issues: 'issues',
  confirm: 'confirm',
  coordinate: 'coordinate',
  decisions: 'decisions',
  voice: 'submit',
  meeting: 'meeting',
  settings: 'settings',
}

export function NoProjectHome({ isAdmin }: { isAdmin: boolean }) {
  return (
    <div className="flex-1 flex items-center justify-center" style={{ background: '#F1F5F9' }}>
      <div className="flex flex-col items-center gap-4 text-center">
        <div
          className="w-16 h-16 rounded-2xl flex items-center justify-center"
          style={{ background: 'linear-gradient(135deg,#0EA5E9,#0369A1)' }}
        >
          <svg style={{ width: 30, height: 30, color: 'white' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
          </svg>
        </div>
        <div>
          <div className="text-slate-700 font-semibold text-base">欢迎使用博维 AI 驾驶舱</div>
          <div className="text-slate-400 text-sm mt-1">
            {isAdmin ? '请在系统设置中创建项目并配置成员' : '请等待管理员为您分配项目'}
          </div>
        </div>
        {isAdmin && (
          <a
            href="/home/settings"
            className="px-5 py-2 rounded-xl text-white text-sm font-semibold"
            style={{ background: 'linear-gradient(135deg,#0369A1,#0EA5E9)' }}
          >
            前往系统设置
          </a>
        )}
      </div>
    </div>
  )
}

export function ProjectLayout() {
  const { currentProjectId, currentUser, currentProjectRoles, logout, projects } = useProject()
  const location = useLocation()
  const navigate = useNavigate()

  const [logoUrl, setLogoUrl] = useState<string | null>(null)
  const [platformName, setPlatformName] = useState<string | undefined>(undefined)

  useEffect(() => {
    getPlatformSettings()
      .then((d) => {
        setLogoUrl(d.logo_url)
        setPlatformName(d.platform_name)
      })
      .catch(() => {})
  }, [])

  const segment = (location.pathname.split('/')[3] ?? '') as PageSegment | ''
  const activePage: AppPage = segment && PATH_TO_PAGE[segment] ? PATH_TO_PAGE[segment] : 'dashboard'

  const handleNavigate = (page: AppPage) => {
    const targetId = currentProjectId ?? (projects.length > 0 ? projects[0].id : null)
    if (targetId === null) {
      if (page === 'settings') navigate('/home/settings')
      return
    }
    const suffix = PAGE_TO_PATH[page]
    navigate(`/project/${targetId}${suffix ? `/${suffix}` : ''}`)
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        activePage={activePage}
        onNavigate={handleNavigate}
        currentUser={currentUser}
        currentProjectRoles={currentProjectRoles}
        onLogout={logout}
        logoUrl={logoUrl}
        platformName={platformName}
      />
      <div className="flex-1 flex flex-col overflow-hidden">
        <Outlet />
      </div>
    </div>
  )
}
