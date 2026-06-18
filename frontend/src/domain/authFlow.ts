type ApiLikeError = {
  status?: number
  message?: string
}

type ProjectRef = {
  id: number
}

function hasMessage(error: unknown, pattern: RegExp): boolean {
  return pattern.test(String((error as ApiLikeError | undefined)?.message ?? ''))
}

export function normalizeLoginError(error: unknown): string {
  const status = (error as ApiLikeError | undefined)?.status
  if (status === 401) return '账号或密码错误'
  if (status === 403) return '账号已禁用，请联系管理员'
  if (status === 423) return '密码错误次数过多，请稍后再试'
  if (status && status >= 500) return '服务器异常，请查看后端日志'
  if (hasMessage(error, /Failed to fetch|NetworkError|Network request failed|Load failed/i)) {
    return '无法连接服务器，请确认后端服务已启动'
  }
  const message = String((error as ApiLikeError | undefined)?.message ?? '')
  if (message) return message
  return '登录失败，请稍后重试'
}

export function getPostLoginDestination(projects: ProjectRef[], preferredProjectId: number | null): string {
  if (projects.length === 0) return '/home'
  if (projects.length === 1) return `/project/${projects[0].id}`
  if (preferredProjectId !== null && projects.some((p) => p.id === preferredProjectId)) {
    return `/project/${preferredProjectId}`
  }
  return '/home'
}

export function getProjectsLandingDestination(projects: ProjectRef[]): string {
  return projects.length === 1 ? `/project/${projects[0].id}` : '/home'
}

export function getProjectScopedNavigationDestination(
  page: string,
  currentProjectId: number | null,
  _projects: ProjectRef[],
): string {
  const pagePath: Record<string, string> = {
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
    mytasks: 'mytasks',
  }

  if (currentProjectId === null) {
    if (page === 'settings') return '/home/settings'
    return '/home'
  }

  const suffix = pagePath[page] ?? ''
  return `/project/${currentProjectId}${suffix ? `/${suffix}` : ''}`
}
