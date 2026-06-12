import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useProject } from '../../context/ProjectContext'

type RequireProjectProps = {
  children: ReactNode
}

export function RequireProject({ children }: RequireProjectProps) {
  const { currentProjectId, projects } = useProject()

  if (currentProjectId === null) {
    return <Navigate to="/projects" replace />
  }

  const hasVisibleProject = projects.some((project) => project.id === currentProjectId)
  if (!hasVisibleProject) {
    return <Navigate to="/projects" replace />
  }

  return <>{children}</>
}
