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
  classifyConfirmation,
  buildConfirmationEffects,
  getConfirmationContext,
} = loadTsModule('frontend/src/domain/confirmationFlow.ts')

const progress = {
  project_id: 7,
  submitter: 'memberA',
  source_type: '我的任务-进展更新',
  special_project: 'ProjectA',
  related_task: '关键任务A',
  task_reports: [
    {
      type: 'progress',
      matched_subtask_id: 11,
      matched_subtask_title: '子任务A',
      completed: '完成接口联调',
      status_update: '进行中',
      achievements: [],
      subtask_issues: [],
    },
  ],
}

assert.equal(classifyConfirmation(progress).type, 'progress_update')
assert.deepEqual(Array.from(buildConfirmationEffects(progress)), [
  '更新 1 个已匹配子任务的进展记录',
  '保留所属关键任务状态，由负责人判断是否关闭',
])
assert.deepEqual(JSON.parse(JSON.stringify(getConfirmationContext(progress))), {
  sourceType: '我的任务-进展更新',
  submitter: 'memberA',
  projectName: 'ProjectA',
  keyTaskName: '关键任务A',
  subtaskNames: ['子任务A'],
})

const completion = {
  ...progress,
  task_reports: [{ ...progress.task_reports[0], status_update: '已完成' }],
}
assert.equal(classifyConfirmation(completion).type, 'subtask_completion')
assert.deepEqual(Array.from(buildConfirmationEffects(completion)), [
  '将 1 个已匹配子任务标记为已完成',
  '保留所属关键任务状态，由负责人判断是否关闭',
])

const statusUpdate = {
  result_type: 'subtask_status_update',
  source_type: '子任务状态变更',
  submitter: 'memberA',
  special_project: 'ProjectA',
  related_task: '关键任务A',
  key_task: '关键任务A',
  subtask_id: 12,
  subtask_title: '子任务A',
  from_status: '进行中',
  to_status: '已完成',
  suggested_status: '已完成',
}
assert.equal(classifyConfirmation(statusUpdate).type, 'subtask_completion')
assert.deepEqual(JSON.parse(JSON.stringify(getConfirmationContext(statusUpdate))), {
  sourceType: '子任务状态变更',
  submitter: 'memberA',
  projectName: 'ProjectA',
  keyTaskName: '关键任务A',
  subtaskNames: ['子任务A'],
})

const issueOnly = {
  source_type: '我的任务-问题上报',
  submitter: 'memberA',
  special_project: 'ProjectA',
  key_task_issues: [{ issue_type: '需决策', description: '需要确认上线时间' }],
}
assert.equal(classifyConfirmation(issueOnly).type, 'issue_report')
assert.deepEqual(Array.from(buildConfirmationEffects(issueOnly)), ['写入问题与决策 1 条'])

const mixed = {
  ...completion,
  key_task_issues: [{ issue_type: '风险', description: '供应商延期' }],
}
assert.equal(classifyConfirmation(mixed).type, 'mixed_update')
assert.deepEqual(Array.from(buildConfirmationEffects(mixed)), [
  '将 1 个已匹配子任务标记为已完成',
  '写入问题与决策 1 条',
  '保留所属关键任务状态，由负责人判断是否关闭',
])

console.log('confirmationFlow tests passed')
