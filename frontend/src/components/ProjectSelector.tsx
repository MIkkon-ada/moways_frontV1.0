import { useProject } from '../context/ProjectContext'

// 角色英文 → 中文标签
const ROLE_LABEL: Record<string, string> = {
  super_admin: '超级管理员',
  owner: '负责人',
  coordinator: '统筹人',
  member: '成员',
  project_ceo: '项目CEO',
}

function roleLabels(roles: string[]): string {
  if (!roles || roles.length === 0) return ''
  return roles.map((r) => ROLE_LABEL[r] ?? r).join(' / ')
}

export function ProjectSelector() {
  const { projects, currentProjectId, currentProject, setCurrentProjectId, currentUser } = useProject()

  if (projects.length === 0) {
    return <span className="project-selector-empty">暂无可用项目</span>
  }

  const handleChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const val = event.target.value
    // super_admin 的"全局视图"占位项 value=""
    setCurrentProjectId(val === '' ? null : Number(val))
  }

  return (
    <div className="project-selector">
      <select
        className="project-selector-select"
        value={currentProjectId ?? ''}
        onChange={handleChange}
        aria-label="切换项目"
      >
        {currentUser?.is_tech_admin ? <option value="">全局视图</option> : null}
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.code ? `（${p.code}）` : ''}
          </option>
        ))}
      </select>
      {currentProject ? (
        <span className="project-selector-role">{roleLabels(currentProject.user_roles)}</span>
      ) : null}
    </div>
  )
}
