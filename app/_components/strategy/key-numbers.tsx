'use client'

// NFL margin-of-victory frequency histogram, highlighting the key numbers
// 3 and 7. Frequencies are approximate published values from public NFL
// margin distributions over the last ~25 seasons; they're stable enough
// for an explanatory chart and labeled as such.

import { TONE } from './tone'
import type { Tone } from './copy'

// Approximate share of NFL games decided by each margin (regulation +
// overtime, includes ties at 0). Source: standard public-domain NFL
// margin tables; rounded to one decimal. Sum is ~100 across 0..21.
const MARGIN_FREQ: Record<number, number> = {
  0: 0.5, 1: 2.4, 2: 4.0, 3: 14.8, 4: 5.7, 5: 2.7, 6: 6.6, 7: 8.9,
  8: 3.0, 9: 1.8, 10: 6.4, 11: 2.4, 12: 1.4, 13: 3.5, 14: 5.6,
  15: 1.4, 16: 2.0, 17: 4.1, 18: 1.4, 19: 1.0, 20: 2.6, 21: 2.5,
}

const KEY = new Set([3, 7])
const MARGINS = Array.from({ length: 22 }, (_, i) => i)

export function KeyNumbers({ tone }: { tone: Tone }) {
  const t = TONE[tone]
  const W = 600
  const H = 200
  const PAD_X = 16
  const PAD_Y_TOP = 14
  const PAD_Y_BOT = 28
  const max = Math.max(...MARGINS.map((m) => MARGIN_FREQ[m] ?? 0))
  const barW = (W - PAD_X * 2) / MARGINS.length

  return (
    <div className={`border-2 ${t.border} bg-slate-950/70 p-5 sm:p-6`}>
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <p className={`font-mono text-[10px] tracking-[0.32em] uppercase ${t.accent}`}>
          ▌ nfl margin frequency
        </p>
        <p className="font-mono text-[9px] tracking-[0.32em] uppercase text-slate-600">
          ~25-year sample · rounded
        </p>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block" preserveAspectRatio="none" aria-hidden>
        {/* y-axis ticks */}
        {[5, 10, 15].map((v) => {
          const y = PAD_Y_TOP + (1 - v / max) * (H - PAD_Y_TOP - PAD_Y_BOT)
          return (
            <g key={v}>
              <line x1={PAD_X} x2={W - PAD_X} y1={y} y2={y} stroke="#1e293b" strokeWidth={1} strokeDasharray="2 4" />
              <text x={W - PAD_X + 2} y={y + 3} fontSize={8} fill="#475569" fontFamily="ui-monospace, monospace" textAnchor="end">
                {v}%
              </text>
            </g>
          )
        })}

        {MARGINS.map((m, i) => {
          const f = MARGIN_FREQ[m] ?? 0
          const h = (f / max) * (H - PAD_Y_TOP - PAD_Y_BOT)
          const x = PAD_X + i * barW + barW * 0.12
          const y = H - PAD_Y_BOT - h
          const isKey = KEY.has(m)
          return (
            <g key={m}>
              <rect
                x={x}
                y={y}
                width={barW * 0.76}
                height={Math.max(0.5, h)}
                fill={isKey ? t.hex : '#334155'}
                opacity={isKey ? 1 : 0.7}
              />
              {isKey && (
                <text
                  x={x + barW * 0.38}
                  y={y - 4}
                  fontSize={9}
                  fontWeight={700}
                  fill={t.hex}
                  fontFamily="ui-monospace, monospace"
                  textAnchor="middle"
                >
                  {f.toFixed(1)}%
                </text>
              )}
              <text
                x={x + barW * 0.38}
                y={H - PAD_Y_BOT + 12}
                fontSize={8}
                fill={isKey ? t.hex : '#64748b'}
                fontFamily="ui-monospace, monospace"
                textAnchor="middle"
                fontWeight={isKey ? 700 : 400}
              >
                {m}
              </text>
            </g>
          )
        })}

        <text x={PAD_X} y={H - 4} fontSize={9} fill="#475569" fontFamily="ui-monospace, monospace">
          margin of victory →
        </text>
      </svg>

      <p className="mt-3 font-mono text-[10px] leading-relaxed text-slate-500">
        Roughly 1 in 7 NFL games lands exactly on 3, and 1 in 11 on 7.
        Crossing those numbers — moving from −3.5 to −2.5, or +6.5 to +7.5 — is worth
        multiples of crossing a non-key margin like 5 or 11.
      </p>
    </div>
  )
}
