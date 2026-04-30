'use client'

// Brutalist SVG sparkline of Ceelo's 2025 weekly edge — cumulative line with
// a filled area under it. Backed by /api/public/ceelo/edge-graph; falls back
// to deterministic demo data per sport when the DB is empty so the teaser
// always reads as a chart, never as a blank panel.

import { useEffect, useMemo, useState } from 'react'

const SPORTS = ['NFL', 'NBA', 'NHL', 'MLB'] as const
export type Sport = typeof SPORTS[number]

interface WeekPoint { w: number; edge_points: number; n_picks: number }
export interface SportSeries {
  sport: Sport
  weeks: WeekPoint[]
  total_edge: number
  total_picks: number
  wins: number
  losses: number
  pushes: number
}
export interface EdgeGraphPayload {
  year: number
  sports: Record<Sport, SportSeries>
}

type Tone = 'amber' | 'orange' | 'red'

const TONE: Record<Tone, { line: string; fill: string; dot: string; text: string; rule: string }> = {
  amber:  { line: '#f59e0b', fill: 'rgba(245,158,11,0.18)',  dot: '#fbbf24', text: 'text-amber-300',  rule: 'stroke-amber-500/15' },
  orange: { line: '#fb923c', fill: 'rgba(251,146,60,0.18)',  dot: '#fdba74', text: 'text-orange-300', rule: 'stroke-orange-500/15' },
  red:    { line: '#ef4444', fill: 'rgba(239,68,68,0.18)',   dot: '#fca5a5', text: 'text-red-300',    rule: 'stroke-red-500/15' },
}

// Mulberry32 — small deterministic PRNG keyed by sport so the demo trace
// is identical between renders and across server/client.
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const DEMO_SEED: Record<Sport, { seed: number; drift: number; ramp: number }> = {
  NFL: { seed: 0x9f1e, drift:  0.62, ramp: 1.10 },
  NBA: { seed: 0x21c0, drift:  0.38, ramp: 0.85 },
  NHL: { seed: 0x55aa, drift: -0.10, ramp: 0.65 },
  MLB: { seed: 0x7c3d, drift:  0.28, ramp: 0.70 },
}

function demoSeries(sport: Sport): SportSeries {
  const cfg = DEMO_SEED[sport]
  const rng = seeded(cfg.seed)
  const weeks: WeekPoint[] = []
  let wins = 0, losses = 0, pushes = 0
  for (let w = 1; w <= 52; w++) {
    const n = Math.floor(rng() * 5) + 1
    const swing = (rng() - 0.5) * 2.4 * cfg.ramp
    const edge = +(swing + cfg.drift).toFixed(2)
    weeks.push({ w, edge_points: edge, n_picks: n })
    for (let i = 0; i < n; i++) {
      const r = rng()
      if (r < 0.54) wins++
      else if (r < 0.94) losses++
      else pushes++
    }
  }
  const total_edge = +weeks.reduce((a, b) => a + b.edge_points, 0).toFixed(2)
  const total_picks = weeks.reduce((a, b) => a + b.n_picks, 0)
  return { sport, weeks, total_edge, total_picks, wins, losses, pushes }
}

export function demoPayload(): EdgeGraphPayload {
  return {
    year: 2025,
    sports: {
      NFL: demoSeries('NFL'),
      NBA: demoSeries('NBA'),
      NHL: demoSeries('NHL'),
      MLB: demoSeries('MLB'),
    },
  }
}

function isLive(s: SportSeries): boolean {
  return s.weeks.length > 0 && s.total_picks > 0
}

interface GraphProps {
  series: SportSeries
  tone?: Tone
  height?: number
  showStats?: boolean
  live?: boolean
}

