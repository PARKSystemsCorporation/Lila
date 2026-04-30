'use client'

// Top-of-page ticker. Pulls real counts from /api/public/landing-stats and
// loops them as a marquee. No demo padding — zeros render honestly.

import { useEffect, useState } from 'react'

interface Stats {
  articles: number
  picks_open: number
  picks_settled: number
  edges_open: number
  trades_closed: number
  bounties_paid_count: number
  bounties_paid_usd: number
}

const ZERO: Stats = {
  articles: 0,
  picks_open: 0,
  picks_settled: 0,
  edges_open: 0,
  trades_closed: 0,
  bounties_paid_count: 0,
  bounties_paid_usd: 0,
}

function fmtUsd(n: number): string {
  if (!n) return '$0'
  if (n < 1000) return `$${n.toFixed(0)}`
  if (n < 10_000) return `$${(n / 1000).toFixed(1)}K`
  return `$${Math.round(n / 1000)}K`
}

function pstClock(): string {
  return new Date().toLocaleTimeString('en-US', {
    timeZone: 'America/Los_Angeles',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  })
}

export default function LandingTicker() {
  const [s, setS] = useState<Stats>(ZERO)
  const [time, setTime] = useState<string>('')

  useEffect(() => {
    let alive = true
    const load = () => {
      fetch('/api/public/landing-stats', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (alive && d) setS(d) })
        .catch(() => {})
    }
    load()
    const id = setInterval(load, 60_000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  useEffect(() => {
    const tick = () => setTime(pstClock())
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])

  const items: string[] = [
    `ARTICLES · ${s.articles}`,
    `EDGES OPEN · ${s.edges_open}`,
    `PICKS SETTLED · ${s.picks_settled}`,
    `TRADES CLOSED · ${s.trades_closed}`,
    `BOUNTIES PAID · ${fmtUsd(s.bounties_paid_usd)} · ${s.bounties_paid_count}`,
    `PST · ${time || '--:--:--'}`,
    `STATUS · LIVE`,
  ]

  // Two equal-width copies + a -50% translate = seamless loop.
  const strip = items.join('  ▌▌▌  ') + '  ▌▌▌  '
  const cls = 'shrink-0 px-6 font-mono text-[10px] sm:text-[11px] tracking-[0.32em] text-amber-300/90 uppercase'

  return (
    <div className="relative w-full border-b-2 border-amber-500/30 bg-[#0a0c14]/95 backdrop-blur-md overflow-hidden">
      <div className="flex whitespace-nowrap will-change-transform animate-[ticker_70s_linear_infinite] py-2">
        <span className={cls}>{strip}</span>
        <span className={cls} aria-hidden>{strip}</span>
      </div>
      <style jsx>{`
        @keyframes ticker {
          from { transform: translate3d(0, 0, 0); }
          to   { transform: translate3d(-50%, 0, 0); }
        }
      `}</style>
    </div>
  )
}
