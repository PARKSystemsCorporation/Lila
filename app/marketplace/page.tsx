'use client'

// Park Gates marketplace. Right now there is exactly one product:
// 1 DM to Lila / Ceelo / Vega for 10 PG. Adding more products later
// means adding tiles + matching API routes — schema (viewer_dms, ledger)
// already supports the spend pattern.

import Link from 'next/link'
import { useEffect, useState } from 'react'

const DM_COST = 10

type AgentKey = 'lila' | 'ceelo' | 'vega'

interface AgentSpec {
  key: AgentKey
  name: string
  role: string
  blurb: string
  accent: 'emerald' | 'rose' | 'blue'
}

const AGENTS: AgentSpec[] = [
  { key: 'lila',  name: 'LILA',  role: 'manager · trades · bounties', blurb: 'Markets, securities, ops. The desk manager. Replies in chat-tone.',     accent: 'emerald' },
  { key: 'ceelo', name: 'CEELO', role: 'nfl handicapper',              blurb: 'Math vs. the book. Edge percentages, fair lines, model spreads.',       accent: 'rose'    },
  { key: 'vega',  name: 'VEGA',  role: 'analyst · stocks',             blurb: 'Watchlists, news scans, picks with tight stops. Equities focus.',        accent: 'blue'    },
]

const ACCENT: Record<AgentSpec['accent'], { ring: string; text: string; bg: string; btn: string; dot: string }> = {
  emerald: { ring: 'border-emerald-500/50 hover:border-emerald-300', text: 'text-emerald-300', bg: 'bg-emerald-500/[0.04]', btn: 'bg-emerald-500 hover:bg-emerald-400 text-black', dot: 'bg-emerald-400' },
  rose:    { ring: 'border-rose-500/50 hover:border-rose-300',       text: 'text-rose-300',    bg: 'bg-rose-500/[0.04]',    btn: 'bg-rose-500 hover:bg-rose-400 text-black',       dot: 'bg-rose-400' },
  blue:    { ring: 'border-blue-500/50 hover:border-blue-300',       text: 'text-blue-300',    bg: 'bg-blue-500/[0.04]',    btn: 'bg-blue-500 hover:bg-blue-400 text-black',       dot: 'bg-blue-400' },
}

interface DM {
  id: number
  agent: string
  prompt: string
  reply: string | null
  cost_pg: number
  status: string
  created_ts: number
  answered_ts: number | null
}

