import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync('frontend/src/pages/VoiceUpdatePage.tsx', 'utf8')

assert.ok(
  source.includes("gridTemplateColumns: '360px minmax(0, 1fr)'"),
  'voice update layout should give the input column a fixed compact width and the review area the remaining space'
)

assert.ok(
  source.indexOf('提取模型') > -1 && source.indexOf('提取模型') < source.indexOf('本次更新内容'),
  'model selector should live in the left input area before the update text'
)

assert.ok(
  source.includes('修改归属') && source.includes('本次完成') && source.includes('下一步计划'),
  'review area should show the ownership edit action and the new card sections'
)

assert.equal(
  source.includes('<span className="w-16 flex-shrink-0 text-xs font-semibold text-slate-400">专项</span>'),
  false,
  'review area should not keep the old bottom project dropdown row'
)

console.log('voiceUpdatePageStructure tests passed')
