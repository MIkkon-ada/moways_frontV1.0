import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function loadTsModule(path) {
  const source = fs.readFileSync(path, 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText
  const module = { exports: {} }
  const sandbox = { module, exports: module.exports }
  vm.runInNewContext(compiled, sandbox, { filename: path })
  return module.exports
}

const {
  buildVoiceUpdateHumanResult,
  filterSubtasksForVoiceContext,
  formatIssueItem,
  formatIssueItems,
  isValidSubtaskSuggestion,
} = loadTsModule('frontend/src/domain/voiceUpdateFlow.ts')

// ── buildVoiceUpdateHumanResult ───────────────────────────────────────────────

const llmResult = {
  special_project: 'AI猜错的项目',
  summary: '完成联调',
  task_reports: [{ type: 'progress', matched_subtask_id: 8, matched_subtask_title: '联调' }],
}
const editValues = { special_project: '用户编辑但不作为归属' }
const humanResult = buildVoiceUpdateHumanResult({
  result: llmResult,
  editValues,
  selectedProjectId: 2,
  selectedProjectName: 'ProjectB',
  taskReports: [{ type: 'progress', matched_subtask_id: 8, matched_subtask_title: '联调' }],
  keyTaskIssues: [{ description: '需要负责人确认', issue_type: '需决策' }],
})

assert.equal(humanResult.special_project, 'ProjectB')
assert.equal(humanResult.project_id, 2)
assert.deepEqual(Array.from(humanResult.task_reports), [{ type: 'progress', matched_subtask_id: 8, matched_subtask_title: '联调' }])
assert.deepEqual(Array.from(humanResult.key_task_issues), [{ description: '需要负责人确认', issue_type: '需决策' }])

// ── file_link 从 result 保留 ──────────────────────────────────────────────────
// ACH-file-link: AI 成果 result 中包含 file_link 时，buildVoiceUpdateHumanResult 应保留

const resultWithFileLink = {
  special_project: 'TestProject',
  file_link: 'https://wiki.example.com/doc.pdf',
  task_reports: [],
}
const hrWithFile = buildVoiceUpdateHumanResult({
  result: resultWithFileLink,
  editValues: {},
  selectedProjectId: 1,
  selectedProjectName: 'TestProject',
  taskReports: [],
  keyTaskIssues: [],
})
assert.equal(hrWithFile.file_link, 'https://wiki.example.com/doc.pdf', 'file_link from result should be preserved')

// editValues 覆盖 result 中的 file_link
const hrOverride = buildVoiceUpdateHumanResult({
  result: resultWithFileLink,
  editValues: { file_link: 'https://other.com/override.pdf' },
  selectedProjectId: 1,
  selectedProjectName: 'TestProject',
  taskReports: [],
  keyTaskIssues: [],
})
assert.equal(hrOverride.file_link, 'https://other.com/override.pdf', 'editValues should override result file_link')

// ── filterSubtasksForVoiceContext ─────────────────────────────────────────────

const subtasks = [
  { id: 1, parent_project_id: 2, title: 'B任务', status: '进行中', parent_key_task: 'B关键任务' },
  { id: 2, parent_project_id: 1, title: 'A任务', status: '进行中', parent_key_task: 'A关键任务' },
  { id: 3, parent_project_id: 2, title: '完成任务', status: '已完成', parent_key_task: 'B关键任务' },
]
assert.deepEqual(filterSubtasksForVoiceContext(subtasks, 2).map((s) => s.id), [1])

// ── formatIssueItem ───────────────────────────────────────────────────────────

assert.equal(formatIssueItem('普通问题'), '普通问题')
assert.equal(formatIssueItem({ issue_type: '风险', description: '字段规则未确认', priority: '高' }), '风险：字段规则未确认')
assert.equal(formatIssueItem({ issue_type: '需决策', description: '先做关键词还是标签' }), '需决策：先做关键词还是标签')
assert.deepEqual(formatIssueItems([
  { issue_type: '风险', description: '字段规则未确认' },
  { issue_type: '需决策', description: '先做关键词还是标签' },
]), ['风险：字段规则未确认', '需决策：先做关键词还是标签'])

// issue 格式不出现 [object Object]
const formatted = formatIssueItem({ issue_type: '风险', description: '字段规则' })
assert.ok(!formatted.includes('[object Object]'), `issue 格式不应包含 [object Object]，实际: ${formatted}`)
assert.ok(typeof formatted === 'string', 'formatIssueItem should return a string')

// 对象缺字段时不崩溃
assert.equal(formatIssueItem({}), '')
assert.equal(formatIssueItem(null), '')
assert.equal(formatIssueItem(undefined), '')

// ── isValidSubtaskSuggestion ──────────────────────────────────────────────────
// suggest_new_subtask 必须带 parent_task_id 才允许提交

assert.equal(isValidSubtaskSuggestion({ title: '新子任务', parent_task_id: 3 }), true)
assert.equal(isValidSubtaskSuggestion({ title: '新子任务', parent_task_id: 0 }), false, '0 不是有效的 parent_task_id')
assert.equal(isValidSubtaskSuggestion({ title: '新子任务' }), false, '缺少 parent_task_id')
assert.equal(isValidSubtaskSuggestion({ parent_task_id: 3 }), false, '缺少 title')
assert.equal(isValidSubtaskSuggestion({ title: '', parent_task_id: 3 }), false, '空 title')
assert.equal(isValidSubtaskSuggestion(null), false)
assert.equal(isValidSubtaskSuggestion(undefined), false)
assert.equal(isValidSubtaskSuggestion('string'), false)

console.log('voiceUpdateFlow tests passed')
