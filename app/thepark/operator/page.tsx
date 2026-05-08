'use client'

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

type Tab = 'chat' | 'dash' | 'floor' | 'trading' | 'bounties' | 'library' | 'picks' | 'desk'

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
  ts?: number   // unix ms; server-provided for posted messages, local-stamped for in-flight
}

interface SecurityReport {
  id: number
  bounty_id: string
  platform: string
  platform_label: string
  title: string
  reward: number                  // max bounty per the platform brief
  chain?: string
  url?: string
  content: string
  confidence: number
  status: 'pending_review' | 'approved' | 'rejected' | 'submitted' | 'paid' | 'dismissed'
  kind?: 'security' | 'code' | 'docs'
  review_notes?: string | null
  payout?: number | string | null  // confirmed dollars the operator received
  submitted_at?: string | null
  paid_at?: string | null
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
  bountyMode?: 'docs' | 'security'
  log: LogEntry[]
}


// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(ts: number) {
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function fmtAge(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

// ─── Voice (Web Speech API — browser-native, zero external APIs) ─────────
//
// Speech recognition for operator input + speech synthesis for agent
// replies. Both run entirely in the browser. STT requires Chrome / Safari
// (iOS 14.5+); TTS works on every modern mobile browser.

interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  start(): void
  stop(): void
  abort(): void
  onresult: ((e: { results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }> & { length: number }; resultIndex: number }) => void) | null
  onerror: ((e: { error?: string }) => void) | null
  onend: (() => void) | null
}

type SRConstructor = new () => SpeechRecognitionLike

function getSpeechRecognition(): SRConstructor | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { SpeechRecognition?: SRConstructor; webkitSpeechRecognition?: SRConstructor }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

interface UseSTT {
  supported: boolean
  listening: boolean
  transcript: string
  start: () => void
  stop: () => void
  reset: () => void
}

// Tap-to-toggle speech-to-text. Streams interim transcripts so the
// caller can render the live partial text in the compose box.
function useSpeechRecognition(onFinal?: (text: string) => void): UseSTT {
  const [listening, setListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  const recRef = useRef<SpeechRecognitionLike | null>(null)
  const supportedRef = useRef<boolean>(false)
  const onFinalRef = useRef(onFinal)
  useEffect(() => { onFinalRef.current = onFinal }, [onFinal])

  useEffect(() => {
    const SR = getSpeechRecognition()
    supportedRef.current = !!SR
    if (!SR) return
    const r = new SR()
    r.continuous = false
    r.interimResults = true
    r.lang = 'en-US'
    r.onresult = (e) => {
      let interim = ''
      let final = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const seg = e.results[i] as unknown as { 0: { transcript: string }; isFinal: boolean }
        const text = seg[0].transcript
        if (seg.isFinal) final += text
        else              interim += text
      }
      if (final) {
        setTranscript(prev => (prev ? prev + ' ' : '') + final.trim())
        onFinalRef.current?.(final.trim())
      } else if (interim) {
        setTranscript(interim)
      }
    }
    r.onerror = () => { setListening(false) }
    r.onend = ()   => { setListening(false) }
    recRef.current = r
    return () => { r.abort?.() }
  }, [])

  const start = useCallback(() => {
    const r = recRef.current
    if (!r || listening) return
    setTranscript('')
    try { r.start(); setListening(true) } catch { /* already started */ }
  }, [listening])

  const stop = useCallback(() => {
    const r = recRef.current
    if (!r) return
    try { r.stop() } catch { /* ignore */ }
    setListening(false)
  }, [])

  const reset = useCallback(() => setTranscript(''), [])

  return { supported: supportedRef.current, listening, transcript, start, stop, reset }
}

interface UseTTS {
  supported: boolean
  enabled: boolean
  setEnabled: (v: boolean) => void
  speak: (text: string) => void
  cancel: () => void
}

// Persistent (localStorage) toggle + speak helper. We strip leading
// emoji / bracketed tags before speaking so the synth doesn't read out
// the literal "warning sign" or "[broadcast:bluesky]" tokens.
function useSpeechSynthesis(storageKey: string): UseTTS {
  const [enabled, setEnabledRaw] = useState(false)
  const [supported, setSupported] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    setSupported(typeof window.speechSynthesis !== 'undefined')
    try {
      const saved = window.localStorage.getItem(storageKey)
      if (saved === '1') setEnabledRaw(true)
    } catch { /* ignore */ }
  }, [storageKey])

  const setEnabled = useCallback((v: boolean) => {
    setEnabledRaw(v)
    try { window.localStorage.setItem(storageKey, v ? '1' : '0') } catch { /* ignore */ }
    if (!v && typeof window !== 'undefined') window.speechSynthesis?.cancel()
  }, [storageKey])

  const speak = useCallback((text: string) => {
    if (!enabled || typeof window === 'undefined') return
    if (!window.speechSynthesis) return
    const cleaned = text
      // Strip a leading run of non-letter / non-digit chars (covers emoji,
      // arrows, bullet glyphs, whitespace) without needing the \p{Emoji}
      // Unicode property class which isn't available in the build target.
      .replace(/^[^\w(]+/, '')
      .replace(/\[[^\]]{1,80}\]/g, '')             // bracketed tags like [broadcast:bluesky]
      .replace(/```[\s\S]*?```/g, '. code block .')  // skip code fences
      .replace(/\s+/g, ' ')
      .trim()
    if (!cleaned) return
    const u = new SpeechSynthesisUtterance(cleaned)
    u.rate = 1.05
    u.pitch = 1.0
    u.lang = 'en-US'
    window.speechSynthesis.speak(u)
  }, [enabled])

  const cancel = useCallback(() => {
    if (typeof window === 'undefined') return
    window.speechSynthesis?.cancel()
  }, [])

  return { supported, enabled, setEnabled, speak, cancel }
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

const IconTrading = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6">
    <path d="M3 17l6-6 4 4 8-8" />
    <polyline points="14 7 21 7 21 14" />
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

const IconNotes = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6">
    <path d="M4 4h12l4 4v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" />
    <line x1="7" y1="10" x2="17" y2="10" />
    <line x1="7" y1="14" x2="17" y2="14" />
    <line x1="7" y1="18" x2="13" y2="18" />
  </svg>
)

const IconDesk = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6">
    {/* a clipboard / inbox: docs landing on the operator's desk */}
    <rect x="6" y="3" width="12" height="3" rx="1" />
    <path d="M5 6h14v15a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6z" />
    <line x1="9"  y1="11" x2="15" y2="11" />
    <line x1="9"  y1="15" x2="15" y2="15" />
  </svg>
)

const IconBounties = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6">
    <circle cx="12" cy="12" r="10" />
    <path d="M12 6v6l4 2" />
  </svg>
)

const IconPicks = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6">
    <path d="M3 12l4-4 4 4 4-4 6 6" />
    <path d="M14 8h7v7" />
  </svg>
)

const IconFloor = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className="w-6 h-6">
    {/* a room cut into quadrants with a body in each — "the floor" */}
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <line x1="3"  y1="12" x2="21" y2="12" />
    <line x1="12" y1="3"  x2="12" y2="21" />
    <circle cx="7"  cy="7"  r="1.2" fill="currentColor" />
    <circle cx="17" cy="7"  r="1.2" fill="currentColor" />
    <circle cx="7"  cy="17" r="1.2" fill="currentColor" />
    <circle cx="17" cy="17" r="1.2" fill="currentColor" />
  </svg>
)

// ─── Bottom Nav ───────────────────────────────────────────────────────────────

const TABS: { key: Tab; label: string; Icon: () => JSX.Element }[] = [
  { key: 'chat',     label: 'Chat',    Icon: IconChat     },
  { key: 'dash',     label: 'Dash',    Icon: IconDash     },
  { key: 'floor',    label: 'Floor',   Icon: IconFloor    },
  { key: 'trading',  label: 'Trades',  Icon: IconTrading  },
  { key: 'bounties', label: 'Board',   Icon: IconBounties },
  { key: 'library',  label: 'Library', Icon: IconNotes    },
  { key: 'picks',    label: 'Picks',   Icon: IconPicks    },
  { key: 'desk',     label: 'Desk',    Icon: IconDesk     },
]

function BottomNav({ tab, onTab, badges }: {
  tab: Tab
  onTab: (t: Tab) => void
  badges?: Partial<Record<Tab, number>>
}) {
  return (
    <nav
      className="shrink-0 flex border-t border-slate-800 bg-slate-950 md:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {TABS.map(({ key, label, Icon }) => {
        const active = tab === key
        const count = badges?.[key] ?? 0
        return (
          <button
            key={key}
            onClick={() => onTab(key)}
            className={`flex-1 flex flex-col items-center gap-0.5 py-2 min-h-[52px] transition-colors relative ${active ? 'text-emerald-400' : 'text-slate-600 active:text-slate-400'}`}
          >
            <div className="relative">
              <Icon />
              {count > 0 && (
                <span className="absolute -top-1 -right-2 min-w-[14px] h-[14px] px-1 rounded-full bg-emerald-500 text-slate-950 text-[9px] font-mono font-bold flex items-center justify-center">
                  {count > 9 ? '9+' : count}
                </span>
              )}
            </div>
            <span className={`text-[8px] font-mono tracking-wider uppercase ${active ? 'text-emerald-400' : 'text-slate-700'}`}>
              {label}
            </span>
          </button>
        )
      })}
    </nav>
  )
}

// Side rail nav. Only renders at md+ (iPad portrait and up). Phones keep
// the bottom tab bar — at 7 tabs that's already a snug fit and a vertical
// rail wouldn't survive the loss of horizontal screen real estate.
function SideNav({ tab, onTab, badges }: {
  tab: Tab
  onTab: (t: Tab) => void
  badges?: Partial<Record<Tab, number>>
}) {
  return (
    <nav
      className="hidden md:flex shrink-0 flex-col border-r border-slate-800 bg-slate-950 w-20 lg:w-56"
      style={{ paddingTop: 'max(16px, env(safe-area-inset-top))' }}
    >
      <div className="px-3 lg:px-5 pb-4 hidden lg:block">
        <p className="text-[9px] font-mono text-emerald-500/80 uppercase tracking-[0.32em]">▓ park</p>
        <p className="text-xs font-mono text-slate-500 mt-1">operator console</p>
      </div>
      <div className="lg:hidden px-3 pb-3 flex justify-center">
        <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse shadow-[0_0_8px_rgba(16,185,129,0.8)]" />
      </div>
      <div className="flex-1 flex flex-col gap-1 px-2 lg:px-3 overflow-y-auto">
        {TABS.map(({ key, label, Icon }) => {
          const active = tab === key
          const count = badges?.[key] ?? 0
          return (
            <button
              key={key}
              onClick={() => onTab(key)}
              className={`group relative flex items-center gap-3 rounded-xl px-3 py-3 min-h-[48px] transition-colors ${
                active
                  ? 'bg-emerald-950/40 text-emerald-300 border border-emerald-900/60'
                  : 'text-slate-500 hover:text-slate-200 hover:bg-slate-900 border border-transparent'
              } justify-center lg:justify-start`}
              title={label}
            >
              <div className="relative shrink-0">
                <Icon />
                {count > 0 && (
                  <span className="absolute -top-1 -right-2 min-w-[14px] h-[14px] px-1 rounded-full bg-emerald-500 text-slate-950 text-[9px] font-mono font-bold flex items-center justify-center">
                    {count > 9 ? '9+' : count}
                  </span>
                )}
              </div>
              <span className="hidden lg:inline text-[12px] font-mono tracking-widest uppercase">
                {label}
              </span>
            </button>
          )
        })}
      </div>
      <div className="px-3 lg:px-5 py-4 border-t border-slate-800/60 hidden lg:block">
        <p className="text-[9px] font-mono text-slate-700 tracking-[0.28em] uppercase">
          parksystems · v1
        </p>
      </div>
    </nav>
  )
}

// ─── Chat Tab (group: you + Lila + Vega) ───────────────────────────────────

const ROLE_STYLE = {
  lila:    { avatar: 'L', color: 'text-emerald-400', ring: 'bg-emerald-900 border-emerald-700', bubble: 'bg-slate-900 text-slate-200 border-slate-800' },
  tasker:  { avatar: 'C', color: 'text-amber-400',   ring: 'bg-amber-950 border-amber-800',     bubble: 'bg-amber-950/40 text-amber-200 border-amber-900/60' },
  analyst: { avatar: 'V', color: 'text-blue-400',    ring: 'bg-blue-900 border-blue-700',       bubble: 'bg-blue-950/60 text-blue-200 border-blue-900/60' },
} as const

// ─── Shared UI primitives ─────────────────────────────────────────────────────