export default function Marketplace() {
  const [pg, setPg] = useState<number | null>(null)
  const [composeFor, setComposeFor] = useState<AgentKey | null>(null)
  const [dms, setDms] = useState<DM[]>([])

  const refresh = () => {
    fetch('/api/viewer/wallet', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d && typeof d.park_gates === 'number') setPg(d.park_gates) })
      .catch(() => {})
    fetch('/api/viewer/dms', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d && Array.isArray(d.dms)) setDms(d.dms) })
      .catch(() => {})
  }

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 30_000)
    return () => clearInterval(id)
  }, [])

  return (
    <main className="min-h-dvh w-full bg-[#0a0c14] text-slate-100 selection:bg-amber-500/30 selection:text-amber-100">
      <div
        className="pointer-events-none fixed inset-0 -z-10 opacity-30"
        style={{
          backgroundImage:
            'linear-gradient(rgba(245,158,11,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(245,158,11,0.06) 1px, transparent 1px)',
          backgroundSize: '64px 64px',
        }}
      />

      <header className="sticky top-0 z-30 border-b-2 border-amber-500/20 bg-[#0a0c14]/85 backdrop-blur-md">
        <div className="mx-auto max-w-5xl px-4 sm:px-8 py-3 flex items-center justify-between gap-3">
          <Link href="/viewer" className="group flex items-center gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
            <span className="font-mono text-[10px] tracking-[0.32em] text-amber-500/80 uppercase group-hover:text-amber-300 transition-colors">
              ▓ park · marketplace
            </span>
          </Link>
          <div className="flex items-center gap-3">
            <span className="font-mono text-[10px] tracking-[0.32em] text-amber-300 uppercase tabular-nums border-2 border-amber-700/60 px-2.5 py-1.5">
              ◆ {pg == null ? '—' : pg} PG
            </span>
            <Link
              href="/viewer"
              className="font-mono text-[10px] tracking-[0.32em] text-slate-500 hover:text-amber-300 uppercase transition-colors hidden sm:inline"
            >
              ← viewer
            </Link>
          </div>
        </div>
      </header>

      <section className="mx-auto max-w-5xl px-4 sm:px-8 pt-10 sm:pt-16 pb-8">
        <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-amber-500/80 uppercase">
          ▌▌▌ marketplace
        </p>
        <h1 className="mt-2 text-[clamp(2rem,7vw,4.4rem)] font-black tracking-tight leading-[0.92] uppercase">
          spend <span className="text-amber-400">park gates</span>.
        </h1>
        <p className="mt-4 max-w-2xl text-sm sm:text-base text-slate-400 leading-relaxed">
          50 free Park Gates land in your wallet at the start of every active month.
          Spend them on direct messages with the desk. More products soon — alerts,
          long-form reports, edge unlocks.
        </p>
      </section>

      <section className="mx-auto max-w-5xl px-4 sm:px-8 pb-12">
        <div className="flex items-baseline justify-between gap-3 mb-4 sm:mb-6">
          <h2 className="font-mono text-[11px] tracking-[0.45em] text-amber-500/80 uppercase">
            ▌ direct messages · {DM_COST} PG each
          </h2>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
          {AGENTS.map((a) => {
            const c = ACCENT[a.accent]
            const canAfford = (pg ?? 0) >= DM_COST
            return (
              <article key={a.key} className={`relative border-2 ${c.ring} ${c.bg} p-5 sm:p-6 transition-all duration-300`}>
                <div className="flex items-center justify-between mb-4">
                  <span className={`font-mono text-[10px] tracking-[0.32em] uppercase ${c.text}`}>{a.role}</span>
                  <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
                </div>
                <div className={`text-[clamp(2rem,5vw,2.8rem)] font-black tracking-tight ${c.text} leading-[0.95]`}>{a.name}</div>
                <p className="mt-3 font-mono text-[11px] leading-relaxed text-slate-400">{a.blurb}</p>
                <button
                  onClick={() => setComposeFor(a.key)}
                  disabled={!canAfford && pg !== null}
                  className={`mt-5 w-full font-mono text-[11px] tracking-[0.32em] uppercase px-3 py-3 transition-colors ${
                    canAfford || pg === null
                      ? c.btn
                      : 'border-2 border-slate-800 text-slate-600 cursor-not-allowed'
                  }`}
                >
                  {canAfford || pg === null ? `send · ${DM_COST} pg →` : 'insufficient · need ' + DM_COST + ' pg'}
                </button>
              </article>
            )
          })}
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-4 sm:px-8 pb-16">
        <h2 className="font-mono text-[11px] tracking-[0.45em] text-amber-500/80 uppercase mb-4">
          ▌ your messages
        </h2>
        {dms.length === 0 ? (
          <p className="font-mono text-[11px] text-slate-600 border-2 border-slate-800 px-4 py-6 text-center">
            no messages yet · queue one above
          </p>
        ) : (
          <ul className="space-y-2">
            {dms.map((dm) => <DmRow key={dm.id} dm={dm} />)}
          </ul>
        )}
      </section>

      {composeFor && (
        <ComposeModal
          agent={composeFor}
          onClose={() => setComposeFor(null)}
          onSent={() => { setComposeFor(null); refresh() }}
        />
      )}
    </main>
  )
}

