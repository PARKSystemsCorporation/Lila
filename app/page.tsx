'use client'

import { useEffect, useRef, useState, useCallback } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

type Tab = 'chat' | 'log' | 'dash' | 'bounties' | 'reports'

interface UnifiedBounty {
  id: string
  platform: string
  platformLabel: string
  title: string
  description: string
  reward: number
  token: string
  url?: string
  deadline?: string
  readOnly: boolean
  chain: string
}

interface Message {
  role: 'user' | 'lila' | 'tasker' | 'analyst'
  content: string
  id?: number
}

interface SecurityReport {
  id: number
  bounty_id: string
  platform: string
  platform_label: string
  title: string
  reward: number
  chain?: string
  url?: string
  content: string
  confidence: number
  status: 'pending_review' | 'approved' | 'rejected' | 'submitted' | 'dismissed'
  review_notes?: string | null
  created_at: string
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

const IconReports = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6">
    <path d="M9 2h6l5 5v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h3" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="9" y1="13" x2="15" y2="13" />
    <line x1="9" y1="17" x2="13" y2="17" />
  </svg>
)

const IconBounties = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6">
    <circle cx="12" cy="12" r="10" />
    <path d="M12 6v6l4 2" />
  </svg>
)

// ─── Bottom Nav ───────────────────────────────────────────────────────────────

