'use client'

import { useEffect, useState } from 'react'
import { LocalShell } from '@/app/_components/local/chrome'
import SlotReel from '@/app/_components/slot-reel'

type ColorTier = 'red' | 'yellow' | 'green' | 'purple'

type Side = {
  team_id:     string
  abbrev:      string
  score_1to10: number
  color_tier:  ColorTier
  label:       string
}

type Game = {
  game_id:       string
  tipoff_at:     string
  pct_game_left: number | null
  away:          Side
  home:          Side
  signals: {
    overround: number | null
    consensus: number | null
    steam:     number | null
    delta:     number | null
    lead_pct:  number | null
    sma10:     number | null
  }
}

type Payload = { games: Game[]; error?: string }

const TIER_TEXT: Record<ColorTier, string> = {
  red:    'text-red-500',
  yellow: 'text-amber-500',
  green:  'text-emerald-500',
  purple: 'text-fuchsia-500',
}

const TIER_BORDER: Record<ColorTier, string> = {
  red:    'border-red-500/50',
  yellow: 'border-amber-500/50',
  green:  'border-emerald-500/50',
  purple: 'border-fuchsia-500/50',
}

const TIER_BUTTON: Record<ColorTier, string> = {
  red:    'bg-red-500 hover:bg-red-300',
  yellow: 'bg-amber-500 hover:bg-amber-300',
  green:  'bg-emerald-500 hover:bg-emerald-300',
  purple: 'bg-fuchsia-500 hover:bg-fuchsia-300',
}

export default function NBAPage() {
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const res = await fetch('/api/sports/nba', { cache: 'no-store' })
        if (!alive) return
        if (res.status === 401) {
          setError('membership required')
          setData({ games: [] })
          return
        }
        const json = (await res.json()) as Payload
        setData(json)
        setError(null)
      } catch (e) {
        setError(String(e).slice(0, 200))
      }
    }
    load()
    const id = setInterval(load, 30_000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  return (
    <LocalShell
      title="NBA"
      subtitle="live intel"
      back={{ href: '/theyield/sports', label: 'back to scoreboard' }}
      accent="amber"
    >
      <section className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8 pt-6 pb-16 space-y-8">
        <QuickSignals games={data?.games ?? null} error={error} />
        <SlotMachine games={data?.games ?? null} />
      </section>

      <style jsx global>{`
        @keyframes skid {
          0%   { opacity: 0; transform: translate3d(-40px, 0, 0) skewX(-10deg); }
          60%  { opacity: 1; transform: translate3d(4px, 0, 0) skewX(0); }
          100% { opacity: 1; transform: translate3d(0, 0, 0) skewX(0); }
        }
        @keyframes reel {
          0%   { opacity: 0; transform: translate3d(0, -140%, 0); filter: blur(2px); }
          55%  { opacity: 1; transform: translate3d(0, 14px, 0); filter: blur(0); }
          72%  { transform: translate3d(0, -8px, 0); }
          88%  { transform: translate3d(0, 3px, 0); }
          100% { transform: translate3d(0, 0, 0); }
        }
      `}</style>
    </LocalShell>
  )
}

function QuickSignals({ games, error }: { games: Game[] | null; error: string | null }) {
  const headlines = games == null ? null : buildHeadlines(games, error)
  return (
    <div className="border-2 border-amber-500/40 bg-slate-950/70 shadow-[0_6px_0_0_rgba(0,0,0,0.6)]">
      <div className="flex items-center justify-between border-b-2 border-amber-500/30 bg-amber-500/5 px-4 py-2">
        <span className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] uppercase text-amber-400">
          ▌▌▌ NBA quick signals
        </span>
        <span className="font-mono text-[9px] sm:text-[10px] tracking-[0.4em] uppercase text-amber-500/60">
          live · session-only
        </span>
      </div>
      <ul className="divide-y divide-amber-500/10">
        {headlines == null ? (
          <li className="px-4 py-3 font-mono text-sm uppercase tracking-wide text-slate-400">loading…</li>
        ) : headlines.length === 0 ? (
          <li className="px-4 py-3 font-mono text-sm uppercase tracking-wide text-slate-400">
            {error ?? 'no signals yet — feeds idle'}
          </li>
        ) : (
          headlines.map((s, i) => (
            <li
              key={i}
              className="motion-safe:opacity-0 motion-safe:animate-[skid_0.5s_cubic-bezier(0.2,0.9,0.1,1.05)_both]"
              style={{ animationDelay: `${60 + i * 110}ms` }}
            >
              <span className="group flex items-center gap-3 px-4 py-3">
                <span className="font-mono text-amber-400 text-xs">▶</span>
                <span className="font-mono text-sm sm:text-base font-bold uppercase tracking-wide text-slate-100">
                  {s}
                </span>
              </span>
            </li>
          ))
        )}
      </ul>
    </div>
  )
}

