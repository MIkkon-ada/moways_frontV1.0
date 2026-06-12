import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { getCurrentUser, login as apiLogin, logout as apiLogout } from '../api/auth'
import { getProjects } from '../api/projects'
import { ApiError } from '../api/client'
import type { CurrentUser, Project } from '../types'

const LS_LAST_PROJECT = 'bowei_last_project_id'

// 从路径中解析 /project/:projectId
function parseProjectIdFromPath(pathname: string): number | null {
  const m = pathname.match(/^\/project\/(\d+)/)
  return m ? Number(m[1]) : null
}

type ProjectContextValue = {
  authState: 'loading' | 'unauthenticated' | 'authenticated'
  currentUser: CurrentUser | null

  projects: Project[]
  currentProjectId: number | null      // 第一事实来源：URL
  currentProject: Project | null
  currentProjectRoles: string[]

  loading: boolean
  error: string | null

  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
  setCurrentProjectId: (id: number | null) => void   // 通过路由跳转实现
  reloadProjects: () => Promise<void>
  /** 登录后/无 URL 时计算应落地的项目：单项目→其 id；多项目→localStorage 命中；否则 null */
  getPreferredProjectId: () => number | null
}

const ProjectContext = createContext<ProjectContextValue | null>(null)

export function ProjectProvider({ children }: { children: ReactNode }) {
  const location = useLocation()
  const navigate = useNavigate()

  const [authState, setAuthState] = useState<'loading' | 'unauthenticated' | 'authenticated'>('loading')
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null)
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // currentProjectId 始终来自 URL
  const currentProjectId = useMemo(
    () => parseProjectIdFromPath(location.pathname),
    [location.pathname],
  )

  // 进入某项目时记忆到 localStorage（用于下次无 URL 时恢复）
  useEffect(() => {
    if (currentProjectId !== null) {
      localStorage.setItem(LS_LAST_PROJECT, String(currentProjectId))
    }
  }, [currentProjectId])

  // 切换项目 = 路由跳转（保留当前子路径，如 /tasks）
  const setCurrentProjectId = useCallback(
    (id: number | null) => {
      if (id === null) {
        navigate('/projects')
      } else {
        localStorage.setItem(LS_LAST_PROJECT, String(id))
        const subPath = location.pathname.split('/').slice(3).join('/')
        navigate(`/project/${id}${subPath ? `/${subPath}` : ''}`)
      }
    },
    [navigate, location.pathname],
  )

  const reloadProjects = useCallback(async () => {
    const list = await getProjects()
    setProjects(list)
  }, [])

  // 计算优先落地项目：有项目时始终返回一个 id（读 localStorage 或取第一个），无项目返回 null
  const getPreferredProjectId = useCallback((): number | null => {
    if (projects.length === 0) return null
    if (projects.length === 1) return projects[0].id
    const saved = localStorage.getItem(LS_LAST_PROJECT)
    const savedId = saved ? Number(saved) : NaN
    return projects.find((p) => p.id === savedId)?.id ?? projects[0].id
  }, [projects])

  // 启动探测会话
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const user = await getCurrentUser()
        if (cancelled) return
        setCurrentUser(user)
        await reloadProjects()
        if (!cancelled) setAuthState('authenticated')
      } catch (err) {
        if (cancelled) return
        setAuthState('unauthenticated')
        if (!(err instanceof ApiError && err.isUnauthorized)) {
          setError(err instanceof Error ? err.message : '初始化失败')
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [reloadProjects])

  const login = useCallback(
    async (username: string, password: string) => {
      setLoading(true)
      setError(null)
      try {
        await apiLogin(username, password)
        const user = await getCurrentUser()
        setCurrentUser(user)
        await reloadProjects()
        setAuthState('authenticated')
      } catch (err) {
        setError(err instanceof Error ? err.message : '登录失败')
        throw err
      } finally {
        setLoading(false)
      }
    },
    [reloadProjects],
  )

  const logout = useCallback(async () => {
    try {
      await apiLogout()
    } catch {
      // 忽略退出接口错误
    }
    setCurrentUser(null)
    setProjects([])
    setError(null)
    setAuthState('unauthenticated')
    navigate('/login')
  }, [navigate])

  const currentProject = useMemo(
    () => projects.find((p) => p.id === currentProjectId) ?? null,
    [projects, currentProjectId],
  )

  const value: ProjectContextValue = {
    authState,
    currentUser,
    projects,
    currentProjectId,
    currentProject,
    currentProjectRoles: currentProject?.user_roles ?? [],
    loading,
    error,
    login,
    logout,
    setCurrentProjectId,
    reloadProjects,
    getPreferredProjectId,
  }

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>
}

export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext)
  if (!ctx) {
    throw new Error('useProject 必须在 ProjectProvider 内使用')
  }
  return ctx
}
