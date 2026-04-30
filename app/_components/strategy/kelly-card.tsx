'use client'

// Interactive sizing card. Slider sweeps edge_pct 0..15%. Output is a
// fractional-Kelly stake (¼-Kelly) at -110, in units. Pure client, no deps.
// Math: full-Kelly = edge / (decimal_odds - 1). At -110, decimal=1.909,
// so denom=0.909. Quarter-Kelly = full / 4.

import { useState } from 'react'
import { TONE } from './tone'
import type { Tone } from './copy'

const DECIMAL_AT_NEG_110 = 1 + 100 / 110 // 1.909...

function kellyStake(edgePct: number, fraction: number): number {
  const edge = edgePct / 100
  const denom = DECIMAL_AT_NEG_110 - 1
  const full = edge / denom
  return Math.max(0, full * fraction)
}

export function KellyCard({ tone }: { tone: Tone }) {
  const t = TONE[tone]
  const [edgePct, setEdgePct] = useState(5)
  const [bankroll, setBankroll] = useState(100)
  const [fraction, setFraction] = useState(0.25)

  const stakeUnits = +(kellyStake(edgePct, fraction) * 100).toFixed(2) // % of bankroll
  const stakeDollars = +(bankroll * stakeUnits / 100).toFixed(2)

  return (
    <div className={`border-2 ${t.border} bg-slate-950/70 p-5 sm:p-6`}>
      <div className="flex items-baseline justify-between gap-4 mb-4">
        <p className={`font-mono text-[10px] tracking-[0.32em] uppercase ${t.accent}`}>▌ stake sizing · ¼-kelly</p>
        <p className="font-mono text-[9px] tracking-[0.32em] uppercase text-slate-700">at −110</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
        <Slider
          label="edge_pct"
          min={0} max={15} step={0.1}
          value={edgePct}
          onChange={setEdgePct}
          unit="%"
          accent={t.accent}
          hex={t.hex}
        />
        <Slider
          label="bankroll"
          min={10} max={1000} step={10}
          value={bankroll}
          onChange={setBankroll}
          unit="u"
          accent={t.accent}
          hex={t.hex}
        />
        <FractionPicker fraction={fraction} onChange={setFraction} accent={t.accent} />
      </div>

      <div className="mt-6 grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Stat label="stake" value={`${stakeUnits.toFixed(2)}%`} unit="of bankroll" accent={t.accent} />
        <Stat label="units"  value={`${stakeDollars.toFixed(2)}u`} unit={`@ ${bankroll}u bankroll`} accent={t.accent} />
        <Stat label="payout" value={`+${(stakeDollars * (DECIMAL_AT_NEG_110 - 1)).toFixed(2)}u`} unit="if it cashes" accent={t.accent} />
      </div>

      <p className="mt-4 font-mono text-[10px] leading-relaxed text-slate-500">
        Below 2% edge_pct, ¼-Kelly stakes are smaller than typical book minimums — pass.
        Above 8%, double-check Ceelo’s reasoning before sizing up.
      </p>
    </div>
  )
}

function Slider({ label, min, max, step, value, onChange, unit, accent, hex }: {
  label: string; min: number; max: number; step: number
  value: number; onChange: (n: number) => void
  unit: string; accent: string; hex: string
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <span className="font-mono text-[10px] tracking-[0.32em] uppercase text-slate-500">{label}</span>
        <span className={`font-mono text-base font-black tabular-nums ${accent}`}>
          {value.toFixed(label === 'edge_pct' ? 1 : 0)}<span className="text-slate-600 ml-1 text-[10px]">{unit}</span>
        </span>
      </div>
      <input
        type="range"
        min={min} max={max} step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full h-1 bg-slate-800 appearance-none cursor-pointer accent-current"
        style={{ accentColor: hex }}
      />
    </div>
  )
}

function FractionPicker({ fraction, onChange, accent }: { fraction: number; onChange: (n: number) => void; accent: string }) {
  const opts: [number, string][] = [[0.125, '⅛'], [0.25, '¼'], [0.5, '½']]
  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <span className="font-mono text-[10px] tracking-[0.32em] uppercase text-slate-500">kelly fraction</span>
        <span className={`font-mono text-base font-black tabular-nums ${accent}`}>
          {opts.find(([v]) => v === fraction)?.[1] ?? '¼'}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-px bg-slate-800/50">
        {opts.map(([v, label]) => (
          <button
            key={v}
            type="button"
            onClick={() => onChange(v)}
            className={`bg-slate-950/80 py-2 font-mono text-[11px] tabular-nums transition-colors ${
              v === fraction ? `${accent} font-bold` : 'text-slate-500 hover:text-white'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}

function Stat({ label, value, unit, accent }: { label: string; value: string; unit: string; accent: string }) {
  return (
    <div className="border border-slate-800/70 bg-slate-950/60 px-4 py-3">
      <p className="font-mono text-[9px] tracking-[0.32em] uppercase text-slate-500">{label}</p>
      <p className={`font-mono text-2xl font-black tabular-nums leading-none mt-1 ${accent}`}>{value}</p>
      <p className="font-mono text-[9px] tracking-[0.25em] uppercase text-slate-600 mt-1">{unit}</p>
    </div>
  )
}