const TABS: { key: Tab; label: string; Icon: () => JSX.Element }[] = [
  { key: 'chat',     label: 'Chat',    Icon: IconChat     },
  { key: 'log',      label: 'Log',     Icon: IconLog      },
  { key: 'dash',     label: 'Dash',    Icon: IconDash     },
  { key: 'bounties', label: 'Board',   Icon: IconBounties },
  { key: 'reports',  label: 'Reports', Icon: IconReports  },
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

// ─── Chat Tab (group: you + Lila + Analyst) ───────────────────────────────────

const ROLE_STYLE = {
  lila:    { avatar: 'L', color: 'text-emerald-400', ring: 'bg-emerald-900 border-emerald-700', bubble: 'bg-slate-900 text-slate-200 border-slate-800' },
  tasker:  { avatar: 'T', color: 'text-amber-400',   ring: 'bg-amber-950 border-amber-800',     bubble: 'bg-amber-950/40 text-amber-200 border-amber-900/60' },
  analyst: { avatar: 'A', color: 'text-blue-400',    ring: 'bg-blue-900 border-blue-700',       bubble: 'bg-blue-950/60 text-blue-200 border-blue-900/60' },
} as const

function ChatTab({ visible }: { visible: boolean }) {
  const [messages, setMessages] = useState<Message[]>([
    { role: 'lila', content: 'Online. Direct line. What do you need.' },
  ])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const lastId = useRef(0)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Poll for Tasker/Lila/Analyst messages every 5s
  useEffect(() => {
    if (!visible) return
    const poll = async () => {
      try {
        const res = await fetch(`/api/chat/messages?after=${lastId.current}`)
        if (!res.ok) return
        const { messages: incoming } = await res.json()
        if (incoming.length > 0) {
          setMessages(prev => [
            ...prev,
            ...incoming.map((m: { id: number; sender: string; content: string }) => ({
              role: (m.sender === 'analyst' ? 'analyst'
                   : m.sender === 'tasker'  ? 'tasker'
                   : 'lila') as Message['role'],
              content: m.content,
              id: m.id,
            })),
          ])
          lastId.current = incoming[incoming.length - 1].id
        }
      } catch { /* network hiccup */ }
    }
    const id = setInterval(poll, 5000)
    return () => clearInterval(id)
  }, [visible])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || streaming) return
    setInput('')

    const history = [...messages, { role: 'user' as const, content: text }]
    setMessages([...history, { role: 'lila', content: '' }])
    setStreaming(true)

    try {
      // Only user/lila history goes to the /api/chat LLM; tasker/analyst posts
      // are background noise from Lila's perspective (she sees the state via
      // server-side context injection instead).
      const apiMessages = history
        .filter(m => m.role === 'user' || m.role === 'lila')
        .map(m => ({ role: m.role === 'lila' ? 'assistant' : 'user', content: m.content }))

      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: apiMessages }),
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
          updated[updated.length - 1] = { role: 'lila', content: full }
          return updated
        })
      }
    } catch {
      setMessages(prev => {
        const updated = [...prev]
        updated[updated.length - 1] = { role: 'lila', content: 'Dropped connection. Try again.' }
        return updated
      })
    } finally {
      setStreaming(false)
    }
  }, [input, messages, streaming])

  return (
    <div className={`absolute inset-0 flex flex-col ${visible ? '' : 'invisible pointer-events-none'}`}>
      {/* Direct-line header */}
      <div className="shrink-0 px-4 pt-3 pb-2 flex items-center gap-3 border-b border-slate-800/60">
        <div className="flex gap-1">
          <span className="w-5 h-5 rounded-full bg-emerald-900 border border-emerald-700 flex items-center justify-center text-[9px] font-mono text-emerald-400">L</span>
          <span className="w-5 h-5 rounded-full bg-amber-950 border border-amber-800 flex items-center justify-center text-[9px] font-mono text-amber-400">T</span>
          <span className="w-5 h-5 rounded-full bg-blue-900 border border-blue-700 flex items-center justify-center text-[9px] font-mono text-blue-400">A</span>
          <span className="w-5 h-5 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center text-[9px] font-mono text-slate-400">U</span>
        </div>
        <div className="min-w-0">
          <p className="text-[10px] font-mono text-emerald-500 uppercase tracking-widest">Direct line · Lila</p>
          <p className="text-[9px] font-mono text-slate-600">Tasker & Analyst post status here</p>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {messages.map((m, i) => {
          const isUser = m.role === 'user'
          const role = m.role !== 'user' ? ROLE_STYLE[m.role] : null
          return (
            <div key={m.id ?? i} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
              {!isUser && role && (
                <span className={`font-mono text-xs mr-2 mt-1.5 shrink-0 w-4 text-center ${role.color}`}>
                  {role.avatar}
                </span>
              )}
              <div className={`max-w-[82%] rounded-2xl px-4 py-2.5 text-sm font-mono leading-relaxed border ${
                isUser
                  ? 'bg-slate-800 text-slate-100 rounded-tr-sm border-slate-700'
                  : `${role!.bubble} rounded-tl-sm`
              }`}>
                {m.content}
                {streaming && i === messages.length - 1 && m.role === 'lila' && (
                  <span className="inline-block w-1.5 h-3.5 bg-emerald-500 ml-0.5 animate-pulse align-middle" />
                )}
              </div>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="shrink-0 px-4 py-3 border-t border-slate-800 bg-slate-950 flex gap-2">
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && send()}
          placeholder="Message Lila..."
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

// ─── Setup Card ───────────────────────────────────────────────────────────────

interface SetupResult {
  success: boolean
  apiKey?: string
  claimCode?: string
  claimUrl?: string
  verified?: boolean | null
  verifyError?: string | null
  alreadyConfigured?: boolean
  status?: { status?: string; username?: string; claimed?: boolean }
  error?: string
}

function SetupCard() {
  const [st, setSt] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [result, setResult] = useState<SetupResult | null>(null)
  const [copiedField, setCopiedField] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)

  const register = async () => {
    setSt('loading')
    try {
      const res = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: 'superteam' }),
      })
      const data = await res.json()
      const r = data.superteam as SetupResult
      setResult(r)
      setSt(r?.success ? 'done' : 'error')
    } catch {
      setSt('error')
      setResult({ success: false, error: 'Network error.' })
    }
  }

  const checkStatus = async () => {
    setChecking(true)
    try {
      const res = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ platform: 'superteam', action: 'status' }),
      })
      const data = await res.json()
      const r = data.superteam as SetupResult
      setResult(prev => ({ ...(prev ?? {}), ...r }))
    } finally {
      setChecking(false)
    }
  }

  const copy = (text: string, field: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedField(field)
      setTimeout(() => setCopiedField(null), 2000)
    })
  }

  const claimed = result?.status?.claimed === true
    || (typeof result?.status?.status === 'string' && result.status.status.toUpperCase() === 'CLAIMED')

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">Platform Setup</p>
          <p className="text-xs font-mono text-slate-400 mt-0.5">Register Lila on Superteam Earn</p>
        </div>
        {st === 'idle' && (
          <button
            onClick={register}
            className="text-[10px] font-mono bg-emerald-700 text-white rounded-lg px-3 py-1.5 active:bg-emerald-600"
          >
            Register
          </button>
        )}
        {st === 'loading' && (
          <div className="w-4 h-4 border-2 border-slate-700 border-t-emerald-500 rounded-full animate-spin" />
        )}
      </div>

      {st === 'done' && result?.success && (
        <div className="space-y-2.5 pt-1">
          {/* API Key */}
          {result.apiKey && (
            <div className="bg-slate-950 rounded-xl p-3">
              <p className="text-[9px] font-mono text-slate-600 uppercase tracking-widest mb-1">API Key — copy to Railway</p>
              <div className="flex items-center gap-2">
                <p className="text-[11px] font-mono text-emerald-400 break-all flex-1">{result.apiKey}</p>
                <button
                  onClick={() => copy(result.apiKey!, 'apiKey')}
                  className="shrink-0 text-[9px] font-mono text-slate-400 border border-slate-700 rounded px-2 py-1 active:bg-slate-800"
                >
                  {copiedField === 'apiKey' ? '✓' : 'Copy'}
                </button>
              </div>
            </div>
          )}

          {/* Claim code (raw) — so it works even if the URL doesn't */}
          {result.claimCode && (
            <div className="bg-slate-950 rounded-xl p-3">
              <p className="text-[9px] font-mono text-slate-600 uppercase tracking-widest mb-1">Claim code — paste on Superteam if link fails</p>
              <div className="flex items-center gap-2">
                <p className="text-[11px] font-mono text-blue-400 break-all flex-1">{result.claimCode}</p>
                <button
                  onClick={() => copy(result.claimCode!, 'code')}
                  className="shrink-0 text-[9px] font-mono text-slate-400 border border-slate-700 rounded px-2 py-1 active:bg-slate-800"
                >
                  {copiedField === 'code' ? '✓' : 'Copy'}
                </button>
              </div>
            </div>
          )}

          {/* Claim URL */}
          {result.claimUrl && (
            <div className="bg-slate-950 rounded-xl p-3">
              <p className="text-[9px] font-mono text-slate-600 uppercase tracking-widest mb-1">Claim link — tap to link payouts to you</p>
              <a
                href={result.claimUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] font-mono text-blue-400 break-all underline"
              >
                {result.claimUrl}
              </a>
            </div>
          )}

          {/* Verification status */}
          {result.verified === true && (
            <p className="text-[10px] font-mono text-emerald-400">✓ Agent verified active.</p>
          )}
          {result.verified === false && (
            <p className="text-[10px] font-mono text-amber-400">
              ⚠ Registration succeeded but status check failed: {result.verifyError ?? 'unknown'}
            </p>
          )}

          {/* Status after check */}
          {result.status && (
            <div className={`rounded-xl p-3 border ${claimed ? 'bg-emerald-950/40 border-emerald-900/50' : 'bg-slate-950 border-slate-800'}`}>
              <p className="text-[9px] font-mono text-slate-500 uppercase tracking-widest mb-1">Agent status</p>
              <p className="text-[11px] font-mono text-slate-300">
                {result.status.status ?? 'unknown'}
                {result.status.username ? ` · @${result.status.username}` : ''}
                {claimed ? ' · already claimed — 404 on link is expected' : ''}
              </p>
            </div>
          )}

          {/* Recheck button */}
          <button
            onClick={checkStatus}
            disabled={checking}
            className="w-full text-[10px] font-mono text-slate-300 border border-slate-700 rounded-lg py-2 active:bg-slate-800 disabled:opacity-40"
          >
            {checking ? 'Checking…' : 'Check agent status'}
          </button>

          <div className="bg-amber-950/40 border border-amber-900/50 rounded-xl p-3">
            <p className="text-[10px] font-mono text-amber-400 leading-relaxed whitespace-pre-line">
              {`1. Copy the API key above → add SUPERTEAM_API_KEY in Railway → redeploy.
2. Tap the claim link to link Lila's winnings to your Superteam account.
3. If the link 404s, the agent is likely already claimed (or still active under your account) — tap "Check agent status" to confirm.`}
            </p>
          </div>
        </div>
      )}

      {st === 'error' && (
        <p className="text-[11px] font-mono text-red-400">{result?.error ?? 'Registration failed. Try again.'}</p>
      )}
    </div>
  )
}

