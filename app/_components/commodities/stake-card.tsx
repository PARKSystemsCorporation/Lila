'use client'

// Interactive position-sizing card. Sliders sweep contracts × stop ticks ×
// account size; outputs $ at risk, % of account, and $/tick. Pure client,
// no deps. Math: $ risk = contracts × stop_ticks × tick_value.

import { useState } from 'react'
import { TONE } from '@/app/_components/strategy/tone'
import type { Tone } from '@/app/_components/strategy/copy'
import type { Contract } from '@/lib/commodities'
import { tickPnL } from '@/lib/commodities'

export function StakeCard({ tone, spec }: { tone: Tone; spec: Contract }) {
  const t = TONE[tone]
  const [contracts, setContracts] = useState(2)
  const [stopTicks, setStopTicks] = useState(20)
  const [account, setAccount] = useState(25000)

  const dollarRisk = contracts * tickPnL(spec, stopTicks)
  const pctOfAccount = (dollarRisk / account) * 100
  const dollarPerTick = contracts * spec.tickValue

  return (
    <div className={`border-2 ${t.border} bg-slate-950/70 p-5 sm:p-6`}>
      <div className="flex items-baseline justify-between gap-4 mb-4">
        <p className={`font-mono text-[10px] tracking-[0.32em] uppercase ${t.accent}`}>▌ position sizing · tick math</p>
        <p className="font-mono text-[9px] tracking-[0.32em] uppercase text-slate-700">
          at {spec.root} ${spec.tickValue.toFixed(2)}/tick
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
        <Slider
          label="contracts"
          min={1} max={10} step={1}
          value={contracts}
          onChange={setContracts}
          format={(v) => v.toFixed(0)}
          unit="lots"
          accent={t.accent}
          hex={t.hex}
        />
        <Slider
          label="stop_ticks"
          min={1} max={200} step={1}
          value={stopTicks}
          onChange={setStopTicks}
          format={(v) => v.toFixed(0)}
          unit="ticks"
          accent={t.accent}
          hex={t.hex}
        />
        <Slider
          label="account"
          min={1000} max={100000} step={1000}
          value={account}
          onChange={setAccount}
          format={(v) => `$${(v / 1000).toFixed(0)}`}
          unit="k"
          accent={t.accent}
          hex={t.hex}
        />
      </div>

      <div className="mt-6 grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Stat
          label="$ at risk"
          value={`$${dollarRisk.toFixed(0)}`}
          unit={`${contracts} × ${stopTicks} × $${spec.tickValue.toFixed(2)}`}
          accent={t.accent}
        />
        <Stat
          label="% of account"
          value={`${pctOfAccount.toFixed(2)}%`}
          unit={`of $${(account / 1000).toFixed(0)}k`}
          accent={t.accent}
        />
        <Stat
          label="$/tick"
          value={`$${dollarPerTick.toFixed(2)}`}
          unit={`${contracts} × $${spec.tickValue.toFixed(2)}`}
          accent={t.accent}
        />
      </div>

      <p className="mt-4 font-mono text-[10px] leading-relaxed text-slate-500">
        Above 2% of account on a single ticket is heavy — one bad print and you are digging out for five trades to get level.
        Below 0.25%, the size is too small to matter; round-turn cost and slippage eat whatever edge you thought you had.
      </p>
    </div>
  )
}

function Slider({ label, min, max, step, value, onChange, format, unit, accent, hex }: {
  label: string; min: number; max: number; step: number
  value: number; onChange: (n: number) => void
  format: (v: number) => string; unit: string; accent: string; hex: string
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <span className="font-mono text-[10px] tracking-[0.32em] uppercase text-slate-500">{label}</span>
        <span className={`font-mono text-base font-black tabular-nums ${accent}`}>
          {format(value)}<span className="text-slate-600 ml-1 text-[10px]">{unit}</span>
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

function Stat({ label, value, unit, accent }: { label: string; value: string; unit: string; accent: string }) {
  return (
    <div className="border border-slate-800/70 bg-slate-950/60 px-4 py-3">
      <p className="font-mono text-[9px] tracking-[0.32em] uppercase text-slate-500">{label}</p>
      <p className={`font-mono text-2xl font-black tabular-nums leading-none mt-1 ${accent}`}>{value}</p>
      <p className="font-mono text-[9px] tracking-[0.25em] uppercase text-slate-600 mt-1">{unit}</p>
    </div>
  )
}