function Section({
  label, count, defaultOpen = true, children,
}: {
  label: string
  count?: number | string
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="space-y-3">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between px-1 py-1 active:opacity-70"
      >
        <div className="flex items-baseline gap-2">
          <span className="text-[10px] md:text-[11px] font-mono text-emerald-600 uppercase tracking-[0.2em]">
            {label}
          </span>
          {count != null && (
            <span className="text-[9px] md:text-[10px] font-mono text-slate-700">· {count}</span>
          )}
        </div>
        <span className={`text-slate-700 text-xs font-mono transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
      </button>
      {open && (
        <div className="space-y-4 lg:space-y-0 lg:grid lg:grid-cols-2 lg:gap-4">
          {children}
        </div>
      )}
    </div>
  )
}

function EmptyState({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="border border-slate-800 rounded-2xl p-6 text-center">
      <p className="text-sm font-mono text-slate-500">{title}</p>
      {subtitle && <p className="text-xs font-mono text-slate-700 mt-1 leading-snug">{subtitle}</p>}
    </div>
  )
}

// Cross-tab navigation. Children call `onNavigate({ tab, notesFilter? })` to
// jump to a tab and pre-set a filter — e.g. TargetCard sends you to Notes
// pre-filtered to Cipher's plans.
type NavigateFn = (to: {
  tab: Tab
  notesFilter?: 'all' | 'analyst' | 'lila' | 'tasker' | 'ceelo' | 'scout' | 'pitches' | 'other'
  libraryMode?: 'reports' | 'notes' | 'articles'
}) => void

function ChatMessage({ m, streaming }: { m: Message; streaming: boolean }) {
  const [copied, setCopied] = useState(false)
  const isUser = m.role === 'user'
  const role = m.role !== 'user' ? ROLE_STYLE[m.role] : null

  const copy = () => {
    if (!m.content) return
    navigator.clipboard.writeText(m.content).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}>
      <div className={`flex w-full ${isUser ? 'justify-end' : 'justify-start'}`}>
        {!isUser && role && (
          <span className={`font-mono text-xs mr-2 mt-1.5 shrink-0 w-4 text-center ${role.color}`}>
            {role.avatar}
          </span>
        )}
        <div className={`max-w-[82%] md:max-w-[68%] rounded-2xl px-4 py-2.5 md:px-5 md:py-3 text-sm md:text-[15px] font-mono leading-relaxed border select-text ${
          isUser
            ? 'bg-slate-800 text-slate-100 rounded-tr-sm border-slate-700'
            : `${role!.bubble} rounded-tl-sm`
        }`}>
          {m.content}
          {streaming && m.role === 'lila' && (
            <span className="inline-block w-1.5 h-3.5 bg-emerald-500 ml-0.5 animate-pulse align-middle" />
          )}
        </div>
      </div>
      {/* Timestamp + copy affordance */}
      {m.content && !streaming && (
        <div className={`flex items-center gap-2 mt-1 ${isUser ? 'mr-1 flex-row-reverse' : 'ml-6'}`}>
          <button
            onClick={copy}
            className={`text-[9px] font-mono px-1 tracking-wider uppercase transition-colors ${
              copied ? 'text-emerald-400' : 'text-slate-700 active:text-slate-500'
            }`}
          >
            {copied ? '✓ copied' : 'copy'}
          </button>
          {m.ts != null && (
            <span className="text-[9px] font-mono text-slate-800">
              {fmt(m.ts)}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

function ChatTab({ visible }: { visible: boolean }) {
  const [messages, setMessages] = useState<Message[]>([
    { role: 'lila', content: 'Online. Direct line. What do you need.' },
  ])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [nearBottom, setNearBottom] = useState(true)
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const lastId = useRef(0)

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    bottomRef.current?.scrollIntoView({ behavior })
  }, [])

  // Only auto-scroll when the user is already near the bottom — otherwise
  // we'd yank them back while they're reading history.
  useEffect(() => {
    if (nearBottom) scrollToBottom('smooth')
  }, [messages, nearBottom, scrollToBottom])

  const onScroll = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    setNearBottom(dist < 60)
  }, [])

  // Poll for Cipher/Lila/Vega messages every 5s
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
            ...incoming.map((m: { id: number; sender: string; content: string; timestamp?: number }) => ({
              role: (m.sender === 'analyst' ? 'analyst'
                   : m.sender === 'tasker'  ? 'tasker'
                   : 'lila') as Message['role'],
              content: m.content,
              id: m.id,
              ts: m.timestamp,
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

    const now = Date.now()
    const history: Message[] = [...messages, { role: 'user', content: text, ts: now }]
    setMessages([...history, { role: 'lila', content: '', ts: now }])
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

      // Server reserved a DB row for this reply and returned its id. Advance
      // the poll cursor past it so /api/chat/messages won't re-fetch the same
      // reply and render it twice.
      const reservedId = parseInt(res.headers.get('X-Lila-Message-Id') ?? '')
      if (!isNaN(reservedId) && reservedId > lastId.current) {
        lastId.current = reservedId
      }

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
      <div className="shrink-0 px-4 md:px-6 pt-3 pb-2 flex items-center gap-3 border-b border-slate-800/60">
        <div className="flex gap-1">
          <span className="w-5 h-5 rounded-full bg-emerald-900 border border-emerald-700 flex items-center justify-center text-[9px] font-mono text-emerald-400">L</span>
          <span className="w-5 h-5 rounded-full bg-amber-950 border border-amber-800 flex items-center justify-center text-[9px] font-mono text-amber-400">C</span>
          <span className="w-5 h-5 rounded-full bg-blue-900 border border-blue-700 flex items-center justify-center text-[9px] font-mono text-blue-400">V</span>
          <span className="w-5 h-5 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center text-[9px] font-mono text-slate-400">U</span>
        </div>
        <div className="min-w-0">
          <p className="text-[10px] md:text-[11px] font-mono text-emerald-500 uppercase tracking-widest">Direct line · Lila</p>
          <p className="text-[9px] md:text-[10px] font-mono text-slate-600">Cipher & Vega post status here</p>
        </div>
      </div>

      {/* Messages */}
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto px-4 md:px-6 py-4 md:py-5 space-y-3 relative"
      >
        {messages.map((m, i) => (
          <ChatMessage
            key={m.id ?? i}
            m={m}
            streaming={streaming && i === messages.length - 1}
          />
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Scroll-to-bottom pill — floats above input when the user has scrolled up */}
      {!nearBottom && (
        <button
          onClick={() => scrollToBottom('smooth')}
          className="absolute bottom-20 left-1/2 -translate-x-1/2 text-[10px] font-mono bg-slate-800 text-slate-300 border border-slate-700 rounded-full px-3 py-1.5 shadow-lg active:bg-slate-700 z-10"
        >
          ↓ Jump to latest
        </button>
      )}

      {/* Input */}
      <div className="shrink-0 px-4 md:px-6 py-3 md:py-4 border-t border-slate-800 bg-slate-950 flex gap-2 md:gap-3">
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && send()}
          placeholder="Message Lila..."
          className="flex-1 bg-slate-900 border border-slate-800 rounded-xl px-4 py-2.5 md:py-3 text-sm md:text-base text-slate-100 font-mono placeholder:text-slate-700 focus:outline-none focus:border-emerald-800"
        />
        <button
          onClick={send}
          disabled={!input.trim() || streaming}
          className="shrink-0 w-10 h-10 md:w-12 md:h-12 rounded-xl bg-emerald-600 disabled:bg-slate-800 flex items-center justify-center transition-colors active:bg-emerald-700"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4 md:w-5 md:h-5 text-white -translate-y-px">
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

// ─── Loop health card ─────────────────────────────────────────────────────────

interface LoopRow {
  key: string
  label: string
  last_at: number | null
  interval_sec: number
  next_at: number | null
}

// ─── KPI funnel card ──────────────────────────────────────────────────────────

interface KpiRow {
  attempts: number
  reviewing: number
  approved: number
  submitted: number
  paid: number
  rejected: number
  dismissed: number
  paid_total: number
  max_pending: number
  paid_ratio: number
  flag: 'ok' | 'no-payouts' | 'low-conversion' | 'new'
}

interface KpiData {
  docs: KpiRow
  security: KpiRow
  code: KpiRow
}

const FLAG_TONE: Record<KpiRow['flag'], { pill: string; tag: string; message?: string }> = {
  ok:              { pill: 'bg-emerald-950 text-emerald-400 border-emerald-900', tag: 'ON TRACK' },
  'new':           { pill: 'bg-slate-800 text-slate-500 border-slate-700',       tag: 'NO DATA' },
  'no-payouts':    {
    pill: 'bg-red-950 text-red-300 border-red-900',
    tag: 'NO PAYOUTS',
    message: '3+ attempts filed, zero paid. Per the alternation plan, consider going heavier on the other lane until at least one pays.',
  },
  'low-conversion': {
    pill: 'bg-amber-950 text-amber-300 border-amber-900',
    tag: 'LOW CONVERSION',
    message: 'Below 15% payout rate after 5+ attempts. The thesis is weakening — tune the prompt or raise the reward floor.',
  },
}

function KpiCard() {
  const [data, setData] = useState<KpiData | null>(null)

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/api/kpis')
        if (res.ok) setData(await res.json())
      } catch { /* ignore */ }
    }
    load()
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [])

  if (!data) return null

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5 space-y-4">
      <p className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">
        Pipeline KPIs
      </p>

      <div className="grid grid-cols-2 gap-3">
        <KpiBlock label="Docs" accent="text-purple-300" row={data.docs} />
        <KpiBlock label="Audit" accent="text-emerald-300" row={data.security} />
      </div>

      {/* Flag narrative for docs only — that's what the operator asked us
          to track mechanically. Security has a higher natural variance. */}
      {data.docs.flag !== 'ok' && data.docs.flag !== 'new' && FLAG_TONE[data.docs.flag].message && (
        <p className={`text-[11px] font-mono leading-relaxed border-l-2 pl-3 ${
          data.docs.flag === 'no-payouts'
            ? 'border-red-700 text-red-300'
            : 'border-amber-700 text-amber-300'
        }`}>
          Docs · {FLAG_TONE[data.docs.flag].message}
        </p>
      )}
    </div>
  )
}

function KpiBlock({ label, accent, row }: { label: string; accent: string; row: KpiRow }) {
  const tone = FLAG_TONE[row.flag]
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950 p-3 space-y-2">
      <div className="flex items-baseline justify-between">
        <span className={`text-[11px] font-mono font-semibold ${accent}`}>{label}</span>
        <span className={`text-[8px] font-mono px-1.5 py-0.5 rounded border ${tone.pill}`}>
          {tone.tag}
        </span>
      </div>

      {/* Big number = paid $, little number = attempts total */}
      <div>
        <p className="text-xl font-bold font-mono text-emerald-400 tabular-nums">
          ${row.paid_total.toFixed(0)}
        </p>
        <p className="text-[9px] font-mono text-slate-600">paid · {row.paid} of {row.attempts}</p>
      </div>

      {/* Funnel breakdown */}
      <div className="space-y-1 text-[10px] font-mono text-slate-500">
        {row.reviewing > 0 && (
          <div className="flex justify-between"><span>reviewing</span><span className="tabular-nums">{row.reviewing}</span></div>
        )}
        {row.approved > 0 && (
          <div className="flex justify-between"><span>approved</span><span className="tabular-nums text-amber-400">{row.approved}</span></div>
        )}
        {row.submitted > 0 && (
          <div className="flex justify-between"><span>submitted</span><span className="tabular-nums text-blue-400">{row.submitted}</span></div>
        )}
        {row.rejected > 0 && (
          <div className="flex justify-between"><span>rejected</span><span className="tabular-nums text-red-400">{row.rejected}</span></div>
        )}
        {row.max_pending > 0 && (
          <div className="flex justify-between pt-1 border-t border-slate-800">
            <span>max pending</span>
            <span className="tabular-nums text-slate-400">${row.max_pending.toFixed(0)}</span>
          </div>
        )}
      </div>

      {row.attempts > 0 && (
        <p className="text-[9px] font-mono text-slate-600">
          payout rate: {(row.paid_ratio * 100).toFixed(0)}%
        </p>
      )}
    </div>
  )
}

function LoopsCard() {
  const [loops, setLoops] = useState<LoopRow[] | null>(null)
  const [now, setNow] = useState(Date.now())

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/loops')
      if (res.ok) {
        const d = await res.json()
        setLoops(d.loops ?? [])
        setNow(Number(d.now ?? Date.now()))
      }
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, 15_000)
    return () => clearInterval(id)
  }, [load])

  // Local tick so countdowns update visually between polls.
  useEffect(() => {
    const id = setInterval(() => setNow(n => n + 1000), 1000)
    return () => clearInterval(id)
  }, [])

  if (!loops) return null

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5 space-y-3">
      <p className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">Loop health</p>
      <div className="space-y-2">
        {loops.map(l => {
          if (!l.last_at) {
            return (
              <div key={l.key} className="flex items-baseline justify-between text-[11px] font-mono">
                <span className="text-slate-300">{l.label}</span>
                <span className="text-slate-600">never</span>
              </div>
            )
          }
          const sinceMs = now - l.last_at
          const untilMs = (l.next_at ?? l.last_at) - now
          const intervalMs = l.interval_sec * 1000
          // "Overdue" = we're more than 2x the interval past expected next.
          const overdue = -untilMs > intervalMs

          const dot =
            overdue ? 'bg-red-500'
              : untilMs < 0 ? 'bg-amber-500'
              : 'bg-emerald-500'

          return (
            <div key={l.key} className="flex items-baseline justify-between gap-2 text-[11px] font-mono">
              <div className="flex items-center gap-2 min-w-0">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
                <span className="text-slate-300 truncate">{l.label}</span>
              </div>
              <div className="text-right shrink-0">
                <span className="text-slate-500">{fmtSince(sinceMs)} ago</span>
                <span className="text-slate-700 mx-1">·</span>
                <span className={overdue ? 'text-red-400' : untilMs < 0 ? 'text-amber-400' : 'text-slate-500'}>
                  {untilMs <= 0 ? 'due' : `in ${fmtUntil(untilMs)}`}
                </span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function fmtSince(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

function fmtUntil(ms: number): string {
  return fmtSince(ms)
}

// Recent activity — shown as a collapsible card on Dash (replaces the
// old Log tab). Defaults collapsed to keep Dash short.
function ActivityLog({ log }: { log: LogEntry[] }) {
  const [open, setOpen] = useState(false)
  const shown = open ? log : log.slice(0, 5)

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5 space-y-3">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between"
      >
        <div>
          <p className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">Recent activity</p>
          <p className="text-[10px] font-mono text-slate-700 mt-0.5">
            {log.length === 0 ? 'Waiting for first tick…' : `${log.length} entries · tap to ${open ? 'collapse' : 'expand'}`}
          </p>
        </div>
        <span className={`text-slate-700 text-xs font-mono transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
      </button>

      {log.length === 0 ? null : (
        <div className="space-y-2.5 pt-1 border-t border-slate-800">
          {shown.map(e => (
            <div key={e.id} className="flex gap-3 items-start pt-1.5">
              <span className={`font-mono text-xs shrink-0 w-3 text-center ${LOG_COLOR[e.type]}`}>
                {LOG_PREFIX[e.type]}
              </span>
              <div className="min-w-0 flex-1">
                <p className={`text-[11px] font-mono leading-snug break-words ${LOG_COLOR[e.type]}`}>
                  {e.message}
                </p>
                <p className="text-[9px] text-slate-700 font-mono mt-0.5">{fmt(e.timestamp)}</p>
              </div>
            </div>
          ))}
        </div>
      )}
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
  earnings_paid_mtd: number       // actual payouts received this month
  pending_max: number             // max possible across submitted-but-unpaid
  pending_count: number
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
  const net = data.earnings_paid_mtd - data.mtd
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

      {/* Earnings vs costs — PAID only, not submitted */}
      <div className="grid grid-cols-3 gap-3 pt-1 border-t border-slate-800">
        <div>
          <p className="text-sm font-mono text-emerald-400 tabular-nums">
            +${data.earnings_paid_mtd.toFixed(2)}
          </p>
          <p className="text-[10px] font-mono text-slate-600">paid MTD</p>
        </div>
        <div>
          <p className="text-sm font-mono text-blue-400 tabular-nums">
            ${data.pending_max.toFixed(2)}
          </p>
          <p className="text-[10px] font-mono text-slate-600">max pending · {data.pending_count}</p>
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

interface BroadcastRow {
  id: number
  channel: string
  content: string
  status: 'posted' | 'failed' | 'cancelled' | 'pending_publish' | string
  external_id: string | null
  error: string | null
  ts: number | null
  scheduled_ts: number | null
}

interface BroadcastData {
  channels: string[]
  interval_min: number
  preview_window_min: number
  enabled: boolean
  recent: BroadcastRow[]
  pending: BroadcastRow[]
  last_broadcast_at: number | null
}

const CHANNEL_STYLE: Record<string, string> = {
  bluesky:  'bg-blue-950 text-blue-300 border-blue-900',
  telegram: 'bg-sky-950 text-sky-300 border-sky-900',
}

// ─── Telegram card — connectivity check + one-tap test ────────────────────────

interface TelegramStatus {
  configured: boolean
  missing: string[]
}

function TelegramCard() {
  const [status, setStatus] = useState<TelegramStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/telegram/test')
      if (res.ok) setStatus(await res.json())
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { load() }, [load])

  const runTest = async () => {
    setBusy(true)
    setResult(null)
    try {
      const res = await fetch('/api/telegram/test', { method: 'POST' })
      const d = await res.json().catch(() => ({}))
      if (res.ok && d.ok) {
        setResult({ ok: true, msg: 'Check your Telegram — message sent.' })
      } else {
        setResult({ ok: false, msg: d.error ?? `HTTP ${res.status}` })
      }
    } catch (e) {
      setResult({ ok: false, msg: String(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">Telegram</p>
          <p className="text-[10px] font-mono text-slate-600 mt-0.5">
            Vega picks + broadcast mirror
          </p>
        </div>
        <span className={`text-[9px] font-mono px-2 py-0.5 rounded border ${
          status?.configured
            ? 'bg-emerald-950 text-emerald-400 border-emerald-900'
            : 'bg-slate-800 text-slate-500 border-slate-700'
        }`}>
          {status?.configured ? 'CONNECTED' : 'NOT SET'}
        </span>
      </div>

      {status && !status.configured && status.missing.length > 0 && (
        <p className="text-[10px] font-mono text-slate-600 leading-relaxed">
          Set on Railway: {status.missing.join(' + ')}. Full setup guide in <span className="text-slate-400">.env.example</span>.
        </p>
      )}

      <button
        onClick={runTest}
        disabled={busy || !status?.configured}
        className="w-full text-[10px] font-mono bg-emerald-700 text-white rounded-lg py-2 active:bg-emerald-600 disabled:bg-slate-800 disabled:text-slate-600"
      >
        {busy ? 'Sending…' : 'Send test message'}
      </button>

      {result && (
        <p className={`text-[10px] font-mono leading-relaxed ${result.ok ? 'text-emerald-400' : 'text-red-400'}`}>
          {result.ok ? '✓ ' : '✗ '}{result.msg}
        </p>
      )}

      {status?.configured && !result && (
        <p className="text-[10px] font-mono text-slate-600 leading-relaxed">
          Vega fires picks on F0 cycles; Broadcast mirrors hourly status. Tap test if you&apos;ve just added the keys.
        </p>
      )}
    </div>
  )
}

// ─── Bluesky card — test auth without leaving a public skeet ──────────────────

interface BlueskyStatus {
  configured: boolean
  missing: string[]
}

function BlueskyCard() {
  const [status, setStatus] = useState<BlueskyStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/bluesky/test')
      if (res.ok) setStatus(await res.json())
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { load() }, [load])

  const runTest = async () => {
    setBusy(true)
    setResult(null)
    try {
      const res = await fetch('/api/bluesky/test', { method: 'POST' })
      const d = await res.json().catch(() => ({}))
      if (res.ok && d.ok) {
        setResult({
          ok: true,
          msg: d.error
            ? d.error
            : 'Auth verified. Test skeet posted and auto-deleted.',
        })
      } else {
        setResult({ ok: false, msg: d.error ?? `HTTP ${res.status}` })
      }
    } catch (e) {
      setResult({ ok: false, msg: String(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">Bluesky</p>
          <p className="text-[10px] font-mono text-slate-600 mt-0.5">
            Public hourly broadcasts
          </p>
        </div>
        <span className={`text-[9px] font-mono px-2 py-0.5 rounded border ${
          status?.configured
            ? 'bg-emerald-950 text-emerald-400 border-emerald-900'
            : 'bg-slate-800 text-slate-500 border-slate-700'
        }`}>
          {status?.configured ? 'CONNECTED' : 'NOT SET'}
        </span>
      </div>

      {status && !status.configured && status.missing.length > 0 && (
        <p className="text-[10px] font-mono text-slate-600 leading-relaxed">
          Set on Railway: {status.missing.join(' + ')}. App password is created in the Bluesky app → Settings → Privacy and security → App Passwords. Not your main login password.
        </p>
      )}

      <button
        onClick={runTest}
        disabled={busy || !status?.configured}
        className="w-full text-[10px] font-mono bg-emerald-700 text-white rounded-lg py-2 active:bg-emerald-600 disabled:bg-slate-800 disabled:text-slate-600"
      >
        {busy ? 'Verifying…' : 'Verify auth (post + auto-delete)'}
      </button>

      {result && (
        <p className={`text-[10px] font-mono leading-relaxed ${result.ok ? 'text-emerald-400' : 'text-red-400'}`}>
          {result.ok ? '✓ ' : '✗ '}{result.msg}
        </p>
      )}

      {status?.configured && !result && (
        <p className="text-[10px] font-mono text-slate-600 leading-relaxed">
          Test posts a throwaway skeet then deletes it. If it fails here, the hourly broadcast will fail too.
        </p>
      )}
    </div>
  )
}

// ─── Pending broadcasts (preview window) ────────────────────────────────────
// Groups pending rows by content so the operator sees one preview per
// composed post (not one row per channel). Countdown ticks locally.

function PendingBroadcastCard() {
  const [data, setData] = useState<BroadcastData | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/broadcasts')
      if (res.ok) setData(await res.json())
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, 10_000)
    return () => clearInterval(id)
  }, [load])

  useEffect(() => {
    const id = setInterval(() => setNow(n => n + 1000), 1000)
    return () => clearInterval(id)
  }, [])

  if (!data || data.pending.length === 0) return null

  // Group pending by content so we show one card per composed post.
  const groups = new Map<string, BroadcastRow[]>()
  for (const row of data.pending) {
    const arr = groups.get(row.content) ?? []
    arr.push(row)
    groups.set(row.content, arr)
  }

  const cancelGroup = async (text: string) => {
    const key = `c:${text.slice(0, 20)}`
    setBusy(key)
    try {
      await fetch('/api/broadcasts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'cancel_text', content: text }),
      })
      await load()
    } finally { setBusy(null) }
  }

  const publishGroup = async (rows: BroadcastRow[]) => {
    const key = `p:${rows.map(r => r.id).join(',')}`
    setBusy(key)
    try {
      await Promise.all(rows.map(r =>
        fetch('/api/broadcasts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'publish_now', id: r.id }),
        })
      ))
      await load()
    } finally { setBusy(null) }
  }

  return (
    <div className="rounded-2xl border-2 border-amber-900/70 bg-amber-950/20 p-5 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[10px] font-mono text-amber-400 uppercase tracking-widest">Preview · About to post</p>
          <p className="text-[10px] font-mono text-slate-600 mt-0.5">
            Countdown runs {data.preview_window_min}m after compose. Tap to override.
          </p>
        </div>
      </div>

      <div className="space-y-4">
        {Array.from(groups.entries()).map(([text, rows]) => {
          const earliest = Math.min(...rows.map(r => r.scheduled_ts ?? Infinity))
          const remainingMs = earliest === Infinity ? null : earliest - now
          const dueSoon = remainingMs != null && remainingMs <= 30_000

          const publishKey = `p:${rows.map(r => r.id).join(',')}`
          const cancelKey  = `c:${text.slice(0, 20)}`

          return (
            <div key={rows[0].id} className="rounded-xl border border-slate-800 bg-slate-950 p-3 space-y-3">
              <pre className="text-[12px] font-mono text-slate-200 leading-relaxed whitespace-pre-wrap break-words select-text">
                {text}
              </pre>

              <div className="flex items-center justify-between text-[10px] font-mono">
                <div className="flex flex-wrap gap-1">
                  {rows.map(r => (
                    <span
                      key={r.id}
                      className={`px-1.5 py-0.5 rounded border ${CHANNEL_STYLE[r.channel] ?? 'bg-slate-800 text-slate-400 border-slate-700'}`}
                    >
                      {r.channel.toUpperCase()}
                    </span>
                  ))}
                </div>
                {remainingMs != null && (
                  <span className={dueSoon ? 'text-amber-400' : 'text-slate-500'}>
                    {remainingMs <= 0 ? 'publishing…' : `in ${fmtRemaining(remainingMs)}`}
                  </span>
                )}
              </div>

              <div className="flex gap-2">
                <button
                  onClick={() => cancelGroup(text)}
                  disabled={busy === cancelKey}
                  className="flex-1 text-[10px] font-mono text-red-400 border border-red-900 rounded-lg py-2 active:opacity-70 disabled:opacity-40"
                >
                  {busy === cancelKey ? 'Cancelling…' : 'Cancel'}
                </button>
                <button
                  onClick={() => publishGroup(rows)}
                  disabled={busy === publishKey}
                  className="flex-1 text-[10px] font-mono bg-emerald-700 text-white rounded-lg py-2 active:bg-emerald-600 disabled:bg-slate-800 disabled:text-slate-600"
                >
                  {busy === publishKey ? 'Publishing…' : 'Publish now'}
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function fmtRemaining(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rem = s % 60
  return rem === 0 ? `${m}m` : `${m}m ${rem}s`
}

function BroadcastCard() {
  const [data, setData] = useState<BroadcastData | null>(null)
  const [posting, setPosting] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/broadcasts')
      if (res.ok) setData(await res.json())
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [load])

  const postNow = async () => {
    setPosting(true)
    try {
      await fetch('/api/broadcasts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      await load()
    } finally { setPosting(false) }
  }

  if (!data) return null

  const nextDue = data.last_broadcast_at
    ? new Date(data.last_broadcast_at + data.interval_min * 60_000)
    : null
  const overdue = nextDue ? nextDue.getTime() <= Date.now() : true

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">Broadcasts</p>
        <span className="text-[9px] font-mono text-slate-600 border border-slate-800 rounded px-1.5 py-0.5">
          every {data.interval_min}m
        </span>
      </div>

      {data.channels.length === 0 ? (
        <p className="text-xs font-mono text-slate-600">
          Bluesky not configured. Set BSKY_HANDLE and BSKY_APP_PASSWORD (from Bluesky Settings → App Passwords) on Railway to enable hourly posts.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5">
            {data.channels.map(ch => (
              <span
                key={ch}
                className={`text-[9px] font-mono px-2 py-0.5 rounded border ${CHANNEL_STYLE[ch] ?? 'bg-slate-800 text-slate-400 border-slate-700'}`}
              >
                {ch.toUpperCase()}
              </span>
            ))}
          </div>

          <div className="flex items-center justify-between">
            <p className="text-[10px] font-mono text-slate-600">
              {data.last_broadcast_at
                ? `Last: ${fmtAge(data.last_broadcast_at)}${nextDue ? ` · next ${overdue ? 'due' : `in ~${Math.max(1, Math.round((nextDue.getTime() - Date.now()) / 60_000))}m`}` : ''}`
                : 'Never posted.'}
            </p>
            <button
              onClick={postNow}
              disabled={posting}
              className="text-[9px] font-mono bg-emerald-700 text-white rounded px-2 py-1 active:bg-emerald-600 disabled:bg-slate-800 disabled:text-slate-600"
            >
              {posting ? 'Posting…' : 'Post now'}
            </button>
          </div>

          {data.recent.length > 0 && (
            <div className="space-y-2 pt-1 border-t border-slate-800">
              {data.recent.slice(0, 3).map(r => (
                <div key={r.id} className="flex items-start gap-2">
                  <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border shrink-0 ${CHANNEL_STYLE[r.channel] ?? 'bg-slate-800 text-slate-400 border-slate-700'}`}>
                    {r.channel.toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className={`text-[11px] font-mono leading-snug ${r.status === 'posted' ? 'text-slate-300' : 'text-red-400'}`}>
                      {r.content}
                    </p>
                    <p className="text-[9px] font-mono text-slate-600 mt-0.5">
                      {r.status === 'posted' ? '✓' : '✗'} {r.ts ? fmtAge(r.ts) : 'just now'}
                      {r.status === 'failed' && r.error ? ` · ${r.error.slice(0, 60)}` : ''}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ─── Discovery watchlist ─────────────────────────────────────────────────────

interface WatchItem {
  id: number
  source: string
  external_id: string
  name: string
  url: string | null
  chain: string | null
  tvl: number | null
  stars: number | null
  scope: string
  status: 'watching' | 'promoted' | 'dismissed'
  first_seen_ts: number | null
  listed_ts: number | null
}

interface WatchlistData {
  items: WatchItem[]
  last_run_at: number | null
  counts: { watching: number; promoted: number; dismissed: number }
}

const SOURCE_STYLE: Record<string, string> = {
  defillama: 'bg-purple-950 text-purple-300 border-purple-900',
  github:    'bg-slate-800 text-slate-300 border-slate-700',
}

function DiscoveryCard() {
  const [data, setData] = useState<WatchlistData | null>(null)
  const [busy, setBusy] = useState<'refresh' | number | null>(null)
  const [expanded, setExpanded] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/watchlist')
      if (res.ok) setData(await res.json())
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, 60_000)
    return () => clearInterval(id)
  }, [load])

  const refresh = async () => {
    setBusy('refresh')
    try {
      await fetch('/api/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'refresh' }),
      })
      await load()
    } finally { setBusy(null) }
  }

  const act = async (id: number, action: 'promote' | 'dismiss' | 'restore') => {
    setBusy(id)
    try {
      await fetch('/api/watchlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action }),
      })
      await load()
    } finally { setBusy(null) }
  }

  if (!data) return null

  const watching = data.items.filter(i => i.status === 'watching')
  const topN = expanded ? watching : watching.slice(0, 3)

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">Watchlist · Discovery</p>
        <button
          onClick={refresh}
          disabled={busy === 'refresh'}
          className="text-[9px] font-mono text-slate-400 border border-slate-700 rounded px-2 py-0.5 active:bg-slate-800 disabled:opacity-40"
        >
          {busy === 'refresh' ? 'Scanning…' : 'Refresh'}
        </button>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div>
          <p className="text-lg font-bold font-mono text-emerald-400 tabular-nums">{data.counts.watching}</p>
          <p className="text-[10px] font-mono text-slate-600">watching</p>
        </div>
        <div>
          <p className="text-lg font-bold font-mono text-blue-400 tabular-nums">{data.counts.promoted}</p>
          <p className="text-[10px] font-mono text-slate-600">promoted</p>
        </div>
        <div>
          <p className="text-lg font-bold font-mono text-slate-500 tabular-nums">{data.counts.dismissed}</p>
          <p className="text-[10px] font-mono text-slate-600">dismissed</p>
        </div>
      </div>

      <p className="text-[10px] font-mono text-slate-600">
        {data.last_run_at ? `Last scan: ${fmtAge(data.last_run_at)}` : 'No scan yet.'} · Sources: DefiLlama + GitHub
      </p>

      {watching.length === 0 ? (
        <p className="text-xs font-mono text-slate-600 text-center py-3">Queue is empty. Hit Refresh to scan now.</p>
      ) : (
        <div className="space-y-2 pt-1 border-t border-slate-800">
          {topN.map(item => (
            <div key={item.id} className="py-1">
              <div className="flex items-start gap-2">
                <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border shrink-0 mt-0.5 ${SOURCE_STYLE[item.source] ?? 'bg-slate-800 text-slate-400 border-slate-700'}`}>
                  {item.source.toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  {item.url ? (
                    <a href={item.url} target="_blank" rel="noopener noreferrer" className="text-[11px] font-mono text-slate-200 break-all underline">
                      {item.name}
                    </a>
                  ) : (
                    <span className="text-[11px] font-mono text-slate-200 break-all">{item.name}</span>
                  )}
                  <p className="text-[9px] font-mono text-slate-600 mt-0.5">
                    {item.tvl != null ? `TVL $${(item.tvl / 1_000_000).toFixed(2)}M` : item.stars != null ? `${item.stars}★` : ''}
                    {item.chain ? ` · ${item.chain}` : ''}
                    {item.listed_ts ? ` · created ${fmtAge(item.listed_ts)}` : ''}
                  </p>
                </div>
              </div>
              <div className="flex gap-2 mt-1.5 ml-12">
                <button
                  onClick={() => act(item.id, 'promote')}
                  disabled={busy === item.id}
                  className="text-[9px] font-mono text-emerald-400 border border-emerald-900 rounded px-2 py-0.5 active:bg-emerald-950 disabled:opacity-40"
                >
                  Promote
                </button>
                <button
                  onClick={() => act(item.id, 'dismiss')}
                  disabled={busy === item.id}
                  className="text-[9px] font-mono text-slate-500 border border-slate-800 rounded px-2 py-0.5 active:bg-slate-800 disabled:opacity-40"
                >
                  Dismiss
                </button>
              </div>
            </div>
          ))}

          {watching.length > 3 && (
            <button
              onClick={() => setExpanded(e => !e)}
              className="w-full text-[10px] font-mono text-slate-500 pt-2 active:text-slate-400"
            >
              {expanded ? `Show less ▴` : `Show all ${watching.length} ▾`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Articles (technical deep-dives → Substack/mirror.xyz) ───────────────────

interface ArticleRow {
  id: number
  title: string
  content: string
  source: string | null
  status: 'draft' | 'published' | 'dismissed'
  external_url: string | null
  created_ts: number
  updated_ts: number
}

interface ArticlesData {
  articles: ArticleRow[]
  counts: { draft: number; published: number; dismissed: number }
}

const ARTICLE_STATUS_STYLE: Record<string, string> = {
  draft:     'bg-amber-950 text-amber-300 border-amber-900',
  published: 'bg-emerald-950 text-emerald-300 border-emerald-900',
  dismissed: 'bg-slate-800 text-slate-500 border-slate-700',
}

function ArticlesCard() {
  const [data, setData] = useState<ArticlesData | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [openId, setOpenId] = useState<number | null>(null)
  const [openContent, setOpenContent] = useState<Record<number, string>>({})
  const [urlInput, setUrlInput] = useState<Record<number, string>>({})

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/articles')
      if (res.ok) setData(await res.json())
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [load])

  const generate = async () => {
    setBusy(true); setError(null)
    try {
      const res = await fetch('/api/articles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'generate' }),
      })
      const d = await res.json()
      if (!res.ok) {
        setError(d.error ?? 'Generation failed')
      } else {
        await load()
        setOpenId(d.id)
        setOpenContent(prev => ({ ...prev, [d.id]: d.content }))
      }
    } finally { setBusy(false) }
  }

  const markPublished = async (id: number) => {
    const url = (urlInput[id] ?? '').trim() || undefined
    await fetch('/api/articles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'mark_published', id, external_url: url }),
    })
    await load()
  }

  const dismiss = async (id: number) => {
    if (!confirm('Dismiss this draft?')) return
    await fetch('/api/articles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'dismiss', id }),
    })
    if (openId === id) setOpenId(null)
    await load()
  }

  const copy = (text: string) => navigator.clipboard.writeText(text)

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">Articles</p>
          <p className="text-[10px] font-mono text-slate-600 mt-0.5">
            Technical deep-dives from completed research · affiliate-linked
          </p>
        </div>
        <button
          onClick={generate}
          disabled={busy}
          className="text-[10px] font-mono bg-emerald-700 text-white rounded-lg px-3 py-1.5 active:bg-emerald-600 disabled:bg-slate-800 disabled:text-slate-600"
        >
          {busy ? 'Drafting…' : 'Draft from latest research'}
        </button>
      </div>

      {error && <p className="text-[11px] font-mono text-red-400">{error}</p>}

      {data && (
        <div className="grid grid-cols-3 gap-3">
          <div>
            <p className="text-lg font-bold font-mono text-amber-300 tabular-nums">{data.counts.draft}</p>
            <p className="text-[10px] font-mono text-slate-600">drafts</p>
          </div>
          <div>
            <p className="text-lg font-bold font-mono text-emerald-300 tabular-nums">{data.counts.published}</p>
            <p className="text-[10px] font-mono text-slate-600">published</p>
          </div>
          <div>
            <p className="text-lg font-bold font-mono text-slate-500 tabular-nums">{data.counts.dismissed}</p>
            <p className="text-[10px] font-mono text-slate-600">dismissed</p>
          </div>
        </div>
      )}

      {data && data.articles.length === 0 ? (
        <p className="text-xs font-mono text-slate-600">
          No drafts yet. Tap above to draft from a finished research target.
        </p>
      ) : (
        <div className="space-y-2 pt-1 border-t border-slate-800">
          {data?.articles.slice(0, 6).map(a => {
            const open = openId === a.id
            return (
              <div key={a.id} className="space-y-1.5 py-1">
                <button
                  onClick={() => {
                    setOpenId(open ? null : a.id)
                    if (!open && !openContent[a.id]) setOpenContent(p => ({ ...p, [a.id]: a.content }))
                  }}
                  className="w-full text-left flex items-start gap-2"
                >
                  <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border shrink-0 mt-0.5 ${ARTICLE_STATUS_STYLE[a.status] ?? 'bg-slate-800 text-slate-400 border-slate-700'}`}>
                    {a.status.toUpperCase()}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-mono text-slate-200 leading-snug truncate">{a.title}</p>
                    <p className="text-[9px] font-mono text-slate-600 mt-0.5">
                      {fmtAge(a.created_ts)}{a.source ? ` · ${a.source}` : ''}
                      {a.external_url ? ' · live' : ''}
                    </p>
                  </div>
                  <span className={`text-slate-600 text-xs font-mono shrink-0 mt-0.5 transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
                </button>

                {open && (
                  <div className="space-y-2 pl-2">
                    <pre className="text-[10px] font-mono text-slate-300 leading-relaxed bg-slate-950 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-words max-h-80 overflow-y-auto select-text">
                      {openContent[a.id] ?? a.content}
                    </pre>
                    <div className="flex gap-2">
                      <button
                        onClick={() => copy(openContent[a.id] ?? a.content)}
                        className="flex-1 text-[10px] font-mono text-slate-300 border border-slate-700 rounded-lg py-1.5 active:bg-slate-800"
                      >
                        Copy MD
                      </button>
                      {a.status === 'draft' && (
                        <button
                          onClick={() => dismiss(a.id)}
                          className="flex-1 text-[10px] font-mono text-red-400 border border-red-900 rounded-lg py-1.5 active:opacity-70"
                        >
                          Dismiss
                        </button>
                      )}
                    </div>
                    {a.status === 'draft' && (
                      <div className="flex gap-2">
                        <input
                          type="url"
                          value={urlInput[a.id] ?? ''}
                          onChange={e => setUrlInput(p => ({ ...p, [a.id]: e.target.value }))}
                          placeholder="https://your-substack-url (optional)"
                          className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-2 py-1.5 text-[10px] font-mono text-slate-300 placeholder:text-slate-700 focus:outline-none focus:border-emerald-800"
                        />
                        <button
                          onClick={() => markPublished(a.id)}
                          className="text-[10px] font-mono bg-emerald-700 text-white rounded-lg px-3 py-1.5 active:bg-emerald-600"
                        >
                          Mark live
                        </button>
                      </div>
                    )}
                    {a.external_url && (
                      <a
                        href={a.external_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block text-[10px] font-mono text-blue-400 break-all underline"
                      >
                        {a.external_url}
                      </a>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ─── Retainer pitch ──────────────────────────────────────────────────────────

function PitchCard() {
  const [content, setContent] = useState<string | null>(null)
  const [createdAt, setCreatedAt] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/pitches/retainer')
      if (res.ok) {
        const d = await res.json()
        setContent(d.content)
        setCreatedAt(d.created_at ?? null)
      }
    } catch { /* ignore */ }
  }, [])

  useEffect(() => { load() }, [load])

  const generate = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/pitches/retainer', { method: 'POST' })
      const d = await res.json()
      if (!res.ok) {
        setError(d.error ?? 'Generation failed')
      } else {
        setContent(d.content)
        setCreatedAt(d.created_at ?? Date.now())
        setExpanded(true)
      }
    } finally { setBusy(false) }
  }

  const copy = () => {
    if (!content) return
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">Retainer Pitch</p>
          <p className="text-[10px] font-mono text-slate-600 mt-0.5">
            One-pager grounded in Lila's live numbers
          </p>
        </div>
        <button
          onClick={generate}
          disabled={busy}
          className="text-[10px] font-mono bg-emerald-700 text-white rounded-lg px-3 py-1.5 active:bg-emerald-600 disabled:bg-slate-800 disabled:text-slate-600"
        >
          {busy ? 'Generating…' : content ? 'Regenerate' : 'Generate'}
        </button>
      </div>

      {error && <p className="text-[11px] font-mono text-red-400">{error}</p>}

      {content ? (
        <>
          <div className="flex items-center justify-between text-[10px] font-mono text-slate-600">
            <span>{createdAt ? `Drafted ${fmtAge(createdAt)}` : 'Draft'}</span>
            <div className="flex gap-2">
              <button
                onClick={copy}
                className="text-[10px] font-mono text-slate-300 border border-slate-700 rounded px-2 py-0.5 active:bg-slate-800"
              >
                {copied ? '✓ copied' : 'Copy MD'}
              </button>
              <button
                onClick={() => setExpanded(e => !e)}
                className="text-[10px] font-mono text-slate-500 border border-slate-800 rounded px-2 py-0.5 active:bg-slate-800"
              >
                {expanded ? 'Hide' : 'View'}
              </button>
            </div>
          </div>
          {expanded && (
            <pre className="text-[10px] font-mono text-slate-300 leading-relaxed bg-slate-950 rounded-xl p-3 overflow-x-auto whitespace-pre-wrap break-words max-h-96 overflow-y-auto select-text">
              {content}
            </pre>
          )}
        </>
      ) : (
        <p className="text-xs font-mono text-slate-600">
          No pitch drafted yet. Hit Generate to produce one from Lila's current performance numbers.
        </p>
      )}
    </div>
  )
}

function TargetCard({ onNavigate }: { onNavigate?: NavigateFn }) {
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
      <p className="text-xs font-mono text-slate-600">No target pinned. Cipher will pin one next cycle.</p>
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

      {onNavigate && (
        <button
          onClick={() => onNavigate({ tab: 'library', notesFilter: 'tasker' })}
          className="w-full text-[10px] font-mono text-slate-400 border border-slate-800 rounded-lg py-2 active:bg-slate-800 mt-1"
        >
          View Cipher plans →
        </button>
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
        <p className="text-xs font-mono text-slate-600">No open positions. Vega queuing picks.</p>
      )}
    </div>
  )
}

// ─── Operator Brief ───────────────────────────────────────────────────────
//
// Lila's spec: one card with the four numbers we'd brief on if a partner
// walked in cold — wallet, open positions, pending bounties, team queue.
// No fluff. Pulls /api/brief which aggregates from lila_state +
// security_reports + lila_positions + Alpaca + every agent's state table.

interface BriefData {
  wallet: {
    confirmed_earned: number
    paid_mtd: number
    last_paid: { title: string; payout: number; on: string } | null
    reconciliation: {
      total_earned: number
      sum_of_paid: number
      paid_count: number
      delta: number
      reconciled: boolean
    }
  }
  positions: {
    paper: boolean
    open: Array<{ symbol: string; qty: number; entry: number; pnl_pct: number }>
    paper_realized: number
  }
  bounties: {
    pending_review: number
    approved: number
    submitted: number
    awaiting_payout_max: number
  }
  team: {
    cipher: { step: string; cycles: number; target: string | null; last_ts: number | null } | null
    scout:  { cycle: number; scanned: number; reported: number; last_ts: number | null } | null
    vega:   { step: string; cycle: number; last_ts: number | null } | null
    ceelo:  { cycle: number; rated: number; upcoming: number; last_ts: number | null } | null
    lila:   { active_tasks: string[]; last_chat_ts: number | null }
  }
}

function OperatorBrief({ visible, onNavigate }: {
  visible: boolean
  onNavigate: NavigateFn
}) {
  const [b, setB] = useState<BriefData | null>(null)

  useEffect(() => {
    if (!visible) return
    const load = async () => {
      try {
        const res = await fetch('/api/brief')
        if (res.ok) setB(await res.json())
      } catch { /* ignore */ }
    }
    load()
    const id = setInterval(load, 12_000)
    return () => clearInterval(id)
  }, [visible])

  if (!b) return (
    <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5 space-y-2">
      <p className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">Operator Brief</p>
      <p className="text-xs font-mono text-slate-700">Loading…</p>
    </div>
  )

  const totalBountyAction = b.bounties.pending_review + b.bounties.approved + b.bounties.submitted

  return (
    <div className="rounded-2xl border border-emerald-900/50 bg-emerald-950/10 p-4 space-y-3">
      <div className="flex items-baseline justify-between">
        <p className="text-[10px] font-mono text-emerald-400 uppercase tracking-widest font-semibold">Operator Brief</p>
        <p className="text-[9px] font-mono text-slate-600">live · refreshes every 12s</p>
      </div>

      {/* 1. Wallet (real cash) */}
      <BriefRow
        label="Wallet"
        primary={`$${b.wallet.confirmed_earned.toFixed(2)}`}
        secondary={
          b.wallet.paid_mtd > 0
            ? `+$${b.wallet.paid_mtd.toFixed(2)} MTD${b.wallet.last_paid ? ` · last: ${b.wallet.last_paid.title.slice(0, 28)}` : ''}`
            : 'No paid bounties yet'
        }
        accent="emerald"
      />
      {/* Reconciliation caption — confirms the wallet headline matches the
          actual sum of paid bounties. Catches paper-P&L leak residue. */}
      <WalletReconcile r={b.wallet.reconciliation} />

      {/* 2. Open positions (Alpaca) */}
      <BriefRow
        label={`Positions${b.positions.paper ? ' (paper)' : ''}`}
        primary={b.positions.open.length === 0 ? 'Flat' : `${b.positions.open.length} open`}
        secondary={
          b.positions.open.length === 0
            ? `Realized P&L ${signedDollar(b.positions.paper_realized)}`
            : b.positions.open.map(p => `${p.symbol} ${signedPct(p.pnl_pct)}`).join(' · ')
        }
        accent="blue"
        onClick={() => onNavigate({ tab: 'trading' })}
      />

      {/* 3. Pending bounty submissions */}
      <BriefRow
        label="Bounties"
        primary={totalBountyAction === 0 ? 'Clear' : `${totalBountyAction} in flight`}
        secondary={
          totalBountyAction === 0
            ? 'No drafts, no submissions'
            : [
                b.bounties.pending_review > 0 ? `${b.bounties.pending_review} for Lila review` : null,
                b.bounties.approved       > 0 ? `${b.bounties.approved} ready to submit`    : null,
                b.bounties.submitted      > 0 ? `${b.bounties.submitted} awaiting payout (≤ $${b.bounties.awaiting_payout_max.toFixed(0)})` : null,
              ].filter(Boolean).join(' · ')
        }
        accent="amber"
        onClick={() => onNavigate({ tab: 'library', libraryMode: 'reports' })}
      />

      {/* 4. Team task queue */}
      <div className="border-t border-emerald-900/30 pt-2 space-y-1">
        <p className="text-[9px] font-mono text-slate-600 tracking-widest">TEAM QUEUE</p>
        <BriefTeamRow color="text-amber-400" who="Cipher"
          line={b.team.cipher
            ? `${b.team.cipher.target ? `${b.team.cipher.target.slice(0, 24)} c${b.team.cipher.cycles}` : `step ${b.team.cipher.step}`}`
            : 'idle'}
          ts={b.team.cipher?.last_ts ?? null}
        />
        <BriefTeamRow color="text-cyan-400" who="Scout"
          line={b.team.scout
            ? `${b.team.scout.scanned} scanned · ${b.team.scout.reported} reported`
            : 'idle'}
          ts={b.team.scout?.last_ts ?? null}
        />
        <BriefTeamRow color="text-blue-400" who="Vega"
          line={b.team.vega
            ? `${vegaStepLabel(b.team.vega.step)} · cycle ${b.team.vega.cycle}`
            : 'idle'}
          ts={b.team.vega?.last_ts ?? null}
        />
        <BriefTeamRow color="text-rose-400" who="Ceelo"
          line={b.team.ceelo
            ? `${b.team.ceelo.rated}/32 rated · ${b.team.ceelo.upcoming} upcoming`
            : 'idle'}
          ts={b.team.ceelo?.last_ts ?? null}
        />
        <BriefTeamRow color="text-emerald-400" who="Lila"
          line={b.team.lila.active_tasks.length
            ? b.team.lila.active_tasks.slice(0, 2).join(' · ').slice(0, 60)
            : 'standing by'}
          ts={b.team.lila.last_chat_ts}
        />
      </div>
    </div>
  )
}

function BriefRow({ label, primary, secondary, accent, onClick }: {
  label: string
  primary: string
  secondary: string
  accent: 'emerald' | 'blue' | 'amber'
  onClick?: () => void
}) {
  const accentColor = accent === 'emerald' ? 'text-emerald-300'
                    : accent === 'blue'    ? 'text-blue-300'
                    : 'text-amber-300'
  const Wrap = onClick ? 'button' : 'div'
  return (
    <Wrap
      onClick={onClick}
      className={`w-full flex items-baseline gap-3 ${onClick ? 'active:opacity-70 text-left' : ''}`}
    >
      <span className="text-[9px] font-mono text-slate-600 tracking-widest w-20 shrink-0">{label.toUpperCase()}</span>
      <div className="flex-1 min-w-0">
        <p className={`text-base font-mono font-semibold tabular-nums ${accentColor}`}>{primary}</p>
        <p className="text-[10px] font-mono text-slate-500 truncate">{secondary}</p>
      </div>
      {onClick && <span className="text-slate-700 text-[10px] font-mono shrink-0">→</span>}
    </Wrap>
  )
}

// Wallet reconciliation caption. If total_earned doesn't match the sum
// of paid bounty payouts, surface the delta + source. Catches residue
// from the now-fixed paper-P&L leak.
function WalletReconcile({ r }: {
  r: BriefData['wallet']['reconciliation']
}) {
  const inSync = Math.abs(r.delta) < 0.01
  const tone = inSync ? 'text-slate-600' : 'text-amber-400'
  const note = inSync
    ? `${r.paid_count} paid bounty${r.paid_count === 1 ? '' : 'ies'} · sum $${r.sum_of_paid.toFixed(2)} · in sync`
    : `${r.paid_count} paid bounty${r.paid_count === 1 ? '' : 'ies'} sum $${r.sum_of_paid.toFixed(2)} · delta ${r.delta >= 0 ? '+' : ''}$${r.delta.toFixed(2)} (likely paper-P&L leak${r.reconciled ? ' — already reconciled' : ' — auto-fix on next deploy'})`
  return (
    <p className={`text-[9px] font-mono pl-[5.25rem] -mt-1 ${tone}`}>{note}</p>
  )
}

function BriefTeamRow({ color, who, line, ts }: {
  color: string
  who: string
  line: string
  ts: number | null
}) {
  return (
    <div className="flex items-center gap-2">
      <span className={`text-[9px] font-mono font-semibold tracking-wider w-12 shrink-0 ${color}`}>{who.toUpperCase()}</span>
      <p className="text-[10px] font-mono text-slate-300 flex-1 min-w-0 truncate">{line}</p>
      <span className="text-[9px] font-mono text-slate-700 shrink-0 tabular-nums">{ts ? fmtAge(ts) : '—'}</span>
    </div>
  )
}

function signedDollar(n: number): string {
  return `${n >= 0 ? '+' : ''}$${n.toFixed(2)}`
}

function signedPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`
}

// ─── Dashboard Tab ────────────────────────────────────────────────────────────

function DashTab({ data, flash, visible, financials, onNavigate }: {
  data: AgentData | null
  flash: boolean
  visible: boolean
  financials: { paidMtd: number; pendingMax: number; pendingCount: number } | null
  onNavigate: NavigateFn
}) {
  return (
    <div className={`absolute inset-0 overflow-y-auto ${visible ? '' : 'invisible pointer-events-none'}`}>
      <div className="px-4 md:px-6 py-5 md:py-7 space-y-6">
        {/* ── Operator Brief — the four numbers Lila and you both want at a glance ─── */}
        <OperatorBrief visible={visible} onNavigate={onNavigate} />

        {/* Earned — bounty payouts ONLY. Trading P&L lives in the Trades tab. */}
        <div className={`rounded-2xl border p-5 transition-colors duration-300 ${flash ? 'border-emerald-500 bg-emerald-950/30' : 'border-slate-800 bg-slate-900'}`}>
          <p className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mb-1">Bounty earnings (real cash)</p>
          <p className={`text-5xl font-bold font-mono tabular-nums transition-colors duration-300 ${flash ? 'text-emerald-300' : 'text-emerald-400'}`}>
            ${data?.totalEarned.toFixed(2) ?? '—'}
          </p>
          <p className="text-[10px] text-slate-700 font-mono mt-2">Confirmed payouts only. Submissions don&rsquo;t count until money arrives. Paper trading P&amp;L is separate (see Trades tab).</p>
          {financials && (financials.pendingCount > 0 || financials.paidMtd > 0) && (
            <div className="grid grid-cols-2 gap-3 mt-4 pt-3 border-t border-slate-800">
              <div>
                <p className="text-sm font-mono text-emerald-400 tabular-nums">${financials.paidMtd.toFixed(2)}</p>
                <p className="text-[10px] font-mono text-slate-600">paid MTD</p>
              </div>
              <div>
                <p className="text-sm font-mono text-blue-400 tabular-nums">${financials.pendingMax.toFixed(2)}</p>
                <p className="text-[10px] font-mono text-slate-600">{financials.pendingCount} submitted · max pending</p>
              </div>
            </div>
          )}
        </div>

        {/* Active Tasks + current bounty mode */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <div className="flex items-center justify-between mb-3">
            <p className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">Active Tasks</p>
            <div className="flex items-center gap-2">
              {data?.bountyMode && (
                <span className={`text-[9px] font-mono px-2 py-0.5 rounded-full border ${
                  data.bountyMode === 'docs'
                    ? 'bg-purple-950 text-purple-300 border-purple-900'
                    : 'bg-emerald-950 text-emerald-400 border-emerald-900'
                }`}>
                  {data.bountyMode === 'docs' ? 'DOCS TURN' : 'AUDIT TURN'}
                </span>
              )}
              <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full border ${(data?.activeTasks.length ?? 0) > 0 ? 'bg-emerald-950 text-emerald-400 border-emerald-900' : 'bg-slate-800 text-slate-600 border-slate-700'}`}>
                {data?.activeTasks.length ?? 0} running
              </span>
            </div>
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

        {/* Status */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/50 p-4 flex items-center gap-3">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse shrink-0" />
          <div>
            <p className="text-[10px] font-mono text-emerald-500 uppercase tracking-widest">Systems operational</p>
            <p className="text-[10px] text-slate-600 font-mono mt-0.5">Lila is running. You don't need to do anything.</p>
          </div>
        </div>

        {/* ── Grouped sections — collapsible, tuned defaults ─────────────── */}

        <Section label="Financials">
          <CostCard />
          <KpiCard />
          <PortfolioCard />
        </Section>

        <Section label="Ops">
          <PendingBroadcastCard />
          <BroadcastCard />
          <BlueskyCard />
          <TelegramCard />
          <TargetCard onNavigate={onNavigate} />
          <DiscoveryCard />
        </Section>

        <Section label="Assets" defaultOpen={false}>
          <ArticlesCard />
          <PitchCard />
        </Section>

        <Section label="Activity" defaultOpen={false}>
          <LoopsCard />
          <ActivityLog log={data?.log ?? []} />
        </Section>

        <Section label="Integrations" defaultOpen={false}>
          <SetupCard />
        </Section>
      </div>
    </div>
  )
}

// ─── Report status styling ────────────────────────────────────────────────────

const REPORT_STATUS_STYLE: Record<string, string> = {
  pending_review: 'bg-slate-800 text-slate-400 border-slate-700',
  approved:       'bg-amber-950 text-amber-300 border-amber-900',
  rejected:       'bg-red-950 text-red-300 border-red-900',
  submitted:      'bg-blue-950 text-blue-300 border-blue-900',
  paid:           'bg-emerald-950 text-emerald-300 border-emerald-900',
  dismissed:      'bg-slate-800 text-slate-500 border-slate-700',
}
const REPORT_STATUS_LABEL: Record<string, string> = {
  pending_review: 'LILA REVIEWING',
  approved:       'APPROVED · TO SUBMIT',
  rejected:       'REJECTED',
  submitted:      'SUBMITTED · AWAITING PAYOUT',
  paid:           'PAID',
  dismissed:      'DISMISSED',
}

type ReportAction =
  | { kind: 'approve' | 'dismiss' | 'submit' | 'mark_unpaid'; id: number }
  | { kind: 'mark_paid'; id: number; payout: number }

// ─── Trading Tab ──────────────────────────────────────────────────────────────

// "Reset paper bankroll" — calls /api/trading/reset which wipes our local
// position history (closed + open in lila_positions), cancels pending picks,
// and closes any actually-open paper positions on Alpaca side. Use this when
// you want the displayed equity / realized P&L to reflect a fresh $100
// bankroll rather than carrying over old results.

function ResetPaperButton({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const click = async () => {
    if (busy) return
    if (!confirm('Reset paper bankroll?\n\nThis will:\n- Close any open paper positions on Alpaca\n- Wipe local position history (closed + open)\n- Cancel pending picks\n\nBounty earnings are NOT touched.')) return
    setBusy(true)
    try {
      const res = await fetch('/api/trading/reset', { method: 'POST' })
      if (res.ok) {
        const body = await res.json()
        setDone(`Closed ${body.alpaca_closed ?? 0} on Alpaca · dropped ${body.positions_dropped?.closed ?? 0} closed / ${body.positions_dropped?.open ?? 0} open · cancelled ${body.picks_cancelled ?? 0} picks`)
        setTimeout(onDone, 1500)
      } else {
        setDone('Reset failed.')
      }
    } catch {
      setDone('Reset failed (network).')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="mt-3 pt-3 border-t border-slate-800">
      <button
        onClick={click}
        disabled={busy}
        className="w-full text-[10px] font-mono text-slate-400 border border-slate-700 rounded-lg py-2 active:bg-slate-800 disabled:opacity-50"
      >
        {busy ? 'Resetting…' : 'Reset paper bankroll'}
      </button>
      {done && <p className="text-[9px] font-mono text-slate-500 mt-1.5 text-center">{done}</p>}
    </div>
  )
}


interface OpenPosition {
  symbol: string
  qty: string
  avg_entry_price: string
  current_price: string
  unrealized_pl: string
  unrealized_plpc: string
  target_price?: string | null
  stop_loss?: string | null
  opened_at?: string | null
}

interface ClosedTrade {
  id: number
  symbol: string
  direction: string
  entry_price: string | null
  target_price: string | null
  stop_loss: string | null
  pnl: string | null
  opened_at: string
  closed_at: string | null
}

interface DailyPnlRow { date: string; pnl: number; trades: number }

interface TradingData {
  account: {
    equity: string
    buying_power: string
    cash: string
    portfolio_value: string
    last_equity?: string
  } | null
  openPositions: OpenPosition[]
  closedTrades: ClosedTrade[]
  portfolioHistory: {
    timestamp: number[]
    equity: number[]
    profit_loss: number[]
    profit_loss_pct: number[]
    base_value: number
    timeframe: string
  } | null
  dailyClosedPnl: DailyPnlRow[]
  period: string
  hasAlpaca: boolean
  paper?: boolean
  paperBankroll?: number
}

const PERIODS: { key: string; label: string }[] = [
  { key: '1D', label: '1D' },
  { key: '1W', label: '1W' },
  { key: '1M', label: '1M' },
  { key: '3M', label: '3M' },
  { key: '1A', label: '1Y' },
  { key: 'all', label: 'ALL' },
]

// ─── Charts ───────────────────────────────────────────────────────────────────

// Tiny chart wrapper — we dynamically import lightweight-charts so server
// rendering doesn't try to touch window/canvas.
function EdgeGraph({ picks }: { picks: PickRow[] }) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!containerRef.current || picks.length === 0) return
    let chart: { remove: () => void } | null = null
    let resizeObserver: ResizeObserver | null = null
    let cancelled = false

    ;(async () => {
      const lib = await import('lightweight-charts')
      if (cancelled || !containerRef.current) return

      const c = lib.createChart(containerRef.current, {
        width: containerRef.current.clientWidth,
        height: 180,
        layout: {
          background: { type: lib.ColorType.Solid, color: 'transparent' },
          textColor: '#64748b',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 10,
        },
        grid: {
          vertLines: { color: 'rgba(30, 41, 59, 0.5)' },
          horzLines: { color: 'rgba(30, 41, 59, 0.5)' },
        },
        timeScale: {
          timeVisible: true,
          borderColor: '#1e293b',
        },
        rightPriceScale: { borderColor: '#1e293b' },
        crosshair: {
          vertLine: { color: '#334155', width: 1 },
          horzLine: { color: '#334155', width: 1 },
        },
        handleScroll: false,
        handleScale: false,
      })
      chart = c

      const series = c.addSeries(lib.HistogramSeries, {
        color: '#f43f5e', // rose-500
        priceFormat: { type: 'volume' }, // hides currency symbol
      })

      // Group by time, add slight offset for exact duplicates
      const seen = new Set<number>()
      const sorted = picks
        .filter(p => p.edge_points != null && p.kickoff_at != null)
        .map(p => {
          let t = Math.floor(new Date(p.kickoff_at!).getTime() / 1000)
          while (seen.has(t)) t++
          seen.add(t)
          return { time: t as unknown as import('lightweight-charts').UTCTimestamp, value: p.edge_points!, color: p.confidence === 'high' ? '#10b981' : p.confidence === 'medium' ? '#f59e0b' : '#334155' }
        })
        .sort((a, b) => (a.time as number) - (b.time as number))

      series.setData(sorted)
      c.timeScale().fitContent()

      resizeObserver = new ResizeObserver(() => {
        if (!containerRef.current) return
        c.applyOptions({ width: containerRef.current.clientWidth })
      })
      resizeObserver.observe(containerRef.current)
    })()

    return () => {
      cancelled = true
      resizeObserver?.disconnect()
      chart?.remove()
    }
  }, [picks])

  if (picks.length === 0) return null

  return (
    <div className="border border-slate-800 rounded-xl bg-slate-900 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-mono text-slate-400 uppercase tracking-widest">Model Edges (Pts)</p>
        <div className="flex gap-2">
          <span className="text-[9px] font-mono text-emerald-400">■ High</span>
          <span className="text-[9px] font-mono text-amber-400">■ Med</span>
        </div>
      </div>
      <div ref={containerRef} className="w-full h-[180px]" />
    </div>
  )
}

// Tiny chart wrapper — we dynamically import lightweight-charts so server
// rendering doesn't try to touch window/canvas.
function EquityChart({ timestamps, values, color = '#10b981' }: {
  timestamps: number[]
  values: number[]
  color?: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!containerRef.current || timestamps.length === 0) return
    let chart: { remove: () => void } | null = null
    let resizeObserver: ResizeObserver | null = null
    let cancelled = false

    ;(async () => {
      const lib = await import('lightweight-charts')
      if (cancelled || !containerRef.current) return

      const c = lib.createChart(containerRef.current, {
        width: containerRef.current.clientWidth,
        height: 180,
        layout: {
          background: { type: lib.ColorType.Solid, color: 'transparent' },
          textColor: '#64748b',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 10,
        },
        grid: {
          vertLines: { color: 'rgba(30, 41, 59, 0.5)' },
          horzLines: { color: 'rgba(30, 41, 59, 0.5)' },
        },
        timeScale: {
          timeVisible: timestamps.length > 0 && (timestamps[timestamps.length - 1] - timestamps[0]) < 86_400 * 2,
          borderColor: '#1e293b',
        },
        rightPriceScale: { borderColor: '#1e293b' },
        crosshair: {
          vertLine: { color: '#334155', width: 1 },
          horzLine: { color: '#334155', width: 1 },
        },
        handleScroll: false,
        handleScale: false,
      })
      chart = c

      const series = c.addSeries(lib.AreaSeries, {
        lineColor: color,
        topColor: `${color}40`,
        bottomColor: `${color}00`,
        priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
      })
      const sorted = timestamps
        .map((t, i) => ({ time: t as unknown as import('lightweight-charts').UTCTimestamp, value: values[i] }))
        .filter(d => Number.isFinite(d.value))
        .sort((a, b) => (a.time as number) - (b.time as number))
      series.setData(sorted)
      c.timeScale().fitContent()

      resizeObserver = new ResizeObserver(() => {
        if (!containerRef.current) return
        c.applyOptions({ width: containerRef.current.clientWidth })
      })
      resizeObserver.observe(containerRef.current)
    })()

    return () => {
      cancelled = true
      resizeObserver?.disconnect()
      chart?.remove()
    }
  }, [timestamps, values, color])

  if (timestamps.length === 0) {
    return (
      <div className="h-[180px] flex items-center justify-center">
        <p className="text-[10px] font-mono text-slate-600">No data.</p>
      </div>
    )
  }
  return <div ref={containerRef} className="w-full h-[180px]" />
}

function TradingTab({ visible }: { visible: boolean }) {
  const [data, setData] = useState<TradingData | null>(null)
  const [period, setPeriod] = useState<string>('1M')
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'open' | 'closed'>('open')

  useEffect(() => {
    if (!visible) return
    const load = async () => {
      try {
        const res = await fetch(`/api/trading?period=${period}`)
        if (!res.ok) return
        setData(await res.json())
      } catch { /* ignore */ }
      finally { setLoading(false) }
    }
    load()
    const id = setInterval(load, 15_000)
    return () => clearInterval(id)
  }, [visible, period])

  // In paper mode we use a fixed display bankroll ($100 by default) and grow
  // / shrink it by realized P&L from our own positions table. Alpaca paper
  // accounts default to $100k which makes the equity number meaningless for
  // tracking. Day P&L is then today's realized P&L (sum of dailyClosedPnl
  // entries dated today).
  const todayKey = new Date().toISOString().slice(0, 10)
  const todayRealized = data?.dailyClosedPnl?.find(d => d.date === todayKey)?.pnl ?? 0

  const realEquity = data?.account ? parseFloat(data.account.equity) : 0
  const realLast   = data?.account?.last_equity ? parseFloat(data.account.last_equity) : realEquity
  const realDayPl  = realEquity - realLast
  const realDayPct = realLast > 0 ? (realDayPl / realLast) * 100 : 0

  const totalRealizedSoFar = useMemo(() => {
    if (!data?.dailyClosedPnl?.length) return 0
    return data.dailyClosedPnl.reduce((s, d) => s + d.pnl, 0)
  }, [data?.dailyClosedPnl])

  const paperBankroll = data?.paperBankroll ?? 100
  const isPaper       = data?.paper !== false  // default true; route returns explicit boolean
  const equity        = isPaper ? +(paperBankroll + totalRealizedSoFar).toFixed(2) : realEquity
  const dayPl         = isPaper ? +todayRealized.toFixed(2) : realDayPl
  const dayPlPct      = isPaper
    ? (paperBankroll > 0 ? (dayPl / paperBankroll) * 100 : 0)
    : realDayPct

  // Cumulative realized P&L from closed trades
  const cumulativePnl = useMemo(() => {
    if (!data?.dailyClosedPnl?.length) return { timestamps: [] as number[], values: [] as number[] }
    let cum = 0
    const timestamps: number[] = []
    const values: number[] = []
    for (const d of data.dailyClosedPnl) {
      cum += d.pnl
      const t = Math.floor(new Date(d.date + 'T00:00:00Z').getTime() / 1000)
      timestamps.push(t)
      values.push(+cum.toFixed(2))
    }
    return { timestamps, values }
  }, [data?.dailyClosedPnl])

  // Paper-mode equity curve: starts at paperBankroll, walks with cumulative
  // realized P&L. We synthesize this client-side instead of using Alpaca's
  // portfolio_history (which is anchored to the $100k paper-account default
  // and shows nonsense numbers like $99,620 for our $100 working bankroll).
  const paperEquityCurve = useMemo(() => {
    const bankroll = data?.paperBankroll ?? 100
    if (!data?.dailyClosedPnl?.length) {
      // No closed trades yet — flat line at the bankroll for the last 30 days.
      const now = Math.floor(Date.now() / 1000)
      return {
        timestamps: [now - 30 * 86400, now],
        values:    [bankroll, bankroll],
      }
    }
    let cum = 0
    const timestamps: number[] = []
    const values: number[] = []
    // Anchor point: bankroll at the day before the first closed trade.
    const firstDay = new Date(data.dailyClosedPnl[0].date + 'T00:00:00Z').getTime() / 1000
    timestamps.push(Math.floor(firstDay - 86400))
    values.push(+bankroll.toFixed(2))
    for (const d of data.dailyClosedPnl) {
      cum += d.pnl
      const t = Math.floor(new Date(d.date + 'T00:00:00Z').getTime() / 1000)
      timestamps.push(t)
      values.push(+(bankroll + cum).toFixed(2))
    }
    // Trail with a "now" point so the line runs to the current moment.
    timestamps.push(Math.floor(Date.now() / 1000))
    values.push(+(bankroll + cum).toFixed(2))
    return { timestamps, values }
  }, [data?.dailyClosedPnl, data?.paperBankroll])

  const totalRealized = cumulativePnl.values.length ? cumulativePnl.values[cumulativePnl.values.length - 1] : 0
  const winRate = useMemo(() => {
    if (!data?.closedTrades.length) return null
    const wins = data.closedTrades.filter(t => parseFloat(t.pnl ?? '0') > 0).length
    return (wins / data.closedTrades.length) * 100
  }, [data?.closedTrades])

  return (
    <div className={`absolute inset-0 overflow-y-auto ${visible ? '' : 'invisible pointer-events-none'}`}>
      <div className="px-4 md:px-6 py-5 md:py-7 space-y-4">
        {loading && !data ? (
          <div className="flex items-center gap-2 py-12 justify-center">
            <div className="w-4 h-4 border-2 border-slate-700 border-t-emerald-500 rounded-full animate-spin" />
            <p className="text-xs font-mono text-slate-600">Loading trading data...</p>
          </div>
        ) : !data?.hasAlpaca ? (
          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-6 text-center">
            <p className="text-sm font-mono text-slate-500">No Alpaca key.</p>
            <p className="text-xs font-mono text-slate-700 mt-1">
              Add ALPACA_API_KEY + ALPACA_SECRET_KEY on Railway to connect your account.
            </p>
          </div>
        ) : (
          <>
            {/* Equity overview */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
              <div className="flex items-baseline justify-between mb-1">
                <p className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">Equity</p>
                <span className="text-[9px] font-mono text-slate-600 border border-slate-800 rounded px-1.5 py-0.5">
                  {process.env.ALPACA_PAPER !== 'false' ? 'PAPER' : 'LIVE'}
                </span>
              </div>
              <p className="text-4xl font-bold font-mono text-white tabular-nums">
                ${equity.toFixed(2)}
              </p>
              <p className={`text-xs font-mono mt-1 tabular-nums ${dayPl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {dayPl >= 0 ? '+' : ''}${dayPl.toFixed(2)} ({dayPl >= 0 ? '+' : ''}{dayPlPct.toFixed(2)}%) today
              </p>

              {data.account && (
                <div className="grid grid-cols-2 gap-3 mt-4 pt-3 border-t border-slate-800">
                  <div>
                    <p className="text-sm font-mono text-slate-300 tabular-nums">
                      ${paperBankroll.toFixed(2)}
                    </p>
                    <p className="text-[10px] font-mono text-slate-600">
                      {isPaper ? 'starting bankroll' : 'buying power'}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm font-mono text-slate-300 tabular-nums">
                      {isPaper
                        ? `${totalRealizedSoFar >= 0 ? '+' : ''}$${totalRealizedSoFar.toFixed(2)}`
                        : `$${parseFloat(data.account.cash).toFixed(2)}`}
                    </p>
                    <p className="text-[10px] font-mono text-slate-600">
                      {isPaper ? 'realized P&L' : 'cash'}
                    </p>
                  </div>
                </div>
              )}
              {isPaper && (
                <ResetPaperButton onDone={() => location.reload()} />
              )}
            </div>

            {/* Equity curve */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">Equity curve</p>
                <div className="flex gap-1">
                  {PERIODS.map(p => (
                    <button
                      key={p.key}
                      onClick={() => setPeriod(p.key)}
                      className={`text-[9px] font-mono px-1.5 py-0.5 rounded border ${
                        period === p.key
                          ? 'bg-emerald-950 text-emerald-400 border-emerald-800'
                          : 'text-slate-500 border-slate-800 active:bg-slate-800'
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
              <EquityChart
                timestamps={isPaper ? paperEquityCurve.timestamps : (data.portfolioHistory?.timestamp ?? [])}
                values={isPaper     ? paperEquityCurve.values     : (data.portfolioHistory?.equity    ?? [])}
                color={dayPl >= 0 ? '#10b981' : '#ef4444'}
              />
            </div>

            {/* Realized cumulative P&L */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4 space-y-2">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">Realized P&L (closed trades)</p>
                  <p className={`text-lg font-bold font-mono mt-0.5 tabular-nums ${totalRealized >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {totalRealized >= 0 ? '+' : ''}${totalRealized.toFixed(2)}
                  </p>
                </div>
                {winRate != null && (
                  <div className="text-right">
                    <p className="text-sm font-mono text-slate-300 tabular-nums">{winRate.toFixed(0)}%</p>
                    <p className="text-[10px] font-mono text-slate-600">win rate · {data.closedTrades.length} trades</p>
                  </div>
                )}
              </div>
              <EquityChart
                timestamps={cumulativePnl.timestamps}
                values={cumulativePnl.values}
                color={totalRealized >= 0 ? '#10b981' : '#ef4444'}
              />
            </div>

            {/* Open / Closed tabs */}
            <div className="rounded-2xl border border-slate-800 bg-slate-900 overflow-hidden">
              <div className="flex border-b border-slate-800">
                <button
                  onClick={() => setTab('open')}
                  className={`flex-1 py-2.5 text-[10px] font-mono uppercase tracking-widest ${
                    tab === 'open' ? 'text-emerald-400 border-b border-emerald-500' : 'text-slate-600 active:bg-slate-800'
                  }`}
                >
                  Open · {data.openPositions.length}
                </button>
                <button
                  onClick={() => setTab('closed')}
                  className={`flex-1 py-2.5 text-[10px] font-mono uppercase tracking-widest ${
                    tab === 'closed' ? 'text-emerald-400 border-b border-emerald-500' : 'text-slate-600 active:bg-slate-800'
                  }`}
                >
                  Closed · {data.closedTrades.length}
                </button>
              </div>

              {tab === 'open' ? (
                data.openPositions.length === 0 ? (
                  <p className="text-xs font-mono text-slate-600 text-center py-8">Flat.</p>
                ) : (
                  <div className="divide-y divide-slate-800">
                    {data.openPositions.map(p => <OpenPositionRow key={p.symbol} p={p} />)}
                  </div>
                )
              ) : (
                data.closedTrades.length === 0 ? (
                  <p className="text-xs font-mono text-slate-600 text-center py-8">No closed trades yet.</p>
                ) : (
                  <div className="divide-y divide-slate-800">
                    {data.closedTrades.map(t => <ClosedTradeRow key={t.id} t={t} />)}
                  </div>
                )
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function OpenPositionRow({ p }: { p: OpenPosition }) {
  const qty = parseFloat(p.qty)
  const entry = parseFloat(p.avg_entry_price)
  const now = parseFloat(p.current_price)
  const pl = parseFloat(p.unrealized_pl)
  const plPct = parseFloat(p.unrealized_plpc) * 100
  const pos = pl >= 0
  const target = p.target_price ? parseFloat(String(p.target_price)) : null
  const stop = p.stop_loss ? parseFloat(String(p.stop_loss)) : null

  // Simple horizontal bar: position of `now` between stop and target.
  let progress: number | null = null
  if (target !== null && stop !== null && target > stop) {
    progress = Math.min(100, Math.max(0, ((now - stop) / (target - stop)) * 100))
  }

  return (
    <div className="px-4 py-3">
      <div className="flex items-baseline justify-between">
        <div>
          <span className="text-sm font-mono text-slate-100 font-semibold">{p.symbol}</span>
          <span className="text-[10px] font-mono text-slate-600 ml-2">
            {qty.toFixed(4).replace(/\.?0+$/, '')} sh @ ${entry.toFixed(2)}
          </span>
        </div>
        <span className={`text-xs font-mono tabular-nums font-semibold ${pos ? 'text-emerald-400' : 'text-red-400'}`}>
          {pos ? '+' : ''}${pl.toFixed(2)} ({pos ? '+' : ''}{plPct.toFixed(1)}%)
        </span>
      </div>

      <div className="flex items-center justify-between mt-1 text-[10px] font-mono">
        <span className="text-slate-500 tabular-nums">now ${now.toFixed(2)}</span>
        {stop !== null && <span className="text-red-500 tabular-nums">stop ${stop.toFixed(2)}</span>}
        {target !== null && <span className="text-emerald-500 tabular-nums">target ${target.toFixed(2)}</span>}
      </div>

      {progress !== null && (
        <div className="relative h-1 rounded-full bg-slate-800 mt-1.5 overflow-hidden">
          <div className="absolute left-0 top-0 h-full bg-slate-700" style={{ width: '100%' }} />
          <div
            className={`absolute top-0 h-full ${pos ? 'bg-emerald-500' : 'bg-red-500'}`}
            style={{ left: `${Math.min(50, progress)}%`, width: `${Math.abs(progress - 50) * 2}%` }}
          />
          <div className="absolute top-0 h-full w-0.5 bg-slate-300" style={{ left: `${progress}%` }} />
        </div>
      )}
    </div>
  )
}

function ClosedTradeRow({ t }: { t: ClosedTrade }) {
  const pnl = parseFloat(t.pnl ?? '0')
  const entry = parseFloat(t.entry_price ?? '0')
  const pos = pnl >= 0
  const closedAt = t.closed_at ? new Date(t.closed_at) : null
  return (
    <div className="px-4 py-3 flex items-baseline justify-between">
      <div>
        <span className="text-sm font-mono text-slate-200 font-semibold">{t.symbol}</span>
        <span className="text-[10px] font-mono text-slate-600 ml-2">
          entry ${entry.toFixed(2)}
          {closedAt && ` · ${closedAt.toISOString().slice(0, 10)}`}
        </span>
      </div>
      <span className={`text-xs font-mono tabular-nums font-semibold ${pos ? 'text-emerald-400' : 'text-red-400'}`}>
        {pos ? '+' : ''}${pnl.toFixed(2)}
      </span>
    </div>
  )
}

// ─── Picks Tab (Ceelo's NFL handicapping) ─────────────────────────────────
//
// Ceelo posts picks; operator picks which to take and marks W/L. No
// auto-execution — bankroll is operator-driven. UI groups by status:
//   open    → Ceelo posted, awaiting operator decision (Take or Skip)
//   taken   → operator placed; awaiting settle (Won / Lost / Push / Void)
//   settled → won / lost / push / void with payout

type PickStatus = 'open' | 'skipped' | 'taken' | 'won' | 'lost' | 'push' | 'void'

interface PickRow {
  id: number
  game_label: string
  kickoff_at: number | null
  market: string
  side: string
  model_prob: number | null
  fair_line: string | null
  min_odds: number | null
  edge_pct: number | null
  model_spread: number | null
  book_spread: number | null
  book_name: string | null
  edge_points: number | null
  source: 'llm' | 'model'
  reasoning: string
  confidence: string
  status: PickStatus
  stake: number | null
  taken_odds: number | null
  payout: number | null
  taken_at: number | null
  settled_at: number | null
  created_ts: number
}

interface CeeloStatus {
  odds_key: boolean
  rated_teams: number
  upcoming_games: number
  model_lines: number
  last_run_ts: number | null
  last_schedule_ts: number | null
  last_grade_ts: number | null
  last_lines_ts: number | null
  cycle: number
}

interface SportRollup {
  sport: 'NFL' | 'NBA' | 'MLB'
  operator: {
    open: number; active: number
    wins: number; losses: number; pushes: number
    staked: number; pnl: number; roi: number
    win_pct: number | null
  }
  model: {
    wins: number; losses: number; pushes: number
    settled: number; pending: number
    accuracy: number | null
  }
}

interface PicksData {
  picks: PickRow[]
  summary: {
    open: number
    active: number
    record: { wins: number; losses: number; pushes: number }
    bankroll: { staked: number; returned: number; pnl: number; roi: number }
  }
  bySport: SportRollup[]
  status: CeeloStatus | null
}

function fmtAmericanOdds(o: number | null): string {
  if (o == null || !Number.isFinite(o)) return '—'
  return o > 0 ? `+${o}` : `${o}`
}

function fmtKickoff(ts: number | null): string {
  if (!ts) return 'TBD'
  const d = new Date(ts)
  const day = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `${day} · ${time}`
}

function PicksTab({ visible }: { visible: boolean }) {
  const [mode, setMode] = useState<'edges' | 'picks' | 'chat'>('edges')
  const [data, setData] = useState<PicksData | null>(null)
  const [openCount, setOpenCount] = useState(0)

  // Light poll on the data so the Picks pill can show an open-pick badge
  // even while the user is sitting elsewhere in the tab.
  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/picks')
      if (res.ok) {
        const d: PicksData = await res.json()
        setData(d)
        setOpenCount(d.summary?.open ?? 0)
      }
    } catch { /* ignore */ }
  }, [])
  useEffect(() => {
    if (!visible) return
    load()
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [visible, load])

  return (
    <div className={`absolute inset-0 flex flex-col ${visible ? '' : 'invisible pointer-events-none'}`}>
      <div className="shrink-0 flex border-b border-slate-800 bg-slate-950">
        <LibraryModePill
          active={mode === 'edges'}
          label="Edges"
          onClick={() => setMode('edges')}
        />
        <LibraryModePill
          active={mode === 'picks'}
          label="My Bets"
          badge={openCount > 0 ? openCount : undefined}
          onClick={() => setMode('picks')}
        />
        <LibraryModePill
          active={mode === 'chat'}
          label="Chat"
          onClick={() => setMode('chat')}
        />
      </div>

      <div className="flex-1 relative overflow-hidden">
        <EdgeBoard  visible={visible && mode === 'edges'} />
        <PicksView  visible={visible && mode === 'picks'} data={data} reload={load} />
        <CeeloChatView visible={visible && mode === 'chat'} />
      </div>
    </div>
  )
}

// ─── EdgeBoard — one row per game, traffic-light, Ceelo's predicted score ──
//
// Every upcoming game gets one card. Card shows Ceelo's predicted final
// scores + revised spread, the consensus book line across however many
// books posted, the open line, and a traffic light:
//   ● green  — |edge| > 1.5 pts (or > 0.75 runs MLB) → bet candidate
//   ● yellow — within 1.5      → Ceelo + book agree
//   ● grey   — no model or no books yet
// Operator can sort by time or by edge size, and filter to green-only.

type EdgeSport = 'NFL' | 'NBA' | 'MLB'

interface BookLine { book: string; home_line: number }

interface GameRow {
  game_id: number
  sport: EdgeSport
  home_team: string
  away_team: string
  home_record: string
  away_record: string
  kickoff_at: number
  books: BookLine[]
  consensus_home_spread: number | null
  best_home_spread: number | null
  worst_home_spread: number | null
  open_home_spread: number | null
  model_home_spread: number | null
  model_home_prob: number | null
  predicted_home_score: number | null
  predicted_away_score: number | null
  predicted_total: number | null
  edge_points: number | null
  edge_side: 'home' | 'away' | null
  edge_team: string | null
  light: 'green' | 'yellow' | 'grey'
  public_bets_pct: number | null
  public_money_pct: number | null
  public_side: 'home' | 'away' | null
}

interface EdgeFeed {
  games: GameRow[]
  byDate: Array<{ date: string; items: GameRow[] }>
  meta: {
    sport: EdgeSport
    threshold: number
    total_games: number
    green_count: number
    yellow_count: number
    avg_total: number
    sort: string
    filter: string
  } | null
}

function EdgeBoard({ visible }: { visible: boolean }) {
  const [sport, setSport] = useState<EdgeSport>('NFL')
  const [sortBy, setSortBy] = useState<'time' | 'edge'>('time')
  const [greenOnly, setGreenOnly] = useState(false)
  const [feed, setFeed] = useState<EdgeFeed | null>(null)
  const [loading, setLoading] = useState(false)
  const [seeded, setSeeded] = useState<Record<string, number>>({})
  const [seeding, setSeeding] = useState(false)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const filter = greenOnly ? 'green' : 'all'
      const [edgesRes, seedRes] = await Promise.all([
        fetch(`/api/picks/edges?sport=${sport}&days=7&sort=${sortBy}&filter=${filter}`),
        fetch('/api/ceelo/seed-prev'),
      ])
      if (edgesRes.ok) setFeed(await edgesRes.json())
      if (seedRes.ok) {
        const body = await seedRes.json()
        const map: Record<string, number> = {}
        for (const s of body.sports ?? []) map[s.sport] = s.rated_teams
        setSeeded(map)
      }
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [sport, sortBy, greenOnly])

  useEffect(() => {
    if (!visible) return
    reload()
    const id = setInterval(reload, 30_000)
    return () => clearInterval(id)
  }, [visible, reload])

  const seedThisSport = async () => {
    if (seeding) return
    if (!confirm(`Seed Ceelo's ${sport} ratings from the most recent completed season?`)) return
    setSeeding(true)
    try {
      const res = await fetch(`/api/ceelo/seed-prev?sport=${sport}`, { method: 'POST' })
      if (res.ok) await reload()
      else alert(`Seed failed (${res.status}).`)
    } catch { alert('Seed failed (network).') }
    finally { setSeeding(false) }
  }

  const ratedCount = seeded[sport] ?? 0
  const expectedTeams = sport === 'NFL' ? 32 : 30

  return (
    <div className={`absolute inset-0 overflow-y-auto ${visible ? '' : 'invisible pointer-events-none'}`}>
      <div className="px-4 py-4 space-y-3">
        {/* Sport selector */}
        <div className="flex gap-2">
          {(['NFL', 'NBA', 'MLB'] as EdgeSport[]).map(s => (
            <button
              key={s}
              onClick={() => setSport(s)}
              className={`flex-1 text-[11px] font-mono py-2 rounded-lg border tracking-widest transition-colors ${
                sport === s
                  ? 'bg-rose-950/40 border-rose-800 text-rose-300'
                  : 'border-slate-800 text-slate-500 active:bg-slate-900'
              }`}
            >
              {s}
            </button>
          ))}
        </div>

        {/* Sort + filter controls */}
        <div className="flex gap-2">
          <SegmentedToggle
            value={sortBy}
            onChange={(v) => setSortBy(v as 'time' | 'edge')}
            options={[{ key: 'time', label: 'TIME' }, { key: 'edge', label: 'EDGE' }]}
            className="flex-1"
          />
          <button
            onClick={() => setGreenOnly(!greenOnly)}
            className={`text-[10px] font-mono px-3 py-1.5 rounded-lg border tracking-widest ${
              greenOnly
                ? 'bg-emerald-950/40 border-emerald-800 text-emerald-300'
                : 'border-slate-800 text-slate-500 active:bg-slate-900'
            }`}
          >
            ● GREEN ONLY
          </button>
        </div>

        {/* Meta caption */}
        {feed?.meta && (
          <p className="text-[10px] font-mono text-slate-500">
            {sport} &middot; {feed.meta.green_count} green &middot; {feed.meta.yellow_count} yellow
            {' '}&middot; pred. total ~{feed.meta.avg_total} &middot; {ratedCount}/{expectedTeams} teams rated
          </p>
        )}

        {/* Cold-start nudge */}
        {ratedCount < expectedTeams * 0.5 && sport !== 'NFL' && (
          <button
            onClick={seedThisSport}
            disabled={seeding}
            className="w-full text-[10px] font-mono text-rose-300 border border-rose-900 bg-rose-950/30 rounded-lg py-2 active:opacity-70 disabled:opacity-50"
          >
            {seeding ? `Seeding ${sport}…` : `Seed ${sport} ratings (last completed season)`}
          </button>
        )}

        {/* Body */}
        {loading && !feed ? (
          <div className="flex items-center gap-2 py-10 justify-center">
            <div className="w-4 h-4 border-2 border-slate-700 border-t-rose-500 rounded-full animate-spin" />
            <p className="text-xs font-mono text-slate-600">Loading games…</p>
          </div>
        ) : !feed?.byDate || feed.byDate.length === 0 ? (
          <EmptyState
            title={greenOnly ? 'No green games right now.' : 'No upcoming games yet.'}
            subtitle={
              greenOnly
                ? `Try toggling green-only off to see all ${sport} matchups + Ceelo's reads on each.`
                : `Schedule + lines populate as the loop fetches them. Live book lines need ODDS_API_KEY.`
            }
          />
        ) : (
          feed.byDate.map(g => (
            <div key={g.date} className="space-y-2">
              <p className="text-[10px] font-mono text-slate-500 tracking-widest pt-2">
                {fmtDateHeader(g.date)} &middot; {g.items.length}
              </p>
              {g.items.map(row => <GameCard key={row.game_id} row={row} />)}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function GameCard({ row }: { row: GameRow }) {
  const time = new Date(row.kickoff_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  const lightColor = row.light === 'green' ? 'bg-emerald-400'
                   : row.light === 'yellow' ? 'bg-amber-400'
                   : 'bg-slate-700'
  const lightBorder = row.light === 'green' ? 'border-emerald-900/60'
                    : row.light === 'yellow' ? 'border-amber-900/40'
                    : 'border-slate-800'

  // Ceelo's revised spread + favored team
  const modelSpread = row.model_home_spread
  const modelFav   = modelSpread != null && modelSpread !== 0
    ? (modelSpread < 0 ? row.home_team : row.away_team)
    : null
  const modelMargin = modelSpread != null ? Math.abs(modelSpread) : null

  // Consensus book line (home spread)
  const cons = row.consensus_home_spread
  const homeIsFavored = cons != null && cons < 0
  const bookFav = cons != null ? (homeIsFavored ? row.home_team : row.away_team) : null
  const bookSpreadMag = cons != null ? Math.abs(cons) : null

  // Edge framing
  const edge = row.edge_points
  const edgeMag = edge != null ? Math.abs(edge).toFixed(1) : null

  return (
    <div className={`rounded-xl border ${lightBorder} bg-slate-950/40 overflow-hidden`}>
      {/* Header — traffic light, matchup, kickoff */}
      <div className="px-3 pt-3 pb-2 flex items-start gap-2">
        <span className={`w-2.5 h-2.5 rounded-full mt-1.5 shrink-0 ${lightColor}`} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5 text-[12px] font-mono text-slate-100 font-semibold tabular-nums flex-wrap">
            <span>{row.away_team}</span>
            <span className="text-[9px] font-mono text-slate-600">{row.away_record}</span>
            <span className="text-slate-600 mx-1">@</span>
            <span>{row.home_team}</span>
            <span className="text-[9px] font-mono text-slate-600">{row.home_record}</span>
          </div>
          <p className="text-[9px] font-mono text-slate-600 mt-0.5">
            {time}
            {row.books.length > 0 && <> &middot; {row.books.length} book{row.books.length === 1 ? '' : 's'}</>}
          </p>
        </div>
      </div>

      {/* Body — Ceelo's read + book consensus + edge */}
      <div className="px-3 pb-3 pt-1 border-t border-slate-800/60 space-y-2">
        {/* Ceelo's prediction line */}
        {row.predicted_home_score != null && row.predicted_away_score != null ? (
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-[8px] font-mono text-slate-600 tracking-widest w-12 shrink-0">CEELO</span>
            <span className="text-[13px] font-mono font-semibold text-rose-300 tabular-nums">
              {row.away_team} {row.predicted_away_score} &mdash; {row.home_team} {row.predicted_home_score}
            </span>
            {modelFav && modelMargin != null && (
              <span className="text-[10px] font-mono text-slate-400">
                ({modelFav} by {modelMargin.toFixed(1)})
              </span>
            )}
          </div>
        ) : (
          <div className="flex items-baseline gap-2">
            <span className="text-[8px] font-mono text-slate-600 tracking-widest w-12 shrink-0">CEELO</span>
            <span className="text-[10px] font-mono text-slate-600">model not computed yet</span>
          </div>
        )}

        {/* Book consensus line */}
        {cons != null && bookFav && bookSpreadMag != null ? (
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-[8px] font-mono text-slate-600 tracking-widest w-12 shrink-0">BOOK</span>
            <span className="text-[12px] font-mono text-slate-200 tabular-nums">
              {bookFav} {bookSpreadMag === 0 ? 'PK' : `-${bookSpreadMag.toFixed(1)}`}
            </span>
            <span className="text-[9px] font-mono text-slate-600">
              consensus
              {row.open_home_spread != null && (() => {
                const openFav = row.open_home_spread < 0 ? row.home_team : row.away_team
                const openMag = Math.abs(row.open_home_spread)
                const moved = row.open_home_spread !== cons
                return (
                  <> · open {openFav} -{openMag.toFixed(1)}{moved ? ' (moved)' : ''}</>
                )
              })()}
            </span>
          </div>
        ) : (
          <div className="flex items-baseline gap-2">
            <span className="text-[8px] font-mono text-slate-600 tracking-widest w-12 shrink-0">BOOK</span>
            <span className="text-[10px] font-mono text-slate-600">no live lines (Odds API silent)</span>
          </div>
        )}

        {/* Edge line + take */}
        {edge != null && row.edge_team && edgeMag != null && (
          <div className="flex items-baseline gap-2 pt-1 border-t border-slate-900/60">
            <span className="text-[8px] font-mono text-slate-600 tracking-widest w-12 shrink-0">EDGE</span>
            <span className={`text-[12px] font-mono font-semibold tabular-nums ${row.light === 'green' ? 'text-emerald-300' : 'text-amber-300'}`}>
              {edge >= 0 ? '+' : '−'}{edgeMag} pt
            </span>
            <span className="text-[10px] font-mono text-slate-400">
              {row.light === 'green'
                ? <>take <span className="text-emerald-300">{row.edge_team}</span></>
                : <>{row.edge_team} edge — within tolerance, agree with book</>}
            </span>
          </div>
        )}

        {/* Public — only when we have data */}
        {row.public_bets_pct != null && row.public_side && (
          <p className="text-[9px] font-mono text-slate-600 pt-1 border-t border-slate-900/60">
            Public: {row.public_bets_pct.toFixed(0)}% bets
            {row.public_money_pct != null && <> &middot; {row.public_money_pct.toFixed(0)}% money</>}
            {' '}on{' '}
            {row.public_side === 'home' ? row.home_team : row.away_team}
          </p>
        )}
      </div>
    </div>
  )
}

// Reusable two-segment toggle (used by the sort selector).
function SegmentedToggle({ value, onChange, options, className }: {
  value: string
  onChange: (v: string) => void
  options: Array<{ key: string; label: string }>
  className?: string
}) {
  return (
    <div className={`flex border border-slate-800 rounded-lg overflow-hidden ${className ?? ''}`}>
      {options.map(o => (
        <button
          key={o.key}
          onClick={() => onChange(o.key)}
          className={`flex-1 text-[10px] font-mono py-1.5 tracking-widest transition-colors ${
            value === o.key
              ? 'bg-rose-950/40 text-rose-300'
              : 'text-slate-500 active:bg-slate-900'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function fmtDateHeader(yyyymmdd: string): string {
  const d = new Date(yyyymmdd + 'T12:00:00')
  const today = new Date()
  const diffDays = Math.floor((d.getTime() - today.getTime()) / 86_400_000)
  if (diffDays === 0) return 'TODAY'
  if (diffDays === 1) return 'TOMORROW'
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase()
}

function PicksView({ visible, data, reload }: {
  visible: boolean
  data: PicksData | null
  reload: () => Promise<void>
}) {
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const post = useCallback(async (body: object) => {
    await fetch('/api/picks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    await reload()
  }, [reload])

  const open    = useMemo(() => (data?.picks ?? []).filter(p => p.status === 'open'), [data])
  const taken   = useMemo(() => (data?.picks ?? []).filter(p => p.status === 'taken'), [data])
  const settled = useMemo(() => (data?.picks ?? []).filter(p => ['won','lost','push','void'].includes(p.status)), [data])
  const skipped = useMemo(() => (data?.picks ?? []).filter(p => p.status === 'skipped'), [data])

  return (
    <div className={`absolute inset-0 overflow-y-auto ${visible ? '' : 'invisible pointer-events-none'}`}>
      <div className="px-4 md:px-6 py-5 md:py-7 space-y-4">
        <div className="flex items-center gap-2">
          <span className="text-rose-400"><IconPicks /></span>
          <div>
            <p className="text-xs font-mono text-slate-300 font-semibold">
              Ceelo &mdash; Multi-Sport Handicapper
            </p>
            <p className="text-[10px] font-mono text-slate-600">
              NFL · NBA · MLB. Math-driven picks. You decide what to take.
            </p>
          </div>
        </div>

        {data && <BankrollCard summary={data.summary} />}
        {data?.bySport && data.bySport.length > 0 && <SportBreakdown rollups={data.bySport} />}
        {data?.status && <CeeloStatusCard status={data.status} />}
        {data?.picks && data.picks.length > 0 && <EdgeGraph picks={open.concat(taken)} />}

        {!data ? (
          <div className="flex items-center gap-2 py-10 justify-center">
            <div className="w-4 h-4 border-2 border-slate-700 border-t-rose-500 rounded-full animate-spin" />
            <p className="text-xs font-mono text-slate-600">Loading picks&hellip;</p>
          </div>
        ) : (
          <>
            <PickSection
              label="Open"
              hint="Ceelo's flagged edges. Take or skip."
              picks={open}
              expandedId={expandedId}
              onToggle={(id) => setExpandedId(expandedId === id ? null : id)}
              onAction={(action, id, payload) => post({ action, id, ...(payload ?? {}) })}
            />
            <PickSection
              label="Active"
              hint="You took these. Mark when settled."
              picks={taken}
              expandedId={expandedId}
              onToggle={(id) => setExpandedId(expandedId === id ? null : id)}
              onAction={(action, id, payload) => post({ action, id, ...(payload ?? {}) })}
            />
            <PickSection
              label="Settled"
              hint="History."
              picks={settled}
              expandedId={expandedId}
              onToggle={(id) => setExpandedId(expandedId === id ? null : id)}
              onAction={(action, id, payload) => post({ action, id, ...(payload ?? {}) })}
            />
            {skipped.length > 0 && (
              <PickSection
                label="Skipped"
                hint="Hidden. Tap to expand any to reopen."
                picks={skipped}
                expandedId={expandedId}
                onToggle={(id) => setExpandedId(expandedId === id ? null : id)}
                onAction={(action, id, payload) => post({ action, id, ...(payload ?? {}) })}
                collapsible
              />
            )}
            {open.length === 0 && taken.length === 0 && settled.length === 0 && skipped.length === 0 && (
              <EmptyState
                title="No picks yet."
                subtitle="Ceelo runs every 30 min. Picks land here once the model finds an edge ≥ 1.0 pt."
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}

// ─── Ceelo one-on-one chat (operator ↔ Ceelo, thread='ceelo') ─────────────
//
// Ceelo's reply lands ~30s after send (the Ceelo loop runs every tick and
// handles chat ungated by the cycle interval). Polls /api/ceelo/chat.

interface CeeloMsg { id: number; sender: 'user' | 'ceelo'; content: string; ts?: number }

function CeeloChatView({ visible }: { visible: boolean }) {
  const [messages, setMessages] = useState<CeeloMsg[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [nearBottom, setNearBottom] = useState(true)
  const lastId = useRef(0)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    bottomRef.current?.scrollIntoView({ behavior })
  }, [])

  useEffect(() => {
    if (nearBottom) scrollToBottom('smooth')
  }, [messages, nearBottom, scrollToBottom])

  const onScroll = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight
    setNearBottom(dist < 60)
  }, [])

  useEffect(() => {
    if (!visible) return
    const poll = async () => {
      try {
        const res = await fetch(`/api/ceelo/chat?after=${lastId.current}`)
        if (!res.ok) return
        const { messages: incoming } = await res.json()
        if (incoming.length > 0) {
          setMessages(prev => [...prev, ...incoming])
          lastId.current = incoming[incoming.length - 1].id
        }
      } catch { /* network hiccup */ }
    }
    poll()
    const id = setInterval(poll, 5000)
    return () => clearInterval(id)
  }, [visible])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || sending) return
    setInput('')
    setSending(true)
    try {
      const res = await fetch('/api/ceelo/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text }),
      })
      if (!res.ok) throw new Error()
      const { id, timestamp } = await res.json()
      setMessages(prev => [...prev, { id, sender: 'user', content: text, ts: timestamp }])
      if (id > lastId.current) lastId.current = id
    } catch {
      setMessages(prev => [...prev, { id: -Date.now(), sender: 'ceelo', content: 'Send failed. Try again.' }])
    } finally {
      setSending(false)
    }
  }, [input, sending])

  return (
    <div className={`absolute inset-0 flex flex-col ${visible ? '' : 'invisible pointer-events-none'}`}>
      {/* Header bubble */}
      <div className="shrink-0 px-4 pt-3 pb-2 flex items-center gap-3 border-b border-slate-800/60">
        <span className="w-6 h-6 rounded-full bg-rose-950 border border-rose-800 flex items-center justify-center text-[10px] font-mono text-rose-400 font-semibold">C</span>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-mono text-slate-200 font-semibold">Ceelo</p>
          <p className="text-[9px] font-mono text-slate-600">NFL handicapper · grounded in his model</p>
        </div>
      </div>

      <div ref={scrollerRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {messages.length === 0 && (
          <EmptyState
            title="Open."
            subtitle="Ask him about ratings, current edges, or his read on a specific matchup."
          />
        )}
        {messages.map(m => (
          <CeeloChatBubble key={m.id} msg={m} />
        ))}
        <div ref={bottomRef} />
      </div>

      <div className="shrink-0 border-t border-slate-800 px-3 py-2 bg-slate-950 flex items-end gap-2"
           style={{ paddingBottom: 'calc(0.5rem + env(safe-area-inset-bottom))' }}>
        <textarea
          rows={1}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
          placeholder="Ask Ceelo…"
          className="flex-1 resize-none bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-rose-700 max-h-32"
        />
        <button
          onClick={send}
          disabled={!input.trim() || sending}
          className="text-[10px] font-mono text-rose-300 border border-rose-800 bg-rose-950/40 rounded-xl px-3 py-2 active:opacity-70 disabled:opacity-40"
        >
          {sending ? '…' : 'Send'}
        </button>
      </div>
    </div>
  )
}

function CeeloChatBubble({ msg }: { msg: CeeloMsg }) {
  if (msg.sender === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-emerald-950/40 text-emerald-100 border border-emerald-900/60 px-3 py-2 text-xs font-mono whitespace-pre-wrap break-words">
          {msg.content}
        </div>
      </div>
    )
  }
  return (
    <div className="flex items-start gap-2">
      <span className="w-6 h-6 rounded-full bg-rose-950 border border-rose-800 flex items-center justify-center text-[10px] font-mono text-rose-400 font-semibold shrink-0 mt-0.5">C</span>
      <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-slate-900 border border-slate-800 text-slate-200 px-3 py-2 text-xs font-mono whitespace-pre-wrap break-words">
        {msg.content}
      </div>
    </div>
  )
}

function BankrollCard({ summary }: { summary: PicksData['summary'] }) {
  const { record, bankroll, open, active } = summary
  const total = record.wins + record.losses
  const winPct = total > 0 ? Math.round((record.wins / total) * 100) : null
  const pnlColor = bankroll.pnl > 0 ? 'text-emerald-400'
                 : bankroll.pnl < 0 ? 'text-red-400'
                 : 'text-slate-400'
  return (
    <div className="border border-slate-800 rounded-xl bg-slate-900 p-3 space-y-3">
      <div className="grid grid-cols-3 gap-2">
        <Stat label="P&amp;L" value={`${bankroll.pnl >= 0 ? '+' : ''}$${bankroll.pnl.toFixed(2)}`} valueClass={pnlColor} />
        <Stat label="ROI"  value={`${bankroll.roi >= 0 ? '+' : ''}${bankroll.roi.toFixed(1)}%`} valueClass={pnlColor} />
        <Stat label="Record" value={`${record.wins}-${record.losses}${record.pushes > 0 ? `-${record.pushes}` : ''}`} />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Win%"   value={winPct != null ? `${winPct}%` : '—'} />
        <Stat label="Staked" value={`$${bankroll.staked.toFixed(2)}`} />
        <Stat label="Open / Active" value={`${open} / ${active}`} />
      </div>
    </div>
  )
}

// Per-sport rollup card. Three columns (NFL / NBA / MLB), each showing
// operator's real-bet record + Ceelo's auto-graded model accuracy. Lets
// the operator answer "is Ceelo better at NFL or NBA right now?" at a
// glance.

interface BacktestRow {
  sport: 'NFL' | 'NBA' | 'MLB'
  total_games: number
  ats_wins: number | null
  ats_losses: number | null
  ats_pushes: number | null
  ats_accuracy: number | null
  edge_wins: number | null
  edge_losses: number | null
  edge_accuracy: number | null
  edge_threshold: number | null
  margin_mae: number | null
  season_range: string | null
  notes: string | null
  ran_ts: number
}

function SportBreakdown({ rollups }: { rollups: SportRollup[] }) {
  // Render fixed NFL/NBA/MLB order even if the API returns them differently.
  const order: Array<'NFL' | 'NBA' | 'MLB'> = ['NFL', 'NBA', 'MLB']
  const map = new Map(rollups.map(r => [r.sport, r]))
  const SPORT_COLOR: Record<string, string> = {
    NFL: 'text-amber-300',
    NBA: 'text-blue-300',
    MLB: 'text-emerald-300',
  }

  // Latest backtest result per sport. Loaded once + on demand.
  const [backtests, setBacktests] = useState<Map<string, BacktestRow>>(new Map())
  const [running, setRunning] = useState(false)

  const loadBacktests = useCallback(async () => {
    try {
      const res = await fetch('/api/ceelo/backtest')
      if (!res.ok) return
      const body = await res.json()
      const m = new Map<string, BacktestRow>()
      for (const r of body.results ?? []) m.set(r.sport, r as BacktestRow)
      setBacktests(m)
    } catch { /* ignore */ }
  }, [])
  useEffect(() => { loadBacktests() }, [loadBacktests])

  const runBacktest = async () => {
    if (running) return
    if (!confirm('Run Ceelo backtest across NFL + NBA + MLB?\n\nWalks every completed game in chronological order, computing his model line BEFORE each result and grading against the actual outcome. ~30s for the full set.')) return
    setRunning(true)
    try {
      const res = await fetch('/api/ceelo/backtest?sport=ALL', { method: 'POST' })
      if (res.ok) await loadBacktests()
      else alert(`Backtest failed (${res.status}).`)
    } catch { alert('Backtest failed (network).') }
    finally { setRunning(false) }
  }

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/60 overflow-hidden">
      <div className="px-3 py-2 border-b border-slate-800 flex items-baseline justify-between">
        <p className="text-[10px] font-mono text-slate-400 tracking-widest font-semibold">BY SPORT</p>
        <p className="text-[9px] font-mono text-slate-600">operator vs model accuracy</p>
      </div>
      <div className="grid grid-cols-3 divide-x divide-slate-800">
        {order.map(sport => {
          const r = map.get(sport)
          const color = SPORT_COLOR[sport] ?? 'text-slate-300'
          if (!r) return (
            <div key={sport} className="p-3 text-center">
              <p className={`text-[11px] font-mono font-semibold tracking-wider ${color}`}>{sport}</p>
              <p className="text-[9px] font-mono text-slate-700 mt-2">no data</p>
            </div>
          )
          const op = r.operator
          const m = r.model
          const opTotal = op.wins + op.losses
          const opPnl = op.pnl
          const pnlColor = opPnl > 0 ? 'text-emerald-300' : opPnl < 0 ? 'text-red-300' : 'text-slate-400'
          const accColor = m.accuracy != null
            ? (m.accuracy >= 55 ? 'text-emerald-300' : m.accuracy >= 50 ? 'text-amber-300' : 'text-red-300')
            : 'text-slate-500'
          return (
            <div key={sport} className="p-3 space-y-2">
              <p className={`text-[11px] font-mono font-semibold tracking-wider text-center ${color}`}>{sport}</p>

              {/* Operator stats */}
              <div className="text-center pt-1 border-t border-slate-800/60">
                <p className="text-[8px] font-mono text-slate-600 tracking-widest">YOU</p>
                <p className={`text-[11px] font-mono font-semibold tabular-nums ${pnlColor}`}>
                  {opPnl >= 0 ? '+' : ''}${opPnl.toFixed(2)}
                </p>
                <p className="text-[8px] font-mono text-slate-700 tabular-nums">
                  {opTotal > 0 ? `${op.wins}-${op.losses}${op.pushes ? `-${op.pushes}` : ''}` : 'no bets yet'}
                  {op.win_pct != null && ` · ${op.win_pct.toFixed(0)}%`}
                </p>
              </div>

              {/* Model stats — auto-graded ATS accuracy */}
              <div className="text-center pt-1 border-t border-slate-800/60">
                <p className="text-[8px] font-mono text-slate-600 tracking-widest">CEELO</p>
                <p className={`text-[11px] font-mono font-semibold tabular-nums ${accColor}`}>
                  {m.accuracy != null ? `${m.accuracy.toFixed(0)}%` : '—'}
                </p>
                <p className="text-[8px] font-mono text-slate-700 tabular-nums">
                  {m.settled > 0
                    ? `${m.wins}-${m.losses}${m.pushes ? `-${m.pushes}` : ''}`
                    : (m.pending > 0 ? `${m.pending} pending` : 'no flags yet')}
                </p>
              </div>

              {/* Backtest stats — historical ATS on completed seasons */}
              {(() => {
                const bt = backtests.get(sport)
                if (!bt) return null
                const accVal = bt.edge_accuracy ?? bt.ats_accuracy
                const accColor = accVal != null
                  ? (accVal >= 55 ? 'text-emerald-300' : accVal >= 50 ? 'text-amber-300' : 'text-red-300')
                  : 'text-slate-500'
                const wins   = bt.edge_wins   ?? bt.ats_wins   ?? 0
                const losses = bt.edge_losses ?? bt.ats_losses ?? 0
                const total  = wins + losses
                return (
                  <div className="text-center pt-1 border-t border-slate-800/60">
                    <p className="text-[8px] font-mono text-slate-600 tracking-widest">BACKTEST</p>
                    <p className={`text-[11px] font-mono font-semibold tabular-nums ${accColor}`}>
                      {accVal != null ? `${accVal.toFixed(0)}%` : (bt.margin_mae != null ? `${bt.margin_mae.toFixed(1)} MAE` : '—')}
                    </p>
                    <p className="text-[8px] font-mono text-slate-700 tabular-nums">
                      {total > 0 ? `${wins}-${losses}` : `${bt.total_games} games`}
                      {bt.season_range && bt.season_range !== 'none' ? ` · ${bt.season_range}` : ''}
                    </p>
                  </div>
                )
              })()}
            </div>
          )
        })}
      </div>
      <div className="px-3 py-2 border-t border-slate-800 flex items-center gap-2">
        <button
          onClick={runBacktest}
          disabled={running}
          className="flex-1 text-[10px] font-mono text-slate-400 border border-slate-800 rounded-lg py-1.5 active:bg-slate-900 disabled:opacity-50 tracking-wider"
        >
          {running ? 'BACKTESTING…' : backtests.size > 0 ? 'RE-RUN BACKTEST' : 'RUN BACKTEST'}
        </button>
        <p className="text-[9px] font-mono text-slate-700">
          {backtests.size > 0 ? 'historical ATS via shadow-Elo replay' : 'verify Ceelo on prior season'}
        </p>
      </div>
    </div>
  )
}

// Snapshot of Ceelo's autonomy loop: ratings depth, schedule depth, model
// freshness, and whether the live-line gate is armed (needs ODDS_API_KEY).
function CeeloStatusCard({ status }: { status: CeeloStatus }) {
  const oddsLabel  = status.odds_key ? 'ARMED' : 'WAITING'
  const oddsClass  = status.odds_key
    ? 'bg-emerald-950 text-emerald-300 border-emerald-900'
    : 'bg-amber-950 text-amber-300 border-amber-900'
  const lastRun = status.last_run_ts ? fmtAge(status.last_run_ts) : 'never'
  const lastSched = status.last_schedule_ts ? fmtAge(status.last_schedule_ts) : '—'
  const lastGrade = status.last_grade_ts ? fmtAge(status.last_grade_ts) : '—'
  const lastLines = status.last_lines_ts ? fmtAge(status.last_lines_ts) : (status.odds_key ? '—' : 'no key')

  return (
    <div className="border border-slate-800 rounded-xl bg-slate-900/60 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-[10px] font-mono text-slate-400 tracking-widest font-semibold">
          CEELO &middot; CYCLE {status.cycle}
        </p>
        <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border ${oddsClass}`}>
          GATE {oddsLabel}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Rated teams" value={`${status.rated_teams}/32`} />
        <Stat label="Upcoming"    value={String(status.upcoming_games)} />
        <Stat label="Model lines" value={String(status.model_lines)} />
      </div>
      <div className="grid grid-cols-2 gap-2 pt-1 border-t border-slate-800">
        <div className="text-center">
          <p className="text-[10px] font-mono text-slate-400 tabular-nums">{lastRun}</p>
          <p className="text-[8px] font-mono text-slate-600 tracking-wider mt-0.5">LAST CYCLE</p>
        </div>
        <div className="text-center">
          <p className="text-[10px] font-mono text-slate-400 tabular-nums">{lastSched}</p>
          <p className="text-[8px] font-mono text-slate-600 tracking-wider mt-0.5">SCHEDULE</p>
        </div>
        <div className="text-center">
          <p className="text-[10px] font-mono text-slate-400 tabular-nums">{lastGrade}</p>
          <p className="text-[8px] font-mono text-slate-600 tracking-wider mt-0.5">LAST GRADE</p>
        </div>
        <div className="text-center">
          <p className="text-[10px] font-mono text-slate-400 tabular-nums">{lastLines}</p>
          <p className="text-[8px] font-mono text-slate-600 tracking-wider mt-0.5">BOOK LINES</p>
        </div>
      </div>
      {status.rated_teams < 16 && (
        <SeedRatingsButton onDone={() => location.reload()} />
      )}
      {!status.odds_key && (
        <p className="text-[9px] font-mono text-amber-400/80 leading-snug pt-1 border-t border-slate-800">
          Add ODDS_API_KEY (free at theoddsapi.com) to engage the edge gate. Until then, model lines are computed but no picks fire.
        </p>
      )}
    </div>
  )
}

// One-shot seed of Ceelo's Elo ratings from the last 3 NFL seasons of
// nflverse historical data. Operator hits this once after deploy so the
// model isn't sitting at 1500-across-the-board (cold start).
function SeedRatingsButton({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const click = async () => {
    if (busy) return
    if (!confirm('Seed Ceelo\'s ratings from the last 3 completed NFL seasons (nflverse data)?\n\nThis Elo-walks ~800 historical games. ~30s.')) return
    setBusy(true)
    try {
      const res = await fetch('/api/ceelo/seed?seasons=3', { method: 'POST' })
      if (res.ok) {
        const body = await res.json()
        setDone(`Seeded ${body.games_graded ?? 0} games across seasons ${(body.seasons_walked ?? []).join(', ')}.`)
        setTimeout(onDone, 2000)
      } else {
        setDone(`Seed failed (${res.status}).`)
      }
    } catch {
      setDone('Seed failed (network).')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="pt-1 border-t border-slate-800">
      <button
        onClick={click}
        disabled={busy}
        className="w-full text-[10px] font-mono text-rose-300 border border-rose-900 bg-rose-950/30 rounded-lg py-2 active:opacity-70 disabled:opacity-50"
      >
        {busy ? 'Seeding ratings…' : 'Seed ratings (last 3 NFL seasons)'}
      </button>
      {done && <p className="text-[9px] font-mono text-slate-500 mt-1.5 text-center">{done}</p>}
    </div>
  )
}

function Stat({ label, value, valueClass = 'text-slate-200' }: {
  label: string; value: string; valueClass?: string
}) {
  return (
    <div className="text-center">
      <p className={`text-sm font-mono font-semibold tabular-nums ${valueClass}`}>{value}</p>
      <p className="text-[9px] font-mono text-slate-600 tracking-wider mt-0.5">{label}</p>
    </div>
  )
}

type PickAction = 'take' | 'skip' | 'settle' | 'reopen' | 'delete'
type PickActionPayload = { stake?: number; taken_odds?: number; result?: 'won' | 'lost' | 'push' | 'void' }

function PickSection({ label, hint, picks, expandedId, onToggle, onAction, collapsible }: {
  label: string
  hint: string
  picks: PickRow[]
  expandedId: number | null
  onToggle: (id: number) => void
  onAction: (action: PickAction, id: number, payload?: PickActionPayload) => void
  collapsible?: boolean
}) {
  const [open, setOpen] = useState(!collapsible)
  if (picks.length === 0) return null
  return (
    <div className="space-y-2">
      <button
        className="flex items-baseline justify-between w-full"
        onClick={() => collapsible && setOpen(!open)}
      >
        <p className="text-[10px] font-mono text-slate-400 tracking-widest font-semibold">
          {label.toUpperCase()} · {picks.length}
        </p>
        <p className="text-[9px] font-mono text-slate-600">
          {collapsible ? (open ? '▾ hide' : '▸ show') : hint}
        </p>
      </button>
      {open && (
        <div className="space-y-2">
          {picks.map(p => (
            <PickCard
              key={p.id}
              pick={p}
              expanded={expandedId === p.id}
              onToggle={() => onToggle(p.id)}
              onAction={onAction}
            />
          ))}
        </div>
      )}
    </div>
  )
}

const CONF_STYLE: Record<string, string> = {
  high:   'bg-emerald-950 text-emerald-300 border-emerald-900',
  medium: 'bg-amber-950 text-amber-300 border-amber-900',
  low:    'bg-slate-800 text-slate-400 border-slate-700',
}

function PickCard({ pick, expanded, onToggle, onAction }: {
  pick: PickRow
  expanded: boolean
  onToggle: () => void
  onAction: (action: PickAction, id: number, payload?: PickActionPayload) => void
}) {
  const isOpen    = pick.status === 'open'
  const isTaken   = pick.status === 'taken'
  const isSettled = ['won','lost','push','void'].includes(pick.status)
  const isSkipped = pick.status === 'skipped'

  const statusBadge =
      pick.status === 'won'  ? <span className="text-[9px] font-mono px-1.5 py-0.5 rounded border bg-emerald-950 text-emerald-300 border-emerald-900">WON</span>
    : pick.status === 'lost' ? <span className="text-[9px] font-mono px-1.5 py-0.5 rounded border bg-red-950 text-red-300 border-red-900">LOST</span>
    : pick.status === 'push' ? <span className="text-[9px] font-mono px-1.5 py-0.5 rounded border bg-slate-800 text-slate-300 border-slate-700">PUSH</span>
    : pick.status === 'void' ? <span className="text-[9px] font-mono px-1.5 py-0.5 rounded border bg-slate-800 text-slate-300 border-slate-700">VOID</span>
    : pick.status === 'taken' ? <span className="text-[9px] font-mono px-1.5 py-0.5 rounded border bg-blue-950 text-blue-300 border-blue-900">ACTIVE</span>
    : null

  const confCls = CONF_STYLE[pick.confidence] ?? CONF_STYLE.medium
  const edge = pick.edge_pct != null ? `${pick.edge_pct >= 0 ? '+' : ''}${pick.edge_pct.toFixed(1)}%` : null
  const prob = pick.model_prob != null ? `${Math.round(pick.model_prob * 100)}%` : null
  const isModel = pick.source === 'model'
  const fmtSpread = (v: number) => v === 0 ? 'PK' : v > 0 ? `+${v.toFixed(1)}` : v.toFixed(1)

  return (
    <div className="border border-slate-800 rounded-xl bg-slate-900 overflow-hidden">
      <button className="w-full p-3 text-left" onClick={onToggle}>
        <div className="flex items-start gap-2">
          <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border shrink-0 mt-0.5 ${confCls}`}>
            {pick.confidence.toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2 flex-wrap">
              <p className="text-[12px] font-mono text-slate-100 font-semibold truncate">{pick.side}</p>
              <p className="text-[10px] font-mono text-slate-500">· {pick.market}</p>
              {statusBadge}
            </div>
            <p className="text-[10px] font-mono text-slate-400 mt-0.5">
              {pick.game_label} · {fmtKickoff(pick.kickoff_at)}
            </p>
            <p className="text-[9px] font-mono text-slate-600 mt-0.5 tabular-nums">
              {isModel ? (
                <>
                  {pick.model_spread != null && <>model {fmtSpread(pick.model_spread)}</>}
                  {pick.book_spread  != null && <> · book {fmtSpread(pick.book_spread)}</>}
                  {pick.book_name           && <> ({pick.book_name})</>}
                  {pick.edge_points  != null && <> · edge {pick.edge_points.toFixed(1)} pt</>}
                </>
              ) : (
                <>
                  {prob && <>p={prob}</>}
                  {pick.fair_line && <> · fair {pick.fair_line}</>}
                  {pick.min_odds != null && <> · min {fmtAmericanOdds(pick.min_odds)}</>}
                  {edge && <> · edge {edge}</>}
                </>
              )}
            </p>
            {isTaken && pick.stake != null && (
              <p className="text-[9px] font-mono text-blue-400 mt-0.5 tabular-nums">
                @${pick.stake.toFixed(2)} · {fmtAmericanOdds(pick.taken_odds)}
              </p>
            )}
            {isSettled && pick.payout != null && (
              <p className={`text-[9px] font-mono mt-0.5 tabular-nums ${pick.payout > 0 ? 'text-emerald-400' : pick.payout < 0 ? 'text-red-400' : 'text-slate-500'}`}>
                {pick.payout >= 0 ? '+' : ''}${pick.payout.toFixed(2)}
                {pick.stake != null && <span className="text-slate-600"> on ${pick.stake.toFixed(2)}</span>}
              </p>
            )}
          </div>
          <span className={`text-slate-600 text-xs font-mono shrink-0 mt-0.5 transition-transform ${expanded ? 'rotate-180' : ''}`}>▾</span>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-slate-800 px-3 py-3 space-y-3">
          <p className="text-[10px] font-mono text-slate-300 leading-relaxed whitespace-pre-wrap">
            {pick.reasoning}
          </p>

          {isOpen   && <OpenActions   pick={pick} onAction={onAction} />}
          {isTaken  && <TakenActions  pick={pick} onAction={onAction} />}
          {isSkipped && (
            <div className="flex gap-2">
              <button
                onClick={() => onAction('reopen', pick.id)}
                className="flex-1 text-[10px] font-mono text-slate-300 border border-slate-700 rounded-lg py-2 active:bg-slate-800"
              >
                Reopen
              </button>
              <button
                onClick={() => onAction('delete', pick.id)}
                className="flex-1 text-[10px] font-mono text-red-400 border border-red-900 rounded-lg py-2 active:opacity-70"
              >
                Delete
              </button>
            </div>
          )}
          {isSettled && (
            <div className="flex gap-2">
              <button
                onClick={() => onAction('reopen', pick.id)}
                className="flex-1 text-[10px] font-mono text-slate-400 border border-slate-700 rounded-lg py-2 active:bg-slate-800"
              >
                Undo settle
              </button>
              <button
                onClick={() => { if (confirm('Delete this pick?')) onAction('delete', pick.id) }}
                className="flex-1 text-[10px] font-mono text-red-400 border border-red-900 rounded-lg py-2 active:opacity-70"
              >
                Delete
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function OpenActions({ pick, onAction }: {
  pick: PickRow
  onAction: (action: PickAction, id: number, payload?: PickActionPayload) => void
}) {
  const [stake, setStake]       = useState<string>('')
  const [odds, setOdds]         = useState<string>(pick.min_odds != null ? String(pick.min_odds) : '-110')
  const [showTake, setShowTake] = useState(false)

  const submit = () => {
    const s = parseFloat(stake)
    const o = parseInt(odds, 10)
    if (!Number.isFinite(s) || s <= 0) return
    if (!Number.isFinite(o) || o === 0) return
    onAction('take', pick.id, { stake: s, taken_odds: o })
  }

  if (!showTake) {
    return (
      <div className="flex gap-2">
        <button
          onClick={() => setShowTake(true)}
          className="flex-1 text-[10px] font-mono text-emerald-300 border border-emerald-800 bg-emerald-950/40 rounded-lg py-2 active:opacity-70"
        >
          I&rsquo;m taking this
        </button>
        <button
          onClick={() => onAction('skip', pick.id)}
          className="flex-1 text-[10px] font-mono text-slate-400 border border-slate-700 rounded-lg py-2 active:bg-slate-800"
        >
          Skip
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[9px] font-mono text-slate-600 tracking-wider">STAKE ($)</label>
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={stake}
            onChange={(e) => setStake(e.target.value)}
            className="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 text-xs font-mono text-slate-200 tabular-nums focus:outline-none focus:border-emerald-700"
            placeholder="50"
          />
        </div>
        <div>
          <label className="text-[9px] font-mono text-slate-600 tracking-wider">ODDS (American)</label>
          <input
            type="number"
            inputMode="numeric"
            value={odds}
            onChange={(e) => setOdds(e.target.value)}
            className="mt-1 w-full bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 text-xs font-mono text-slate-200 tabular-nums focus:outline-none focus:border-emerald-700"
            placeholder="-110"
          />
        </div>
      </div>
      <div className="flex gap-2">
        <button
          onClick={submit}
          className="flex-1 text-[10px] font-mono text-emerald-300 border border-emerald-800 bg-emerald-950/40 rounded-lg py-2 active:opacity-70"
        >
          Confirm Take
        </button>
        <button
          onClick={() => setShowTake(false)}
          className="flex-1 text-[10px] font-mono text-slate-400 border border-slate-700 rounded-lg py-2 active:bg-slate-800"
        >
          Cancel
        </button>
      </div>
    </div>
  )
}

function TakenActions({ pick, onAction }: {
  pick: PickRow
  onAction: (action: PickAction, id: number, payload?: PickActionPayload) => void
}) {
  return (
    <div className="grid grid-cols-4 gap-2">
      <button
        onClick={() => onAction('settle', pick.id, { result: 'won' })}
        className="text-[10px] font-mono text-emerald-300 border border-emerald-800 bg-emerald-950/40 rounded-lg py-2 active:opacity-70"
      >
        Won
      </button>
      <button
        onClick={() => onAction('settle', pick.id, { result: 'lost' })}
        className="text-[10px] font-mono text-red-400 border border-red-900 bg-red-950/30 rounded-lg py-2 active:opacity-70"
      >
        Lost
      </button>
      <button
        onClick={() => onAction('settle', pick.id, { result: 'push' })}
        className="text-[10px] font-mono text-slate-300 border border-slate-700 rounded-lg py-2 active:bg-slate-800"
      >
        Push
      </button>
      <button
        onClick={() => onAction('settle', pick.id, { result: 'void' })}
        className="text-[10px] font-mono text-slate-400 border border-slate-700 rounded-lg py-2 active:bg-slate-800"
      >
        Void
      </button>
    </div>
  )
}

// ─── Library Tab (Reports + Notes, mode toggle) ───────────────────────────
//
// Single tab housing the bounty-report pipeline (actionable items) and
// the agent-written notes library. Mode toggle at the top swaps between
// the two views; both subviews remain mounted so their internal state /
// polling persists across toggles.

// ─── Articles (Substack drafts from Lila / Vega / Ceelo) ─────────────────
//
// Lila, Vega, and Ceelo each draft a daily noon Substack article from
// the operator's actual data. Drafts persist; operator copies the
// markdown into Substack manually. Per-author manual-trigger buttons at
// the top let the operator prompt any author at will (this is the
// "settings" entry point the brief asked for).

type ArticleAuthor = 'lila' | 'vega' | 'ceelo'

interface ArticleRow {
  id: number
  title: string
  content: string
  source: string | null
  status: 'draft' | 'published' | 'dismissed'
  external_url: string | null
  author: ArticleAuthor
  kind: string
  created_ts: number
  updated_ts: number
}

interface ArticlesPayload {
  articles: ArticleRow[]
  counts: { draft: number; published: number; dismissed: number; lila: number; vega: number; ceelo: number }
  wroteToday: { lila: boolean; vega: boolean; ceelo: boolean }
}

const AUTHOR_STYLE: Record<ArticleAuthor, { color: string; label: string }> = {
  lila:  { color: 'text-emerald-300 border-emerald-800 bg-emerald-950/40', label: 'LILA' },
  vega:  { color: 'text-blue-300 border-blue-800 bg-blue-950/40',          label: 'VEGA' },
  ceelo: { color: 'text-rose-300 border-rose-800 bg-rose-950/40',          label: 'CEELO' },
}

function ArticlesView({ visible }: { visible: boolean }) {
  const [data, setData] = useState<ArticlesPayload | null>(null)
  const [filter, setFilter] = useState<'all' | ArticleAuthor>('all')
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [generating, setGenerating] = useState<ArticleAuthor | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/articles')
      if (res.ok) setData(await res.json())
    } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    if (!visible) return
    load()
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [visible, load])

  const generateNow = async (author: ArticleAuthor) => {
    if (generating) return
    setGenerating(author)
    try {
      const res = await fetch('/api/articles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'noon-report', author }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        alert(`Generate failed: ${body?.error ?? res.status}`)
      }
      await load()
    } catch {
      alert('Generate failed (network).')
    } finally {
      setGenerating(null)
    }
  }

  const dismiss = async (id: number) => {
    if (!confirm('Dismiss this draft?')) return
    await fetch('/api/articles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'dismiss', id }),
    })
    await load()
  }

  const markPublished = async (id: number) => {
    const url = prompt('Substack URL (optional)?', '')
    await fetch('/api/articles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'mark_published', id, external_url: url || null }),
    })
    await load()
  }

  const filtered = useMemo(() => {
    if (!data) return [] as ArticleRow[]
    if (filter === 'all') return data.articles
    return data.articles.filter(a => a.author === filter)
  }, [data, filter])

  return (
    <div className={`absolute inset-0 overflow-y-auto ${visible ? '' : 'invisible pointer-events-none'}`}>
      <div className="px-4 py-4 space-y-4">
        {/* Manual generate row — the "settings" controls per author. */}
        <div className="space-y-2">
          <p className="text-[10px] font-mono text-slate-500 tracking-widest">GENERATE NOW</p>
          <div className="grid grid-cols-3 gap-2">
            {(['lila','vega','ceelo'] as ArticleAuthor[]).map(a => {
              const wrote = data?.wroteToday?.[a]
              const cls = AUTHOR_STYLE[a].color
              return (
                <button
                  key={a}
                  onClick={() => generateNow(a)}
                  disabled={generating !== null}
                  className={`text-[10px] font-mono py-2 rounded-lg border tracking-wider transition-colors ${cls} disabled:opacity-50`}
                >
                  {generating === a ? 'WRITING…' : `${AUTHOR_STYLE[a].label}${wrote ? ' ✓' : ''}`}
                </button>
              )
            })}
          </div>
          <p className="text-[9px] font-mono text-slate-600">
            ✓ marks today&rsquo;s noon report already filed. Manual press writes a fresh draft anyway.
          </p>
        </div>

        {/* Author filter pills */}
        {data && data.articles.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            <ArticleFilterPill active={filter === 'all'} label="ALL" count={data.articles.length} onClick={() => setFilter('all')} />
            {(['lila','vega','ceelo'] as ArticleAuthor[]).map(a => (
              <ArticleFilterPill
                key={a}
                active={filter === a}
                label={AUTHOR_STYLE[a].label}
                count={data.counts[a]}
                onClick={() => setFilter(a)}
              />
            ))}
          </div>
        )}

        {/* Article list */}
        {!data ? (
          <p className="text-xs font-mono text-slate-700">Loading…</p>
        ) : filtered.length === 0 ? (
          <EmptyState
            title="No articles yet."
            subtitle="Lila / Vega / Ceelo each draft a noon report daily. Or hit a button above to generate one now."
          />
        ) : (
          <div className="space-y-2">
            {filtered.map(a => (
              <ArticleCard
                key={a.id}
                article={a}
                expanded={expandedId === a.id}
                onToggle={() => setExpandedId(expandedId === a.id ? null : a.id)}
                onDismiss={() => dismiss(a.id)}
                onMarkPublished={() => markPublished(a.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function ArticleFilterPill({ active, label, count, onClick }: {
  active: boolean; label: string; count: number; onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`text-[9px] font-mono px-2 py-1 rounded border tracking-wider ${
        active
          ? 'bg-emerald-950 text-emerald-400 border-emerald-800'
          : 'text-slate-500 border-slate-800 active:bg-slate-800'
      }`}
    >
      {label} · {count}
    </button>
  )
}

function ArticleCard({ article, expanded, onToggle, onDismiss, onMarkPublished }: {
  article: ArticleRow
  expanded: boolean
  onToggle: () => void
  onDismiss: () => void
  onMarkPublished: () => void
}) {
  const [copied, setCopied] = useState(false)
  const cls = AUTHOR_STYLE[article.author]?.color ?? 'text-slate-300 border-slate-700 bg-slate-900'
  const label = AUTHOR_STYLE[article.author]?.label ?? article.author.toUpperCase()
  const statusBadge =
      article.status === 'published' ? <span className="text-[8px] font-mono text-emerald-400 border border-emerald-900 rounded px-1">PUBLISHED</span>
    : article.status === 'dismissed' ? <span className="text-[8px] font-mono text-slate-600 border border-slate-800 rounded px-1">DISMISSED</span>
    : <span className="text-[8px] font-mono text-amber-400 border border-amber-900 rounded px-1">DRAFT</span>

  const copyMd = () => {
    navigator.clipboard.writeText(article.content).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div className="border border-slate-800 rounded-xl bg-slate-900 overflow-hidden">
      <button className="w-full p-3 text-left" onClick={onToggle}>
        <div className="flex items-start gap-2">
          <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border shrink-0 mt-0.5 ${cls}`}>
            {label}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-mono text-slate-100 font-semibold truncate">{article.title}</p>
            <p className="text-[9px] font-mono text-slate-600 mt-0.5">
              {fmtAge(article.created_ts)} · {article.kind} · {article.content.length.toLocaleString()} chars
            </p>
          </div>
          <span className="shrink-0">{statusBadge}</span>
          <span className={`text-slate-600 text-xs font-mono shrink-0 mt-0.5 transition-transform ${expanded ? 'rotate-180' : ''}`}>▾</span>
        </div>
      </button>
      {expanded && (
        <div className="border-t border-slate-800 px-3 py-3 space-y-3">
          <pre className="text-[10px] font-mono text-slate-300 leading-relaxed bg-slate-950 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-words max-h-[60vh] overflow-y-auto select-text">
            {article.content}
          </pre>
          <div className="flex gap-2 flex-wrap">
            <button
              onClick={copyMd}
              className="flex-1 text-[10px] font-mono text-emerald-300 border border-emerald-800 bg-emerald-950/40 rounded-lg py-2 active:opacity-70"
            >
              {copied ? '✓ copied' : 'Copy Markdown'}
            </button>
            {article.status !== 'published' && (
              <button
                onClick={onMarkPublished}
                className="flex-1 text-[10px] font-mono text-blue-300 border border-blue-800 bg-blue-950/40 rounded-lg py-2 active:opacity-70"
              >
                Mark published
              </button>
            )}
            {article.status !== 'dismissed' && (
              <button
                onClick={onDismiss}
                className="flex-1 text-[10px] font-mono text-slate-400 border border-slate-700 rounded-lg py-2 active:bg-slate-800"
              >
                Dismiss
              </button>
            )}
            {article.external_url && (
              <a
                href={article.external_url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 text-[10px] font-mono text-emerald-400 border border-emerald-900 rounded-lg py-2 text-center active:opacity-70"
              >
                Open ↗
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function LibraryTab({
  visible,
  mode,
  onModeChange,
  reports,
  reportsLoading,
  onReportAction,
  onNavigate,
  notesFilter,
  onNotesFilterChange,
}: {
  visible: boolean
  mode: 'reports' | 'notes' | 'articles'
  onModeChange: (m: 'reports' | 'notes' | 'articles') => void
  reports: SecurityReport[]
  reportsLoading: boolean
  onReportAction: (a: ReportAction) => void
  onNavigate: NavigateFn
  notesFilter: NoteFilter
  onNotesFilterChange: (f: NoteFilter) => void
}) {
  const reportsBadge = reports.filter(r => r.status === 'approved' || r.status === 'pending_review').length

  return (
    <div className={`absolute inset-0 flex flex-col ${visible ? '' : 'invisible pointer-events-none'}`}>
      {/* Mode toggle bar */}
      <div className="shrink-0 flex border-b border-slate-800 bg-slate-950">
        <LibraryModePill
          active={mode === 'reports'}
          label="Reports"
          badge={reportsBadge > 0 ? reportsBadge : undefined}
          onClick={() => onModeChange('reports')}
        />
        <LibraryModePill
          active={mode === 'notes'}
          label="Notes"
          onClick={() => onModeChange('notes')}
        />
        <LibraryModePill
          active={mode === 'articles'}
          label="Articles"
          onClick={() => onModeChange('articles')}
        />
      </div>

      {/* Subviews — all mounted so polling/state persists across mode flips. */}
      <div className="flex-1 relative overflow-hidden">
        <ReportsTab
          reports={reports}
          loading={reportsLoading}
          visible={visible && mode === 'reports'}
          onAction={onReportAction}
          onNavigate={onNavigate}
        />
        <NotesTab
          visible={visible && mode === 'notes'}
          filter={notesFilter}
          onFilterChange={onNotesFilterChange}
        />
        <ArticlesView visible={visible && mode === 'articles'} />
      </div>
    </div>
  )
}

function LibraryModePill({ active, label, badge, onClick }: {
  active: boolean
  label: string
  badge?: number
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 py-3 text-[11px] font-mono tracking-widest uppercase relative transition-colors ${
        active
          ? 'text-emerald-400 border-b-2 border-emerald-500'
          : 'text-slate-600 active:text-slate-400 border-b-2 border-transparent'
      }`}
    >
      {label}
      {badge != null && badge > 0 && (
        <span className="ml-2 inline-flex items-center justify-center min-w-[16px] h-[16px] px-1 rounded-full bg-amber-500 text-slate-950 text-[9px] font-bold tabular-nums">
          {badge > 9 ? '9+' : badge}
        </span>
      )}
    </button>
  )
}

// ─── Notes Tab ────────────────────────────────────────────────────────────────

type NoteCategory = 'analyst' | 'lila' | 'tasker' | 'ceelo' | 'scout' | 'pitches' | 'other'

interface NoteRow {
  id: number
  path: string
  category: NoteCategory
  preview: string
  size: number
  created_ts: number
  updated_ts: number
}

interface AgentActivity {
  vega: { step: string; cycle: number; last_ts: number | null } | null
  cipher: {
    step: string
    turn_count: number
    last_ts: number | null
    target: { title: string; phase: string; cycles: number; last_ts: number | null } | null
  } | null
  lila: { last_chat_ts: number | null }
  ceelo?: { cycle: number; rated: number; upcoming: number; last_ts: number | null } | null
  scout?: { cycle: number; scanned: number; reported: number; last_ts: number | null } | null
  artist?: { cycle: number; total_pieces: number; latest_id: number | null; last_ts: number | null } | null
}

interface NotesData {
  notes: NoteRow[]
  counts: Record<NoteCategory | 'total', number>
  activity: AgentActivity | null
}

// Map a Vega T-step to a human label.
function vegaStepLabel(step: string): string {
  switch (step) {
    case 'T0': return 'reading chat'
    case 'T1': return 'scanning news'
    case 'T2': return 'scanning charts'
    case 'T3': return 'writing research'
    case 'F0': return 'filing picks'
    case 'M0': return 'summarizing'
    case 'M1': return 'P&L report'
    default:   return step.toLowerCase()
  }
}

// Map a Cipher bounty-step to a human label.
function cipherStepLabel(step: string): string {
  switch (step) {
    case 'BT0': return 'parsing tasks'
    case 'BH0': return 'working target'
    case 'BZ0': return 'posting status'
    default:    return step.toLowerCase()
  }
}

// Convert an analyst_notes path into a readable title + subtitle.
// Examples:
//   analyst/notes/feed-2026-04-25.md     → "News feed"        · "2026-04-25"
//   analyst/notes/scan-2026-04-25.md     → "Market scan"       · "2026-04-25"
//   analyst/notes/research-2026-04-25.md → "Research note"     · "2026-04-25"
//   analyst/summaries/2026-04-25-maintenance.md → "Daily summary" · "2026-04-25"
//   analyst/pnl/2026-04-25-analysis.md   → "P&L briefing"      · "2026-04-25"
//   lila/plans/2026-04-25-1714000000.md  → "Lila trade plan"   · "2026-04-25"
//   lila/pitches/acme-retainer.md        → "Pitch"             · "acme-retainer"
//   tasks/current.md                     → "Current task"      · "live"
//   tasker/report/... .md                → "Cipher draft"      · <leaf>
function humanizeNotePath(path: string): { title: string; subtitle: string } {
  const leaf = path.split('/').pop() ?? path
  const base = leaf.replace(/\.md$/, '')
  const dateMatch = base.match(/\d{4}-\d{2}-\d{2}/)
  const date = dateMatch ? dateMatch[0] : ''

  if (path === 'tasks/current.md')                return { title: 'Current task',  subtitle: 'live' }
  if (path.startsWith('analyst/notes/feed-'))     return { title: 'News feed',     subtitle: date || base }
  if (path.startsWith('analyst/notes/scan-'))     return { title: 'Market scan',   subtitle: date || base }
  if (path.startsWith('analyst/notes/research-')) return { title: 'Research note', subtitle: date || base }
  if (path.startsWith('analyst/summaries/'))      return { title: 'Daily summary', subtitle: date || base }
  if (path.startsWith('analyst/pnl/'))            return { title: 'P&L briefing', subtitle: date || base }
  if (path.startsWith('lila/plans/'))             return { title: 'Trade plan',    subtitle: date || base }
  if (path.startsWith('lila/pitches/'))           return { title: 'Pitch',         subtitle: base }
  if (path.startsWith('lila/'))                   return { title: 'Lila note',     subtitle: base }
  if (path.startsWith('tasker/'))                 return { title: 'Cipher note',   subtitle: base }
  if (path.startsWith('analyst/'))                return { title: 'Vega note',     subtitle: base }
  if (path.startsWith('ceelo/cycles/'))           return { title: 'Ceelo cycle',   subtitle: date || base }
  if (path.startsWith('ceelo/'))                  return { title: 'Ceelo note',    subtitle: base }
  if (path.startsWith('scout/'))                  return { title: 'Scout finding', subtitle: base }
  return { title: leaf, subtitle: path }
}

// Group notes by updated-day bucket: 'Today' / 'Yesterday' / 'Earlier'.
function dayBucket(ts: number): 'today' | 'yesterday' | 'earlier' {
  const d = new Date(ts)
  const now = new Date()
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (sameDay(d, now)) return 'today'
  const y = new Date(now); y.setDate(y.getDate() - 1)
  if (sameDay(d, y)) return 'yesterday'
  return 'earlier'
}

const NOTE_CATEGORY_STYLE: Record<NoteCategory, string> = {
  analyst: 'bg-blue-950 text-blue-300 border-blue-900',
  lila:    'bg-emerald-950 text-emerald-300 border-emerald-900',
  tasker:  'bg-amber-950 text-amber-300 border-amber-900',
  ceelo:   'bg-rose-950 text-rose-300 border-rose-900',
  scout:   'bg-cyan-950 text-cyan-300 border-cyan-900',
  pitches: 'bg-purple-950 text-purple-300 border-purple-900',
  other:   'bg-slate-800 text-slate-400 border-slate-700',
}

const NOTE_CATEGORY_LABEL: Record<NoteCategory, string> = {
  analyst: 'VEGA',
  lila:    'LILA',
  tasker:  'CIPHER',
  ceelo:   'CEELO',
  scout:   'SCOUT',
  pitches: 'PITCH',
  other:   'OTHER',
}

type NoteFilter = 'all' | NoteCategory

function NotesTab({ visible, filter, onFilterChange }: {
  visible: boolean
  filter: NoteFilter
  onFilterChange: (f: NoteFilter) => void
}) {
  const [data, setData] = useState<NotesData | null>(null)
  const setFilter = onFilterChange
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [expandedContent, setExpandedContent] = useState<string | null>(null)
  const [fetchingContent, setFetchingContent] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/notes')
      if (res.ok) setData(await res.json())
    } catch { /* ignore */ }
    finally { setLoading(false) }
  }, [])

  useEffect(() => {
    if (!visible) return
    load()
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [visible, load])

  const expand = useCallback(async (id: number) => {
    if (expandedId === id) {
      setExpandedId(null)
      setExpandedContent(null)
      return
    }
    setExpandedId(id)
    setExpandedContent(null)
    setFetchingContent(true)
    try {
      const res = await fetch(`/api/notes?id=${id}`)
      if (res.ok) {
        const d = await res.json()
        setExpandedContent(d.content ?? '')
      }
    } finally { setFetchingContent(false) }
  }, [expandedId])

  const remove = useCallback(async (id: number) => {
    if (!confirm('Delete this note permanently?')) return
    await fetch('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete', id }),
    })
    if (expandedId === id) {
      setExpandedId(null)
      setExpandedContent(null)
    }
    await load()
  }, [expandedId, load])

  const clearCategory = useCallback(async (category: Exclude<NoteFilter, 'all'>) => {
    const label = NOTE_CATEGORY_LABEL[category] ?? category
    const count = data?.counts?.[category] ?? 0
    if (count === 0) return
    if (!confirm(`Delete ALL ${count} ${label} notes? This cannot be undone.`)) return
    await fetch('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete_category', category }),
    })
    setExpandedId(null)
    setExpandedContent(null)
    await load()
  }, [data?.counts, load])

  const filtered = useMemo(() => {
    if (!data) return []
    if (filter === 'all') return data.notes
    return data.notes.filter(n => n.category === filter)
  }, [data, filter])

  const pills: { key: NoteFilter; label: string; count: number }[] = data ? [
    { key: 'all',     label: 'ALL',     count: data.counts.total   },
    { key: 'analyst', label: 'VEGA',    count: data.counts.analyst },
    { key: 'tasker',  label: 'CIPHER',  count: data.counts.tasker  },
    { key: 'scout',   label: 'SCOUT',   count: data.counts.scout ?? 0 },
    { key: 'ceelo',   label: 'CEELO',   count: data.counts.ceelo ?? 0 },
    { key: 'lila',    label: 'LILA',    count: data.counts.lila    },
    { key: 'pitches', label: 'PITCH',   count: data.counts.pitches },
    ...(data.counts.other > 0 ? [{ key: 'other' as const, label: 'OTHER', count: data.counts.other }] : []),
  ] : []

  const groups = useMemo(() => {
    const out: { today: NoteRow[]; yesterday: NoteRow[]; earlier: NoteRow[] } = {
      today: [], yesterday: [], earlier: [],
    }
    for (const n of filtered) out[dayBucket(n.updated_ts)].push(n)
    return out
  }, [filtered])

  return (
    <div className={`absolute inset-0 overflow-y-auto ${visible ? '' : 'invisible pointer-events-none'}`}>
      <div className="px-4 md:px-6 py-5 md:py-7 space-y-4">
        <div className="flex items-center gap-2">
          <span className="text-emerald-500"><IconNotes /></span>
          <div>
            <p className="text-xs font-mono text-slate-300 font-semibold">Notes &amp; Activity</p>
            <p className="text-[10px] font-mono text-slate-600">
              What the team is doing now + everything they&rsquo;ve written down
            </p>
          </div>
        </div>

        {/* Live agent activity. Updates every 30s with the notes list. */}
        {data?.activity && <AgentActivityCard activity={data.activity} />}

        {/* Filter pills */}
        {data && data.counts.total > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {pills.map(p => (
              <button
                key={p.key}
                onClick={() => setFilter(p.key)}
                className={`text-[9px] font-mono px-2 py-1 rounded border tracking-wider ${
                  filter === p.key
                    ? 'bg-emerald-950 text-emerald-400 border-emerald-800'
                    : 'text-slate-500 border-slate-800 active:bg-slate-800'
                }`}
              >
                {p.label} · {p.count}
              </button>
            ))}
          </div>
        )}

        {/* Bulk delete for the active filter (except 'all') */}
        {data && filter !== 'all' && (data.counts[filter] ?? 0) > 0 && (
          <button
            onClick={() => clearCategory(filter)}
            className="text-[9px] font-mono text-red-400 border border-red-900 rounded px-2 py-1 active:opacity-70"
          >
            Clear all {NOTE_CATEGORY_LABEL[filter]} · {data.counts[filter]}
          </button>
        )}

        {loading && !data ? (
          <div className="flex items-center gap-2 py-10 justify-center">
            <div className="w-4 h-4 border-2 border-slate-700 border-t-emerald-500 rounded-full animate-spin" />
            <p className="text-xs font-mono text-slate-600">Loading notes...</p>
          </div>
        ) : filtered.length === 0 ? (
          <EmptyState
            title="Nothing here yet."
            subtitle="Vega, Lila, and Cipher write notes as they work. They'll show up here."
          />
        ) : (
          <div className="space-y-4">
            {(['today', 'yesterday', 'earlier'] as const).map(bucket => {
              const rows = groups[bucket]
              if (rows.length === 0) return null
              const label = bucket === 'today' ? 'TODAY' : bucket === 'yesterday' ? 'YESTERDAY' : 'EARLIER'
              return (
                <div key={bucket} className="space-y-2">
                  <p className="text-[9px] font-mono text-slate-600 tracking-widest">{label} · {rows.length}</p>
                  <div className="space-y-2">
                    {rows.map(n => (
                      <NoteRow
                        key={n.id}
                        note={n}
                        expanded={expandedId === n.id}
                        content={expandedId === n.id ? expandedContent : null}
                        loadingContent={expandedId === n.id && fetchingContent}
                        onToggle={() => expand(n.id)}
                        onDelete={() => remove(n.id)}
                      />
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Agent Activity Card ──────────────────────────────────────────────────────
//
// At-a-glance view of what each agent is doing *right now*. Consumes live
// state snapshots (analyst_state, lila_loop_state, research_targets) that
// the autonomy ticker updates as loops advance.

function AgentActivityCard({ activity }: { activity: AgentActivity }) {
  const rows: Array<{
    who: 'Vega' | 'Cipher' | 'Scout' | 'Ceelo' | 'Lila'
    color: string
    line: string
    ts: number | null
  }> = []

  if (activity.vega) {
    rows.push({
      who: 'Vega',
      color: 'text-blue-400',
      line: vegaStepLabel(activity.vega.step) + (activity.vega.cycle ? ` · cycle ${activity.vega.cycle}` : ''),
      ts: activity.vega.last_ts,
    })
  }
  if (activity.cipher) {
    const t = activity.cipher.target
    const line = t
      ? `${t.title.length > 28 ? t.title.slice(0, 28) + '…' : t.title} · ${t.phase} · c${t.cycles}`
      : cipherStepLabel(activity.cipher.step) + (activity.cipher.turn_count ? ` · turn ${activity.cipher.turn_count}` : '')
    rows.push({
      who: 'Cipher',
      color: 'text-amber-400',
      line,
      ts: activity.cipher.target?.last_ts ?? activity.cipher.last_ts,
    })
  }
  if (activity.scout) {
    rows.push({
      who: 'Scout',
      color: 'text-cyan-400',
      line: `cycle ${activity.scout.cycle} · ${activity.scout.scanned} scanned · ${activity.scout.reported} reported`,
      ts: activity.scout.last_ts,
    })
  }
  if (activity.ceelo) {
    rows.push({
      who: 'Ceelo',
      color: 'text-rose-400',
      line: `cycle ${activity.ceelo.cycle} · ${activity.ceelo.rated}/32 rated · ${activity.ceelo.upcoming} upcoming`,
      ts: activity.ceelo.last_ts,
    })
  }
  rows.push({
    who: 'Lila',
    color: 'text-emerald-400',
    line: activity.lila.last_chat_ts ? 'last chat message' : 'idle — no chats yet',
    ts: activity.lila.last_chat_ts,
  })

  return (
    <div className="border border-slate-800 rounded-xl bg-slate-900/60 divide-y divide-slate-800">
      {rows.map(r => (
        <div key={r.who} className="px-3 py-2 flex items-center gap-3">
          <span className={`text-[10px] font-mono font-semibold tracking-wider w-14 shrink-0 ${r.color}`}>
            {r.who.toUpperCase()}
          </span>
          <p className="text-[11px] font-mono text-slate-300 flex-1 min-w-0 truncate">
            {r.line}
          </p>
          <span className="text-[9px] font-mono text-slate-600 shrink-0 tabular-nums">
            {r.ts ? fmtAge(r.ts) : '—'}
          </span>
        </div>
      ))}
    </div>
  )
}

function NoteRow({ note, expanded, content, loadingContent, onToggle, onDelete }: {
  note: NoteRow
  expanded: boolean
  content: string | null
  loadingContent: boolean
  onToggle: () => void
  onDelete: () => void
}) {
  const [copied, setCopied] = useState(false)
  const catCls = NOTE_CATEGORY_STYLE[note.category] ?? NOTE_CATEGORY_STYLE.other

  const copy = () => {
    if (!content) return
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  const { title, subtitle } = humanizeNotePath(note.path)
  const catLabel = NOTE_CATEGORY_LABEL[note.category]

  return (
    <div className="border border-slate-800 rounded-xl bg-slate-900 overflow-hidden">
      <button className="w-full p-3 text-left" onClick={onToggle}>
        <div className="flex items-start gap-2">
          <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border shrink-0 mt-0.5 ${catCls}`}>
            {catLabel}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <p className="text-[11px] font-mono text-slate-200 font-semibold truncate">{title}</p>
              <p className="text-[9px] font-mono text-slate-600 truncate">{subtitle}</p>
            </div>
            <p className="text-[9px] font-mono text-slate-600 mt-0.5">
              {fmtAge(note.updated_ts)} · {note.size.toLocaleString()} chars
            </p>
            {!expanded && (
              <p className="text-[10px] font-mono text-slate-500 mt-1 line-clamp-2 leading-snug">
                {note.preview}
              </p>
            )}
          </div>
          <span className={`text-slate-600 text-xs font-mono shrink-0 mt-0.5 transition-transform ${expanded ? 'rotate-180' : ''}`}>▾</span>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-slate-800 px-3 py-3 space-y-3">
          {loadingContent ? (
            <p className="text-[10px] font-mono text-slate-600 text-center py-3">Loading…</p>
          ) : content ? (
            <pre className="text-[10px] font-mono text-slate-300 leading-relaxed bg-slate-950 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-words max-h-96 overflow-y-auto select-text">
              {content}
            </pre>
          ) : null}

          <div className="flex gap-2">
            <button
              onClick={copy}
              disabled={!content}
              className="flex-1 text-[10px] font-mono text-slate-300 border border-slate-700 rounded-lg py-2 active:bg-slate-800 disabled:opacity-40"
            >
              {copied ? '✓ copied' : 'Copy MD'}
            </button>
            <button
              onClick={onDelete}
              className="flex-1 text-[10px] font-mono text-red-400 border border-red-900 rounded-lg py-2 active:opacity-70"
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Terminal Tab ─────────────────────────────────────────────────────────────
//
// A persistent command-line shell for the operator. Each command hits an
// existing API and renders structured output; nothing here calls an LLM
// directly so it stays fast and free.

interface TermLine {
  id: number
  prompt: string                  // what the operator typed
  output: string                  // rendered result (mono)
  status: 'ok' | 'warn' | 'err'
}

const TERM_HELP = [
  'Commands:',
  '  status              team snapshot (earnings, target, queue)',
  '  kpis                docs / audit funnel + flag',
  '  loops               last-fired timestamps for every loop',
  '  post                fire a broadcast NOW (skips hourly gate)',
  '  verify bluesky      auth check (post + auto-delete)',
  '  verify telegram     auth check (sends a test message)',
  '  pitch retainer      regenerate the retainer one-pager',
  '  article             draft an article from latest finished research',
  '  watchlist refresh   force discovery scan now',
  '  say <text>          post <text> to Bluesky + Telegram immediately',
  '  ceelo seed          seed Ceelo historical NFL ratings',
  '  clear               wipe scrollback',
  '  help                this list',
].join('\n')

// ─── Desk Tab ────────────────────────────────────────────────────────────
//
// Inbox where Lila / Cipher / Vega / Scout / Ceelo file docs for the
// operator. Workflow:
//   approve → Lila reads it on her next tick and posts a 2-4 sentence
//             report to the chat (kind='message', shows up as Lila's
//             reply in the Chat tab + Telegram bridge).
//   deny    → operator captures a comment so the agent's future drafts
//             can avoid the dead-end direction. (Agent prompts can pull
//             recentDenials() from lib/desk.ts when generating.)
//
// Replaces the old Terminal tab — operator never used the CLI.

type DeskAgent = 'lila' | 'cipher' | 'vega' | 'scout' | 'ceelo'
type DeskStatus = 'pending' | 'approved' | 'reported' | 'denied'

interface DeskItem {
  id: number
  from_agent: DeskAgent
  title: string
  summary: string | null
  body: string
  kind: string
  status: DeskStatus
  operator_comment: string | null
  report_message: string | null
  created_ts: number | null
  approved_ts: number | null
  denied_ts: number | null
  reported_ts: number | null
}

interface DeskPayload {
  items: DeskItem[]
  counts: { pending: number; approved: number; reported: number; denied: number }
}

const DESK_AGENT_STYLE: Record<DeskAgent, string> = {
  lila:   'bg-emerald-950/40 border-emerald-800 text-emerald-300',
  cipher: 'bg-amber-950/40 border-amber-800 text-amber-300',
  vega:   'bg-blue-950/40 border-blue-800 text-blue-300',
  scout:  'bg-cyan-950/40 border-cyan-800 text-cyan-300',
  ceelo:  'bg-rose-950/40 border-rose-800 text-rose-300',
}

function DeskTab({ visible }: { visible: boolean }) {
  const [filter, setFilter] = useState<DeskStatus | 'all'>('pending')
  const [data, setData] = useState<DeskPayload | null>(null)
  const [expandedId, setExpandedId] = useState<number | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/desk?status=${filter}`)
      if (res.ok) setData(await res.json())
    } catch { /* ignore */ }
  }, [filter])

  useEffect(() => {
    if (!visible) return
    load()
    const id = setInterval(load, 15_000)
    return () => clearInterval(id)
  }, [visible, load])

  const post = useCallback(async (id: number, body: object) => {
    await fetch(`/api/desk/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    await load()
  }, [load])

  return (
    <div className={`absolute inset-0 overflow-y-auto ${visible ? '' : 'invisible pointer-events-none'}`}>
      <div className="px-4 md:px-6 py-5 md:py-7 space-y-4">
        <div className="flex items-center gap-2">
          <span className="text-emerald-500"><IconDesk /></span>
          <div>
            <p className="text-xs font-mono text-slate-300 font-semibold">Operator&rsquo;s Desk</p>
            <p className="text-[10px] font-mono text-slate-600">
              Lila, Cipher, Vega, Scout, Ceelo file docs here. Approve → Lila reads + reports. Deny + comment → agent avoids that direction next time.
            </p>
          </div>
        </div>

        {/* Filter pills */}
        {data && (
          <div className="flex flex-wrap gap-1.5">
            {(['pending','approved','reported','denied','all'] as const).map(k => (
              <button
                key={k}
                onClick={() => setFilter(k)}
                className={`text-[9px] font-mono px-2 py-1 rounded border tracking-wider ${
                  filter === k
                    ? 'bg-emerald-950 text-emerald-400 border-emerald-800'
                    : 'text-slate-500 border-slate-800 active:bg-slate-800'
                }`}
              >
                {k.toUpperCase()} · {k === 'all' ? Object.values(data.counts).reduce((a,b) => a+b, 0) : (data.counts[k] ?? 0)}
              </button>
            ))}
          </div>
        )}

        {/* Items */}
        {!data ? (
          <p className="text-xs font-mono text-slate-700">Loading…</p>
        ) : data.items.length === 0 ? (
          <EmptyState
            title={filter === 'pending' ? 'No items waiting.' : `No ${filter} items.`}
            subtitle="Agents will file docs here as they generate them. Approve to have Lila read + report; deny to flag a direction as dead so the agent doesn't re-pitch."
          />
        ) : (
          <div className="space-y-2">
            {data.items.map(it => (
              <DeskCard
                key={it.id}
                item={it}
                expanded={expandedId === it.id}
                onToggle={() => setExpandedId(expandedId === it.id ? null : it.id)}
                onApprove={() => post(it.id, { action: 'approve' })}
                onDeny={(comment) => post(it.id, { action: 'deny', comment })}
                onReset={() => post(it.id, { action: 'reset' })}
                onDelete={() => post(it.id, { action: 'delete' })}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function DeskCard({ item, expanded, onToggle, onApprove, onDeny, onReset, onDelete }: {
  item: DeskItem
  expanded: boolean
  onToggle: () => void
  onApprove: () => void
  onDeny: (comment: string) => void
  onReset: () => void
  onDelete: () => void
}) {
  const [showDeny, setShowDeny] = useState(false)
  const [denyComment, setDenyComment] = useState('')

  const cls = DESK_AGENT_STYLE[item.from_agent] ?? 'bg-slate-900 border-slate-800 text-slate-300'
  const status = item.status
  const statusColor =
      status === 'reported' ? 'text-emerald-400 border-emerald-900'
    : status === 'approved' ? 'text-blue-400 border-blue-900'
    : status === 'denied'   ? 'text-red-400 border-red-900'
    : 'text-amber-400 border-amber-900'

  const submitDeny = () => {
    onDeny(denyComment.trim() || 'no reason provided')
    setShowDeny(false)
    setDenyComment('')
  }

  return (
    <div className="border border-slate-800 rounded-xl bg-slate-900 overflow-hidden">
      <button className="w-full p-3 text-left" onClick={onToggle}>
        <div className="flex items-start gap-2">
          <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border shrink-0 mt-0.5 ${cls}`}>
            {item.from_agent.toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-mono text-slate-100 font-semibold truncate">{item.title}</p>
            {item.summary && (
              <p className="text-[10px] font-mono text-slate-500 mt-0.5 line-clamp-2 leading-snug">
                {item.summary}
              </p>
            )}
            <p className="text-[9px] font-mono text-slate-700 mt-1">
              {item.kind} · {item.created_ts ? fmtAge(item.created_ts) : 'just now'}
            </p>
          </div>
          <span className={`text-[8px] font-mono px-1.5 py-0.5 rounded border shrink-0 mt-0.5 ${statusColor}`}>
            {status.toUpperCase()}
          </span>
          <span className={`text-slate-600 text-xs font-mono shrink-0 mt-0.5 transition-transform ${expanded ? 'rotate-180' : ''}`}>▾</span>
        </div>
      </button>

      {expanded && (
        <div className="border-t border-slate-800 px-3 py-3 space-y-3">
          <pre className="text-[10px] font-mono text-slate-300 leading-relaxed bg-slate-950 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-words max-h-[55vh] overflow-y-auto select-text">
            {item.body}
          </pre>

          {/* Lila's report when reported */}
          {item.status === 'reported' && item.report_message && (
            <div className="rounded-lg border border-emerald-900 bg-emerald-950/30 p-3 space-y-1">
              <p className="text-[9px] font-mono text-emerald-400 tracking-wider">LILA REPORTED</p>
              <p className="text-[11px] font-mono text-emerald-100 whitespace-pre-wrap leading-relaxed">{item.report_message}</p>
            </div>
          )}

          {/* Denial comment */}
          {item.status === 'denied' && item.operator_comment && (
            <div className="rounded-lg border border-red-900 bg-red-950/30 p-3 space-y-1">
              <p className="text-[9px] font-mono text-red-400 tracking-wider">DENIED · YOUR COMMENT</p>
              <p className="text-[11px] font-mono text-red-100 whitespace-pre-wrap leading-relaxed">{item.operator_comment}</p>
            </div>
          )}

          {/* Action row */}
          {item.status === 'pending' && (
            showDeny ? (
              <div className="space-y-2">
                <textarea
                  rows={2}
                  value={denyComment}
                  onChange={(e) => setDenyComment(e.target.value)}
                  placeholder="Why is this dead? (agent reads this on next cycle)"
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 text-xs font-mono text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-red-700"
                  autoFocus
                />
                <div className="flex gap-2">
                  <button
                    onClick={submitDeny}
                    className="flex-1 text-[10px] font-mono text-red-300 border border-red-800 bg-red-950/40 rounded-lg py-2 active:opacity-70"
                  >
                    Confirm deny
                  </button>
                  <button
                    onClick={() => { setShowDeny(false); setDenyComment('') }}
                    className="flex-1 text-[10px] font-mono text-slate-400 border border-slate-700 rounded-lg py-2 active:bg-slate-800"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex gap-2">
                <button
                  onClick={onApprove}
                  className="flex-1 text-[10px] font-mono text-emerald-300 border border-emerald-800 bg-emerald-950/40 rounded-lg py-2 active:opacity-70"
                >
                  Approve · send to Lila
                </button>
                <button
                  onClick={() => setShowDeny(true)}
                  className="flex-1 text-[10px] font-mono text-red-400 border border-red-900 rounded-lg py-2 active:opacity-70"
                >
                  Deny + comment
                </button>
              </div>
            )
          )}
          {(item.status === 'approved' || item.status === 'reported' || item.status === 'denied') && (
            <div className="flex gap-2">
              <button
                onClick={onReset}
                className="flex-1 text-[10px] font-mono text-slate-300 border border-slate-700 rounded-lg py-2 active:bg-slate-800"
              >
                Reset to pending
              </button>
              <button
                onClick={() => { if (confirm('Delete this desk item?')) onDelete() }}
                className="flex-1 text-[10px] font-mono text-red-400 border border-red-900 rounded-lg py-2 active:opacity-70"
              >
                Delete
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function TerminalTab({ visible }: { visible: boolean }) {
  const [history, setHistory] = useState<TermLine[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const counterRef = useRef(0)
  const scrollerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight, behavior: 'smooth' })
  }, [history])

  const append = (prompt: string, output: string, status: TermLine['status'] = 'ok') => {
    counterRef.current += 1
    setHistory(h => [...h, { id: counterRef.current, prompt, output, status }])
  }

  const run = useCallback(async (raw: string) => {
    const cmd = raw.trim()
    if (!cmd) return
    setBusy(true)
    try {
      const lower = cmd.toLowerCase()
      const args = cmd.split(/\s+/)

      if (lower === 'help' || lower === '?') {
        append(cmd, TERM_HELP)
      } else if (lower === 'clear' || lower === 'cls') {
        setHistory([])
      } else if (lower === 'status') {
        const [agentRes, researchRes] = await Promise.all([
          fetch('/api/agent'), fetch('/api/research'),
        ])
        const a = agentRes.ok ? await agentRes.json() : null
        const r = researchRes.ok ? await researchRes.json() : null
        const out = [
          `earned (paid + closed P&L): $${(a?.totalEarned ?? 0).toFixed(2)}`,
          `bounty mode: ${a?.bountyMode ?? '—'}`,
          `tasks: ${(a?.activeTasks ?? []).length} active`,
          r?.current
            ? `research: "${r.current.title}" · cycle ${r.current.cycles} · phase ${r.current.phase}`
            : 'research: no target pinned',
        ].join('\n')
        append(cmd, out)
      } else if (lower === 'kpis') {
        const res = await fetch('/api/kpis')
        const d = res.ok ? await res.json() : null
        if (!d) { append(cmd, 'kpis: no data', 'warn'); return }
        const fmt = (label: string, k: typeof d.docs) =>
          `${label.padEnd(8)} attempts ${k.attempts}  paid ${k.paid}  paid$ $${k.paid_total.toFixed(2)}  pending$ $${k.max_pending.toFixed(2)}  flag ${k.flag}`
        append(cmd, [fmt('docs', d.docs), fmt('audit', d.security), fmt('code', d.code)].join('\n'))
      } else if (lower === 'loops') {
        const res = await fetch('/api/loops')
        const d = res.ok ? await res.json() : null
        if (!d?.loops) { append(cmd, 'loops: no data', 'warn'); return }
        const now = d.now ?? Date.now()
        const out = d.loops.map((l: LoopRow) => {
          if (!l.last_at) return `  ${l.label.padEnd(20)} never`
          const ago = Math.floor((now - l.last_at) / 1000)
          return `  ${l.label.padEnd(20)} ${ago}s ago`
        }).join('\n')
        append(cmd, out)
      } else if (lower === 'ceelo seed') {
        const res = await fetch('/api/ceelo/seed?seasons=3', { method: 'POST' })
        const d = await res.json().catch(() => ({}))
        append(cmd, res.ok ? `OK · Seeded ${d.games_graded} games.` : `FAIL: ${d.error ?? res.status}`, res.ok ? 'ok' : 'err')
      } else if (lower === 'post') {
        const res = await fetch('/api/broadcasts', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
        })
        const d = await res.json().catch(() => ({}))
        append(cmd, d.logMessage ?? `broadcast ${res.status}`, d.posted ? 'ok' : 'warn')
      } else if (lower.startsWith('say ')) {
        const text = cmd.slice(4).trim()
        if (!text) { append(cmd, 'say: text required', 'warn'); return }
        const res = await fetch('/api/broadcasts', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ override: text }),
        })
        const d = await res.json().catch(() => ({}))
        append(cmd, d.logMessage ?? `say ${res.status}`, d.posted ? 'ok' : 'warn')
      } else if (lower === 'verify bluesky' || lower === 'verify bsky') {
        const res = await fetch('/api/bluesky/test', { method: 'POST' })
        const d = await res.json().catch(() => ({}))
        append(cmd,
          d.ok ? (d.error ? `OK: ${d.error}` : 'OK · post + auto-delete succeeded')
               : `FAIL: ${d.error ?? res.status}`,
          d.ok ? 'ok' : 'err'
        )
      } else if (lower === 'verify telegram' || lower === 'verify tg') {
        const res = await fetch('/api/telegram/test', { method: 'POST' })
        const d = await res.json().catch(() => ({}))
        append(cmd,
          d.ok ? 'OK · check Telegram'
               : `FAIL: ${d.error ?? res.status}`,
          d.ok ? 'ok' : 'err'
        )
      } else if (lower === 'pitch retainer') {
        const res = await fetch('/api/pitches/retainer', { method: 'POST' })
        const d = await res.json().catch(() => ({}))
        append(cmd, res.ok ? 'OK · pitch refreshed (open Dash → Assets to read)' : `FAIL: ${d.error ?? res.status}`, res.ok ? 'ok' : 'err')
      } else if (lower === 'article') {
        const res = await fetch('/api/articles', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'generate' }),
        })
        const d = await res.json().catch(() => ({}))
        if (!res.ok) { append(cmd, `FAIL: ${d.error ?? res.status}`, 'err'); return }
        append(cmd, `OK · drafted "${d.title}" (id ${d.id}). Open Dash → Assets → Articles.`)
      } else if (lower === 'watchlist refresh' || lower === 'discover') {
        const res = await fetch('/api/watchlist', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'refresh' }),
        })
        const d = await res.json().catch(() => ({}))
        append(cmd, res.ok ? `OK · +${d.inserted ?? 0} new, ${d.skipped ?? 0} skipped` : `FAIL: ${res.status}`, res.ok ? 'ok' : 'err')
      } else if (args[0]?.toLowerCase() === 'target' && args[1]) {
        // Unhide for future: assigning a research target by id is non-trivial
        // since we'd need a bounty payload. Tell the operator to use Board.
        append(cmd, 'target: assign via Board tab (tap a bounty → Assign to Lila).', 'warn')
      } else if (lower === 'unpin') {
        const res = await fetch('/api/bounties', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bounty: null }),
        })
        append(cmd, res.ok ? 'OK · assignment cleared' : `FAIL: ${res.status}`, res.ok ? 'ok' : 'err')
      } else {
        append(cmd, `unknown command: ${cmd}\nType 'help' for a list.`, 'warn')
      }
    } catch (e) {
      append(cmd, `error: ${String(e)}`, 'err')
    } finally {
      setBusy(false)
    }
  }, [])

  const submit = () => {
    const t = input
    setInput('')
    run(t)
  }

  // Quick-tap chips for common commands (mobile is a pain to type in)
  const QUICK = ['status', 'kpis', 'loops', 'post', 'article', 'ceelo seed', 'help']

  return (
    <div className={`absolute inset-0 flex flex-col ${visible ? '' : 'invisible pointer-events-none'}`}>
      {/* Header */}
      <div className="shrink-0 px-4 pt-3 pb-2 border-b border-slate-800/60">
        <p className="text-[10px] font-mono text-emerald-500 uppercase tracking-widest">▓ Terminal</p>
        <p className="text-[9px] font-mono text-slate-600">type 'help' or tap a chip · clear with 'clear'</p>
      </div>

      {/* Scrollback */}
      <div ref={scrollerRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3 font-mono text-[11px]">
        {history.length === 0 ? (
          <pre className="text-slate-600 text-[10px] leading-relaxed whitespace-pre-wrap select-text">{TERM_HELP}</pre>
        ) : history.map(line => (
          <div key={line.id} className="space-y-0.5">
            <p className="text-emerald-500">
              <span className="text-slate-700">{'>'}</span> {line.prompt}
            </p>
            <pre className={`whitespace-pre-wrap break-words leading-snug select-text ${
              line.status === 'err'  ? 'text-red-400'  :
              line.status === 'warn' ? 'text-amber-400' :
              'text-slate-300'
            }`}>{line.output}</pre>
          </div>
        ))}
      </div>

      {/* Quick chips */}
      <div className="shrink-0 px-4 pb-2 flex gap-1.5 flex-wrap">
        {QUICK.map(c => (
          <button
            key={c}
            disabled={busy}
            onClick={() => run(c)}
            className="text-[9px] font-mono px-2 py-1 rounded border border-slate-800 text-slate-500 active:bg-slate-800 disabled:opacity-40"
          >
            {c}
          </button>
        ))}
      </div>

      {/* Input */}
      <div className="shrink-0 px-4 py-3 border-t border-slate-800 bg-slate-950 flex items-center gap-2">
        <span className="text-emerald-500 font-mono">{'>'}</span>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submit() }}
          placeholder="command..."
          disabled={busy}
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          className="flex-1 bg-transparent border-0 text-sm text-slate-100 font-mono placeholder:text-slate-700 focus:outline-none disabled:opacity-40"
        />
        <button
          onClick={submit}
          disabled={!input.trim() || busy}
          className="text-[10px] font-mono text-emerald-400 border border-emerald-900 rounded px-2 py-1 active:bg-emerald-950 disabled:opacity-40"
        >
          run
        </button>
      </div>
    </div>
  )
}

// ─── Reports Tab ──────────────────────────────────────────────────────────────

function ReportsTab({ reports, loading, visible, onAction, onNavigate }: {
  reports: SecurityReport[]
  loading: boolean
  visible: boolean
  onAction: (a: ReportAction) => void
  onNavigate: NavigateFn
}) {
  const toSubmit   = reports.filter(r => r.status === 'approved')
  const awaiting   = reports.filter(r => r.status === 'submitted')
  const paid       = reports.filter(r => r.status === 'paid')
  const lilaQueue  = reports.filter(r => r.status === 'pending_review')
  const archive    = reports.filter(r => ['dismissed', 'rejected'].includes(r.status))

  const totalPaid = paid.reduce((s, r) => s + parseFloat(String(r.payout ?? 0)), 0)
  const totalPendingMax = awaiting.reduce((s, r) => s + Number(r.reward ?? 0), 0)

  return (
    <div className={`absolute inset-0 overflow-y-auto ${visible ? '' : 'invisible pointer-events-none'}`}>
      <div className="px-4 md:px-6 py-5 md:py-7 space-y-5">
        <div className="flex items-center gap-2">
          <span className="text-emerald-500"><IconReports /></span>
          <div>
            <p className="text-xs font-mono text-slate-300 font-semibold">Bounty Pipeline</p>
            <p className="text-[10px] font-mono text-slate-600">Cipher files → Lila reviews → you submit → mark paid when money lands</p>
          </div>
        </div>

        {/* Financial header — honest */}
        {reports.length > 0 && (
          <div className="rounded-2xl border border-slate-800 bg-slate-900 p-4 grid grid-cols-2 gap-3">
            <div>
              <p className="text-lg font-bold font-mono text-emerald-400 tabular-nums">${totalPaid.toFixed(2)}</p>
              <p className="text-[10px] font-mono text-slate-600">paid · {paid.length} report{paid.length === 1 ? '' : 's'}</p>
            </div>
            <div>
              <p className="text-lg font-bold font-mono text-blue-400 tabular-nums">${totalPendingMax.toFixed(2)}</p>
              <p className="text-[10px] font-mono text-slate-600">max pending · {awaiting.length} submitted</p>
            </div>
          </div>
        )}

        {loading ? (
          <div className="flex items-center gap-2 py-10 justify-center">
            <div className="w-4 h-4 border-2 border-slate-700 border-t-emerald-500 rounded-full animate-spin" />
            <p className="text-xs font-mono text-slate-600">Loading reports...</p>
          </div>
        ) : reports.length === 0 ? (
          <EmptyState
            title="No reports yet."
            subtitle="Cipher files drafts on security bounties automatically."
          />
        ) : (
          <>
            {toSubmit.length > 0 && (
              <section className="space-y-3">
                <p className="text-[10px] font-mono text-amber-400 uppercase tracking-widest">Ready to submit · {toSubmit.length}</p>
                {toSubmit.map(r => <ReportCard key={r.id} report={r} onAction={onAction} onNavigate={onNavigate} />)}
              </section>
            )}
            {awaiting.length > 0 && (
              <section className="space-y-3">
                <p className="text-[10px] font-mono text-blue-400 uppercase tracking-widest">Submitted · awaiting payout · {awaiting.length}</p>
                {awaiting.map(r => <ReportCard key={r.id} report={r} onAction={onAction} onNavigate={onNavigate} />)}
              </section>
            )}
            {paid.length > 0 && (
              <section className="space-y-3">
                <p className="text-[10px] font-mono text-emerald-400 uppercase tracking-widest">Paid · {paid.length}</p>
                {paid.map(r => <ReportCard key={r.id} report={r} onAction={onAction} onNavigate={onNavigate} />)}
              </section>
            )}
            {lilaQueue.length > 0 && (
              <section className="space-y-3">
                <p className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">Lila reviewing · {lilaQueue.length}</p>
                {lilaQueue.map(r => <ReportCard key={r.id} report={r} onAction={onAction} onNavigate={onNavigate} />)}
              </section>
            )}
            {archive.length > 0 && (
              <section className="space-y-3">
                <p className="text-[10px] font-mono text-slate-600 uppercase tracking-widest">Archive · {archive.length}</p>
                {archive.map(r => <ReportCard key={r.id} report={r} onAction={onAction} onNavigate={onNavigate} />)}
              </section>
            )}
          </>
        )}
      </div>
    </div>
  )
}

function ReportCard({ report, onAction, onNavigate }: {
  report: SecurityReport
  onAction: (a: ReportAction) => void
  onNavigate?: NavigateFn
}) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const [payoutInput, setPayoutInput] = useState('')
  const statusCls = REPORT_STATUS_STYLE[report.status] ?? 'bg-slate-800 text-slate-400 border-slate-700'
  const maxBounty = Number(report.reward ?? 0)
  const paidAmount = report.payout != null ? parseFloat(String(report.payout)) : null

  const copy = () => {
    navigator.clipboard.writeText(report.content).then(() => {
      setCopied(true); setTimeout(() => setCopied(false), 2000)
    })
  }

  return (
    <div className="border border-slate-800 rounded-2xl bg-slate-900 overflow-hidden">
      <button className="w-full p-4 text-left" onClick={() => setExpanded(e => !e)}>
        <div className="flex items-start gap-2 mb-2 flex-wrap">
          <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border shrink-0 mt-0.5 ${statusCls}`}>
            {REPORT_STATUS_LABEL[report.status] ?? report.status.toUpperCase()}
          </span>
          {report.kind && report.kind !== 'security' && (
            <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border shrink-0 mt-0.5 ${
              report.kind === 'docs'
                ? 'bg-purple-950 text-purple-300 border-purple-900'
                : 'bg-slate-800 text-slate-400 border-slate-700'
            }`}>
              {report.kind.toUpperCase()}
            </span>
          )}
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

        <div className="flex items-end justify-between mt-2 gap-2">
          <div className="min-w-0">
            {paidAmount !== null && paidAmount > 0 ? (
              <>
                <p className="text-lg font-bold font-mono text-emerald-400 tabular-nums">
                  +${paidAmount.toFixed(2)} paid
                </p>
                <p className="text-[10px] font-mono text-slate-600">
                  max was ${maxBounty.toLocaleString()} {report.chain ?? ''}
                </p>
              </>
            ) : (
              <>
                <p className="text-lg font-bold font-mono text-slate-400 tabular-nums">
                  ${maxBounty.toLocaleString()}
                  <span className="text-[10px] text-slate-700 ml-1 font-normal">max</span>
                </p>
                <p className="text-[10px] font-mono text-slate-600">
                  {report.status === 'submitted' ? 'awaiting payout' : 'not yet earned'} · {report.chain ?? ''}
                </p>
              </>
            )}
          </div>
          <span className={`text-slate-600 text-xs font-mono transition-transform shrink-0 ${expanded ? 'rotate-180' : ''}`}>▾</span>
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
            {onNavigate && (
              <button
                onClick={() => onNavigate({ tab: 'library', notesFilter: 'tasker' })}
                className="flex-1 text-[10px] font-mono text-slate-400 border border-slate-700 rounded-lg py-2 active:bg-slate-800"
              >
                Research notes →
              </button>
            )}
          </div>

          {report.status === 'approved' && (
            <div className="flex gap-2">
              <button
                onClick={() => onAction({ kind: 'submit', id: report.id })}
                className="flex-1 text-[10px] font-mono bg-amber-700 text-white rounded-lg py-2 active:bg-amber-600"
              >
                I submitted it
              </button>
              <button
                onClick={() => onAction({ kind: 'dismiss', id: report.id })}
                className="flex-1 text-[10px] font-mono text-red-400 border border-red-900 rounded-lg py-2 active:opacity-70"
              >
                Dismiss
              </button>
            </div>
          )}

          {report.status === 'submitted' && (
            <div className="space-y-2">
              <p className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">Enter actual payout when money arrives</p>
              <div className="flex gap-2">
                <div className="flex-1 flex items-center bg-slate-950 border border-slate-800 rounded-lg px-3">
                  <span className="text-[11px] font-mono text-slate-500 mr-1">$</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    value={payoutInput}
                    onChange={e => setPayoutInput(e.target.value)}
                    placeholder="0.00"
                    className="flex-1 bg-transparent py-2 text-[11px] font-mono text-emerald-400 placeholder:text-slate-700 focus:outline-none"
                  />
                </div>
                <button
                  onClick={() => {
                    const v = parseFloat(payoutInput)
                    if (!isNaN(v) && v >= 0) {
                      onAction({ kind: 'mark_paid', id: report.id, payout: v })
                      setPayoutInput('')
                    }
                  }}
                  disabled={!payoutInput || isNaN(parseFloat(payoutInput)) || parseFloat(payoutInput) < 0}
                  className="text-[10px] font-mono bg-emerald-700 text-white rounded-lg px-3 py-2 active:bg-emerald-600 disabled:bg-slate-800 disabled:text-slate-600"
                >
                  Mark paid
                </button>
              </div>
              <button
                onClick={() => onAction({ kind: 'mark_paid', id: report.id, payout: 0 })}
                className="w-full text-[10px] font-mono text-slate-500 border border-slate-800 rounded-lg py-1.5 active:bg-slate-800"
              >
                Platform rejected · mark $0 paid
              </button>
            </div>
          )}

          {report.status === 'paid' && (
            <button
              onClick={() => onAction({ kind: 'mark_unpaid', id: report.id })}
              className="w-full text-[10px] font-mono text-slate-500 border border-slate-800 rounded-lg py-1.5 active:bg-slate-800"
            >
              Undo payout (mark back as submitted)
            </button>
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
      <div className="px-4 md:px-6 py-5 md:py-7 space-y-3">
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
          <EmptyState
            title="No bounties found."
            subtitle="Add platform API keys to pull live boards."
          />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {bounties.map(b => {
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
          })}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Floor Tab — 2D scene of agents at their current stations ────────────────
//
// Reads the same /api/notes AgentActivity blob NotesTab uses (polled 30s)
// and renders each agent as a small avatar parked at the station their
// current step maps to. No new endpoints, no canvas/SVG — just CSS Grid +
// Tailwind. Step changes naturally re-mount the avatar in the new station;
// `transition-opacity` smooths the swap and a brief ping ring fires while
// last_ts is fresh.

type FloorStation =
  | 'news' | 'charts' | 'writing'
  | 'brief' | 'bench' | 'broadcast'
  | 'draft' | 'ratings' | 'jobs'
  | 'studio'
  | 'lounge' | 'offshift'

interface FloorAgent {
  key: 'lila' | 'cipher' | 'vega' | 'forge' | 'scout' | 'ceelo' | 'artist'
  letter: string
  display: string
  ring: string
  text: string
  glow: string
  station: FloorStation
  status?: string
  lastTs: number | null
}

const FLOOR_STATIONS: { id: FloorStation; label: string }[] = [
  { id: 'news',      label: 'News desk' },
  { id: 'charts',    label: 'Charts'    },
  { id: 'writing',   label: 'Writing'   },
  { id: 'brief',     label: 'Brief'     },
  { id: 'bench',     label: 'Bench'     },
  { id: 'broadcast', label: 'Broadcast' },
  { id: 'draft',     label: 'Draft'     },
  { id: 'ratings',   label: 'Ratings'   },
  { id: 'jobs',      label: 'Jobs'      },
]

function vegaStation(step: string): FloorStation {
  switch (step) {
    case 'T0': return 'lounge'
    case 'T1': return 'news'
    case 'T2': return 'charts'
    case 'T3': return 'writing'
    case 'F0': return 'brief'
    case 'M0':
    case 'M1': return 'broadcast'
    default:   return 'lounge'
  }
}

function cipherFloorStation(step: string): FloorStation {
  switch (step) {
    case 'BT0': return 'brief'
    case 'BH0': return 'bench'
    case 'BZ0': return 'broadcast'
    default:    return 'bench'
  }
}

function FloorTab({ visible, agentData }: {
  visible: boolean
  agentData: AgentData | null
}) {
  const [activity, setActivity] = useState<AgentActivity | null>(null)
  const [synced, setSynced] = useState<number | null>(null)
  // Heartbeat so "Xs ago" labels and 60s/5m thresholds re-evaluate live.
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!visible) return
    const load = async () => {
      try {
        const res = await fetch('/api/notes')
        if (!res.ok) return
        const d: NotesData = await res.json()
        setActivity(d.activity)
        setSynced(Date.now())
      } catch { /* ignore */ }
    }
    load()
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [visible])

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const agents = useMemo<FloorAgent[]>(() => {
    if (!activity) return []
    const list: FloorAgent[] = []

    // Lila — always at the lounge.
    list.push({
      key: 'lila',
      letter: 'L',
      display: 'lila',
      ring: 'bg-emerald-900 border-emerald-700',
      text: 'text-emerald-300',
      glow: 'shadow-[0_0_20px_rgba(16,185,129,0.55)]',
      station: 'lounge',
      status: activity.lila?.last_chat_ts
        ? `last chat ${fmtAge(activity.lila.last_chat_ts)}`
        : 'standing by',
      lastTs: activity.lila?.last_chat_ts ?? null,
    })

    // Vega — equities analyst.
    if (activity.vega) {
      list.push({
        key: 'vega',
        letter: 'V',
        display: 'vega',
        ring: 'bg-blue-900 border-blue-700',
        text: 'text-blue-300',
        glow: 'shadow-[0_0_20px_rgba(96,165,250,0.55)]',
        station: vegaStation(activity.vega.step),
        status: `${activity.vega.step} · ${vegaStepLabel(activity.vega.step)}`,
        lastTs: activity.vega.last_ts,
      })
    } else {
      list.push({ key: 'vega', letter: 'V', display: 'vega', ring: 'bg-blue-900 border-blue-700', text: 'text-blue-300', glow: '', station: 'offshift', status: 'off-shift', lastTs: null })
    }

    // Cipher — bounty operator.
    if (activity.cipher) {
      const target = activity.cipher.target?.title
      list.push({
        key: 'cipher',
        letter: 'C',
        display: 'cipher',
        ring: 'bg-amber-950 border-amber-800',
        text: 'text-amber-300',
        glow: 'shadow-[0_0_20px_rgba(251,191,36,0.55)]',
        station: cipherFloorStation(activity.cipher.step),
        status: target
          ? `${activity.cipher.step} · ${cipherStepLabel(activity.cipher.step)} · "${target}"`
          : `${activity.cipher.step} · ${cipherStepLabel(activity.cipher.step)}`,
        lastTs: activity.cipher.last_ts,
      })
    } else {
      list.push({ key: 'cipher', letter: 'C', display: 'cipher', ring: 'bg-amber-950 border-amber-800', text: 'text-amber-300', glow: '', station: 'offshift', status: 'off-shift', lastTs: null })
    }

    // Forge — PR drafter. v1: lives at DRAFT iff Lila has any active task.
    const forgeAlive = !!(agentData?.activeTasks?.length)
    list.push({
      key: 'forge',
      letter: 'F',
      display: 'forge',
      ring: 'bg-purple-950 border-purple-800',
      text: 'text-purple-300',
      glow: 'shadow-[0_0_20px_rgba(192,132,252,0.55)]',
      station: forgeAlive ? 'draft' : 'offshift',
      status: forgeAlive ? 'drafting…' : 'off-shift',
      lastTs: forgeAlive ? now : null,
    })

    // Scout — job board.
    if (activity.scout) {
      list.push({
        key: 'scout',
        letter: 'S',
        display: 'scout',
        ring: 'bg-slate-800 border-slate-600',
        text: 'text-slate-300',
        glow: 'shadow-[0_0_20px_rgba(148,163,184,0.55)]',
        station: 'jobs',
        status: `scanned ${activity.scout.scanned} · reported ${activity.scout.reported}`,
        lastTs: activity.scout.last_ts,
      })
    } else {
      list.push({ key: 'scout', letter: 'S', display: 'scout', ring: 'bg-slate-800 border-slate-600', text: 'text-slate-300', glow: '', station: 'offshift', status: 'off-shift', lastTs: null })
    }

    // Ceelo — sports ratings.
    if (activity.ceelo) {
      list.push({
        key: 'ceelo',
        letter: 'Ce',
        display: 'ceelo',
        ring: 'bg-rose-950 border-rose-800',
        text: 'text-rose-300',
        glow: 'shadow-[0_0_20px_rgba(251,113,133,0.55)]',
        station: 'ratings',
        status: `rated ${activity.ceelo.rated} · upcoming ${activity.ceelo.upcoming}`,
        lastTs: activity.ceelo.last_ts,
      })
    } else {
      list.push({ key: 'ceelo', letter: 'Ce', display: 'ceelo', ring: 'bg-rose-950 border-rose-800', text: 'text-rose-300', glow: '', station: 'offshift', status: 'off-shift', lastTs: null })
    }

    // Artist — autonomous painter. Lives at the Studio when alive,
    // off-shift otherwise (FAL_API_KEY not set, or no piece yet).
    if (activity.artist) {
      list.push({
        key: 'artist',
        letter: 'A',
        display: 'artist',
        ring: 'bg-fuchsia-950 border-fuchsia-800',
        text: 'text-fuchsia-300',
        glow: 'shadow-[0_0_20px_rgba(232,121,249,0.55)]',
        station: 'studio',
        status: `cycle ${activity.artist.cycle} · ${activity.artist.total_pieces} pieces`,
        lastTs: activity.artist.last_ts,
      })
    } else {
      list.push({ key: 'artist', letter: 'A', display: 'artist', ring: 'bg-fuchsia-950 border-fuchsia-800', text: 'text-fuchsia-300', glow: '', station: 'offshift', status: 'off-shift', lastTs: null })
    }

    return list
  }, [activity, agentData, now])

  const byStation = useMemo(() => {
    const map = new Map<FloorStation, FloorAgent[]>()
    for (const a of agents) {
      const list = map.get(a.station) ?? []
      list.push(a)
      map.set(a.station, list)
    }
    return map
  }, [agents])

  const offshift = byStation.get('offshift') ?? []

  return (
    <div className={`absolute inset-0 overflow-y-auto ${visible ? '' : 'invisible pointer-events-none'}`}>
      <div className="px-4 md:px-6 py-5 md:py-7 space-y-4">
        <div className="flex items-baseline justify-between">
          <div>
            <p className="text-xs font-mono text-slate-300 font-semibold">The Floor</p>
            <p className="text-[10px] font-mono text-slate-600">
              {synced ? `live · synced ${fmtAge(synced)}` : 'connecting…'}
            </p>
          </div>
          <p className="text-[9px] font-mono text-slate-700 tracking-[0.28em] uppercase">▓▓▓ park</p>
        </div>

        {!activity && (
          <p className="text-xs font-mono text-slate-700 px-1">Waiting for agent state…</p>
        )}

        {activity && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {FLOOR_STATIONS.map(s => (
                <FloorStation
                  key={s.id}
                  label={s.label}
                  agents={byStation.get(s.id) ?? []}
                  now={now}
                />
              ))}
            </div>

            <StudioStation
              agents={byStation.get('studio') ?? []}
              latestId={activity.artist?.latest_id ?? null}
              now={now}
            />

            <FloorStation
              label="Lounge"
              agents={byStation.get('lounge') ?? []}
              now={now}
              wide
            />

            {offshift.length > 0 && (
              <div className="rounded-2xl border border-dashed border-slate-800 bg-slate-950/50 p-3 md:p-4">
                <p className="text-[10px] md:text-[11px] font-mono text-slate-700 uppercase tracking-[0.2em]">Off-shift</p>
                <div className="flex flex-wrap items-center gap-3 mt-2">
                  {offshift.map(a => <FloorAvatar key={a.key} a={a} now={now} dim />)}
                </div>
              </div>
            )}

            <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-[9px] md:text-[10px] font-mono text-slate-700">
              <span className="inline-flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                acted &lt; 60s
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
                idle 1–5m
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-slate-700" />
                idle &gt; 5m
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function StudioStation({ agents, latestId, now }: {
  agents: FloorAgent[]
  latestId: number | null
  now: number
}) {
  const active = agents.length > 0
  const thumbSrc = latestId != null ? `/api/artist/image/${latestId}` : null
  return (
    <div
      className={`relative rounded-2xl border bg-slate-900 overflow-hidden transition-colors ${
        active ? 'border-fuchsia-900/60' : 'border-slate-800'
      }`}
    >
      <div className="flex items-stretch gap-0">
        <div className="shrink-0 w-20 h-20 md:w-28 md:h-28 bg-slate-950 border-r border-slate-800 flex items-center justify-center overflow-hidden">
          {thumbSrc ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={thumbSrc}
              alt="latest piece"
              className="w-full h-full object-cover"
            />
          ) : (
            <span className="text-[9px] font-mono text-slate-700 tracking-widest uppercase">no piece yet</span>
          )}
        </div>
        <div className="flex-1 min-w-0 p-4 flex flex-col justify-center">
          <div className="flex items-baseline justify-between">
            <p className="text-[10px] md:text-[11px] font-mono text-fuchsia-500 uppercase tracking-[0.2em]">
              Studio
            </p>
            {active && (
              <span className="text-[9px] font-mono text-fuchsia-400/70 tracking-wider uppercase">
                ▶ live
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-start gap-3 mt-2">
            {agents.length > 0
              ? agents.map(a => <FloorAvatar key={a.key} a={a} now={now} />)
              : <p className="text-[10px] font-mono text-slate-700">artist off-shift — set FAL_API_KEY to wake.</p>
            }
          </div>
        </div>
      </div>
    </div>
  )
}

function FloorStation({ label, agents, now, wide = false }: {
  label: string
  agents: FloorAgent[]
  now: number
  wide?: boolean
}) {
  const active = agents.length > 0
  return (
    <div
      className={`relative rounded-2xl border bg-slate-900 p-4 transition-colors ${
        active ? 'border-slate-700' : 'border-slate-800'
      } ${wide ? 'min-h-[88px]' : 'min-h-[120px]'}`}
    >
      <div className="flex items-baseline justify-between">
        <p className="text-[10px] md:text-[11px] font-mono text-emerald-600 uppercase tracking-[0.2em]">
          {label}
        </p>
        {active && (
          <span className="text-[9px] font-mono text-emerald-500/70 tracking-wider uppercase">
            ▶ live
          </span>
        )}
      </div>
      <div className={`flex flex-wrap items-start gap-3 mt-3 ${wide ? 'md:gap-4' : ''}`}>
        {agents.map(a => <FloorAvatar key={a.key} a={a} now={now} />)}
      </div>
    </div>
  )
}

function FloorAvatar({ a, now, dim = false }: {
  a: FloorAgent
  now: number
  dim?: boolean
}) {
  const age = a.lastTs != null ? now - a.lastTs : null
  const recent = age != null && age < 60_000
  const idle   = age != null && age > 5 * 60_000
  const opacityCls = dim ? 'opacity-40' : (idle ? 'opacity-50' : '')
  return (
    <div className={`flex items-center gap-2 transition-opacity duration-500 ${opacityCls}`}>
      <span
        className={`relative w-9 h-9 md:w-10 md:h-10 rounded-full border ${a.ring} flex items-center justify-center text-[12px] md:text-[13px] font-mono font-semibold ${a.text} ${recent ? a.glow : ''} transition-shadow duration-500`}
      >
        {a.letter}
        {recent && (
          <span className={`absolute inset-[-2px] rounded-full border ${a.ring} animate-ping opacity-40`} />
        )}
      </span>
      <div className="min-w-0">
        <p className={`text-[10px] md:text-[11px] font-mono ${a.text} leading-tight truncate max-w-[200px]`}>
          {a.display}
        </p>
        {a.status && (
          <p className="text-[9px] md:text-[10px] font-mono text-slate-600 leading-tight truncate max-w-[220px]">
            {a.status}
          </p>
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
  const [financials, setFinancials] = useState<{ paidMtd: number; pendingMax: number; pendingCount: number } | null>(null)
  // Pre-filter the Notes tab when the operator deep-links from elsewhere
  // (TargetCard → Cipher plans, ReportCard → Cipher, etc).
  const [notesFilter, setNotesFilter] = useState<NoteFilter>('all')
  // Library tab inner mode: Reports (default; actionable items) or Notes.
  const [libraryMode, setLibraryMode] = useState<'reports' | 'notes' | 'articles'>('reports')
  // Badge count for unread chat messages (since the operator last opened
  // the Chat tab). Reset when they switch back to Chat.
  const [chatSeenId, setChatSeenId] = useState(0)
  const [chatLatestId, setChatLatestId] = useState(0)
  const prevEarned = useRef<number | null>(null)

  const setTabWithSeen = useCallback((t: Tab) => {
    if (t === 'chat') setChatSeenId(chatLatestId)
    setTab(t)
  }, [chatLatestId])

  const navigate: NavigateFn = useCallback((to) => {
    if (to.notesFilter) {
      setNotesFilter(to.notesFilter)
      setLibraryMode('notes')
    }
    if (to.libraryMode) setLibraryMode(to.libraryMode)
    setTab(to.tab)
  }, [])

  // Financial summary for Dash (paid MTD, pending). Polled cheaply.
  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch('/api/costs')
        if (!res.ok) return
        const d = await res.json()
        setFinancials({
          paidMtd: Number(d.earnings_paid_mtd ?? 0),
          pendingMax: Number(d.pending_max ?? 0),
          pendingCount: Number(d.pending_count ?? 0),
        })
      } catch { /* ignore */ }
    }
    load()
    const id = setInterval(load, 20_000)
    return () => clearInterval(id)
  }, [])

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

  // Chat unread tracker: poll latest message id and compare to lastSeen.
  // Also load reports continuously so the Reports-tab badge counts
  // approved items even when the operator never opens that tab.
  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch('/api/chat/messages?after=0')
        if (!res.ok) return
        const { messages }: { messages: { id: number }[] } = await res.json()
        const maxId = messages.reduce((m, x) => Math.max(m, x.id), 0)
        setChatLatestId(maxId)
        if (tab === 'chat') setChatSeenId(maxId)
      } catch { /* ignore */ }
    }
    poll()
    const id = setInterval(poll, 10_000)
    return () => clearInterval(id)
  }, [tab])

  useEffect(() => {
    const id = setInterval(() => {
      // Reuse the same endpoint the Reports tab uses; Home already lets
      // loadReports run on the reports tab. This keeps the badge live
      // without blocking on tab switch.
      fetch('/api/reports')
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (Array.isArray(d)) setReports(d) })
        .catch(() => {})
    }, 30_000)
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

  useEffect(() => { if (tab === 'library' && libraryMode === 'reports') loadReports() }, [tab, libraryMode, loadReports])

  const reportAction = useCallback(async (a: ReportAction) => {
    const body: Record<string, unknown> = { id: a.id, action: a.kind }
    if (a.kind === 'mark_paid') body.payout = a.payout
    await fetch('/api/reports', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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

  const navBadges = {
    chat:    tab === 'chat' ? 0 : Math.max(0, chatLatestId - chatSeenId),
    library: reports.filter(r => r.status === 'approved' || r.status === 'pending_review').length,
  }

  return (
    // Root: side rail (md+) + main column. On phones the rail is hidden and
    // the bottom nav handles tabs. The main column is centered and capped
    // wider on iPad than the legacy 448px phone column.
    <div className="h-dvh flex bg-slate-950 select-none">
      <SideNav tab={tab} onTab={setTabWithSeen} badges={navBadges} />

      <div className="flex-1 flex justify-center min-w-0">
        <div className="w-full max-w-md md:max-w-3xl lg:max-w-5xl flex flex-col min-h-0">
          {/* Header */}
          <header
            className="shrink-0 px-5 md:px-8 py-3 md:py-4 border-b border-slate-800/60 flex items-center justify-between"
            style={{ paddingTop: 'max(12px, env(safe-area-inset-top))' }}
          >
            <div className="flex items-center gap-2.5 md:gap-3.5">
              <span className={`w-2 h-2 md:w-2.5 md:h-2.5 rounded-full shrink-0 ${status === 'live' ? 'bg-emerald-500 animate-pulse' : status === 'error' ? 'bg-red-500' : 'bg-slate-600 animate-pulse'}`} />
              <div>
                <div className="flex items-baseline gap-2">
                  <span className="text-white font-bold text-lg md:text-xl tracking-tight">Lila</span>
                  <span className="text-slate-700 font-mono text-[10px] md:text-[11px] tracking-widest">AGENT v1</span>
                </div>
                <p className="text-[8px] md:text-[9px] font-mono text-slate-800 tracking-[0.2em] uppercase mt-0.5">
                  ▓ PARKSYSTEMS CORP
                </p>
              </div>
            </div>
            {data && (
              <div className="text-right">
                <p className={`text-sm md:text-base font-mono font-bold tabular-nums transition-colors duration-300 ${flash ? 'text-emerald-300' : 'text-emerald-500'}`}>
                  ${data.totalEarned.toFixed(2)}
                </p>
                <p className="text-[9px] md:text-[10px] font-mono text-slate-700 uppercase tracking-widest">earned</p>
              </div>
            )}
          </header>

          {/* Tab content */}
          <main className="flex-1 relative overflow-hidden">
            <ChatTab visible={tab === 'chat'} />
            <DashTab data={data} flash={flash} visible={tab === 'dash'} financials={financials} onNavigate={navigate} />
            <FloorTab visible={tab === 'floor'} agentData={data} />
            <TradingTab visible={tab === 'trading'} />
            <BountiesTab
              bounties={bounties}
              assignedBounty={assignedBounty}
              loading={bountiesLoading}
              visible={tab === 'bounties'}
              onAssign={setAssignedBounty}
            />
            <LibraryTab
              visible={tab === 'library'}
              mode={libraryMode}
              onModeChange={setLibraryMode}
              reports={reports}
              reportsLoading={reportsLoading}
              onReportAction={reportAction}
              onNavigate={navigate}
              notesFilter={notesFilter}
              onNotesFilterChange={setNotesFilter}
            />
            <PicksTab visible={tab === 'picks'} />
            <DeskTab visible={tab === 'desk'} />
          </main>

          <BottomNav tab={tab} onTab={setTabWithSeen} badges={navBadges} />
        </div>
      </div>
    </div>
  )
}
