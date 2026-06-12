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

export function ProjectLayout() {
  const { currentProjectId, currentUser, currentProjectRoles, logout } = useProject()
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

  const projectId = currentProjectId as number
  const segment = (location.pathname.split('/')[3] ?? '') as PageSegment | ''
  const activePage: AppPage = segment && PATH_TO_PAGE[segment] ? PATH_TO_PAGE[segment] : 'dashboard'

  const handleNavigate = (page: AppPage) => {
    const suffix = PAGE_TO_PATH[page]
    navigate(`/project/${projectId}${suffix ? `/${suffix}` : ''}`)
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
