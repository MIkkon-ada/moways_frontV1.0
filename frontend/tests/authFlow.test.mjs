import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const sourcePath = join(root, 'src', 'domain', 'authFlow.ts')
const source = readFileSync(sourcePath, 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

const sandbox = { exports: {}, module: { exports: {} } }
sandbox.exports = sandbox.module.exports
vm.runInNewContext(compiled, sandbox, { filename: sourcePath })

const {
  normalizeLoginError,
  getPostLoginDestination,
  getProjectsLandingDestination,
  getProjectScopedNavigationDestination,
} = sandbox.module.exports

assert.equal(normalizeLoginError({ status: 401, message: 'Unauthorized' }), '账号或密码错误')
assert.equal(normalizeLoginError({ status: 403, message: 'account disabled' }), '账号已禁用，请联系管理员')
assert.equal(normalizeLoginError({ status: 423, message: 'locked' }), '密码错误次数过多，请稍后再试')
assert.equal(normalizeLoginError({ message: 'Failed to fetch' }), '无法连接服务器，请确认后端服务已启动')
assert.equal(normalizeLoginError({ status: 500, message: 'Internal Server Error' }), '服务器异常，请查看后端日志')
assert.equal(normalizeLoginError(new Error('自定义错误')), '自定义错误')

const projects = [{ id: 1 }, { id: 2 }]
assert.equal(getPostLoginDestination([], null), '/home')
assert.equal(getPostLoginDestination([{ id: 7 }], null), '/project/7')
assert.equal(getPostLoginDestination(projects, 2), '/project/2')
assert.equal(getPostLoginDestination(projects, 99), '/home')
assert.equal(getPostLoginDestination(projects, null), '/home')

assert.equal(getProjectsLandingDestination([{ id: 3 }]), '/project/3')
assert.equal(getProjectsLandingDestination([{ id: 3 }, { id: 4 }]), '/home')
assert.equal(getProjectsLandingDestination([]), '/home')

assert.equal(getProjectScopedNavigationDestination('settings', null, projects), '/home/settings')
assert.equal(getProjectScopedNavigationDestination('mytasks', null, projects), '/home')
assert.equal(getProjectScopedNavigationDestination('table', null, projects), '/home')
assert.equal(getProjectScopedNavigationDestination('table', 2, projects), '/project/2/tasks')
assert.equal(getProjectScopedNavigationDestination('dashboard', 2, projects), '/project/2')
assert.equal(getProjectScopedNavigationDestination('voice', 2, projects), '/project/2/submit')

console.log('authFlow tests passed')
