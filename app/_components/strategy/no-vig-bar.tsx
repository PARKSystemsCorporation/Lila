'use client'

// Three stacked horizontal bars: book implied (with vig), no-vig implied,
// Ceelo's model_prob. The gap between no-vig and model_prob IS the edge.
// Honest visualization — every input is named.

import { useMemo } from 'react'
import { TONE } from './tone'
import type { Tone } from './copy'

interface Props {
  tone: Tone
  modelProb: number   // 0..1
  americanOdds: number // e.g. -110, -115, +105
  marketLabel: string // e.g. "BOS @ DEN · Over 228.5"
  caption?: string
}

function americanToImplied(odds: number): number {
  return odds < 0 ? -odds / (-odds + 100) : 100 / (odds + 100)
}

// Approximation: assume the other side's vig is symmetric and back out no-vig.
// Real no-vig requires the opposing-side price; for a single-line teaser we
// assume the line is fair across both sides at the same vig (close enough
// for explanatory purposes — explicitly flagged in the caption).
function noVigImplied(odds: number): number {
  const impl = americanToImplied(odds)
  // Symmetric vig assumption: book book = 2 * impl - 1 worth of overround.
  // Pull each side's no-vig back proportionally.
  const overround = 2 * impl
  return impl / overround
}

export function NoVigBar({ tone, modelProb, americanOdds, marketLabel, caption }: Props) {
  const t = TONE[tone]
  const book = useMemo(() => americanToImplied(americanOdds), [americanOdds])
  const noVig = useMemo(() => noVigImplied(americanOdds), [americanOdds])
  const edgePct = +((modelProb - noVig) * 100).toFixed(2)
  const edgeSign = edgePct >= 0 ? '+' : ''

  return (
    <div className={`border-2 ${t.border} bg-slate-950/70 p-5 sm:p-6`}>
      <div className="flex items-baseline justify-between gap-3 mb-4">
        <p className={`font-mono text-[10px] tracking-[0.32em] uppercase ${t.accent}`}>▌ no-vig anchor</p>
        <p className="font-mono text-[9px] tracking-[0.32em] uppercase text-slate-600 truncate">{marketLabel}</p>
      </div>

      <div className="space-y-3">
        <Bar label="book implied"  pct={book * 100}      hex="#475569" tone="text-slate-400" suffix="(with vig)" />
        <Bar label="no-vig implied" pct={noVig * 100}    hex="#94a3b8" tone="text-slate-300" suffix="(remove juice)" />
        <Bar label="model_prob"     pct={modelProb * 100} hex={t.hex}   tone={t.accent}      suffix="(ceelo)" />
      </div>

      <div className="mt-5 flex items-baseline justify-between border-t border-slate-800/70 pt-4">
        <p className="font-mono text-[10px] tracking-[0.32em] uppercase text-slate-500">edge_pct over no-vig</p>
        <p className={`font-mono text-2xl font-black tabular-nums ${t.accent}`}>
          {edgeSign}{edgePct.toFixed(2)}%
        </p>
      </div>

      {caption && (
        <p className="mt-3 font-mono text-[10px] leading-relaxed text-slate-500">{caption}</p>
      )}
      <p className="mt-2 font-mono text-[9px] tracking-[0.25em] uppercase text-slate-700">
        symmetric-vig approximation · use both sides for the true no-vig in production
      </p>
    </div>
  )
}

function Bar({ label, pct, hex, tone, suffix }: { label: string; pct: number; hex: string; tone: string; suffix: string }) {
  const w = Math.max(0, Math.min(100, pct))
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1.5">
        <span className="font-mono text-[10px] tracking-[0.28em] uppercase text-slate-500">
          {label} <span className="text-slate-700 normal-case tracking-normal">{suffix}</span>
        </span>
        <span className={`font-mono text-sm font-bold tabular-nums ${tone}`}>{pct.toFixed(1)}%</span>
      </div>
      <div className="h-2 bg-slate-900 border border-slate-800/70 relative overflow-hidden">
        <div
          className="absolute inset-y-0 left-0 transition-[width] duration-700"
          style={{ width: `${w}%`, background: hex, boxShadow: `0 0 10px ${hex}66` }}
        />
      </div>
    </div>
  )
}
