import { useEffect, useState } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useProject } from '../context/ProjectContext'
import { RequireAuth } from './guards/RequireAuth'
import { RequireProject } from './guards/RequireProject'
import {
  LoginRoute,
  ProjectsLanding,
  RootRedirect,
  CenterMessage,
} from '../layouts/AppLayout'
import { ProjectLayout, NoProjectHome } from '../layouts/ProjectLayout'
import { AdminLayout } from '../layouts/AdminLayout'
import { DashboardPage } from '../pages/DashboardPage'
import { ConfirmPage } from '../pages/ConfirmPage'
import { MeetingPage } from '../pages/MeetingPage'
import { TaskManagementPage } from '../pages/TaskManagementPage'
import { VoiceUpdatePage } from '../pages/VoiceUpdatePage'
import { AchievementsPage } from '../pages/AchievementsPage'
import { IssuesPage } from '../pages/IssuesPage'
import { CoordinatePage } from '../pages/CoordinatePage'
import { DecisionPage } from '../pages/DecisionPage'
import { SettingsPage } from '../pages/SettingsPage'
import { ProjectAdminPage } from '../pages/ProjectAdminPage'
import { ProjectMembersPage } from '../pages/ProjectMembersPage'
import { SetupPage } from '../pages/SetupPage'

function HomeIndex() {
  const { currentUser } = useProject()
  return <NoProjectHome isAdmin={!!currentUser?.is_tech_admin} />
}

type SetupState = 'loading' | 'needed' | 'done'

export function AppRoutes() {
  const { authState } = useProject()
  const [setupState, setSetupState] = useState<SetupState>('loading')

  useEffect(() => {
    fetch('/api/setup/status')
      .then((r) => r.json())
      .then((d) => setSetupState(d.initialized ? 'done' : 'needed'))
      .catch(() => setSetupState('done'))
  }, [])

  if (setupState === 'loading' || authState === 'loading') {
    return <CenterMessage title="加载中..." />
  }

  if (setupState === 'needed') {
    return (
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="*" element={<Navigate to="/setup" replace />} />
      </Routes>
    )
  }

  return (
    <Routes>
      <Route path="/setup" element={<Navigate to="/login" replace />} />
      <Route path="/login" element={<LoginRoute />} />
      <Route
        path="/home"
        element={
          <RequireAuth>
            <ProjectLayout />
          </RequireAuth>
        }
      >
        <Route index element={<HomeIndex />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
      <Route
        path="/projects"
        element={
          <RequireAuth>
            <ProjectsLanding />
          </RequireAuth>
        }
      />
      <Route
        path="/project/:projectId"
        element={
          <RequireAuth>
            <RequireProject>
              <ProjectLayout />
            </RequireProject>
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="tasks" element={<TaskManagementPage />} />
        <Route path="achievements" element={<AchievementsPage />} />
        <Route path="issues" element={<IssuesPage />} />
        <Route path="confirm" element={<ConfirmPage />} />
        <Route path="coordinate" element={<CoordinatePage />} />
        <Route path="decisions" element={<DecisionPage />} />
        <Route path="submit" element={<VoiceUpdatePage />} />
        <Route path="meeting" element={<MeetingPage />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
      <Route
        path="/admin/projects"
        element={
          <RequireAuth>
            <AdminLayout />
          </RequireAuth>
        }
      >
        <Route index element={<ProjectAdminPage />} />
        <Route path=":projectId/members" element={<ProjectMembersPage />} />
      </Route>
      <Route path="*" element={<RootRedirect />} />
    </Routes>
  )
}