// ─── Portfolio Card ───────────────────────────────────────────────────────────

interface AlpacaPosition { symbol: string; qty: string; current_price: string; unrealized_pl: string; unrealized_plpc: string }
interface AlpacaAccount { equity: string; buying_power: string; cash: string }

interface ResearchTarget {
  id: number
  title: string
  platform_label: string
  reward: number | string
  chain?: string
  phase: 'map' | 'surfaces' | 'invariants' | 'hypothesize' | 'investigate' | 'found' | 'exhausted'
  cycles: number
  fruitless_cycles: number
  status: 'active' | 'exhausted' | 'found' | 'abandoned'
  open_hyp?: number | string
  closed_hyp?: number | string
  finding_cnt?: number | string
}

const PHASE_LABEL: Record<string, string> = {
  map: 'MAPPING',
  surfaces: 'SURFACES',
  invariants: 'INVARIANTS',
  hypothesize: 'HYPOTHESIZING',
  investigate: 'INVESTIGATING',
  found: 'FINDING FILED',
  exhausted: 'EXHAUSTED',
}
const PHASE_ORDER = ['map', 'surfaces', 'invariants', 'hypothesize', 'investigate']

interface CostData {
  today: number
  today_tokens: number
  calls_today: number
  mtd: number
  earnings_submitted_mtd: number
  earnings_lifetime: number
  budget: number
  byModule: { module: string; cost: number; calls: number; tokens: number }[]
}

