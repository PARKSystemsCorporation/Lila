'use client'

// Brutalist worked-example card. Three columns: Ceelo's posted signal,
// viewer-side math, decision + close + CLV. Always tagged as illustration.

import type { Strategy } from './copy'
import { TONE } from './tone'
import type { Tone } from './copy'

export function WorkedExample({ strategy, tone }: { strategy: Strategy; tone: Tone }) {
  const t = TONE[tone]
  const ex = strategy.example

  return (
    <article className={`group relative border-2 ${t.border} bg-slate-950/70 transition-all duration-300 ${t.ring}`}>
      <header className={`flex items-baseline justify-between gap-3 border-b ${t.borderSoft} px-5 sm:px-7 py-4`}>
        <div>
          <p className={`font-mono text-[10px] tracking-[0.32em] uppercase ${t.accent}`}>
            ▌ {strategy.name}
          </p>
          <h3 className="mt-1.5 text-lg sm:text-xl font-black tracking-tight uppercase text-white">
            {ex.game} <span className="text-slate-600">·</span> {ex.market}
          </h3>
        </div>
        <span className="font-mono text-[9px] tracking-[0.32em] uppercase text-slate-700 whitespace-nowrap">
          illustration · not a track record
        </span>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-px bg-slate-800/50">
        <Column label="ceelo posts" rows={ex.signal} accent={t.accent} />
        <Column label="you compute" rows={ex.math}   accent={t.accent} />
        <DecisionColumn decision={ex.decision} close={ex.close} clv={ex.clv} outcome={ex.outcome} accent={t.accent} />
      </div>

      <footer className={`border-t ${t.borderSoft} px-5 sm:px-7 py-3`}>
        <p className="font-mono text-[10px] sm:text-[11px] leading-relaxed text-slate-400">
          <span className={`${t.accent} font-bold mr-2`}>why:</span>
          {strategy.why}
        </p>
      </footer>
    </article>
  )
}

function Column({ label, rows, accent }: { label: string; rows: { label: string; value: string }[]; accent: string }) {
  return (
    <div className="bg-slate-950/85 px-5 sm:px-6 py-5">
      <p className={`font-mono text-[9px] tracking-[0.32em] uppercase ${accent} mb-3`}>{label}</p>
      <dl className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="flex items-baseline justify-between gap-3 font-mono text-[11px] leading-snug">
            <dt className="tracking-wider uppercase text-slate-500">{r.label}</dt>
            <dd className="tabular-nums text-white text-right">{r.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function DecisionColumn({ decision, close, clv, outcome, accent }: { decision: string; close: string; clv: string; outcome: string; accent: string }) {
  return (
    <div className="bg-slate-950/85 px-5 sm:px-6 py-5 flex flex-col gap-4">
      <div>
        <p className={`font-mono text-[9px] tracking-[0.32em] uppercase ${accent} mb-2`}>decision</p>
        <p className="font-mono text-[11px] leading-relaxed text-white">{decision}</p>
      </div>
      <div>
        <p className="font-mono text-[9px] tracking-[0.32em] uppercase text-slate-500 mb-1">close</p>
        <p className="font-mono text-[11px] text-slate-300">{close}</p>
      </div>
      <div>
        <p className={`font-mono text-[9px] tracking-[0.32em] uppercase ${accent} mb-1`}>clv</p>
        <p className={`font-mono text-[11px] ${accent} font-bold`}>{clv}</p>
      </div>
      <div className="mt-auto pt-2 border-t border-slate-800/70">
        <p className="font-mono text-[10px] leading-relaxed text-slate-500">{outcome}</p>
      </div>
    </div>
  )
}
