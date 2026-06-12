import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useProject } from '../../context/ProjectContext'

type RequireAuthProps = {
  children: ReactNode
}

export function RequireAuth({ children }: RequireAuthProps) {
  const { authState } = useProject()

  if (authState !== 'authenticated') {
    return <Navigate to="/login" replace />
  }

  return <>{children}</>
}
