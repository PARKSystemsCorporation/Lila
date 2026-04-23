'use client'

import { useEffect, useState, useRef, useCallback } from 'react'

interface LogEntry {
  id: number
  message: string
  timestamp: number
  type: 'info' | 'success' | 'warn'
}

interface Bounty {
  name: string
  value: number
  time: number
}

interface AgentData {
  totalEarned: number
  activeTasks: string[]
  lastBounty: Bounty
  log: LogEntry[]
}

const TYPE_COLOR: Record<LogEntry['type'], string> = {
  info: 'text-slate-400',
  success: 'text-emerald-400',
  warn: 'text-amber-400',
}

const TYPE_PREFIX: Record<LogEntry['type'], string> = {
  info: '›',
  success: '✓',
  warn: '⚠',
}

function fmt(ts: number) {
  return new Date(ts).toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function fmtAge(ts: number) {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  return `${Math.floor(m / 60)}h ago`
}

export default function Home() {
  const [tab, setTab] = useState<'log' | 'dashboard'>('log')
  const [data, setData] = useState<AgentData | null>(null)
  const [status, setStatus] = useState<'connecting' | 'live' | 'error'>('connecting')
  const [tick, setTick] = useState(0)
  const prevEarned = useRef<number | null>(null)
  const [flash, setFlash] = useState(false)

  const poll = useCallback(async () => {
    try {
      const res = await window.fetch('/api/agent')
      if (!res.ok) throw new Error()
      const json: AgentData = await res.json()

      if (prevEarned.current !== null && json.totalEarned > prevEarned.current) {
        setFlash(true)
        setTimeout(() => setFlash(false), 800)
      }
      prevEarned.current = json.totalEarned
      setData(json)
      setStatus('live')
    } catch {
      setStatus('error')
    }
  }, [])

  useEffect(() => {
    poll()
    const id = setInterval(() => {
      poll()
      setTick((t) => t + 1)
    }, 5000)
    return () => clearInterval(id)
  }, [poll])

  // Re-render age timestamps every second
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="flex flex-col h-dvh max-w-md mx-auto bg-slate-950 overflow-hidden">
      {/* Header */}
      <header className="shrink-0 px-5 pt-safe pt-5 pb-4 border-b border-slate-800/70 bg-slate-950">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span
              className={`w-2 h-2 rounded-full ${
                status === 'live'
                  ? 'bg-emerald-500 animate-pulse'
                  : status === 'error'
                  ? 'bg-red-500'
                  : 'bg-slate-600 animate-pulse'
              }`}
            />
            <span className="text-[10px] font-mono tracking-widest uppercase text-slate-500">
              {status === 'live' ? 'Live' : status === 'error' ? 'Disconnected' : 'Connecting'}
            </span>
          </div>
          <span className="text-[10px] font-mono text-slate-700 tracking-widest">
            {tick > 0 ? `POLL #${tick}` : ''}
          </span>
        </div>
        <div className="mt-1.5 flex items-baseline gap-3">
          <h1 className="text-3xl font-bold tracking-tight text-white">Lila</h1>
          <span className="text-xs font-mono text-slate-600">v1.0 · Autonomous Agent</span>
        </div>
      </header>

      {/* Tabs */}
      <div className="shrink-0 flex border-b border-slate-800/70 bg-slate-950">
        {(['log', 'dashboard'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-3 text-xs font-mono uppercase tracking-widest transition-colors ${
              tab === t
                ? 'text-emerald-400 border-b-2 border-emerald-500 bg-slate-900/40'
                : 'text-slate-600 hover:text-slate-400'
            }`}
          >
            {t === 'log' ? "Lila's Log" : 'Dashboard'}
          </button>
        ))}
      </div>

      {/* Content */}
      <main className="flex-1 overflow-y-auto overscroll-contain">
        {status === 'connecting' ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-slate-600">
            <div className="w-5 h-5 border-2 border-slate-700 border-t-emerald-500 rounded-full animate-spin" />
            <p className="text-xs font-mono tracking-widest uppercase">Establishing link</p>
          </div>
        ) : status === 'error' ? (
          <div className="flex flex-col items-center justify-center h-full gap-2">
            <p className="text-sm font-mono text-red-400">Connection lost.</p>
            <p className="text-xs font-mono text-slate-600">She'll be back.</p>
          </div>
        ) : tab === 'log' ? (
          <LogTab log={data?.log ?? []} />
        ) : (
          <DashboardTab data={data} flash={flash} />
        )}
      </main>

      {/* Footer */}
      <footer className="shrink-0 px-4 py-2.5 border-t border-slate-800/70 bg-slate-950 text-center">
        <p className="text-[10px] font-mono text-slate-800 tracking-widest">
          LILA AGENT · RAILWAY · {new Date().getFullYear()}
        </p>
      </footer>
    </div>
  )
}

function LogTab({ log }: { log: LogEntry[] }) {
  return (
    <div className="px-4 py-4 space-y-3.5">
      {log.length === 0 ? (
        <p className="text-xs font-mono text-slate-600 pt-8 text-center">Initializing log...</p>
      ) : (
        log.map((entry) => (
          <div key={entry.id} className="flex gap-3 items-start">
            <span className={`font-mono text-sm shrink-0 w-4 text-center ${TYPE_COLOR[entry.type]}`}>
              {TYPE_PREFIX[entry.type]}
            </span>
            <div className="min-w-0">
              <p className={`text-sm font-mono leading-snug break-words ${TYPE_COLOR[entry.type]}`}>
                {entry.message}
              </p>
              <p className="text-[10px] text-slate-700 font-mono mt-0.5">{fmt(entry.timestamp)}</p>
            </div>
          </div>
        ))
      )}
    </div>
  )
}

function DashboardTab({ data, flash }: { data: AgentData | null; flash: boolean }) {
  if (!data) return null

  return (
    <div className="px-4 py-5 space-y-4">
      {/* Total Earned */}
      <div
        className={`rounded-xl border p-5 transition-colors duration-300 ${
          flash ? 'border-emerald-500 bg-emerald-950/30' : 'border-slate-800 bg-slate-900'
        }`}
      >
        <p className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mb-1">
          Total Earned
        </p>
        <p
          className={`text-5xl font-bold font-mono tabular-nums transition-colors duration-300 ${
            flash ? 'text-emerald-300' : 'text-emerald-400'
          }`}
        >
          ${data.totalEarned.toFixed(2)}
        </p>
        <p className="text-[10px] text-slate-700 font-mono mt-2">
          Refreshes every 5s. Real work, real numbers.
        </p>
      </div>

      {/* Active Tasks */}
      <div className="rounded-xl border border-slate-800 bg-slate-900 p-5">
        <div className="flex items-center justify-between mb-3">
          <p className="text-[10px] font-mono text-slate-500 uppercase tracking-widest">
            Active Tasks
          </p>
          <span
            className={`text-[10px] font-mono px-2 py-0.5 rounded-full ${
              data.activeTasks.length > 0
                ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                : 'bg-slate-800 text-slate-600'
            }`}
          >
            {data.activeTasks.length} running
          </span>
        </div>
        {data.activeTasks.length === 0 ? (
          <p className="text-sm text-slate-600 font-mono">Queue empty. Scanning for the next one.</p>
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
      <div className="rounded-xl border border-slate-800 bg-slate-900 p-5">
        <p className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mb-2">
          Last Bounty Claimed
        </p>
        <p className="text-sm text-slate-200 font-mono leading-snug">{data.lastBounty.name}</p>
        <div className="flex justify-between items-center mt-3">
          <span className="text-xl font-bold text-emerald-400 font-mono tabular-nums">
            +${data.lastBounty.value}
          </span>
          <span className="text-[10px] text-slate-600 font-mono">{fmtAge(data.lastBounty.time)}</span>
        </div>
      </div>

      {/* Status Bar */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4 flex items-center gap-3">
        <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse shrink-0" />
        <div>
          <p className="text-[10px] font-mono text-emerald-500 uppercase tracking-widest">
            Systems operational
          </p>
          <p className="text-[10px] text-slate-600 font-mono mt-0.5">
            Lila is running. You don't need to do anything.
          </p>
        </div>
      </div>
    </div>
  )
}