function DmRow({ dm }: { dm: DM }) {
  const accent: 'emerald' | 'rose' | 'blue' = dm.agent === 'lila' ? 'emerald' : dm.agent === 'ceelo' ? 'rose' : 'blue'
  const c = ACCENT[accent]
  return (
    <li className={`border-2 ${c.ring} bg-slate-950/40 p-4`}>
      <div className="flex items-center justify-between gap-3 mb-2">
        <span className={`font-mono text-[10px] tracking-[0.32em] uppercase ${c.text}`}>{dm.agent}</span>
        <span className="font-mono text-[9px] tracking-[0.3em] uppercase text-slate-600 tabular-nums">
          {fmtRel(dm.created_ts)} · −{dm.cost_pg} PG · {dm.status}
        </span>
      </div>
      <p className="font-mono text-[11px] leading-relaxed text-slate-200 whitespace-pre-wrap">{dm.prompt}</p>
      {dm.reply ? (
        <div className="mt-3 pt-3 border-t border-slate-800/70">
          <p className="font-mono text-[9px] tracking-[0.3em] uppercase text-slate-500 mb-1">
            reply · {dm.answered_ts ? fmtRel(dm.answered_ts) : ''}
          </p>
          <p className="font-mono text-[11px] leading-relaxed text-slate-100 whitespace-pre-wrap">{dm.reply}</p>
        </div>
      ) : (
        <p className="mt-3 font-mono text-[10px] tracking-[0.25em] uppercase text-slate-600">awaiting reply…</p>
      )}
    </li>
  )
}

function ComposeModal({ agent, onClose, onSent }: { agent: AgentKey; onClose: () => void; onSent: () => void }) {
  const a = AGENTS.find((x) => x.key === agent)!
  const c = ACCENT[a.accent]
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const send = async () => {
    if (busy) return
    const trimmed = prompt.trim()
    if (trimmed.length < 4) { setError('write a real question'); return }
    setBusy(true); setError(null)
    try {
      const res = await fetch('/api/marketplace/dm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent, prompt: trimmed }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        if (body?.error === 'insufficient') setError(`need ${DM_COST} PG · you have ${body.remaining ?? 0}`)
        else if (body?.error === 'inactive') setError('subscription not active')
        else if (body?.error === 'unauthorized') setError('please sign in again')
        else setError(body?.error ?? 'send failed')
        setBusy(false)
        return
      }
      onSent()
    } catch (e) {
      setError(String(e).slice(0, 120))
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-3 sm:p-6" onClick={onClose}>
      <div
        className={`w-full max-w-lg border-2 ${c.ring} bg-[#0a0c14] p-5 sm:p-6`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <p className={`font-mono text-[10px] tracking-[0.32em] uppercase ${c.text}`}>
            ▌ direct message · {a.name}
          </p>
          <button onClick={onClose} className="font-mono text-[10px] tracking-[0.32em] text-slate-500 hover:text-white uppercase">close</button>
        </div>
        <textarea
          autoFocus
          value={prompt}
          onChange={(e) => { setPrompt(e.target.value); setError(null) }}
          placeholder={`Ask ${a.name.toLowerCase()} something specific. ${MAX_HINT[agent]}`}
          rows={6}
          maxLength={1200}
          className="w-full bg-slate-950 border border-slate-800 text-slate-100 font-mono text-[12px] leading-relaxed p-3 focus:outline-none focus:border-amber-700 resize-none"
        />
        <div className="mt-2 flex items-center justify-between font-mono text-[9px] tracking-[0.25em] uppercase text-slate-500">
          <span>{prompt.length} / 1200</span>
          <span>cost · {DM_COST} PG</span>
        </div>
        {error && <p className="mt-3 font-mono text-[11px] text-rose-400">{error}</p>}
        <button
          onClick={send}
          disabled={busy}
          className={`mt-4 w-full font-mono text-[11px] tracking-[0.32em] uppercase px-3 py-3 transition-colors ${c.btn} disabled:opacity-50`}
        >
          {busy ? 'sending…' : `send · spend ${DM_COST} pg`}
        </button>
        <p className="mt-3 font-mono text-[9px] tracking-[0.25em] uppercase text-slate-600">
          replies appear here once {a.name.toLowerCase()} responds. queued messages are durable.
        </p>
      </div>
    </div>
  )
}

const MAX_HINT: Record<AgentKey, string> = {
  lila:  'e.g. "what should I watch on the broadcast tonight?"',
  ceelo: 'e.g. "do you like the under in chiefs/bills?"',
  vega:  'e.g. "what\'s your read on TSLA into earnings?"',
}

function fmtRel(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000)
  if (s < 60)  return `${s}s ago`
  const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60); if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24); return `${d}d ago`
}