function CostCard() {
  const [data, setData] = useState<CostData | null>(null)

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/api/costs')
        if (res.ok) setData(await res.json())
      } catch { /* ignore */ }
    }
    load()
    const id = setInterval(load, 20_000)
    return () => clearInterval(id)
  }, [])

  if (!data) return null

  const pct = data.budget > 0 ? Math.min(100, (data.today / data.budget) * 100) : 0
  const net = data.earnings_submitted_mtd - data.mtd
  const top = data.byModule.slice(0, 5)
  const maxCost = top[0]?.cost ?? 0

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">Service Costs</p>
        {data.budget > 0 && (
          <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border ${
            pct >= 90 ? 'bg-red-950 text-red-400 border-red-900'
            : pct >= 60 ? 'bg-amber-950 text-amber-400 border-amber-900'
            : 'bg-slate-800 text-slate-400 border-slate-700'
          }`}>
            {pct.toFixed(0)}% of cap
          </span>
        )}
      </div>

      <div className="flex gap-4">
        <div>
          <p className="text-2xl font-bold font-mono text-white tabular-nums">${data.today.toFixed(4)}</p>
          <p className="text-[10px] font-mono text-slate-600">today · {data.calls_today} calls</p>
        </div>
        <div className="border-l border-slate-800 pl-4">
          <p className="text-sm font-mono text-slate-400 tabular-nums">${data.mtd.toFixed(2)}</p>
          <p className="text-[10px] font-mono text-slate-600">month to date</p>
        </div>
      </div>

      {data.budget > 0 && (
        <div className="h-1 rounded-full bg-slate-800 overflow-hidden">
          <div className={`h-full transition-all ${
            pct >= 90 ? 'bg-red-500' : pct >= 60 ? 'bg-amber-500' : 'bg-emerald-500'
          }`} style={{ width: `${pct}%` }} />
        </div>
      )}

      {/* Earnings vs costs */}
      <div className="grid grid-cols-2 gap-3 pt-1 border-t border-slate-800">
        <div>
          <p className="text-sm font-mono text-emerald-400 tabular-nums">
            +${data.earnings_submitted_mtd.toFixed(2)}
          </p>
          <p className="text-[10px] font-mono text-slate-600">submitted reports (MTD)</p>
        </div>
        <div>
          <p className={`text-sm font-mono tabular-nums ${net >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {net >= 0 ? '+' : ''}${net.toFixed(2)}
          </p>
          <p className="text-[10px] font-mono text-slate-600">net MTD</p>
        </div>
      </div>

      {/* Per-module burn, today */}
      {top.length > 0 && (
        <div className="space-y-1.5 pt-2 border-t border-slate-800">
          <p className="text-[9px] font-mono text-slate-600 uppercase tracking-widest">Burn today by module</p>
          {top.map(m => {
            const barPct = maxCost > 0 ? (m.cost / maxCost) * 100 : 0
            return (
              <div key={m.module} className="flex items-center gap-2">
                <span className="text-[10px] font-mono text-slate-400 w-28 shrink-0 truncate">{m.module}</span>
                <div className="flex-1 h-1 rounded-full bg-slate-800 overflow-hidden">
                  <div className="h-full bg-slate-600" style={{ width: `${barPct}%` }} />
                </div>
                <span className="text-[10px] font-mono text-slate-500 tabular-nums w-16 text-right shrink-0">
                  ${m.cost.toFixed(4)}
                </span>
              </div>
            )
          })}
        </div>
      )}

      <p className="text-[9px] font-mono text-slate-700">
        Lifetime earned: ${data.earnings_lifetime.toFixed(2)}.
        {data.budget > 0 ? ` Daily cap: $${data.budget.toFixed(2)}.` : ' No daily cap.'}
      </p>
    </div>
  )
}

function TargetCard() {
  const [current, setCurrent] = useState<ResearchTarget | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/api/research')
        if (!res.ok) return
        const d = await res.json()
        setCurrent(d.current)
      } catch { /* ignore */ }
      finally { setLoading(false) }
    }
    load()
    const id = setInterval(load, 15_000)
    return () => clearInterval(id)
  }, [])

  if (loading) return null
  if (!current) return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5 space-y-2">
      <p className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">Current Target</p>
      <p className="text-xs font-mono text-slate-600">No target pinned. Tasker will pin one next cycle.</p>
    </div>
  )

  const phaseIdx = PHASE_ORDER.indexOf(current.phase)
  const open = Number(current.open_hyp ?? 0)
  const closed = Number(current.closed_hyp ?? 0)
  const findings = Number(current.finding_cnt ?? 0)
  const reward = typeof current.reward === 'string' ? parseFloat(current.reward) : current.reward

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">Current Target · {current.platform_label}</p>
        <span className="text-[9px] font-mono text-emerald-400 border border-emerald-900 rounded px-1.5 py-0.5">
          {PHASE_LABEL[current.phase] ?? current.phase.toUpperCase()}
        </span>
      </div>

      <div>
        <p className="text-sm font-mono text-slate-200 leading-snug">{current.title}</p>
        <p className="text-xs font-mono text-emerald-400 mt-1 tabular-nums">
          ${reward.toLocaleString()} <span className="text-[10px] text-slate-600 ml-1">{current.chain ?? ''}</span>
        </p>
      </div>

      {/* Phase progress bar */}
      {phaseIdx >= 0 && (
        <div className="flex gap-1">
          {PHASE_ORDER.map((p, i) => (
            <div key={p} className={`flex-1 h-1 rounded-full ${
              i < phaseIdx ? 'bg-emerald-600'
              : i === phaseIdx ? 'bg-emerald-500 animate-pulse'
              : 'bg-slate-800'
            }`} />
          ))}
        </div>
      )}

      <div className="grid grid-cols-3 gap-3 pt-1">
        <div>
          <p className="text-lg font-bold font-mono text-white tabular-nums">{current.cycles}</p>
          <p className="text-[10px] font-mono text-slate-600">cycles</p>
        </div>
        <div>
          <p className="text-lg font-bold font-mono text-amber-400 tabular-nums">{open}</p>
          <p className="text-[10px] font-mono text-slate-600">open hyps</p>
        </div>
        <div>
          <p className="text-lg font-bold font-mono text-emerald-400 tabular-nums">{findings}</p>
          <p className="text-[10px] font-mono text-slate-600">findings</p>
        </div>
      </div>

      {closed > 0 && (
        <p className="text-[10px] font-mono text-slate-600">
          {closed} hypothesis{closed > 1 ? 'es' : ''} tested · fruitless {current.fruitless_cycles}/3
        </p>
      )}
    </div>
  )
}