function buildHeadlines(games: Game[], error: string | null): string[] {
  if (error) return [error]
  if (games.length === 0) return []
  const out: string[] = []
  for (const g of games.slice(0, 4)) {
    const lead  = g.home.score_1to10 >= g.away.score_1to10 ? g.home : g.away
    const other = lead === g.home ? g.away : g.home
    out.push(`${lead.abbrev} ${lead.label} (${lead.score_1to10}/10) vs ${other.abbrev}`)
  }
  return out
}

function SlotMachine({ games }: { games: Game[] | null }) {
  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] uppercase text-amber-400">
          ▌▌▌ tonight&rsquo;s slots
        </h2>
        <span className="font-mono text-[9px] sm:text-[10px] tracking-[0.4em] uppercase text-amber-500/60">
          {games == null ? 'loading…' : `${games.length} games · auto-refresh`}
        </span>
      </div>
      {games == null ? (
        <div className="border-2 border-amber-500/30 bg-slate-950/70 px-4 py-6 font-mono text-sm uppercase tracking-wide text-slate-400">
          fetching feeds…
        </div>
      ) : games.length === 0 ? (
        <div className="border-2 border-amber-500/30 bg-slate-950/70 px-4 py-6 font-mono text-sm uppercase tracking-wide text-slate-400">
          no live games right now
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 sm:gap-5">
          {games.slice(0, 6).map((g, i) => (
            <GameCard key={g.game_id} game={g} index={i} />
          ))}
        </div>
      )}
    </div>
  )
}

function GameCard({ game, index }: { game: Game; index: number }) {
  // Pick the higher-scored side as the headline side for tier color.
  const lead = game.home.score_1to10 >= game.away.score_1to10 ? game.home : game.away
  const tier = lead.color_tier
  const tipoff = new Date(game.tipoff_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

  return (
    <article
      className={`motion-safe:opacity-0 motion-safe:animate-[reel_1.1s_cubic-bezier(0.16,1,0.3,1)_both]
                  border-2 ${TIER_BORDER[tier]} bg-gradient-to-b from-slate-900 to-slate-950
                  shadow-[0_10px_0_0_rgba(0,0,0,0.55)] overflow-hidden`}
      style={{ animationDelay: `${index * 220}ms` }}
    >
      <header className="flex items-baseline justify-between border-b-2 border-amber-500/30 bg-amber-500/5 px-4 py-3">
        <span className="font-mono text-[10px] tracking-[0.4em] uppercase text-amber-400">
          slot {index + 1}
        </span>
        <span className={`font-mono text-[10px] tracking-[0.3em] uppercase font-bold ${TIER_TEXT[tier]}`}>
          {lead.label}
        </span>
      </header>

      <div className="px-4 py-5 space-y-1">
        <div className="text-2xl sm:text-3xl font-black tracking-tight text-slate-100">
          {game.away.abbrev} <span className="text-amber-500">@</span> {game.home.abbrev}
        </div>
        <div className="font-mono text-[11px] tracking-[0.3em] uppercase text-slate-500">
          tip-off · {tipoff}
        </div>
      </div>

      <dl className="grid grid-cols-3 border-y-2 border-amber-500/20 divide-x divide-amber-500/20 text-center">
        {([
          ['overround', game.signals.overround],
          ['delta',     game.signals.delta],
          ['steam',     game.signals.steam],
        ] as const).map(([k, v]) => (
          <div key={k} className="px-2 py-3">
            <dt className="font-mono text-[9px] tracking-[0.3em] uppercase text-slate-500">{k}</dt>
            <dd className="mt-1 font-mono text-sm font-bold text-amber-200">{v ?? '—'}/10</dd>
          </div>
        ))}
      </dl>

      <div className="px-4 py-4 space-y-3">
        <div className="flex items-baseline justify-between">
          <span className="font-mono text-[10px] tracking-[0.3em] uppercase text-slate-400">
            {lead.abbrev} score
          </span>
          <SlotReel
            final={`${lead.score_1to10}/10`}
            fakes={['2/10', '5/10', '7/10', '9/10', '4/10']}
            delay={index * 220 + 750}
            duration={520}
            className={`text-lg font-black ${TIER_TEXT[tier]}`}
          />
        </div>
        <div className="flex items-baseline justify-between">
          <span className="font-mono text-[10px] tracking-[0.3em] uppercase text-slate-400">
            {(lead === game.home ? game.away : game.home).abbrev} score
          </span>
          <SlotReel
            final={`${(lead === game.home ? game.away : game.home).score_1to10}/10`}
            fakes={['3/10', '6/10', '4/10', '8/10']}
            delay={index * 220 + 900}
            duration={520}
            className="text-lg font-black text-slate-300"
          />
        </div>
      </div>

      <button
        type="button"
        className={`block w-full border-t-2 border-amber-500/40 ${TIER_BUTTON[tier]}
                    text-black font-black uppercase tracking-[0.25em] text-sm py-3 transition-colors
                    focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-200`}
      >
        {lead.label} →
      </button>
    </article>
  )
}
