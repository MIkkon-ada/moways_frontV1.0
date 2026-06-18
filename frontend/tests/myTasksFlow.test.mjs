import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const sourcePath = join(root, 'src', 'domain', 'myTasksFlow.ts')
const source = readFileSync(sourcePath, 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

const sandbox = { exports: {}, module: { exports: {} } }
sandbox.exports = sandbox.module.exports
vm.runInNewContext(compiled, sandbox, { filename: sourcePath })

const {
  normalizeTaskStatus,
  filterMyTasksByProject,
  getMemberTaskActions,
  groupMyTasks,
} = sandbox.module.exports

assert.equal(normalizeTaskStatus('推进中'), '进行中')
assert.equal(normalizeTaskStatus('completed'), '已完成')
assert.equal(normalizeTaskStatus('暂停'), '暂缓')

const tasks = [
  { id: 1, parent_project_id: 10, status: '未开始' },
  { id: 2, parent_project_id: 20, status: '进行中' },
  { id: 3, parent_project_id: 10, status: '已完成' },
  { id: 4, parent_project_id: 10, status: '延期' },
]

assert.deepEqual(filterMyTasksByProject(tasks, null).map((t) => t.id), [1, 2, 3, 4])
assert.deepEqual(filterMyTasksByProject(tasks, 10).map((t) => t.id), [1, 3, 4])

assert.deepEqual(Array.from(getMemberTaskActions('未开始')), ['start', 'report_issue'])
assert.deepEqual(Array.from(getMemberTaskActions('进行中')), ['submit_progress', 'complete', 'report_issue', 'pause'])
assert.deepEqual(Array.from(getMemberTaskActions('已完成')), ['view_parent'])

const grouped = groupMyTasks(tasks)
assert.deepEqual(grouped['进行中'].map((t) => t.id), [2])
assert.deepEqual(grouped['未开始'].map((t) => t.id), [1])
assert.deepEqual(grouped['延期/暂缓'].map((t) => t.id), [4])
assert.deepEqual(grouped['已完成'].map((t) => t.id), [3])

console.log('myTasksFlow tests passed')