function PortfolioCard() {
  const [account, setAccount] = useState<AlpacaAccount | null>(null)
  const [positions, setPositions] = useState<AlpacaPosition[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/analyst')
      .then(r => r.json())
      .then(d => { setAccount(d.account); setPositions(d.positions ?? []) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) return null
  if (!account) return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4">
      <p className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mb-1">Portfolio</p>
      <p className="text-xs font-mono text-slate-600">Add ALPACA_API_KEY to Railway to enable trading.</p>
    </div>
  )

  const equity = parseFloat(account.equity)
  const buyingPower = parseFloat(account.buying_power)

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">Portfolio · Alpaca</p>
        <span className="text-[9px] font-mono text-slate-600 border border-slate-800 rounded px-1.5 py-0.5">
          {process.env.ALPACA_PAPER !== 'false' ? 'PAPER' : 'LIVE'}
        </span>
      </div>

      <div className="flex gap-4">
        <div>
          <p className="text-2xl font-bold font-mono text-white tabular-nums">${equity.toFixed(2)}</p>
          <p className="text-[10px] font-mono text-slate-600">equity</p>
        </div>
        <div className="border-l border-slate-800 pl-4">
          <p className="text-sm font-mono text-slate-400 tabular-nums">${buyingPower.toFixed(2)}</p>
          <p className="text-[10px] font-mono text-slate-600">buying power</p>
        </div>
      </div>

      {positions.length > 0 && (
        <div className="space-y-2 pt-1">
          {positions.map(p => {
            const pl = parseFloat(p.unrealized_pl)
            const plPct = parseFloat(p.unrealized_plpc) * 100
            const pos = pl >= 0
            return (
              <div key={p.symbol} className="flex items-center justify-between">
                <div>
                  <span className="text-xs font-mono text-slate-200 font-semibold">{p.symbol}</span>
                  <span className="text-[10px] font-mono text-slate-600 ml-2">{p.qty} sh @ ${parseFloat(p.current_price).toFixed(2)}</span>
                </div>
                <span className={`text-xs font-mono tabular-nums ${pos ? 'text-emerald-400' : 'text-red-400'}`}>
                  {pos ? '+' : ''}{pl.toFixed(2)} ({plPct.toFixed(1)}%)
                </span>
              </div>
            )
          })}
        </div>
      )}

      {positions.length === 0 && (
        <p className="text-xs font-mono text-slate-600">No open positions. Analyst queuing picks.</p>
      )}
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

        <CostCard />

        <TargetCard />

        <PortfolioCard />

        <SetupCard />
      </div>
    </div>
  )
}

