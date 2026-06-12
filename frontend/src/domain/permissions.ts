import type { CurrentUser } from '../types'

export type ProjectRole = 'owner' | 'member' | 'coordinator' | 'project_ceo'

type CurrentUserLike = Pick<CurrentUser, 'is_tech_admin'> | null | undefined

export function isSuperAdmin(user: CurrentUserLike): boolean {
  return Boolean(user?.is_tech_admin)
}

export function hasProjectRole(roles: readonly string[] | null | undefined, role: ProjectRole): boolean {
  return roles?.includes(role) ?? false
}

function hasAnyProjectRole(roles: readonly string[] | null | undefined): boolean {
  return Boolean(
    roles?.some((role) =>
      role === 'owner' ||
      role === 'member' ||
      role === 'coordinator' ||
      role === 'project_ceo',
    ),
  )
}

function hasProjectAccess(user: CurrentUserLike, roles: readonly string[] | null | undefined): boolean {
  return isSuperAdmin(user) || hasAnyProjectRole(roles)
}

export function canViewProjectDashboard(user: CurrentUserLike, roles: readonly string[] | null | undefined): boolean {
  return hasProjectAccess(user, roles)
}

export function canViewTasks(user: CurrentUserLike, roles: readonly string[] | null | undefined): boolean {
  return hasProjectAccess(user, roles)
}

export function canViewAchievements(user: CurrentUserLike, roles: readonly string[] | null | undefined): boolean {
  return hasProjectAccess(user, roles)
}

export function canViewIssues(user: CurrentUserLike, roles: readonly string[] | null | undefined): boolean {
  return hasProjectAccess(user, roles)
}

export function canViewMeetings(user: CurrentUserLike, roles: readonly string[] | null | undefined): boolean {
  return hasProjectAccess(user, roles)
}

export function canSubmitUpdate(user: CurrentUserLike, roles: readonly string[] | null | undefined): boolean {
  return isSuperAdmin(user) || hasProjectRole(roles, 'owner') || hasProjectRole(roles, 'member') || hasProjectRole(roles, 'coordinator')
}

export function canWriteProjectMainData(user: CurrentUserLike, roles: readonly string[] | null | undefined): boolean {
  return isSuperAdmin(user) || hasProjectRole(roles, 'owner')
}

export function canViewOwnerConfirmCenter(user: CurrentUserLike, roles: readonly string[] | null | undefined): boolean {
  return isSuperAdmin(user) || hasProjectRole(roles, 'owner')
}

export function canViewConfirmCenter(user: CurrentUserLike, roles: readonly string[] | null | undefined): boolean {
  return (
    canViewOwnerConfirmCenter(user, roles) ||
    canViewCoordinatorReview(user, roles) ||
    canViewCeoDecision(user, roles)
  )
}

export function canViewCoordinatorReview(user: CurrentUserLike, roles: readonly string[] | null | undefined): boolean {
  return isSuperAdmin(user) || hasProjectRole(roles, 'coordinator')
}

export function canViewCeoDecision(user: CurrentUserLike, roles: readonly string[] | null | undefined): boolean {
  return isSuperAdmin(user) || hasProjectRole(roles, 'project_ceo')
}

export function canManageProjects(user: CurrentUserLike): boolean {
  return isSuperAdmin(user)
}

export function canManageProjectMembers(user: CurrentUserLike): boolean {
  return isSuperAdmin(user)
}

export function canViewGlobalOverview(user: CurrentUserLike): boolean {
  return isSuperAdmin(user)
}
