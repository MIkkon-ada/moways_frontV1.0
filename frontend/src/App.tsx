import { BrowserRouter } from 'react-router-dom'
import { ProjectProvider } from './context/ProjectContext'
import { AppRoutes } from './app/routes'

export default function App() {
  return (
    <BrowserRouter>
      <ProjectProvider>
        <AppRoutes />
      </ProjectProvider>
    </BrowserRouter>
  )
}
