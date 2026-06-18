import { useEffect, useRef, useState } from 'react'
import { useProject } from '../context/ProjectContext'
import { getPlatformSettings, savePlatformSettings } from '../api/platformSettings'
import { getProjects, getProjectMembers, createProject, patchProject, archiveProject, addProjectMember, updateProjectMember, removeProjectMember, batchImportProjects } from '../api/projects'
import type { BatchImportRow } from '../api/projects'
import { getLLMConfigs, saveLLMConfig, type LLMProviderConfig } from '../api/llmConfig'
import { fetchPeople, createPerson, updatePerson, deletePerson, batchCreatePeople, type BatchPersonItem } from '../api/people'
import { createAccount, fetchAccounts, resetAccountPassword, updateAccountStatus, type AccountItem } from '../api/accounts'
import { fetchGlobalLogs, type OperationLogItem } from '../api/logs'
import type { Project, ProjectMember, Person } from '../types'

type Section = 'basic' | 'notify' | 'ai' | 'security' | 'integration' | 'data' | 'logs' | 'projects-mgmt' | 'people-mgmt'

const SECTIONS: { key: Section; label: string; icon: React.ReactNode }[] = [
  { key: 'basic', label: '基础信息', icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" /> },
  { key: 'notify', label: '通知与提醒', icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" /> },
  { key: 'ai', label: 'AI 能力配置', icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /> },
  { key: 'security', label: '安全与权限', icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" /> },
  { key: 'integration', label: '集成与接口', icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" /> },
  { key: 'data', label: '数据与备份', icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" /> },
  { key: 'logs', label: '操作日志', icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /> },
  { key: 'projects-mgmt', label: '项目管理', icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" /> },
  { key: 'people-mgmt', label: '人员管理', icon: <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /> },
]

const THEME_COLORS = ['#0369A1', '#7C3AED', '#059669', '#DC2626', '#D97706', '#0F172A']

export function SettingsPage() {
  const { currentUser, reloadProjects } = useProject()
  const [activeSection, setActiveSection] = useState<Section>('basic')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null)

  // 基础信息
  const [logoUrl, setLogoUrl] = useState<string | null>(null)
  const logoInputRef = useRef<HTMLInputElement>(null)
  const [platformName, setPlatformName] = useState('博维AI升级项目驾驶舱')
  const [language, setLanguage] = useState<'zh' | 'en'>('zh')
  const [timezone, setTimezone] = useState('（GMT+08:00）北京、上海、香港')
  const [themeColor, setThemeColor] = useState('#0369A1')

  // 通知
  const [notifyDelay, setNotifyDelay] = useState(true)
  const [notifyAI, setNotifyAI] = useState(true)
  const [notifyDecision, setNotifyDecision] = useState(true)
  const [notifyWeekly, setNotifyWeekly] = useState(false)
  const [channels, setChannels] = useState<Set<string>>(new Set(['站内信', '企业微信']))

  // AI
  const [confidence, setConfidence] = useState(75)

  // 安全
  const [twoFA, setTwoFA] = useState(true)
  const [sessionTTL, setSessionTTL] = useState('8 小时')

  // ── 初始加载 ──
  useEffect(() => {
    getPlatformSettings()
      .then((d) => {
        if (d.logo_url) setLogoUrl(d.logo_url)
        setPlatformName(d.platform_name)
        setLanguage(d.language)
        setTimezone(d.timezone)
        setThemeColor(d.theme_color)
        setNotifyDelay(d.notify_delay)
        setNotifyAI(d.notify_ai)
        setNotifyDecision(d.notify_decision)
        setNotifyWeekly(d.notify_weekly)
        setChannels(new Set(d.notify_channels))
        setConfidence(d.confidence)
        setTwoFA(d.two_fa)
        setSessionTTL(d.session_ttl)
      })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  // ── Logo 选图（转 base64 以便持久化）──
  function handleLogoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => setLogoUrl(reader.result as string)
    reader.readAsDataURL(file)
  }

  function toggleChannel(ch: string) {
    setChannels((prev) => {
      const next = new Set(prev)
      next.has(ch) ? next.delete(ch) : next.add(ch)
      return next
    })
  }

  function showToast(msg: string, ok = true) {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 2500)
  }

  // ── 保存 ──
  async function handleSave() {
    setSaving(true)
    try {
      await savePlatformSettings({
        logo_url: logoUrl,
        platform_name: platformName,
        language,
        timezone,
        theme_color: themeColor,
        notify_delay: notifyDelay,
        notify_ai: notifyAI,
        notify_decision: notifyDecision,
        notify_weekly: notifyWeekly,
        notify_channels: [...channels],
        confidence,
        two_fa: twoFA,
        session_ttl: sessionTTL,
      })
      showToast('设置已保存')
      setTimeout(() => window.location.reload(), 1200)
    } catch {
      showToast('保存失败，请重试', false)
    } finally {
      setSaving(false)
    }
  }

  if (!currentUser?.is_tech_admin) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 text-slate-400">
        <svg style={{ width: 48, height: 48, opacity: 0.3 }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
        </svg>
        <p className="text-sm font-semibold">无权限访问</p>
        <p className="text-xs">仅超级管理员可访问系统设置</p>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Toast */}
      {toast && (
        <div
          className="fixed top-5 left-1/2 z-50 flex items-center gap-2 px-5 py-3 rounded-xl text-sm font-semibold text-white shadow-lg"
          style={{
            transform: 'translateX(-50%)',
            background: toast.ok ? 'linear-gradient(135deg,#059669,#34D399)' : 'linear-gradient(135deg,#DC2626,#F87171)',
            boxShadow: toast.ok ? '0 4px 20px rgba(5,150,105,0.35)' : '0 4px 20px rgba(220,38,38,0.35)',
          }}
        >
          <svg style={{ width: 16, height: 16 }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d={toast.ok ? 'M5 13l4 4L19 7' : 'M6 18L18 6M6 6l12 12'} />
          </svg>
          {toast.msg}
        </div>
      )}

      {/* Top Bar */}
      <header className="h-16 flex items-center px-6 gap-3 flex-shrink-0 bg-white border-b" style={{ borderColor: '#E9EFF6' }}>
        <div className="flex-1">
          <h1 className="text-base font-bold text-slate-800">系统设置</h1>
          <p className="text-xs text-slate-400 mt-0.5">配置平台基础信息、通知、AI 能力、安全与集成</p>
        </div>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="cursor-pointer px-4 py-2 rounded-lg border border-slate-200 text-slate-500 text-sm font-semibold hover:bg-slate-50 transition-colors"
        >
          取消
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || loading}
          className="cursor-pointer flex items-center gap-2 px-4 py-2 rounded-lg text-white text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-60"
          style={{ background: 'linear-gradient(135deg,#0369A1,#0EA5E9)', boxShadow: '0 2px 8px rgba(3,105,161,0.25)' }}
        >
          <svg style={{ width: 14, height: 14 }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" />
          </svg>
          {saving ? '保存中…' : '保存更改'}
        </button>
      </header>

      {loading ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-slate-400">加载中…</p>
        </div>
      ) : (
        <div className="flex-1 overflow-hidden flex">

          {/* Secondary nav */}
          <div className="w-52 flex-shrink-0 bg-white border-r overflow-y-auto p-3" style={{ borderColor: '#E9EFF6' }}>
            {SECTIONS.map((s) => {
              const active = activeSection === s.key
              return (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => setActiveSection(s.key)}
                  className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-medium transition-all text-left"
                  style={{ background: active ? '#EFF6FF' : 'transparent', color: active ? '#0369A1' : '#64748B', fontWeight: active ? 700 : 500 }}
                  onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = '#F1F5F9' }}
                  onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent' }}
                >
                  <svg style={{ width: 16, height: 16, flexShrink: 0, color: active ? '#0369A1' : '#94A3B8' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    {s.icon}
                  </svg>
                  {s.label}
                </button>
              )
            })}
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto p-6" style={{ background: '#F1F5F9' }}>
            <div className="max-w-3xl mx-auto space-y-5">

              {activeSection === 'basic' && (
                <Card>
                  <SectionTitle>平台基础信息</SectionTitle>

                  <Field label="平台标识" desc="显示在登录页和侧边栏顶部的 Logo 与名称">
                    <div className="flex items-center gap-3">
                      <div className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: 'linear-gradient(135deg,#0EA5E9,#0369A1)' }}>
                        {logoUrl
                          ? <img src={logoUrl} alt="logo" style={{ width: 48, height: 48, objectFit: 'contain', borderRadius: 12 }} />
                          : <svg style={{ width: 24, height: 24, color: 'white' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                            </svg>
                        }
                      </div>
                      <input ref={logoInputRef} type="file" accept="image/*" className="hidden" onChange={handleLogoChange} />
                      <button type="button" onClick={() => logoInputRef.current?.click()}
                        className="cursor-pointer px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 text-xs font-semibold hover:bg-slate-50 transition-colors">
                        更换 Logo
                      </button>
                      {logoUrl && (
                        <button type="button" onClick={() => { setLogoUrl(null); if (logoInputRef.current) logoInputRef.current.value = '' }}
                          className="cursor-pointer px-3 py-1.5 rounded-lg border border-slate-200 text-red-500 text-xs font-semibold hover:bg-red-50 transition-colors">
                          重置
                        </button>
                      )}
                    </div>
                  </Field>

                  <Field label="平台名称" desc="展示在浏览器标题与系统各处">
                    <input type="text" value={platformName} onChange={(e) => setPlatformName(e.target.value)}
                      className="w-72 border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-400/30 focus:border-sky-400 transition" />
                  </Field>

                  <Field label="默认语言" desc="新成员加入时的默认界面语言">
                    <div className="flex bg-slate-100 rounded-xl p-1 gap-1">
                      {(['zh', 'en'] as const).map((lang) => (
                        <button key={lang} type="button" onClick={() => setLanguage(lang)}
                          className="px-4 py-1.5 rounded-lg text-xs font-semibold transition-all"
                          style={language === lang ? { background: '#fff', color: '#0369A1', boxShadow: '0 1px 3px rgba(15,23,42,0.1)' } : { color: '#64748B' }}>
                          {lang === 'zh' ? '简体中文' : 'English'}
                        </button>
                      ))}
                    </div>
                  </Field>

                  <Field label="时区" desc="影响所有时间戳与定时任务的执行时间">
                    <select value={timezone} onChange={(e) => setTimezone(e.target.value)}
                      className="w-72 border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-800 cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-400/30 focus:border-sky-400 transition">
                      <option>（GMT+08:00）北京、上海、香港</option>
                      <option>（GMT+00:00）协调世界时 UTC</option>
                      <option>（GMT-08:00）太平洋时间</option>
                    </select>
                  </Field>

                  <Field label="主题色" desc="用于按钮、链接与高亮元素的品牌主色" last>
                    <div className="flex items-center gap-2.5">
                      {THEME_COLORS.map((color) => (
                        <button key={color} type="button" onClick={() => setThemeColor(color)}
                          className="w-8 h-8 rounded-xl transition-transform hover:scale-110 relative flex-shrink-0"
                          style={{ background: color, border: '2px solid transparent', outline: themeColor === color ? '2px solid #0369A1' : 'none', outlineOffset: 2 }}>
                          {themeColor === color && <span className="absolute inset-0 flex items-center justify-center text-white text-xs font-bold">✓</span>}
                        </button>
                      ))}
                    </div>
                  </Field>
                </Card>
              )}

              {activeSection === 'notify' && (
                <Card>
                  <SectionTitle>通知与提醒</SectionTitle>
                  <Field label="任务延期提醒" desc="任务临近或超过计划时间时，向负责人推送提醒">
                    <Toggle checked={notifyDelay} onChange={setNotifyDelay} />
                  </Field>
                  <Field label="AI 待确认提醒" desc="AI 提取结果待确认时，每日汇总推送至确认人">
                    <Toggle checked={notifyAI} onChange={setNotifyAI} />
                  </Field>
                  <Field label="需决策事项提醒" desc="出现需高层决策的问题时，即时通知决策人">
                    <Toggle checked={notifyDecision} onChange={setNotifyDecision} />
                  </Field>
                  <Field label="周报自动汇总" desc="每周五 18:00 自动生成项目周报并发送给管理层">
                    <Toggle checked={notifyWeekly} onChange={setNotifyWeekly} />
                  </Field>
                  <Field label="通知渠道" desc="选择接收系统通知的方式" last>
                    <div className="flex items-center gap-2 flex-wrap">
                      {['站内信', '企业微信', '邮件', '短信'].map((ch) => {
                        const on = channels.has(ch)
                        return (
                          <button key={ch} type="button" onClick={() => toggleChannel(ch)}
                            className="cursor-pointer px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors flex items-center gap-1.5"
                            style={on ? { border: '2px solid #BFDBFE', background: '#EFF6FF', color: '#1D4ED8' } : { border: '1px solid #E2E8F0', background: '#fff', color: '#64748B' }}>
                            {on && <svg style={{ width: 12, height: 12 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7" /></svg>}
                            {ch}
                          </button>
                        )
                      })}
                    </div>
                  </Field>
                </Card>
              )}

              {activeSection === 'ai' && (
                <>
                  <Card>
                    <SectionTitle>AI 建议置信度</SectionTitle>
                    <Field label="置信度阈值" desc={`低于该值的 AI 提取结果将标记为"待人工复核"，需负责人手动确认后方可入库`} last>
                      <div className="flex items-center gap-3" style={{ width: 280 }}>
                        <input type="range" min={50} max={95} value={confidence} onChange={(e) => setConfidence(Number(e.target.value))}
                          className="flex-1 cursor-pointer" style={{ accentColor: '#0369A1' }} />
                        <span className="text-sm font-bold text-blue-700 w-10 text-right">{confidence}%</span>
                      </div>
                    </Field>
                  </Card>
                  <LLMConfigSection />
                </>
              )}

              {activeSection === 'security' && (
                <>
                  <Card>
                    <SectionTitle>安全与权限</SectionTitle>
                    <Field label="双因素认证（2FA）" desc="要求全员登录时进行二次身份验证">
                      <Toggle checked={twoFA} onChange={setTwoFA} />
                    </Field>
                    <Field label="登录会话有效期" desc="超过该时长未操作将自动登出">
                      <select value={sessionTTL} onChange={(e) => setSessionTTL(e.target.value)}
                        className="w-40 border border-slate-200 rounded-xl px-3 py-2 text-sm text-slate-800 cursor-pointer focus:outline-none focus:ring-2 focus:ring-blue-400/30 focus:border-sky-400 transition">
                        <option>2 小时</option>
                        <option>8 小时</option>
                        <option>24 小时</option>
                      </select>
                    </Field>
                    <Field label="操作留痕审计" desc="记录所有数据修改、确认与删除操作（不可关闭）" last>
                      <Toggle checked disabled />
                    </Field>
                  </Card>
                  <div className="flex items-center justify-between p-4 rounded-xl" style={{ background: '#FEF2F2', border: '1px solid #FECACA' }}>
                    <div>
                      <p className="text-sm font-bold text-red-800">清空 AI 缓存数据</p>
                      <p className="text-xs text-red-500 mt-1">将清除所有未确认的 AI 提取暂存结果，此操作不可恢复</p>
                    </div>
                    <button className="cursor-pointer px-4 py-2 rounded-lg bg-white border-2 border-red-200 text-red-600 text-sm font-semibold hover:bg-red-50 transition-colors flex-shrink-0">
                      清空缓存
                    </button>
                  </div>
                </>
              )}

              {activeSection === 'projects-mgmt' && <ProjectsMgmtSection />}
              {activeSection === 'people-mgmt' && <AccountPeopleMgmtSection />}

              {(['integration', 'data'] as Section[]).includes(activeSection) && (
                <Card>
                  <div className="py-12 flex flex-col items-center text-center">
                    <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4" style={{ background: '#EFF6FF' }}>
                      <svg style={{ width: 28, height: 28, color: '#2563EB' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
                      </svg>
                    </div>
                    <p className="text-sm font-bold text-slate-700">
                      {{ integration: '集成与接口', data: '数据与备份' }[activeSection as 'integration' | 'data']}
                    </p>
                    <p className="text-xs text-slate-400 mt-1.5">该模块正在建设中，即将上线</p>
                  </div>
                </Card>
              )}
              {activeSection === 'logs' && <LogsSection />}

            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ── 子组件 ── */

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl border p-6" style={{ borderColor: '#E9EFF6', boxShadow: '0 1px 4px rgba(15,23,42,0.06)' }}>
      {children}
    </div>
  )
}

function SectionTitle({ children, inline }: { children: React.ReactNode; inline?: boolean }) {
  return (
    <h2 className="text-sm font-bold text-slate-800 flex items-center gap-2" style={inline ? {} : { marginBottom: 20 }}>
      <span className="w-0.5 h-3.5 rounded-full flex-shrink-0" style={{ background: '#0369A1' }} />
      {children}
    </h2>
  )
}

function Field({ label, desc, children, last }: { label: string; desc: string; children: React.ReactNode; last?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-6" style={{ padding: '16px 0', borderBottom: last ? 'none' : '1px solid #F1F5F9' }}>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-slate-800">{label}</p>
        <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">{desc}</p>
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  )
}

function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange?: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} disabled={disabled} onClick={() => onChange?.(!checked)}
      className="relative inline-flex items-center flex-shrink-0 rounded-full transition-colors"
      style={{ width: 42, height: 24, background: checked ? '#0369A1' : '#E2E8F0', opacity: disabled ? 0.6 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}>
      <span className="inline-block rounded-full bg-white transition-transform"
        style={{ width: 18, height: 18, boxShadow: '0 1px 3px rgba(0,0,0,0.2)', transform: checked ? 'translateX(21px)' : 'translateX(3px)' }} />
    </button>
  )
}

function LLMConfigSection() {
  const [configs, setConfigs] = useState<LLMProviderConfig[]>([])
  const [loading, setLoading] = useState(true)
  const [editingProvider, setEditingProvider] = useState<string | null>(null)
  const [editForm, setEditForm] = useState({ api_key: '', base_url: '', model: '' })
  const [saving, setSaving] = useState<string | null>(null)

  useEffect(() => {
    getLLMConfigs().then(setConfigs).catch(() => setConfigs([])).finally(() => setLoading(false))
  }, [])

  async function handleToggle(cfg: LLMProviderConfig) {
    setSaving(cfg.provider)
    try {
      await saveLLMConfig(cfg.provider, { enabled: !cfg.enabled, model: cfg.model, base_url: cfg.base_url })
      setConfigs(prev => prev.map(c => c.provider === cfg.provider ? { ...c, enabled: !cfg.enabled } : c))
    } finally { setSaving(null) }
  }

  function startEdit(cfg: LLMProviderConfig) {
    setEditingProvider(cfg.provider)
    setEditForm({ api_key: '', base_url: cfg.base_url, model: cfg.model })
  }

  async function handleSaveEdit(cfg: LLMProviderConfig) {
    setSaving(cfg.provider)
    try {
      await saveLLMConfig(cfg.provider, {
        enabled: cfg.enabled,
        model: editForm.model || cfg.default_model,
        base_url: editForm.base_url || cfg.default_base_url,
        ...(editForm.api_key ? { api_key: editForm.api_key } : {}),
      })
      setConfigs(prev => prev.map(c => c.provider === cfg.provider
        ? { ...c, model: editForm.model || c.default_model, base_url: editForm.base_url || c.default_base_url, api_key_set: editForm.api_key ? true : c.api_key_set }
        : c))
      setEditingProvider(null)
    } finally { setSaving(null) }
  }

  return (
    <Card>
      <SectionTitle>大模型配置</SectionTitle>
      {loading
        ? <p className="text-sm text-slate-400 py-4 text-center">加载中…</p>
        : configs.map(cfg => (
          <div key={cfg.provider} style={{ borderBottom: '1px solid #F1F5F9', paddingBottom: 16, marginBottom: 16 }}>
            <div className="flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-slate-800">{cfg.display_name}</span>
                  {cfg.enabled && (
                    <span className="text-xs px-2 py-0.5 rounded-full font-medium" style={{ background: '#D1FAE5', color: '#065F46' }}>启用中</span>
                  )}
                </div>
                <p className="text-xs text-slate-400 mt-0.5">
                  模型：<span className="font-medium text-slate-600">{cfg.model}</span>
                  {' · '}API Key：{cfg.api_key_set ? <span className="text-emerald-600">已配置</span> : <span className="text-red-500">未配置</span>}
                </p>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <button type="button" onClick={() => startEdit(cfg)}
                  className="cursor-pointer px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 text-xs font-semibold hover:bg-slate-50 transition-colors">
                  配置
                </button>
                <button type="button" onClick={() => handleToggle(cfg)} disabled={saving === cfg.provider}
                  className="cursor-pointer px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50"
                  style={cfg.enabled
                    ? { background: '#FEF2F2', color: '#DC2626', border: '1px solid #FECACA' }
                    : { background: '#EFF6FF', color: '#1D4ED8', border: '1px solid #BFDBFE' }}>
                  {saving === cfg.provider ? '处理中…' : cfg.enabled ? '停用' : '启用'}
                </button>
              </div>
            </div>

            {editingProvider === cfg.provider && (
              <div className="mt-3 p-3 rounded-xl space-y-2" style={{ background: '#F8FAFC', border: '1px solid #E2E8F0' }}>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <p className="text-xs text-slate-500 mb-1">模型名称</p>
                    <input value={editForm.model} onChange={e => setEditForm(f => ({ ...f, model: e.target.value }))}
                      placeholder={cfg.default_model}
                      className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-400/30" />
                  </div>
                  <div>
                    <p className="text-xs text-slate-500 mb-1">API Key {cfg.api_key_set ? '（已设置，留空保留）' : '（未设置）'}</p>
                    <input type="password" value={editForm.api_key} onChange={e => setEditForm(f => ({ ...f, api_key: e.target.value }))}
                      placeholder={cfg.api_key_set ? '••••••••' : '输入 API Key'}
                      className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-400/30" />
                  </div>
                </div>
                <div>
                  <p className="text-xs text-slate-500 mb-1">Base URL</p>
                  <input value={editForm.base_url} onChange={e => setEditForm(f => ({ ...f, base_url: e.target.value }))}
                    placeholder={cfg.default_base_url}
                    className="w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-400/30" />
                </div>
                <div className="flex gap-2 pt-1">
                  <button type="button" onClick={() => handleSaveEdit(cfg)} disabled={saving === cfg.provider}
                    className="cursor-pointer px-3 py-1.5 rounded-lg text-white text-xs font-semibold disabled:opacity-50" style={{ background: '#0369A1' }}>
                    {saving === cfg.provider ? '保存中…' : '保存'}
                  </button>
                  <button type="button" onClick={() => setEditingProvider(null)}
                    className="cursor-pointer px-3 py-1.5 rounded-lg border border-slate-200 text-slate-500 text-xs">取消</button>
                </div>
              </div>
            )}
          </div>
        ))
      }
    </Card>
  )
}

const ROLE_LABELS: Record<string, string> = {
  owner: '负责人', coordinator: '统筹人', member: '成员', project_ceo: '项目CEO',
}

function ProjectsMgmtSection() {
  const { reloadProjects } = useProject()
  const [projects, setProjects] = useState<Project[]>([])
  const [people, setPeople] = useState<Person[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [members, setMembers] = useState<Record<number, ProjectMember[]>>({})
  const [showArchived, setShowArchived] = useState(false)

  const [showNew, setShowNew] = useState(false)
  const [newName, setNewName] = useState('')
  const [creating, setCreating] = useState(false)

  const [editingId, setEditingId] = useState<number | null>(null)
  const [editingName, setEditingName] = useState('')

  const [addingTo, setAddingTo] = useState<number | null>(null)
  const [addPersonId, setAddPersonId] = useState<number | ''>('')
  const [addRole, setAddRole] = useState('member')

  // 批量导入
  const [importOpen, setImportOpen] = useState(false)
  const [importText, setImportText] = useState('')
  const [importRows, setImportRows] = useState<BatchImportRow[]>([])
  const [importing, setImporting] = useState(false)

  useEffect(() => {
    Promise.all([getProjects(true), fetchPeople()])
      .then(([ps, ppl]) => { setProjects(ps); setPeople(ppl) })
      .finally(() => setLoading(false))
  }, [])

  async function toggleExpand(pid: number) {
    if (expandedId === pid) { setExpandedId(null); return }
    setExpandedId(pid)
    if (!members[pid]) {
      const ms = await getProjectMembers(pid)
      setMembers(prev => ({ ...prev, [pid]: ms }))
    }
  }

  // 列名映射表
  const COL_MAP: Record<string, keyof BatchImportRow> = {
    '专项': 'project_name', '阶段': 'project_name',
    '关键任务': 'key_task',
    '关键成果': 'key_achievement',
    '完成标准': 'completion_standard',
    '统筹人': 'coordinator', '统筹': 'coordinator',
    '负责人': 'owner',
    '协同/成员': 'collaborators', '协同': 'collaborators', '成员': 'collaborators',
    '计划时间': 'plan_time',
    '当前状态': 'status', '状态': 'status',
    '问题与需协调事项': 'issue', '问题': 'issue',
  }

  function parseImportText(text: string): BatchImportRow[] {
    const lines = text.split('\n').map(l => l.trimEnd()).filter(l => l.trim())
    if (lines.length < 2) return []
    const headers = lines[0].split('\t')
    const isHeader = headers.some(h => COL_MAP[h.trim()] !== undefined)
    if (!isHeader) return []
    const colFields = headers.map(h => COL_MAP[h.trim()] ?? null)
    const rows: BatchImportRow[] = []
    for (let i = 1; i < lines.length; i++) {
      const cells = lines[i].split('\t')
      const row: Partial<BatchImportRow> = {}
      colFields.forEach((field, idx) => {
        if (field && cells[idx] !== undefined) {
          const val = cells[idx].trim()
          if (val) (row as Record<string, string>)[field] = val
        }
      })
      if (row.project_name && row.key_task) rows.push(row as BatchImportRow)
    }
    return rows
  }

  function handleImportTextChange(text: string) {
    setImportText(text)
    setImportRows(parseImportText(text))
  }

  async function handleImportConfirm() {
    if (!importRows.length) return
    setImporting(true)
    try {
      const res = await batchImportProjects(importRows)
      alert(`导入完成！\n新建专项：${res.projects_created} 个\n匹配专项：${res.projects_matched} 个\n创建任务：${res.tasks_created} 条\n创建问题：${res.issues_created} 条${res.skipped_rows ? `\n跳过行数：${res.skipped_rows}` : ''}`)
      const ps = await getProjects(true)
      setProjects(ps)
      reloadProjects()
      setImportOpen(false)
      setImportText('')
      setImportRows([])
    } catch {
      alert('导入失败，请检查数据格式后重试')
    } finally {
      setImporting(false)
    }
  }

  async function handleCreate() {
    const name = newName.trim()
    if (!name) return
    if (projects.some(p => p.name === name)) {
      alert(`项目「${name}」已存在，请使用其他名称`)
      return
    }
    setCreating(true)
    try {
      const p = await createProject({ name })
      setProjects(prev => [...prev, p])
      reloadProjects()
      setNewName(''); setShowNew(false)
    } catch {
      alert('创建失败，请重试')
    } finally { setCreating(false) }
  }

  async function handleSaveEdit(pid: number) {
    if (!editingName.trim()) return
    const p = await patchProject(pid, { name: editingName.trim() })
    setProjects(prev => prev.map(x => x.id === pid ? { ...x, name: p.name } : x))
    setEditingId(null)
  }

  async function handleArchive(pid: number, name: string) {
    if (!window.confirm(`确认归档「${name}」？归档后不再显示在驾驶舱中。`)) return
    await archiveProject(pid)
    setProjects(prev => prev.map(x => x.id === pid ? { ...x, is_active: false } : x))
    if (expandedId === pid) setExpandedId(null)
    reloadProjects()
  }

  async function handleUnarchive(pid: number, name: string) {
    if (!window.confirm(`确认恢复「${name}」？恢复后将重新显示在驾驶舱中。`)) return
    await patchProject(pid, { status: 'active' })
    setProjects(prev => prev.map(x => x.id === pid ? { ...x, is_active: true } : x))
    reloadProjects()
  }

  async function handleAddMember(pid: number) {
    if (!addPersonId) return
    const m = await addProjectMember(pid, { person_id: Number(addPersonId), role: addRole })
    setMembers(prev => ({ ...prev, [pid]: [...(prev[pid] || []), m] }))
    setAddPersonId(''); setAddRole('member'); setAddingTo(null)
  }

  async function handleRemoveMember(pid: number, mid: number, name: string) {
    if (!window.confirm(`确认移除成员「${name}」？`)) return
    await removeProjectMember(pid, mid)
    setMembers(prev => ({ ...prev, [pid]: (prev[pid] || []).filter(m => m.id !== mid) }))
  }

  async function handleChangeRole(pid: number, mid: number, role: string) {
    const updated = await updateProjectMember(pid, mid, { role })
    setMembers(prev => ({ ...prev, [pid]: (prev[pid] || []).map(m => m.id === mid ? { ...m, role: updated.role } : m) }))
  }

  const visible = projects.filter(p => showArchived ? true : p.is_active)

  if (loading) return <Card><p className="text-sm text-slate-400 py-8 text-center">加载中…</p></Card>

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <SectionTitle inline>项目管理</SectionTitle>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer select-none">
            <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)} className="w-3.5 h-3.5 accent-blue-600" />
            显示已归档
          </label>
          <button type="button" onClick={() => setImportOpen(true)}
            className="cursor-pointer flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border"
            style={{ color: '#0369A1', borderColor: '#BAE6FD', background: '#F0F9FF' }}>
            <svg style={{ width: 13, height: 13 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
            批量导入
          </button>
          <button type="button" onClick={() => setShowNew(true)}
            className="cursor-pointer flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-white text-xs font-semibold"
            style={{ background: 'linear-gradient(135deg,#0369A1,#0EA5E9)' }}>
            <svg style={{ width: 13, height: 13 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M12 4v16m8-8H4" /></svg>
            新建项目
          </button>
        </div>
      </div>

      {showNew && (
        <Card>
          <p className="text-sm font-semibold text-slate-700 mb-3">新建项目</p>
          <div className="flex items-center gap-2">
            <input autoFocus value={newName} onChange={e => setNewName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleCreate()}
              placeholder="输入项目名称"
              className="flex-1 border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400/30 focus:border-sky-400" />
            <button type="button" onClick={handleCreate} disabled={creating || !newName.trim()}
              className="cursor-pointer px-4 py-2 rounded-xl text-white text-sm font-semibold disabled:opacity-50"
              style={{ background: '#0369A1' }}>{creating ? '创建中…' : '创建'}</button>
            <button type="button" onClick={() => { setShowNew(false); setNewName('') }}
              className="cursor-pointer px-3 py-2 rounded-xl border border-slate-200 text-slate-500 text-sm">取消</button>
          </div>
        </Card>
      )}

      {visible.length === 0 && <Card><p className="text-sm text-slate-400 py-8 text-center">暂无项目</p></Card>}

      {visible.map(p => (
        <Card key={p.id}>
          <div className="flex items-center gap-3">
            <button type="button" onClick={() => toggleExpand(p.id)}
              className="cursor-pointer flex-shrink-0 w-5 h-5 flex items-center justify-center text-slate-400 hover:text-slate-600 transition-transform"
              style={{ transform: expandedId === p.id ? 'rotate(90deg)' : 'rotate(0deg)' }}>
              <svg style={{ width: 14, height: 14 }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5l7 7-7 7" />
              </svg>
            </button>

            {editingId === p.id ? (
              <div className="flex-1 flex items-center gap-2">
                <input autoFocus value={editingName} onChange={e => setEditingName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleSaveEdit(p.id); if (e.key === 'Escape') setEditingId(null) }}
                  className="flex-1 border border-sky-400 rounded-lg px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400/30" />
                <button type="button" onClick={() => handleSaveEdit(p.id)}
                  className="cursor-pointer px-3 py-1 rounded-lg text-white text-xs font-semibold" style={{ background: '#0369A1' }}>保存</button>
                <button type="button" onClick={() => setEditingId(null)}
                  className="cursor-pointer px-2 py-1 rounded-lg border border-slate-200 text-slate-500 text-xs">取消</button>
              </div>
            ) : (
              <div className="flex-1 flex items-center gap-2 min-w-0">
                <span className="text-sm font-semibold text-slate-800 truncate">{p.name}</span>
                {!p.is_active && <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-400 flex-shrink-0">已归档</span>}
              </div>
            )}

            {editingId !== p.id && (
              <div className="flex items-center gap-1.5 flex-shrink-0">
                <button type="button" onClick={() => { setEditingId(p.id); setEditingName(p.name) }}
                  className="cursor-pointer p-1.5 rounded-lg text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition-colors" title="编辑名称">
                  <svg style={{ width: 14, height: 14 }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                  </svg>
                </button>
                {p.is_active ? (
                  <button type="button" onClick={() => handleArchive(p.id, p.name)}
                    className="cursor-pointer p-1.5 rounded-lg text-slate-400 hover:text-amber-600 hover:bg-amber-50 transition-colors" title="归档项目">
                    <svg style={{ width: 14, height: 14 }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
                    </svg>
                  </button>
                ) : (
                  <button type="button" onClick={() => handleUnarchive(p.id, p.name)}
                    className="cursor-pointer px-2 py-1 rounded-lg text-xs font-semibold text-emerald-600 hover:bg-emerald-50 border border-emerald-200 transition-colors" title="恢复项目">
                    恢复
                  </button>
                )}
              </div>
            )}
          </div>

          {expandedId === p.id && (
            <div className="mt-4 pt-4" style={{ borderTop: '1px solid #F1F5F9' }}>
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs font-semibold text-slate-500 uppercase" style={{ letterSpacing: '0.06em' }}>项目成员</p>
                {p.is_active && addingTo !== p.id && (
                  <button type="button" onClick={() => setAddingTo(p.id)}
                    className="cursor-pointer flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 font-semibold">
                    <svg style={{ width: 12, height: 12 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M12 4v16m8-8H4" /></svg>
                    添加成员
                  </button>
                )}
              </div>

              {addingTo === p.id && (
                <div className="flex items-center gap-2 mb-3 p-3 rounded-xl" style={{ background: '#F8FAFC', border: '1px solid #E2E8F0' }}>
                  <select value={addPersonId} onChange={e => setAddPersonId(Number(e.target.value))}
                    className="flex-1 border border-slate-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-400/30">
                    <option value="">选择人员</option>
                    {people.filter(per => !(members[p.id] || []).some(m => m.person_id === per.id)).map(per => (
                      <option key={per.id} value={per.id}>{per.name}</option>
                    ))}
                  </select>
                  <select value={addRole} onChange={e => setAddRole(e.target.value)}
                    className="w-24 border border-slate-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-blue-400/30">
                    <option value="member">成员</option>
                    <option value="owner">负责人</option>
                    <option value="coordinator">统筹人</option>
                    <option value="project_ceo">项目CEO</option>
                  </select>
                  <button type="button" onClick={() => handleAddMember(p.id)} disabled={!addPersonId}
                    className="cursor-pointer px-3 py-1.5 rounded-lg text-white text-xs font-semibold disabled:opacity-50" style={{ background: '#0369A1' }}>添加</button>
                  <button type="button" onClick={() => { setAddingTo(null); setAddPersonId(''); setAddRole('member') }}
                    className="cursor-pointer px-2 py-1.5 rounded-lg border border-slate-200 text-slate-500 text-xs">取消</button>
                </div>
              )}

              {(members[p.id] || []).length === 0
                ? <p className="text-xs text-slate-400 py-2">暂无成员</p>
                : (
                  <div className="space-y-1">
                    {(members[p.id] || []).map(m => (
                      <div key={m.id} className="flex items-center gap-2 py-1.5 px-2 rounded-lg hover:bg-slate-50">
                        <div className="w-6 h-6 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
                          style={{ background: 'linear-gradient(135deg,#3B82F6,#0369A1)' }}>
                          {m.person_name_snapshot.slice(0, 1)}
                        </div>
                        <span className="flex-1 text-xs font-medium text-slate-700">{m.person_name_snapshot}</span>
                        <select
                          value={m.role}
                          onChange={e => handleChangeRole(p.id, m.id, e.target.value)}
                          className="text-xs border border-slate-200 rounded-lg px-2 py-0.5 focus:outline-none focus:border-blue-400 cursor-pointer"
                          style={{ color: '#1D4ED8', background: '#EFF6FF' }}
                        >
                          <option value="member">成员</option>
                          <option value="owner">负责人</option>
                          <option value="coordinator">统筹人</option>
                          <option value="project_ceo">项目CEO</option>
                        </select>
                        <button type="button" onClick={() => handleRemoveMember(p.id, m.id, m.person_name_snapshot)}
                          className="cursor-pointer p-1 rounded text-slate-300 hover:text-red-500 hover:bg-red-50 transition-colors" title="移除">
                          <svg style={{ width: 12, height: 12 }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    ))}
                  </div>
                )
              }
            </div>
          )}
        </Card>
      ))}

      {/* 批量导入弹窗 */}
      {importOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(15,23,42,0.45)' }}
          onClick={() => { if (!importing) { setImportOpen(false); setImportText(''); setImportRows([]) } }}>
          <div className="bg-white rounded-2xl shadow-2xl flex flex-col overflow-hidden"
            style={{ width: 760, maxHeight: '88vh' }}
            onClick={e => e.stopPropagation()}>

            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: '#E9EFF6' }}>
              <div>
                <div className="text-sm font-bold text-slate-800">批量导入专项与关键任务</div>
                <div className="text-xs text-slate-400 mt-0.5">从 Excel 复制数据（Ctrl+A → Ctrl+C），粘贴到下方文本框</div>
              </div>
              <button onClick={() => { setImportOpen(false); setImportText(''); setImportRows([]) }}
                className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400">
                <svg style={{ width: 15, height: 15 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>

            <div className="overflow-y-auto px-6 py-4 space-y-4">
              {/* 格式说明 */}
              <div className="rounded-xl px-4 py-3 text-xs text-slate-500 space-y-1" style={{ background: '#F8FAFC', border: '1px solid #E2E8F0' }}>
                <div className="font-semibold text-slate-600 mb-1">支持的列名（顺序可不固定）：</div>
                <div className="flex flex-wrap gap-2">
                  {['专项/阶段', '关键任务', '关键成果', '完成标准', '统筹人/统筹', '负责人', '协同/成员', '计划时间', '当前状态', '问题与需协调事项'].map(col => (
                    <span key={col} className="px-2 py-0.5 rounded-md bg-white border border-slate-200 text-slate-600">{col}</span>
                  ))}
                </div>
                <div className="text-slate-400 mt-1">序号、备注等无关列会自动跳过。</div>
              </div>

              {/* 粘贴区 */}
              <textarea
                value={importText}
                onChange={e => handleImportTextChange(e.target.value)}
                placeholder={'从 Excel 粘贴数据（含表头行），例如：\n序号\t阶段\t专项\t关键任务\t关键成果\t统筹人\t负责人\t计划时间\t当前状态\n1\t项目统筹\t知识资产AI化\t确认AI升级方案\t《AI升级方案》\t刘万超\tmoways\t4-5月\t未启动'}
                className="w-full border border-slate-200 rounded-xl p-3 text-xs font-mono focus:outline-none focus:border-indigo-400 resize-none"
                style={{ height: 160 }}
              />

              {/* 预览表格 */}
              {importRows.length > 0 && (
                <div>
                  <div className="text-xs font-semibold text-slate-500 mb-2">解析预览（共 {importRows.length} 行）</div>
                  <div className="overflow-x-auto rounded-xl border" style={{ borderColor: '#E9EFF6' }}>
                    <table className="w-full text-xs">
                      <thead>
                        <tr style={{ background: '#F8FAFC' }}>
                          {['专项', '关键任务', '负责人', '统筹', '计划时间', '状态', '问题'].map(h => (
                            <th key={h} className="px-3 py-2 text-left font-semibold text-slate-500 whitespace-nowrap">{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {importRows.map((r, i) => (
                          <tr key={i} className="border-t" style={{ borderColor: '#F1F5F9' }}>
                            <td className="px-3 py-2 font-semibold text-indigo-700 whitespace-nowrap">{r.project_name}</td>
                            <td className="px-3 py-2 text-slate-700 max-w-xs truncate">{r.key_task}</td>
                            <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{r.owner || '—'}</td>
                            <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{r.coordinator || '—'}</td>
                            <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{r.plan_time || '—'}</td>
                            <td className="px-3 py-2 whitespace-nowrap">
                              <span className="px-1.5 py-0.5 rounded text-xs font-semibold bg-slate-100 text-slate-600">{r.status || '未开始'}</span>
                            </td>
                            <td className="px-3 py-2 text-amber-600 max-w-xs truncate">{r.issue || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {importText && importRows.length === 0 && (
                <div className="text-xs text-red-500 px-1">未识别到有效数据，请确认第一行为标题行，且包含「专项」或「关键任务」等列名。</div>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between px-6 py-4 border-t" style={{ borderColor: '#E9EFF6' }}>
              <div className="text-xs text-slate-400">
                {importRows.length > 0 && `将创建/匹配专项，新增 ${importRows.length} 条关键任务${importRows.filter(r => r.issue).length > 0 ? `，写入 ${importRows.filter(r => r.issue).length} 条问题` : ''}`}
              </div>
              <div className="flex gap-2">
                <button onClick={() => { setImportOpen(false); setImportText(''); setImportRows([]) }}
                  className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-600 hover:bg-slate-100">
                  取消
                </button>
                <button onClick={handleImportConfirm}
                  disabled={importing || importRows.length === 0}
                  className="px-4 py-2 rounded-xl text-sm font-semibold text-white disabled:opacity-50"
                  style={{ background: 'linear-gradient(135deg,#0369A1,#0EA5E9)' }}>
                  {importing ? '导入中…' : `确认导入 ${importRows.length} 行`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function AccountPeopleMgmtSection() {
  const [people, setPeople] = useState<Person[]>([])
  const [accounts, setAccounts] = useState<AccountItem[]>([])
  const [loading, setLoading] = useState(true)
  const [showNew, setShowNew] = useState(false)
  const [showBatchImport, setShowBatchImport] = useState(false)
  const [newName, setNewName] = useState('')
  const [newRole, setNewRole] = useState('普通成员')
  const [newDept, setNewDept] = useState('')
  const [newUsername, setNewUsername] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [createLoginAccount, setCreateLoginAccount] = useState(true)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editForm, setEditForm] = useState<{ name: string; system_role: string; department: string }>({ name: '', system_role: '', department: '' })
  const [creating, setCreating] = useState(false)
  const [accountDraft, setAccountDraft] = useState<Record<number, { username: string; password: string }>>({})
  const [resetDraft, setResetDraft] = useState<Record<number, string>>({})
  const [message, setMessage] = useState('')

  function loadAll() {
    setLoading(true)
    Promise.all([
      fetchPeople(),
      fetchAccounts().catch(() => [] as AccountItem[]),
    ]).then(([peopleRows, accountRows]) => {
      setPeople(peopleRows)
      setAccounts(accountRows)
    }).finally(() => setLoading(false))
  }

  useEffect(() => { loadAll() }, [])

  function accountForPerson(personId: number) {
    return accounts.find((account) => account.person_id === personId)
  }

  function showMessage(text: string) {
    setMessage(text)
    window.setTimeout(() => setMessage(''), 2200)
  }

  async function handleCreate() {
    if (!newName.trim()) return
    if (createLoginAccount && newPassword.trim().length < 6) {
      alert('初始密码至少 6 位')
      return
    }
    setCreating(true)
    try {
      const person = await createPerson({ name: newName.trim(), system_role: newRole, department: newDept })
      let createdAccount: AccountItem | null = null
      if (createLoginAccount) {
        createdAccount = await createAccount({
          username: (newUsername || newName).trim(),
          password: newPassword.trim(),
          person_id: person.id,
          is_tech_admin: newRole === '超级管理员',
        })
      }
      setPeople((prev) => [...prev, person])
      if (createdAccount) setAccounts((prev) => [...prev, createdAccount])
      setNewName('')
      setNewRole('普通成员')
      setNewDept('')
      setNewUsername('')
      setNewPassword('')
      setCreateLoginAccount(true)
      setShowNew(false)
      showMessage('人员已创建')
    } catch (err) {
      alert(err instanceof Error ? err.message : '创建失败')
    } finally {
      setCreating(false)
    }
  }

  async function handleSaveEdit(id: number) {
    const person = await updatePerson(id, {
      name: editForm.name,
      system_role: editForm.system_role,
      department: editForm.department,
    })
    setPeople((prev) => prev.map((item) => item.id === id ? { ...item, ...person } : item))
    setEditingId(null)
    showMessage('人员信息已保存')
  }

  async function handleCreateAccount(person: Person) {
    const draft = accountDraft[person.id] || { username: String(person.name || ''), password: '' }
    if (!draft.username.trim()) return alert('请输入账号名')
    if (draft.password.trim().length < 6) return alert('初始密码至少 6 位')
    const account = await createAccount({
      username: draft.username.trim(),
      password: draft.password.trim(),
      person_id: person.id,
      is_tech_admin: person.system_role === '超级管理员',
    })
    setAccounts((prev) => [...prev, account])
    setAccountDraft((prev) => ({ ...prev, [person.id]: { username: '', password: '' } }))
    showMessage('登录账号已创建')
  }

  async function handleResetPassword(account: AccountItem) {
    const password = resetDraft[account.id] || ''
    if (password.length < 6) return alert('新密码至少 6 位')
    await resetAccountPassword(account.id, password)
    setResetDraft((prev) => ({ ...prev, [account.id]: '' }))
    showMessage('密码已重置')
    loadAll()
  }

  async function handleToggleAccount(account: AccountItem) {
    const nextStatus = account.status === 'active' ? 'disabled' : 'active'
    if (nextStatus === 'disabled' && !window.confirm(`确认禁用账号「${account.username}」？禁用后该用户不能登录。`)) return
    const updated = await updateAccountStatus(account.id, nextStatus)
    setAccounts((prev) => prev.map((item) => item.id === updated.id ? updated : item))
    showMessage(nextStatus === 'active' ? '账号已启用' : '账号已禁用')
  }

  async function handleDelete(id: number, name: string) {
    if (!window.confirm(`确认删除「${name}」？建议优先禁用账号，删除人员会影响项目成员关系。`)) return
    await deletePerson(id)
    setPeople((prev) => prev.filter((item) => item.id !== id))
    showMessage('人员已删除')
  }

  if (loading) return <Card><p className="text-sm text-slate-400 py-8 text-center">加载中...</p></Card>

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <SectionTitle inline>人员与账号管理</SectionTitle>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setShowBatchImport(true)}
            className="cursor-pointer flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-indigo-200 text-indigo-600 bg-indigo-50 hover:bg-indigo-100">
            批量导入人员
          </button>
          <button type="button" onClick={() => setShowNew(true)}
            className="cursor-pointer flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-white text-xs font-semibold"
            style={{ background: 'linear-gradient(135deg,#0369A1,#0EA5E9)' }}>
            新建人员
          </button>
        </div>
      </div>

      {message && <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700">{message}</div>}

      {showBatchImport && (
        <PeopleBatchImportModal
          onClose={() => setShowBatchImport(false)}
          onDone={() => {
            loadAll()
            setShowBatchImport(false)
          }}
        />
      )}

      {showNew && (
        <Card>
          <p className="text-sm font-semibold text-slate-700 mb-3">新建人员与登录账号</p>
          <div className="flex items-center gap-2 flex-wrap">
            <input autoFocus value={newName} onChange={e => setNewName(e.target.value)}
              placeholder="姓名（必填）"
              className="w-32 border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400/30 focus:border-sky-400" />
            <select value={newRole} onChange={e => setNewRole(e.target.value)}
              className="w-32 border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400/30">
              <option>普通成员</option>
              <option>过程保障</option>
              <option>组长CEO</option>
              <option>超级管理员</option>
            </select>
            <input value={newDept} onChange={e => setNewDept(e.target.value)}
              placeholder="部门（可选）"
              className="w-36 border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400/30 focus:border-sky-400" />
            <label className="flex items-center gap-1.5 text-xs text-slate-600 px-2">
              <input type="checkbox" checked={createLoginAccount} onChange={e => setCreateLoginAccount(e.target.checked)} />
              同时创建登录账号
            </label>
            {createLoginAccount && (
              <>
                <input value={newUsername} onChange={e => setNewUsername(e.target.value)}
                  placeholder="账号名，默认同姓名"
                  className="w-40 border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400/30 focus:border-sky-400" />
                <input type="password" value={newPassword} onChange={e => setNewPassword(e.target.value)}
                  placeholder="初始密码，至少 6 位"
                  className="w-40 border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400/30 focus:border-sky-400" />
              </>
            )}
            <button type="button" onClick={handleCreate} disabled={creating || !newName.trim()}
              className="cursor-pointer px-4 py-2 rounded-xl text-white text-sm font-semibold disabled:opacity-50" style={{ background: '#0369A1' }}>
              {creating ? '创建中...' : '创建'}
            </button>
            <button type="button" onClick={() => setShowNew(false)}
              className="cursor-pointer px-3 py-2 rounded-xl border border-slate-200 text-slate-500 text-sm">取消</button>
          </div>
        </Card>
      )}

      <Card>
        {people.length === 0 ? (
          <p className="text-sm text-slate-400 py-8 text-center">暂无人员</p>
        ) : (
          <div className="divide-y">
            {people.map((person) => {
              const account = accountForPerson(person.id)
              const draft = accountDraft[person.id] || { username: String(person.name || ''), password: '' }
              return (
                <div key={person.id} className="py-4">
                  <div className="flex items-start gap-3">
                    <div className="w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-bold flex-shrink-0"
                      style={{ background: person.is_active === false ? '#CBD5E1' : 'linear-gradient(135deg,#3B82F6,#0369A1)' }}>
                      {String(person.name || '?').slice(0, 1)}
                    </div>

                    {editingId === person.id ? (
                      <div className="flex-1 flex items-center gap-2 flex-wrap">
                        <input value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
                          className="w-24 border border-sky-400 rounded-lg px-2 py-1 text-sm focus:outline-none" />
                        <select value={editForm.system_role} onChange={e => setEditForm(f => ({ ...f, system_role: e.target.value }))}
                          className="w-28 border border-slate-200 rounded-lg px-2 py-1 text-xs focus:outline-none">
                          <option>普通成员</option>
                          <option>过程保障</option>
                          <option>组长CEO</option>
                          <option>超级管理员</option>
                        </select>
                        <input value={editForm.department} onChange={e => setEditForm(f => ({ ...f, department: e.target.value }))}
                          placeholder="部门" className="w-28 border border-slate-200 rounded-lg px-2 py-1 text-xs focus:outline-none" />
                        <button type="button" onClick={() => handleSaveEdit(person.id)}
                          className="cursor-pointer px-3 py-1 rounded-lg text-white text-xs font-semibold" style={{ background: '#0369A1' }}>保存</button>
                        <button type="button" onClick={() => setEditingId(null)}
                          className="cursor-pointer px-2 py-1 rounded-lg border border-slate-200 text-slate-500 text-xs">取消</button>
                      </div>
                    ) : (
                      <>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-semibold text-slate-800">{person.name as string}</span>
                            {person.department && <span className="text-xs text-slate-400">{person.department as string}</span>}
                            <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">{person.system_role || '普通成员'}</span>
                            {person.is_active === false && <span className="text-xs text-slate-400">已停用</span>}
                          </div>

                          {!account ? (
                            <div className="flex items-center gap-2 mt-2 flex-wrap">
                              <span className="text-xs text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full">未创建登录账号</span>
                              <input value={draft.username} onChange={e => setAccountDraft(prev => ({ ...prev, [person.id]: { ...draft, username: e.target.value } }))}
                                placeholder="账号名" className="w-28 border border-slate-200 rounded-lg px-2 py-1 text-xs focus:outline-none" />
                              <input type="password" value={draft.password} onChange={e => setAccountDraft(prev => ({ ...prev, [person.id]: { ...draft, password: e.target.value } }))}
                                placeholder="初始密码" className="w-28 border border-slate-200 rounded-lg px-2 py-1 text-xs focus:outline-none" />
                              <button type="button" onClick={() => handleCreateAccount(person)}
                                className="px-2 py-1 rounded-lg text-xs font-semibold text-white" style={{ background: '#0369A1' }}>创建账号</button>
                            </div>
                          ) : (
                            <div className="flex items-center gap-2 mt-2 flex-wrap">
                              <span className="text-xs text-slate-500">账号：{account.username}</span>
                              <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: account.status === 'active' ? '#DCFCE7' : '#F1F5F9', color: account.status === 'active' ? '#047857' : '#64748B' }}>
                                {account.status === 'active' ? '可登录' : '已禁用'}
                              </span>
                              <input type="password" value={resetDraft[account.id] || ''} onChange={e => setResetDraft(prev => ({ ...prev, [account.id]: e.target.value }))}
                                placeholder="新密码" className="w-24 border border-slate-200 rounded-lg px-2 py-1 text-xs focus:outline-none" />
                              <button type="button" onClick={() => handleResetPassword(account)}
                                className="px-2 py-1 rounded-lg text-xs font-semibold border border-slate-200 text-slate-600 hover:bg-slate-50">重置密码</button>
                              <button type="button" onClick={() => handleToggleAccount(account)}
                                className="px-2 py-1 rounded-lg text-xs font-semibold border border-slate-200 text-slate-600 hover:bg-slate-50">
                                {account.status === 'active' ? '禁用账号' : '启用账号'}
                              </button>
                            </div>
                          )}
                        </div>

                        <div className="flex items-center gap-1 flex-shrink-0">
                          <button type="button"
                            onClick={() => { setEditingId(person.id); setEditForm({ name: person.name as string, system_role: (person.system_role as string) || '普通成员', department: (person.department as string) || '' }) }}
                            className="cursor-pointer px-2 py-1 rounded-lg text-xs text-blue-600 hover:bg-blue-50">编辑</button>
                          <button type="button" onClick={() => handleDelete(person.id, person.name as string)}
                            className="cursor-pointer px-2 py-1 rounded-lg text-xs text-red-500 hover:bg-red-50">删除</button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Card>
    </div>
  )
}

function PeopleMgmtSection() {
  const [people, setPeople] = useState<Person[]>([])
  const [loading, setLoading] = useState(true)
  const [showNew, setShowNew] = useState(false)
  const [showBatchImport, setShowBatchImport] = useState(false)
  const [newName, setNewName] = useState('')
  const [newRole, setNewRole] = useState('普通成员')
  const [newDept, setNewDept] = useState('')
  const [creating, setCreating] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editForm, setEditForm] = useState<{ name: string; system_role: string; department: string }>({ name: '', system_role: '', department: '' })

  useEffect(() => {
    fetchPeople().then(setPeople).finally(() => setLoading(false))
  }, [])

  async function handleCreate() {
    if (!newName.trim()) return
    setCreating(true)
    try {
      const p = await createPerson({ name: newName.trim(), system_role: newRole, department: newDept })
      setPeople(prev => [...prev, p])
      setNewName(''); setNewRole('普通成员'); setNewDept(''); setShowNew(false)
    } finally { setCreating(false) }
  }

  async function handleSaveEdit(id: number) {
    const p = await updatePerson(id, { name: editForm.name, system_role: editForm.system_role, department: editForm.department })
    setPeople(prev => prev.map(x => x.id === id ? { ...x, ...p } : x))
    setEditingId(null)
  }

  async function handleDelete(id: number, name: string) {
    if (!window.confirm(`确认删除「${name}」？该操作不可恢复。`)) return
    await deletePerson(id)
    setPeople(prev => prev.filter(x => x.id !== id))
  }

  if (loading) return <Card><p className="text-sm text-slate-400 py-8 text-center">加载中…</p></Card>

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <SectionTitle inline>人员管理</SectionTitle>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setShowBatchImport(true)}
            className="cursor-pointer flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border border-indigo-200 text-indigo-600 bg-indigo-50 hover:bg-indigo-100">
            <svg style={{ width: 13, height: 13 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" /></svg>
            批量导入
          </button>
          <button type="button" onClick={() => setShowNew(true)}
            className="cursor-pointer flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-white text-xs font-semibold"
            style={{ background: 'linear-gradient(135deg,#0369A1,#0EA5E9)' }}>
            <svg style={{ width: 13, height: 13 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M12 4v16m8-8H4" /></svg>
            新建人员
          </button>
        </div>
      </div>

      {showBatchImport && (
        <PeopleBatchImportModal
          onClose={() => setShowBatchImport(false)}
          onDone={() => {
            fetchPeople().then(setPeople)
            setShowBatchImport(false)
          }}
        />
      )}

      {showNew && (
        <Card>
          <p className="text-sm font-semibold text-slate-700 mb-3">新建人员</p>
          <div className="flex items-center gap-2 flex-wrap">
            <input autoFocus value={newName} onChange={e => setNewName(e.target.value)}
              placeholder="姓名（必填）" onKeyDown={e => e.key === 'Enter' && handleCreate()}
              className="w-32 border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400/30 focus:border-sky-400" />
            <select value={newRole} onChange={e => setNewRole(e.target.value)}
              className="w-32 border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400/30">
              <option>普通成员</option>
              <option>过程保障</option>
              <option>组长CEO</option>
              <option>超级管理员</option>
            </select>
            <input value={newDept} onChange={e => setNewDept(e.target.value)}
              placeholder="部门（可选）"
              className="w-36 border border-slate-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400/30 focus:border-sky-400" />
            <button type="button" onClick={handleCreate} disabled={creating || !newName.trim()}
              className="cursor-pointer px-4 py-2 rounded-xl text-white text-sm font-semibold disabled:opacity-50" style={{ background: '#0369A1' }}>
              {creating ? '创建中…' : '创建'}
            </button>
            <button type="button" onClick={() => { setShowNew(false); setNewName(''); setNewRole('普通成员'); setNewDept('') }}
              className="cursor-pointer px-3 py-2 rounded-xl border border-slate-200 text-slate-500 text-sm">取消</button>
          </div>
        </Card>
      )}

      <Card>
        {people.length === 0
          ? <p className="text-sm text-slate-400 py-8 text-center">暂无人员</p>
          : (
            <div className="divide-y" style={{ '--tw-divide-opacity': 1 } as React.CSSProperties}>
              {people.map(per => (
                <div key={per.id} className="flex items-center gap-3 py-3">
                  <div className="w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-bold flex-shrink-0"
                    style={{ background: per.is_active === false ? '#CBD5E1' : 'linear-gradient(135deg,#3B82F6,#0369A1)' }}>
                    {(per.name as string).slice(0, 1)}
                  </div>

                  {editingId === per.id ? (
                    <div className="flex-1 flex items-center gap-2 flex-wrap">
                      <input value={editForm.name} onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
                        className="w-24 border border-sky-400 rounded-lg px-2 py-1 text-sm focus:outline-none" />
                      <select value={editForm.system_role} onChange={e => setEditForm(f => ({ ...f, system_role: e.target.value }))}
                        className="w-28 border border-slate-200 rounded-lg px-2 py-1 text-xs focus:outline-none">
                        <option>普通成员</option>
                        <option>过程保障</option>
                        <option>组长CEO</option>
                        <option>超级管理员</option>
                      </select>
                      <input value={editForm.department} onChange={e => setEditForm(f => ({ ...f, department: e.target.value }))}
                        placeholder="部门" className="w-28 border border-slate-200 rounded-lg px-2 py-1 text-xs focus:outline-none" />
                      <button type="button" onClick={() => handleSaveEdit(per.id)}
                        className="cursor-pointer px-3 py-1 rounded-lg text-white text-xs font-semibold" style={{ background: '#0369A1' }}>保存</button>
                      <button type="button" onClick={() => setEditingId(null)}
                        className="cursor-pointer px-2 py-1 rounded-lg border border-slate-200 text-slate-500 text-xs">取消</button>
                    </div>
                  ) : (
                    <>
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-semibold text-slate-800">{per.name as string}</span>
                        {per.department && <span className="text-xs text-slate-400 ml-2">{per.department as string}</span>}
                        {per.is_active === false && <span className="text-xs text-slate-400 ml-2">（已停用）</span>}
                      </div>
                      <span className="text-xs px-2 py-0.5 rounded-full flex-shrink-0"
                        style={{ background: per.system_role === '超级管理员' ? '#FEF3C7' : '#F1F5F9', color: per.system_role === '超级管理员' ? '#92400E' : '#64748B' }}>
                        {per.system_role || '普通成员'}
                      </span>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button type="button"
                          onClick={() => { setEditingId(per.id); setEditForm({ name: per.name as string, system_role: (per.system_role as string) || '普通成员', department: (per.department as string) || '' }) }}
                          className="cursor-pointer p-1.5 rounded-lg text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition-colors" title="编辑">
                          <svg style={{ width: 14, height: 14 }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                          </svg>
                        </button>
                        <button type="button" onClick={() => handleDelete(per.id, per.name as string)}
                          className="cursor-pointer p-1.5 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors" title="删除">
                          <svg style={{ width: 14, height: 14 }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          )
        }
      </Card>
    </div>
  )
}

// ─── 操作日志面板 ─────────────────────────────────────────────

const TARGET_TYPE_LABEL: Record<string, string> = {
  task: '任务', issue: '问题', achievement: '成果', project: '项目', person: '人员', meeting: '会议',
}

const ACTION_COLOR: Record<string, string> = {
  新建任务: '#0369A1', 修改任务: '#0891B2', 删除任务: '#DC2626',
  新建问题: '#7C3AED', 修改问题: '#6D28D9', 删除问题: '#B91C1C',
  新建成果: '#059669', 修改成果: '#047857', 删除成果: '#B45309',
  确认入库: '#0369A1', 退回: '#DC2626',
}

function fmtLogTime(s?: string) {
  if (!s) return '-'
  const d = new Date(s.endsWith('Z') ? s : s + 'Z')
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function LogsSection() {
  const [logs, setLogs] = useState<OperationLogItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [page, setPage] = useState(1)
  const [filterOp, setFilterOp] = useState('')
  const [filterType, setFilterType] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const PAGE_SIZE = 50

  function load(p = page) {
    setLoading(true)
    fetchGlobalLogs({ operator: filterOp || undefined, target_type: filterType || undefined, date_from: dateFrom || undefined, date_to: dateTo || undefined, page: p, page_size: PAGE_SIZE })
      .then((r) => { setLogs(r.items); setTotal(r.total) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }

  useEffect(() => { load(1); setPage(1) }, [filterOp, filterType, dateFrom, dateTo])

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="bg-white rounded-2xl border p-4 flex items-center gap-3 flex-wrap" style={{ borderColor: '#E9EFF6' }}>
        <input value={filterOp} onChange={(e) => setFilterOp(e.target.value)} placeholder="操作人" className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-blue-400" style={{ width: 120 }} />
        <select value={filterType} onChange={(e) => setFilterType(e.target.value)} className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm bg-white focus:outline-none focus:border-blue-400 cursor-pointer">
          <option value="">全部类型</option>
          {Object.entries(TARGET_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-blue-400" />
        <span className="text-xs text-slate-400">至</span>
        <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-blue-400" />
        <button onClick={() => load(page)} className="px-3 py-1.5 rounded-lg text-white text-sm font-semibold hover:opacity-90" style={{ background: '#0369A1' }}>查询</button>
        <span className="ml-auto text-xs text-slate-400">共 {total} 条记录</span>
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl border overflow-hidden" style={{ borderColor: '#E9EFF6' }}>
        <table className="w-full text-xs" style={{ borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: '#E8EDF5', borderBottom: '1px solid #C7D2E8' }}>
              {['时间', '操作人', '操作类型', '对象类型', '对象ID', '变更摘要'].map((h) => (
                <th key={h} className="text-left py-2.5 px-4 font-semibold" style={{ color: '#475569' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="py-12 text-center text-slate-400">加载中…</td></tr>
            ) : logs.length === 0 ? (
              <tr><td colSpan={6} className="py-12 text-center text-slate-400">暂无日志记录</td></tr>
            ) : logs.map((log) => {
              const color = ACTION_COLOR[log.action] ?? '#64748B'
              let summary = ''
              try {
                const before = log.before_json ? JSON.parse(log.before_json) : {}
                const after  = log.after_json  ? JSON.parse(log.after_json)  : {}
                const changed = Object.keys(after).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
                summary = changed.length ? `修改字段：${changed.slice(0, 4).join('、')}${changed.length > 4 ? '…' : ''}` : (log.before_json ? '记录已删除' : '新建记录')
              } catch { summary = '-' }
              return (
                <tr key={log.id} style={{ borderBottom: '1px solid #F1F5F9' }}>
                  <td className="py-3 px-4 text-slate-500 whitespace-nowrap">{fmtLogTime(log.created_at)}</td>
                  <td className="py-3 px-4 font-semibold text-slate-700">{log.operator || '-'}</td>
                  <td className="py-3 px-4">
                    <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold text-white" style={{ background: color }}>{log.action || '-'}</span>
                  </td>
                  <td className="py-3 px-4 text-slate-600">{TARGET_TYPE_LABEL[log.target_type] ?? log.target_type ?? '-'}</td>
                  <td className="py-3 px-4 text-slate-400">#{log.target_id ?? '-'}</td>
                  <td className="py-3 px-4 text-slate-500">{summary}</td>
                </tr>
              )
            })}
          </tbody>
        </table>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 py-3 border-t" style={{ borderColor: '#E9EFF6' }}>
            <button disabled={page <= 1} onClick={() => { const p = page - 1; setPage(p); load(p) }} className="px-3 py-1 rounded-lg text-xs border border-slate-200 disabled:opacity-40 hover:bg-slate-50 cursor-pointer">上一页</button>
            <span className="text-xs text-slate-500">{page} / {totalPages}</span>
            <button disabled={page >= totalPages} onClick={() => { const p = page + 1; setPage(p); load(p) }} className="px-3 py-1 rounded-lg text-xs border border-slate-200 disabled:opacity-40 hover:bg-slate-50 cursor-pointer">下一页</button>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── 批量导入人员弹窗 ─────────────────────────────────────────

const SYSTEM_ROLES = ['普通成员', '过程保障', '组长CEO', '超级管理员']

function parsePeopleText(raw: string): BatchPersonItem[] {
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean)
  if (!lines.length) return []

  // 判断是否为 TSV（含 Tab）
  const isTsv = lines.some(l => l.includes('\t'))
  if (isTsv) {
    // 找表头行
    const headerIdx = lines.findIndex(l => l.includes('姓名') || l.includes('名字') || l.includes('name'))
    const dataLines = headerIdx >= 0 ? lines.slice(headerIdx + 1) : lines
    const header = headerIdx >= 0 ? lines[headerIdx].split('\t').map(h => h.trim()) : []
    const col = (row: string[], ...keys: string[]) => {
      for (const k of keys) {
        const i = header.findIndex(h => h.includes(k))
        if (i >= 0 && row[i]) return row[i].trim()
      }
      return ''
    }
    return dataLines.map(l => {
      const row = l.split('\t').map(c => c.trim())
      const name = header.length ? col(row, '姓名', '名字', 'name') : row[0]
      if (!name) return null
      return {
        name,
        role: col(row, '职务', '职位', '岗位', 'role') || '',
        department: col(row, '部门', '团队', 'dept') || '',
        system_role: SYSTEM_ROLES.find(r => col(row, '系统角色', '权限', 'system_role').includes(r)) || '普通成员',
        contact: col(row, '联系', '电话', '邮件', 'contact') || '',
      }
    }).filter(Boolean) as BatchPersonItem[]
  }

  // 纯姓名列表：每行一个名字
  return lines.map(name => ({ name, role: '', department: '', system_role: '普通成员', contact: '' }))
}

function PeopleBatchImportModal({ onClose, onDone }: {
  onClose: () => void
  onDone: () => void
}) {
  const [step, setStep] = useState<'input' | 'preview' | 'result'>('input')
  const [raw, setRaw] = useState('')
  const [rows, setRows] = useState<BatchPersonItem[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<{ created: number; skipped: number; skipped_names: string[] } | null>(null)

  function handleParse() {
    const parsed = parsePeopleText(raw)
    if (!parsed.length) return alert('未识别到有效人员，请检查格式')
    setRows(parsed)
    setStep('preview')
  }

  function updateRow(i: number, field: keyof BatchPersonItem, val: string) {
    setRows(prev => prev.map((r, idx) => idx === i ? { ...r, [field]: val } : r))
  }

  function removeRow(i: number) {
    setRows(prev => prev.filter((_, idx) => idx !== i))
  }

  async function handleSubmit() {
    if (!rows.length) return
    setSubmitting(true)
    try {
      const res = await batchCreatePeople(rows)
      setResult(res)
      setStep('result')
      onDone()
    } catch { alert('批量导入失败，请重试') }
    finally { setSubmitting(false) }
  }

  const inputCls = 'w-full border border-slate-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-indigo-400'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center" style={{ background: 'rgba(15,23,42,0.45)' }}>
      <div className="bg-white rounded-2xl shadow-2xl flex flex-col" style={{ width: 680, maxWidth: '95vw', maxHeight: '88vh' }}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b flex-shrink-0" style={{ borderColor: '#E9EFF6' }}>
          <div>
            <h2 className="text-base font-bold text-slate-800">批量导入人员</h2>
            <p className="text-xs text-slate-400 mt-0.5">
              {step === 'input' && '粘贴表格或每行一个姓名'}
              {step === 'preview' && `已解析 ${rows.length} 条，确认后导入`}
              {step === 'result' && '导入完成'}
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400">
            <svg style={{ width: 16, height: 16 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          {step === 'input' && (
            <div className="space-y-4">
              <div className="rounded-xl border border-slate-100 bg-slate-50 px-4 py-3 text-xs text-slate-500 space-y-1">
                <p className="font-semibold text-slate-600">支持两种格式：</p>
                <p>① 从 Excel/WPS 直接复制粘贴表格（含"姓名"列即可，可选列：职务、部门、系统角色、联系方式）</p>
                <p>② 每行输入一个姓名，默认角色为"普通成员"</p>
              </div>
              <textarea
                autoFocus
                rows={12}
                value={raw}
                onChange={e => setRaw(e.target.value)}
                placeholder={"示例（每行一个）：\n张三\n李四\n王五\n\n或粘贴 Excel 表格"}
                className="w-full border border-slate-200 rounded-xl px-4 py-3 text-sm resize-none focus:outline-none focus:border-indigo-400"
              />
            </div>
          )}

          {step === 'preview' && (
            <div className="space-y-2">
              <div className="grid text-xs font-semibold text-slate-500 px-2 pb-1" style={{ gridTemplateColumns: '1fr 90px 110px 110px 32px' }}>
                <span>姓名</span><span>职务</span><span>部门</span><span>系统角色</span><span />
              </div>
              {rows.map((row, i) => (
                <div key={i} className="grid items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-50" style={{ gridTemplateColumns: '1fr 90px 110px 110px 32px' }}>
                  <input value={row.name} onChange={e => updateRow(i, 'name', e.target.value)} className={inputCls} placeholder="姓名" />
                  <input value={row.role} onChange={e => updateRow(i, 'role', e.target.value)} className={inputCls} placeholder="职务" />
                  <input value={row.department} onChange={e => updateRow(i, 'department', e.target.value)} className={inputCls} placeholder="部门" />
                  <select value={row.system_role} onChange={e => updateRow(i, 'system_role', e.target.value)}
                    className="border border-slate-200 rounded-lg px-2 py-1.5 text-xs focus:outline-none focus:border-indigo-400 bg-white">
                    {SYSTEM_ROLES.map(r => <option key={r}>{r}</option>)}
                  </select>
                  <button onClick={() => removeRow(i)} className="text-slate-300 hover:text-red-400 flex items-center justify-center">
                    <svg style={{ width: 14, height: 14 }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                </div>
              ))}
            </div>
          )}

          {step === 'result' && result && (
            <div className="py-8 text-center space-y-4">
              <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto" style={{ background: '#F0FDF4' }}>
                <svg style={{ width: 28, height: 28, color: '#16A34A' }} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
              </div>
              <p className="text-lg font-bold text-slate-800">导入完成</p>
              <div className="flex items-center justify-center gap-6 text-sm">
                <span className="text-emerald-600 font-semibold">✓ 新增 {result.created} 人</span>
                {result.skipped > 0 && <span className="text-slate-400">跳过 {result.skipped} 人（已存在）</span>}
              </div>
              {result.skipped_names.length > 0 && (
                <p className="text-xs text-slate-400">已跳过：{result.skipped_names.join('、')}</p>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t flex-shrink-0" style={{ borderColor: '#E9EFF6' }}>
          <button onClick={step === 'preview' ? () => setStep('input') : onClose}
            className="px-4 py-2 rounded-lg border border-slate-200 text-slate-600 text-sm hover:bg-slate-50 cursor-pointer">
            {step === 'preview' ? '返回修改' : '关闭'}
          </button>
          {step === 'input' && (
            <button onClick={handleParse} disabled={!raw.trim()}
              className="px-5 py-2 rounded-lg text-white text-sm font-semibold disabled:opacity-40 cursor-pointer"
              style={{ background: 'linear-gradient(135deg,#4F46E5,#7C3AED)' }}>
              解析预览
            </button>
          )}
          {step === 'preview' && (
            <button onClick={handleSubmit} disabled={submitting || !rows.length}
              className="px-5 py-2 rounded-lg text-white text-sm font-semibold disabled:opacity-40 cursor-pointer"
              style={{ background: 'linear-gradient(135deg,#0369A1,#0EA5E9)' }}>
              {submitting ? '导入中…' : `确认导入 ${rows.length} 人`}
            </button>
          )}
          {step === 'result' && (
            <button onClick={onClose}
              className="px-5 py-2 rounded-lg text-white text-sm font-semibold cursor-pointer"
              style={{ background: 'linear-gradient(135deg,#0369A1,#0EA5E9)' }}>
              完成
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
