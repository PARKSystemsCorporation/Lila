'use client'

import { useEffect, useRef, useState, useCallback } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

type Tab = 'chat' | 'log' | 'dash' | 'skills'

interface Message {
  role: 'user' | 'assistant'
  content: string
}

interface LogEntry {
  id: number
  message: string
  timestamp: number
  type: 'info' | 'success' | 'warn'
}

interface AgentData {
  totalEarned: number
  activeTasks: string[]
  lastBounty: { name: string; value: number; time: number }
  log: LogEntry[]
}

interface Skill {
  id: number
  name: string
  description: string
  trigger: string
  code: string
  use_count: number
  created_at: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(ts: number) {
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function fmtAge(ts: number) {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`
}

// ─── Icons ────────────────────────────────────────────────────────────────────

const IconChat = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6">
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
  </svg>
)

const IconLog = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6">
    <polyline points="4 17 10 11 4 5" />
    <line x1="12" y1="19" x2="20" y2="19" />
  </svg>
)

const IconDash = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6">
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
  </svg>
)

const IconSkills = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6">
    <path d="M13 2 4.09 12.26a1 1 0 0 0 .91 1.74H11l-1 8 8.91-10.26A1 1 0 0 0 18 10h-5l1-8z" />
  </svg>
)

// ─── Bottom Nav ───────────────────────────────────────────────────────────────

const TABS: { key: Tab; label: string; Icon: () => JSX.Element }[] = [
  { key: 'chat',   label: 'Chat',      Icon: IconChat   },
  { key: 'log',    label: 'Log',       Icon: IconLog    },
  { key: 'dash',   label: 'Dashboard', Icon: IconDash   },
  { key: 'skills', label: 'Skills',    Icon: IconSkills },
]

function BottomNav({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  return (
    <nav className="shrink-0 flex border-t border-slate-800 bg-slate-950" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      {TABS.map(({ key, label, Icon }) => {
        const active = tab === key
        return (
          <button
            key={key}
            onClick={() => onTab(key)}
            className={`flex-1 flex flex-col items-center gap-1 py-2.5 transition-colors ${active ? 'text-emerald-400' : 'text-slate-600 active:text-slate-400'}`}
          >
            <Icon />
            <span className={`text-[9px] font-mono tracking-widest uppercase ${active ? 'text-emerald-400' : 'text-slate-700'}`}>
              {label}
            </span>
          </button>
        )
      })}
    </nav>
  )
}

// ─── Chat Tab ─────────────────────────────────────────────────────────────────

function ChatTab({ visible }: { visible: boolean }) {
  const [messages, setMessages] = useState<Message[]>([
    { role: 'assistant', content: 'Online. What do you need.' },
  ])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || streaming) return
    setInput('')

    const history = [...messages, { role: 'user' as const, content: text }]
    setMessages([...history, { role: 'assistant', content: '' }])
    setStreaming(true)

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history.map(m => ({ role: m.role, content: m.content })) }),
      })

      if (!res.ok || !res.body) throw new Error()

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let full = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        full += decoder.decode(value, { stream: true })
        setMessages(prev => {
          const updated = [...prev]
          updated[updated.length - 1] = { role: 'assistant', content: full }
          return updated
        })
      }
    } catch {
      setMessages(prev => {
        const updated = [...prev]
        updated[updated.length - 1] = { role: 'assistant', content: 'Dropped connection. Try again.' }
        return updated
      })
    } finally {
      setStreaming(false)
    }
  }, [input, messages, streaming])

  return (
    <div className={`absolute inset-0 flex flex-col ${visible ? '' : 'invisible pointer-events-none'}`}>
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            {m.role === 'assistant' && (
              <span className="text-emerald-500 font-mono text-xs mr-2 mt-1.5 shrink-0">L</span>
            )}
            <div
              className={`max-w-[82%] rounded-2xl px-4 py-2.5 text-sm font-mono leading-relaxed ${
                m.role === 'user'
                  ? 'bg-slate-800 text-slate-100 rounded-tr-sm'
                  : 'bg-slate-900 text-slate-200 rounded-tl-sm border border-slate-800'
              }`}
            >
              {m.content}
              {streaming && i === messages.length - 1 && m.role === 'assistant' && (
                <span className="inline-block w-1.5 h-3.5 bg-emerald-500 ml-0.5 animate-pulse align-middle" />
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="shrink-0 px-4 py-3 border-t border-slate-800 bg-slate-950 flex gap-2">
        <input
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && send()}
          placeholder="Ask Lila anything..."
          className="flex-1 bg-slate-900 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-slate-100 font-mono placeholder:text-slate-700 focus:outline-none focus:border-emerald-800"
        />
        <button
          onClick={send}
          disabled={!input.trim() || streaming}
          className="shrink-0 w-10 h-10 rounded-xl bg-emerald-600 disabled:bg-slate-800 flex items-center justify-center transition-colors active:bg-emerald-700"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 text-white -translate-y-px">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
      </div>
    </div>
  )
}

// ─── Log Tab ──────────────────────────────────────────────────────────────────

const LOG_COLOR = { info: 'text-slate-400', success: 'text-emerald-400', warn: 'text-amber-400' }
const LOG_PREFIX = { info: '›', success: '✓', warn: '⚠' }

function LogTab({ log, visible }: { log: LogEntry[]; visible: boolean }) {
  return (
    <div className={`absolute inset-0 overflow-y-auto ${visible ? '' : 'invisible pointer-events-none'}`}>
      <div className="px-4 py-4 space-y-3.5">
        {log.length === 0 ? (
          <p className="text-xs font-mono text-slate-700 pt-10 text-center">Waiting for first tick...</p>
        ) : log.map(e => (
          <div key={e.id} className="flex gap-3 items-start">
            <span className={`font-mono text-sm shrink-0 w-4 text-center ${LOG_COLOR[e.type]}`}>
              {LOG_PREFIX[e.type]}
            </span>
            <div className="min-w-0">
              <p className={`text-sm font-mono leading-snug break-words ${LOG_COLOR[e.type]}`}>{e.message}</p>
              <p className="text-[10px] text-slate-700 font-mono mt-0.5">{fmt(e.timestamp)}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Dashboard Tab ────────────────────────────────────────────────────────────

function DashTab({ data, flash, visible }: { data: AgentData | null; flash: boolean; visible: boolean }) {
  return (
    <div className={`absolute inset-0 overflow-y-auto ${visible ? '' : 'invisible pointer-events-none'}`}>
      <div className="px-4 py-5 space-y-4">
        {/* Earned */}
        <div className={`rounded-2xl border p-5 transition-colors duration-300 ${flash ? 'border-emerald-500 bg-emerald-950/30' : 'border-slate-800 bg-slate-900'}`}>
          <p className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mb-1">Total Earned</p>
          <p className={`text-5xl font-bold font-mono tabular-nums transition-colors duration-300 ${flash ? 'text-emerald-300' : 'text-emerald-400'}`}>
            ${data?.totalEarned.toFixed(2) ?? '—'}
          </p>
          <p className="text-[10px] text-slate-700 font-mono mt-2">Persisted. Survives restarts.</p>
        </div>

        {/* Active Tasks */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <div className="flex items-center justify-between mb-3">
            <p className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">Active Tasks</p>
            <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ${(data?.activeTasks.length ?? 0) > 0 ? 'bg-emerald-950 text-emerald-400 border-emerald-900' : 'bg-slate-800 text-slate-600 border-slate-700'}`}>
              {data?.activeTasks.length ?? 0} running
            </span>
          </div>
          {!data?.activeTasks.length ? (
            <p className="text-sm text-slate-600 font-mono">Queue empty. Scanning.</p>
          ) : (
            <ul className="space-y-2.5">
              {data.activeTasks.map((task, i) => (
                <li key={i} className="flex items-start gap-2.5">
                  <span className="text-emerald-500 mt-0.5 shrink-0 text-xs">▶</span>
                  <span className="text-sm text-slate-300 font-mono leading-snug">{task}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Last Bounty */}
        {data?.lastBounty && (
          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
            <p className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mb-2">Last Bounty Claimed</p>
            <p className="text-sm text-slate-200 font-mono leading-snug">{data.lastBounty.name}</p>
            <div className="flex justify-between items-center mt-3">
              <span className="text-xl font-bold text-emerald-400 font-mono tabular-nums">+${data.lastBounty.value}</span>
              <span className="text-[10px] text-slate-600 font-mono">{fmtAge(data.lastBounty.time)}</span>
            </div>
          </div>
        )}

        {/* Status */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4 flex items-center gap-3">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse shrink-0" />
          <div>
            <p className="text-[10px] font-mono text-emerald-500 uppercase tracking-widest">Systems operational</p>
            <p className="text-[10px] text-slate-600 font-mono mt-0.5">Lila is running. You don't need to do anything.</p>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Skills Tab ───────────────────────────────────────────────────────────────

function SkillsTab({ skills, loading, visible }: { skills: Skill[]; loading: boolean; visible: boolean }) {
  return (
    <div className={`absolute inset-0 overflow-y-auto ${visible ? '' : 'invisible pointer-events-none'}`}>
      <div className="px-4 py-5">
        {/* Header */}
        <div className="flex items-center gap-2 mb-4">
          <span className="text-emerald-500"><IconSkills /></span>
          <div>
            <p className="text-xs font-mono text-slate-300 font-semibold">Hermes Skill Library</p>
            <p className="text-[10px] font-mono text-slate-600">Autonomously synthesized</p>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 py-10 justify-center">
            <div className="w-4 h-4 border-2 border-slate-700 border-t-emerald-500 rounded-full animate-spin" />
            <p className="text-xs font-mono text-slate-600">Loading skill library...</p>
          </div>
        ) : skills.length === 0 ? (
          <div className="border border-slate-800 rounded-2xl p-6 text-center">
            <p className="text-sm font-mono text-slate-500">No skills yet.</p>
            <p className="text-xs font-mono text-slate-700 mt-1">Hermes synthesizes one every 6 ticks.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {skills.map(skill => (
              <SkillCard key={skill.id} skill={skill} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function SkillCard({ skill }: { skill: Skill }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="border border-slate-800 rounded-2xl bg-slate-900 overflow-hidden">
      <button className="w-full p-4 text-left" onClick={() => setExpanded(e => !e)}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs font-mono text-emerald-400 font-semibold truncate">{skill.name}</p>
            <p className="text-sm text-slate-300 font-mono leading-snug mt-1">{skill.description}</p>
          </div>
          <span className={`text-slate-600 text-xs font-mono shrink-0 mt-0.5 transition-transform ${expanded ? 'rotate-180' : ''}`}>▾</span>
        </div>
        <p className="text-[10px] font-mono text-slate-600 mt-2">{skill.created_at} · used {skill.use_count}×</p>
      </button>

      {expanded && (
        <div className="border-t border-slate-800 px-4 py-3 space-y-3">
          <div>
            <p className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mb-1">Trigger</p>
            <p className="text-xs font-mono text-slate-400 leading-snug">{skill.trigger}</p>
          </div>
          <div>
            <p className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mb-1">Implementation</p>
            <pre className="text-[10px] font-mono text-emerald-300/70 leading-relaxed overflow-x-auto whitespace-pre-wrap break-all">{skill.code}</pre>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Root ─────────────────────────────────────────────────────────────────────

export default function Home() {
  const [tab, setTab] = useState<Tab>('chat')
  const [data, setData] = useState<AgentData | null>(null)
  const [status, setStatus] = useState<'connecting' | 'live' | 'error'>('connecting')
  const [flash, setFlash] = useState(false)
  const [skills, setSkills] = useState<Skill[]>([])
  const [skillsLoading, setSkillsLoading] = useState(false)
  const prevEarned = useRef<number | null>(null)

  // Agent poll every 5s
  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch('/api/agent')
        if (!res.ok) throw new Error()
        const json: AgentData = await res.json()
        if (prevEarned.current !== null && json.totalEarned > prevEarned.current) {
          setFlash(true)
          setTimeout(() => setFlash(false), 900)
        }
        prevEarned.current = json.totalEarned
        setData(json)
        setStatus('live')
      } catch {
        setStatus('error')
      }
    }
    poll()
    const id = setInterval(poll, 5000)
    return () => clearInterval(id)
  }, [])

  // Load skills when tab opens
  useEffect(() => {
    if (tab !== 'skills') return
    setSkillsLoading(true)
    fetch('/api/skills')
      .then(r => r.json())
      .then(setSkills)
      .catch(() => {})
      .finally(() => setSkillsLoading(false))
  }, [tab])

  return (
    <div className="h-dvh flex flex-col bg-slate-950 max-w-md mx-auto select-none">
      {/* Header */}
      <header className="shrink-0 px-5 py-3 border-b border-slate-800/60 flex items-center justify-between" style={{ paddingTop: 'max(12px, env(safe-area-inset-top))' }}>
        <div className="flex items-center gap-2.5">
          <span className={`w-2 h-2 rounded-full shrink-0 ${status === 'live' ? 'bg-emerald-500 animate-pulse' : status === 'error' ? 'bg-red-500' : 'bg-slate-600 animate-pulse'}`} />
          <div>
            <span className="text-white font-bold text-lg tracking-tight">Lila</span>
            <span className="text-slate-700 font-mono text-[10px] ml-2 tracking-widest">AGENT v1</span>
          </div>
        </div>
        {data && (
          <div className="text-right">
            <p className={`text-sm font-mono font-bold tabular-nums transition-colors duration-300 ${flash ? 'text-emerald-300' : 'text-emerald-500'}`}>
              ${data.totalEarned.toFixed(2)}
            </p>
            <p className="text-[9px] font-mono text-slate-700 uppercase tracking-widest">earned</p>
          </div>
        )}
      </header>

      {/* Tab content */}
      <main className="flex-1 relative overflow-hidden">
        <ChatTab visible={tab === 'chat'} />
        <LogTab log={data?.log ?? []} visible={tab === 'log'} />
        <DashTab data={data} flash={flash} visible={tab === 'dash'} />
        <SkillsTab skills={skills} loading={skillsLoading} visible={tab === 'skills'} />
      </main>

      <BottomNav tab={tab} onTab={setTab} />
    </div>
  )
}