export function EdgeGraph({ series, tone = 'amber', height = 120, showStats = true, live = false }: GraphProps) {
  const t = TONE[tone]
  const W = 600
  const H = height
  const PAD = 8

  // Build cumulative trace, padding empty weeks with the carry value so the
  // line stays continuous across gaps in the underlying data.
  const cum = useMemo(() => {
    const byWeek = new Map(series.weeks.map((p) => [p.w, p.edge_points]))
    const arr: { w: number; v: number }[] = []
    let running = 0
    for (let w = 1; w <= 52; w++) {
      running += byWeek.get(w) ?? 0
      arr.push({ w, v: +running.toFixed(2) })
    }
    return arr
  }, [series])

  const min = Math.min(0, ...cum.map((p) => p.v))
  const max = Math.max(0, ...cum.map((p) => p.v))
  const span = Math.max(1, max - min)
  const xOf = (w: number) => PAD + ((w - 1) / 51) * (W - PAD * 2)
  const yOf = (v: number) => H - PAD - ((v - min) / span) * (H - PAD * 2)
  const yZero = yOf(0)

  const path = cum.map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(p.w).toFixed(2)},${yOf(p.v).toFixed(2)}`).join(' ')
  const area = `${path} L${xOf(52).toFixed(2)},${yZero.toFixed(2)} L${xOf(1).toFixed(2)},${yZero.toFixed(2)} Z`
  const last = cum[cum.length - 1]
  const totalSign = series.total_edge >= 0 ? '+' : ''

  return (
    <div className="w-full">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block" preserveAspectRatio="none" aria-hidden>
        {/* zero line */}
        <line x1={PAD} x2={W - PAD} y1={yZero} y2={yZero} className={t.rule} strokeWidth={1} strokeDasharray="2 4" />
        {/* quarter rules */}
        {[13, 26, 39].map((w) => (
          <line key={w} x1={xOf(w)} x2={xOf(w)} y1={PAD} y2={H - PAD} className="stroke-slate-700/30" strokeWidth={1} strokeDasharray="1 5" />
        ))}
        <path d={area} fill={t.fill} />
        <path d={path} fill="none" stroke={t.line} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={xOf(last.w)} cy={yOf(last.v)} r={2.6} fill={t.dot} />
      </svg>

      {showStats && (
        <div className="mt-2 flex items-baseline justify-between font-mono text-[9px] tracking-[0.25em] uppercase text-slate-500">
          <span>jan</span>
          <span className={`tabular-nums ${t.text} font-bold`}>
            {totalSign}{series.total_edge.toFixed(1)} pts
          </span>
          <span>dec</span>
        </div>
      )}
      {!live && showStats && (
        <div className="mt-1 text-center font-mono text-[8px] tracking-[0.32em] uppercase text-slate-700">
          demo trace
        </div>
      )}
    </div>
  )
}

const QUARTILE_LABELS = ['q1', 'q2', 'q3', 'q4'] as const

export function EdgeGraphLarge({ series, tone = 'amber', live = false }: { series: SportSeries; tone?: Tone; live?: boolean }) {
  const t = TONE[tone]
  const W = 800
  const H = 280
  const PAD_X = 28
  const PAD_Y = 24

  const cum = useMemo(() => {
    const byWeek = new Map(series.weeks.map((p) => [p.w, p.edge_points]))
    const arr: { w: number; v: number; weekly: number; n: number }[] = []
    let running = 0
    for (let w = 1; w <= 52; w++) {
      const weekly = byWeek.get(w) ?? 0
      running += weekly
      const wp = series.weeks.find((p) => p.w === w)
      arr.push({ w, v: +running.toFixed(2), weekly, n: wp?.n_picks ?? 0 })
    }
    return arr
  }, [series])

  const min = Math.min(0, ...cum.map((p) => p.v))
  const max = Math.max(0, ...cum.map((p) => p.v))
  const span = Math.max(1, max - min)
  const xOf = (w: number) => PAD_X + ((w - 1) / 51) * (W - PAD_X * 2)
  const yOf = (v: number) => H - PAD_Y - ((v - min) / span) * (H - PAD_Y * 2)
  const yZero = yOf(0)

  const path = cum.map((p, i) => `${i === 0 ? 'M' : 'L'}${xOf(p.w).toFixed(2)},${yOf(p.v).toFixed(2)}`).join(' ')
  const area = `${path} L${xOf(52).toFixed(2)},${yZero.toFixed(2)} L${xOf(1).toFixed(2)},${yZero.toFixed(2)} Z`
  const last = cum[cum.length - 1]
  const peak = cum.reduce((a, b) => (b.v > a.v ? b : a), cum[0])
  const trough = cum.reduce((a, b) => (b.v < a.v ? b : a), cum[0])
  const totalSign = series.total_edge >= 0 ? '+' : ''
  const winPct = series.wins + series.losses > 0
    ? (series.wins / (series.wins + series.losses)) * 100
    : 0

  return (
    <div className="w-full">
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block" preserveAspectRatio="none" aria-hidden>
          <line x1={PAD_X} x2={W - PAD_X} y1={yZero} y2={yZero} className={t.rule} strokeWidth={1.2} strokeDasharray="3 5" />
          {[13, 26, 39].map((w) => (
            <line key={w} x1={xOf(w)} x2={xOf(w)} y1={PAD_Y} y2={H - PAD_Y} className="stroke-slate-700/40" strokeWidth={1} strokeDasharray="1 6" />
          ))}
          {/* weekly bars */}
          {cum.map((p) => {
            if (p.weekly === 0) return null
            const x = xOf(p.w)
            const y0 = yZero
            const y1 = yOf(p.weekly + 0)
            const top = Math.min(y0, y1)
            const h = Math.abs(y1 - y0)
            return (
              <rect
                key={p.w}
                x={x - 1.4}
                y={top}
                width={2.8}
                height={Math.max(0.5, h)}
                fill={t.line}
                opacity={0.18}
              />
            )
          })}
          <path d={area} fill={t.fill} />
          <path d={path} fill="none" stroke={t.line} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {/* peak / trough markers */}
          {peak.v > 0 && (
            <g>
              <circle cx={xOf(peak.w)} cy={yOf(peak.v)} r={3.5} fill={t.dot} />
              <line x1={xOf(peak.w)} x2={xOf(peak.w)} y1={yOf(peak.v)} y2={PAD_Y} className={t.rule} strokeWidth={1} strokeDasharray="2 3" />
            </g>
          )}
          <circle cx={xOf(last.w)} cy={yOf(last.v)} r={3.5} fill={t.dot} />
        </svg>
      </div>

      <div className="mt-3 grid grid-cols-4 gap-px bg-slate-800/40 border border-slate-800/40">
        {QUARTILE_LABELS.map((q) => (
          <div key={q} className="bg-slate-950/70 px-2 py-1.5 text-center font-mono text-[9px] tracking-[0.3em] uppercase text-slate-500">
            {q}
          </div>
        ))}
      </div>

      <div className="mt-5 grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="2025 edge" value={`${totalSign}${series.total_edge.toFixed(1)}`} unit="pts" tone={t.text} />
        <Stat label="record" value={`${series.wins}-${series.losses}${series.pushes ? `-${series.pushes}` : ''}`} unit={`${winPct.toFixed(0)}%`} tone={t.text} />
        <Stat label="picks" value={String(series.total_picks)} unit="logged" tone={t.text} />
        <Stat label="peak" value={`+${peak.v.toFixed(1)}`} unit={`wk ${peak.w}`} tone={t.text} />
      </div>

      {!live && (
        <div className="mt-4 font-mono text-[9px] tracking-[0.32em] uppercase text-slate-700 text-center">
          ▌ demo trace · live data wires up as picks settle · trough wk {trough.w} ({trough.v.toFixed(1)})
        </div>
      )}
    </div>
  )
}

function Stat({ label, value, unit, tone }: { label: string; value: string; unit: string; tone: string }) {
  return (
    <div className="border border-slate-800/70 bg-slate-950/40 px-3 py-2">
      <div className="font-mono text-[9px] tracking-[0.3em] uppercase text-slate-500">{label}</div>
      <div className={`font-mono text-xl sm:text-2xl font-black tabular-nums leading-none mt-1 ${tone}`}>{value}</div>
      <div className="font-mono text-[9px] tracking-[0.25em] uppercase text-slate-600 mt-1">{unit}</div>
    </div>
  )
}

// Hook: fetches live payload, falls back to deterministic demo. `live` flag
// reflects whether at least one sport has real picks logged.
export function useEdgeGraph(): { payload: EdgeGraphPayload; live: Record<Sport, boolean>; loaded: boolean } {
  const demo = useMemo(() => demoPayload(), [])
  const [payload, setPayload] = useState<EdgeGraphPayload>(demo)
  const [live, setLive] = useState<Record<Sport, boolean>>({ NFL: false, NBA: false, NHL: false, MLB: false })
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let alive = true
    fetch('/api/public/ceelo/edge-graph', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: EdgeGraphPayload | null) => {
        if (!alive || !d || !d.sports) return
        const next: EdgeGraphPayload = { year: d.year, sports: { ...demo.sports } }
        const liveMap: Record<Sport, boolean> = { NFL: false, NBA: false, NHL: false, MLB: false }
        for (const s of SPORTS) {
          const incoming = d.sports[s]
          if (incoming && isLive(incoming)) {
            next.sports[s] = incoming
            liveMap[s] = true
          }
        }
        setPayload(next)
        setLive(liveMap)
      })
      .catch(() => {})
      .finally(() => alive && setLoaded(true))
    return () => { alive = false }
  }, [demo])

  return { payload, live, loaded }
}
