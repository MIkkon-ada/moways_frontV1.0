import { Routes, Route } from 'react-router-dom'
import { useProject } from '../context/ProjectContext'
import { RequireAuth } from './guards/RequireAuth'
import { RequireProject } from './guards/RequireProject'
import {
  LoginRoute,
  ProjectsLanding,
  RootRedirect,
  CenterMessage,
} from '../layouts/AppLayout'
import { ProjectLayout } from '../layouts/ProjectLayout'
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

export function AppRoutes() {
  const { authState } = useProject()

  if (authState === 'loading') {
    return <CenterMessage title="加载中..." />
  }

  return (
    <Routes>
      <Route path="/login" element={<LoginRoute />} />
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
