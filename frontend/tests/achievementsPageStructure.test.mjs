import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync('frontend/src/pages/AchievementsPage.tsx', 'utf8')

// ── 待确认成果状态管理 ────────────────────────────────────────────────────────
assert.match(source, /selectedSubmission/, 'selectedSubmission 状态应存在')
assert.match(source, /setSelectedSubmission\(sub\)/, 'setSelectedSubmission(sub) 赋值应存在')

// ── 待确认成果详情区域 ────────────────────────────────────────────────────────
assert.match(source, /待确认成果详情/, '待确认成果详情标签应存在')

// ── 负责人判断逻辑 ────────────────────────────────────────────────────────────
assert.match(source, /canReviewSubmission/, 'canReviewSubmission 函数应存在')
assert.match(source, /canWithdrawSubmission/, 'canWithdrawSubmission 函数应存在')
assert.match(source, /role === 'owner' \|\| role === '项目负责人'/, '负责人角色判断应覆盖 owner 和项目负责人')

// ── 负责人可见确认入口 ────────────────────────────────────────────────────────
assert.match(source, /canReviewSubmission\(selectedSubmission\)/, '详情区应根据 canReviewSubmission 显示确认按钮')

// ── 非负责人显示无权限提示 ───────────────────────────────────────────────────
assert.match(source, /仅项目负责人或技术管理员可确认入库/, '非负责人应看到无权限提示文案')
assert.match(source, /!canReviewSubmission/, '非负责人情况下应有 !canReviewSubmission 判断')

console.log('achievementsPageStructure tests passed')
