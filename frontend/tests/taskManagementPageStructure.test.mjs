import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync('frontend/src/pages/TaskManagementPage.tsx', 'utf8')

assert.match(
  source,
  /data-testid="work-progress-detail-panel"/,
  'work progress page should render details in a right-side panel',
)

assert.doesNotMatch(
  source,
  /\/\*\s*Detail Panel\s*\*\/[\s\S]{0,800}fixed inset-0/,
  'key task detail should not be rendered as a centered full-screen modal',
)

assert.match(
  source,
  /点选左侧项目、关键任务或子任务查看详情|选择左侧项目、关键任务或子任务查看详情/,
  'empty detail panel should guide users to select a project, key task, or subtask',
)

console.log('taskManagementPageStructure tests passed')
