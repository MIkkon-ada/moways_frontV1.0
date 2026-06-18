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

const { getAchievementAddressAction } = loadTsModule('frontend/src/domain/achievementFlow.ts')

// ── https 地址时允许打开 ──────────────────────────────────────────────────────
const openAction = getAchievementAddressAction('https://docs.example.com/a')
assert.equal(openAction.ok, true)
assert.equal(openAction.url, 'https://docs.example.com/a')

const openHttp = getAchievementAddressAction('http://internal.corp/wiki')
assert.equal(openHttp.ok, true, 'http 地址也应允许打开')

// ── 空白/null/undefined 不允许打开 ───────────────────────────────────────────
const missingAction = getAchievementAddressAction('   ')
assert.equal(missingAction.ok, false)
assert.equal(missingAction.message, '该成果暂未登记存储地址')

const nullAction = getAchievementAddressAction(null)
assert.equal(nullAction.ok, false)
assert.equal(nullAction.message, '该成果暂未登记存储地址')

const undefinedAction = getAchievementAddressAction(undefined)
assert.equal(undefinedAction.ok, false)
assert.equal(undefinedAction.message, '该成果暂未登记存储地址')

const emptyAction = getAchievementAddressAction('')
assert.equal(emptyAction.ok, false)
assert.equal(emptyAction.message, '该成果暂未登记存储地址', '空字符串应提示未登记地址')

// ── 占位符不允许打开 ─────────────────────────────────────────────────────────
const placeholders = ['无', '-', '暂无', '未填写', '无地址']
for (const placeholder of placeholders) {
  const action = getAchievementAddressAction(placeholder)
  assert.equal(action.ok, false, `"${placeholder}" 不应被视为有效地址`)
  assert.equal(action.message, '该成果暂未登记存储地址', `"${placeholder}" 应提示未登记地址`)
}

// 前后有空格的占位符也不允许
const paddedAction = getAchievementAddressAction('  无  ')
assert.equal(paddedAction.ok, false, '带空格的"无"应被 trim 后识别为占位符')

console.log('achievementFlow tests passed')
