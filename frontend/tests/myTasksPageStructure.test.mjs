import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync('frontend/src/pages/MyTasksPage.tsx', 'utf8')

assert.ok(
  source.includes("style={{ background: '#F1F5F9' }}"),
  'my tasks page should use the owner-side slate background',
)

assert.ok(
  source.includes("boxShadow: '0 1px 4px rgba(15,23,42,0.06)'"),
  'my tasks page cards should use the same soft owner-side shadow',
)

assert.ok(
  source.includes('color="#0369A1"'),
  'in-progress stat and primary action colors should use the owner-side cyan-blue palette',
)

assert.ok(
  source.includes("linear-gradient(135deg, #0369A1, #0EA5E9)"),
  'primary member actions should use the owner-side gradient button treatment',
)

assert.equal(
  source.includes('<div className="flex flex-col h-full overflow-hidden" style={{ background: \'#F8FAFC\' }}>'),
  false,
  'the page should not keep the old flat light-blue root background',
)

console.log('myTasksPageStructure tests passed')
