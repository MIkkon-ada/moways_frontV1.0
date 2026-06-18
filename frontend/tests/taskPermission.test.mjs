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
  canManageProjectWork,
  canManageProjectTrash,
  canEditSubTaskStatus,
} = loadTsModule('frontend/src/domain/taskPermission.ts')

assert.equal(
  canManageProjectWork({ isTechAdmin: false, projectRoles: ['member'], globalRoles: ['owner'] }),
  false,
  'owner role from another project must not grant current-project work permissions',
)

assert.equal(
  canManageProjectWork({ isTechAdmin: false, projectRoles: ['owner'], globalRoles: ['member'] }),
  true,
  'current-project owner can manage project work',
)

assert.equal(
  canManageProjectWork({ isTechAdmin: false, projectRoles: ['coordinator'], globalRoles: [] }),
  true,
  'current-project coordinator can manage project work',
)

assert.equal(
  canManageProjectTrash({ isTechAdmin: false, projectRoles: ['member'], globalRoles: ['owner'] }),
  false,
  'trash access must not be granted by global owner role',
)

assert.equal(
  canManageProjectTrash({ isTechAdmin: false, projectRoles: ['owner'], globalRoles: [] }),
  true,
  'current-project owner can manage trash',
)

assert.equal(
  canManageProjectTrash({ isTechAdmin: true, projectRoles: [], globalRoles: [] }),
  true,
  'tech admin can manage trash',
)

assert.equal(
  canEditSubTaskStatus({
    isTechAdmin: false,
    projectRoles: ['member'],
    globalRoles: ['owner'],
    currentUserName: 'Alice',
    assignee: 'Bob',
  }),
  false,
  'global owner role must not allow editing another user subtask in this project',
)

assert.equal(
  canEditSubTaskStatus({
    isTechAdmin: false,
    projectRoles: ['member'],
    globalRoles: [],
    currentUserName: 'Alice',
    assignee: 'Alice',
  }),
  true,
  'subtask assignee can submit their own status change',
)

console.log('taskPermission tests passed')