// ─── Skills Tab ───────────────────────────────────────────────────────────────

const REPORT_STATUS_STYLE: Record<string, string> = {
  pending_review: 'bg-slate-800 text-slate-400 border-slate-700',
  approved:       'bg-emerald-950 text-emerald-300 border-emerald-900',
  rejected:       'bg-red-950 text-red-300 border-red-900',
  submitted:      'bg-blue-950 text-blue-300 border-blue-900',
  dismissed:      'bg-slate-800 text-slate-500 border-slate-700',
}
const REPORT_STATUS_LABEL: Record<string, string> = {
  pending_review: 'LILA REVIEWING',
  approved:       'APPROVED',
  rejected:       'REJECTED',
  submitted:      'SUBMITTED',
  dismissed:      'DISMISSED',
}

function ReportsTab({ reports, loading, visible, onAction }: {
  reports: SecurityReport[]
  loading: boolean
  visible: boolean
  onAction: (id: number, action: 'approve' | 'dismiss' | 'submitted') => void
}) {
  const approved = reports.filter(r => r.status === 'approved')
  const pending  = reports.filter(r => r.status === 'pending_review')
  const done     = reports.filter(r => ['submitted', 'dismissed', 'rejected'].includes(r.status))

  return (
    <div className={`absolute inset-0 overflow-y-auto ${visible ? '' : 'invisible pointer-events-none'}`}>
      <div className="px-4 py-5 space-y-5">
        <div className="flex items-center gap-2">
          <span className="text-emerald-500"><IconReports /></span>
          <div>
            <p className="text-xs font-mono text-slate-300 font-semibold">Security Reports</p>
            <p className="text-[10px] font-mono text-slate-600">Tasker drafts → Lila reviews → you submit</p>
          </div>
        </div>

        {loading ? (
          <div className="flex items-center gap-2 py-10 justify-center">
            <div className="w-4 h-4 border-2 border-slate-700 border-t-emerald-500 rounded-full animate-spin" />
            <p className="text-xs font-mono text-slate-600">Loading reports...</p>
          </div>
        ) : reports.length === 0 ? (
          <div className="border border-slate-800 rounded-2xl p-6 text-center">
            <p className="text-sm font-mono text-slate-500">No reports yet.</p>
            <p className="text-xs font-mono text-slate-700 mt-1">Tasker files drafts on security bounties automatically.</p>
          </div>
        ) : (
          <>
            {/* Ready for operator */}
            {approved.length > 0 && (
              <section className="space-y-3">
                <p className="text-[10px] font-mono text-emerald-500 uppercase tracking-widest">Ready · {approved.length}</p>
                {approved.map(r => <ReportCard key={r.id} report={r} onAction={onAction} />)}
              </section>
            )}

            {/* Lila's queue */}
            {pending.length > 0 && (
              <section className="space-y-3">
                <p className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">Lila reviewing · {pending.length}</p>
                {pending.map(r => <ReportCard key={r.id} report={r} onAction={onAction} />)}
              </section>
            )}

            {/* Done / dismissed / rejected */}
            {done.length > 0 && (
              <section className="space-y-3">
                <p className="text-[10px] font-mono text-slate-600 uppercase tracking-widest">Archive · {done.length}</p>
                {done.map(r => <ReportCard key={r.id} report={r} onAction={onAction} />)}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function ReportCard({ report, onAction }: {
  report: SecurityReport
  onAction: (id: number, action: 'approve' | 'dismiss' | 'submitted') => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const statusCls = REPORT_STATUS_STYLE[report.status] ?? 'bg-slate-800 text-slate-400 border-slate-700'

  const copy = () => {
    navigator.clipboard.writeText(report.content).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div className="border border-slate-800 rounded-2xl bg-slate-900 overflow-hidden">
      <button className="w-full p-4 text-left" onClick={() => setExpanded(e => !e)}>
        <div className="flex items-start gap-2 mb-2">
          <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border shrink-0 mt-0.5 ${statusCls}`}>
            {REPORT_STATUS_LABEL[report.status] ?? report.status.toUpperCase()}
          </span>
          <span className="text-[9px] font-mono px-1.5 py-0.5 rounded border shrink-0 mt-0.5 bg-slate-800 text-slate-400 border-slate-700">
            {report.platform_label.toUpperCase()}
          </span>
          <span className="text-[9px] font-mono text-slate-600 ml-auto mt-0.5">conf {Math.round(report.confidence * 100)}%</span>
        </div>
        <p className="text-sm font-mono text-slate-200 leading-snug">{report.title}</p>

        {/* Lila's review note, if any */}
        {report.review_notes && (
          <p className="text-[10px] font-mono text-emerald-400 mt-1.5 italic">
            L: {report.review_notes}
          </p>
        )}

        <div className="flex items-center justify-between mt-2">
          <p className="text-lg font-bold font-mono text-emerald-400 tabular-nums">
            ${Number(report.reward).toLocaleString()}
            <span className="text-[10px] text-slate-600 ml-1">{report.chain ?? ''}</span>
          </p>
          <span className={`text-slate-600 text-xs font-mono transition-transform ${expanded ? 'rotate-180' : ''}`}>▾</span>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-slate-800 px-4 py-3 space-y-3">
          <pre className="text-[10px] font-mono text-slate-300 leading-relaxed overflow-x-auto whitespace-pre-wrap break-words max-h-96 overflow-y-auto">
            {report.content}
          </pre>

          <div className="flex gap-2">
            <button
              onClick={copy}
              className="flex-1 text-[10px] font-mono text-slate-300 border border-slate-700 rounded-lg py-2 active:bg-slate-800"
            >
              {copied ? 'Copied ✓' : 'Copy report'}
            </button>
            {report.url && (
              <a
                href={report.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 text-[10px] font-mono text-blue-400 border border-blue-900 rounded-lg py-2 text-center"
              >
                Open bounty ↗
              </a>
            )}
          </div>

          {report.status === 'approved' && (
            <div className="flex gap-2">
              <button
                onClick={() => onAction(report.id, 'submitted')}
                className="flex-1 text-[10px] font-mono bg-emerald-700 text-white rounded-lg py-2 active:bg-emerald-600"
              >
                Mark submitted
              </button>
              <button
                onClick={() => onAction(report.id, 'dismiss')}
                className="flex-1 text-[10px] font-mono text-red-400 border border-red-900 rounded-lg py-2 active:opacity-70"
              >
                Dismiss
              </button>
            </div>
          )}

          {report.status === 'pending_review' && (
            <p className="text-[10px] font-mono text-slate-600 italic text-center py-1">
              Waiting for Lila's review.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Bounties Tab ─────────────────────────────────────────────────────────────

const PLATFORM_COLOR: Record<string, string> = {
  superteam:   'bg-purple-950 text-purple-300 border-purple-900',
  bountycaster:'bg-blue-950  text-blue-300  border-blue-900',
  immunefi:    'bg-red-950   text-red-300   border-red-900',
  clawtasks:   'bg-amber-950 text-amber-300 border-amber-900',
}

function BountiesTab({
  bounties,
  assignedBounty,
  loading,
  visible,
  onAssign,
}: {
  bounties: UnifiedBounty[]
  assignedBounty: UnifiedBounty | null
  loading: boolean
  visible: boolean
  onAssign: (b: UnifiedBounty | null) => void
}) {
  const [assigning, setAssigning] = useState<string | null>(null)

  const handleAssign = async (b: UnifiedBounty | null) => {
    const key = b?.id ?? 'clear'
    setAssigning(key)
    try {
      await fetch('/api/bounties', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bounty: b }),
      })
      onAssign(b)
    } finally {
      setAssigning(null)
    }
  }

  return (
    <div className={`absolute inset-0 overflow-y-auto ${visible ? '' : 'invisible pointer-events-none'}`}>
      <div className="px-4 py-5 space-y-3">
        {/* Header */}
        <div className="flex items-center justify-between mb-1">
          <div>
            <p className="text-xs font-mono text-slate-300 font-semibold">Bounty Board</p>
            <p className="text-[10px] font-mono text-slate-600">Sorted by value · tap to assign</p>
          </div>
          {assignedBounty && (
            <button
              onClick={() => handleAssign(null)}
              disabled={assigning === 'clear'}
              className="text-[10px] font-mono text-red-400 border border-red-900 rounded-lg px-2 py-1 active:opacity-70 disabled:opacity-40"
            >
              {assigning === 'clear' ? '...' : 'Clear task'}
            </button>
          )}
        </div>

        {/* Assigned banner */}
        {assignedBounty && (
          <div className="rounded-2xl border border-emerald-800 bg-emerald-950/30 px-4 py-3">
            <p className="text-[10px] font-mono text-emerald-500 uppercase tracking-widest mb-1">Assigned to Lila</p>
            <p className="text-sm font-mono text-emerald-300 leading-snug">{assignedBounty.title}</p>
            <p className="text-[10px] font-mono text-emerald-700 mt-1">${assignedBounty.reward} · {assignedBounty.platformLabel}</p>
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 py-12 justify-center">
            <div className="w-4 h-4 border-2 border-slate-700 border-t-emerald-500 rounded-full animate-spin" />
            <p className="text-xs font-mono text-slate-600">Scanning boards...</p>
          </div>
        ) : bounties.length === 0 ? (
          <div className="border border-slate-800 rounded-2xl p-6 text-center">
            <p className="text-sm font-mono text-slate-500">No bounties found.</p>
            <p className="text-xs font-mono text-slate-700 mt-1">Add API keys to pull live boards.</p>
          </div>
        ) : (
          bounties.map(b => {
            const isAssigned = assignedBounty?.id === b.id
            const platformCls = PLATFORM_COLOR[b.platform] ?? 'bg-slate-800 text-slate-400 border-slate-700'
            return (
              <div
                key={b.id}
                className={`rounded-2xl border bg-slate-900 overflow-hidden transition-colors ${isAssigned ? 'border-emerald-700' : 'border-slate-800'}`}
              >
                <div className="p-4">
                  <div className="flex items-start gap-2 mb-2">
                    <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border shrink-0 mt-0.5 ${platformCls}`}>
                      {b.platformLabel.toUpperCase()}
                    </span>
                    {b.readOnly && (
                      <span className="text-[9px] font-mono px-1.5 py-0.5 rounded border shrink-0 mt-0.5 bg-slate-800 text-slate-500 border-slate-700">
                        VIEW-ONLY
                      </span>
                    )}
                  </div>

                  <p className="text-sm font-mono text-slate-200 leading-snug">{b.title}</p>

                  <div className="flex items-center justify-between mt-3">
                    <div>
                      <p className="text-lg font-bold font-mono text-emerald-400 tabular-nums">
                        ${b.reward.toLocaleString()}
                        <span className="text-[10px] text-slate-600 ml-1">{b.token}</span>
                      </p>
                      <p className="text-[10px] font-mono text-slate-600">{b.chain}</p>
                    </div>

                    {!b.readOnly && (
                      isAssigned ? (
                        <span className="text-[10px] font-mono text-emerald-500 border border-emerald-800 rounded-lg px-2 py-1">
                          ▶ Active
                        </span>
                      ) : (
                        <button
                          onClick={() => handleAssign(b)}
                          disabled={!!assigning}
                          className="text-[10px] font-mono text-slate-300 border border-slate-700 rounded-lg px-3 py-1.5 active:bg-slate-800 disabled:opacity-40 transition-colors"
                        >
                          {assigning === b.id ? '...' : 'Assign to Lila'}
                        </button>
                      )
                    )}

                    {b.readOnly && b.url && (
                      <a
                        href={b.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[10px] font-mono text-slate-500 border border-slate-800 rounded-lg px-2 py-1"
                      >
                        Open ↗
                      </a>
                    )}
                  </div>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

// ─── Root ─────────────────────────────────────────────────────────────────────

export default function Home() {
  const [tab, setTab] = useState<Tab>('chat')
  const [data, setData] = useState<AgentData | null>(null)
  const [status, setStatus] = useState<'connecting' | 'live' | 'error'>('connecting')
  const [flash, setFlash] = useState(false)
  const [reports, setReports] = useState<SecurityReport[]>([])
  const [reportsLoading, setReportsLoading] = useState(false)
  const [bounties, setBounties] = useState<UnifiedBounty[]>([])
  const [assignedBounty, setAssignedBounty] = useState<UnifiedBounty | null>(null)
  const [bountiesLoading, setBountiesLoading] = useState(false)
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

  // Load security reports when tab opens
  const loadReports = useCallback(async () => {
    setReportsLoading(true)
    try {
      const res = await fetch('/api/reports')
      if (res.ok) setReports(await res.json())
    } finally { setReportsLoading(false) }
  }, [])

  useEffect(() => { if (tab === 'reports') loadReports() }, [tab, loadReports])

  const reportAction = useCallback(async (id: number, action: 'approve' | 'dismiss' | 'submitted') => {
    await fetch('/api/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action }),
    })
    loadReports()
  }, [loadReports])

  // Load bounties when tab opens
  useEffect(() => {
    if (tab !== 'bounties') return
    setBountiesLoading(true)
    fetch('/api/bounties')
      .then(r => r.json())
      .then(d => {
        setBounties(d.bounties ?? [])
        setAssignedBounty(d.assignedBounty ?? null)
      })
      .catch(() => {})
      .finally(() => setBountiesLoading(false))
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
        <BountiesTab
          bounties={bounties}
          assignedBounty={assignedBounty}
          loading={bountiesLoading}
          visible={tab === 'bounties'}
          onAssign={setAssignedBounty}
        />
        <ReportsTab
          reports={reports}
          loading={reportsLoading}
          visible={tab === 'reports'}
          onAction={reportAction}
        />
      </main>

      <BottomNav tab={tab} onTab={setTab} />
    </div>
  )
}
