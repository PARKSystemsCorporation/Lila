'use client'

// Kelly convergence under the CLT. For a Kelly bettor with win prob p at net
// odds b, expected log-wealth after N bets is g·N with stdev σ·√N. The 95%
// confidence band is g·N ± Z·σ·√N. The "convergence point" n* is the smallest
// N for which Z·σ/(g·√N) ≤ margin — i.e. the realized log-wealth lands within
// `margin` of theory at 95% CI. Direct port of the R&D find_kelly_convergence
// algorithm. Pure SVG, no chart deps.

import { useState } from 'react'
import { TONE } from './tone'
import type { Tone } from './copy'

const B = 1.0 // net decimal odds (1:1 even money)
const Z = 1.959963984540054 // norm.ppf((1 + 0.95) / 2)

function kellyMath(p: number) {
  const q = 1 - p
  const fStar = (p * B - q) / B
  const logWin = Math.log(1 + fStar * B)
  const logLoss = Math.log(1 - fStar)
  const g = p * logWin + q * logLoss
  const variance = p * (logWin - g) ** 2 + q * (logLoss - g) ** 2
  return { fStar, g, variance, sigma: Math.sqrt(variance) }
}

function betsToConverge(g: number, variance: number, margin: number): number {
  return Math.ceil((Z * Z * variance) / (g * margin) ** 2)
}

export function KellyConvergence({ tone }: { tone: Tone }) {
  const t = TONE[tone]
  const [p, setP] = useState(0.6)
  const [margin, setMargin] = useState(0.05)

  const { fStar, g, variance, sigma } = kellyMath(p)
  const nStar = betsToConverge(g, variance, margin)

  // Chart geometry — mirrors key-numbers.tsx
  const W = 600
  const H = 240
  const PAD_X_L = 16
  const PAD_X_R = 36
  const PAD_Y_TOP = 22
  const PAD_Y_BOT = 28

  // X range: clamp to a reasonable view so the convergence marker is visible
  // but the curve never collapses to a single pixel.
  const Nview = Math.max(Math.ceil(nStar * 1.5), 200)
  const yMax = g * Nview + Z * sigma * Math.sqrt(Nview)
  const yMin = g * Nview - Z * sigma * Math.sqrt(Nview)

  const xPx = (n: number) => PAD_X_L + (n / Nview) * (W - PAD_X_L - PAD_X_R)
  const yPx = (y: number) => PAD_Y_TOP + (1 - (y - yMin) / (yMax - yMin)) * (H - PAD_Y_TOP - PAD_Y_BOT)

  // Sample the band at ~120 points
  const SAMPLES = 120
  const samples = Array.from({ length: SAMPLES + 1 }, (_, i) => {
    const n = (i / SAMPLES) * Nview
    const mean = g * n
    const half = Z * sigma * Math.sqrt(Math.max(n, 0))
    return { n, mean, upper: mean + half, lower: mean - half }
  })

  const upperPath = samples.map((s, i) => `${i === 0 ? 'M' : 'L'}${xPx(s.n).toFixed(2)},${yPx(s.upper).toFixed(2)}`).join(' ')
  const lowerPath = [...samples].reverse().map((s) => `L${xPx(s.n).toFixed(2)},${yPx(s.lower).toFixed(2)}`).join(' ')
  const bandPath = `${upperPath} ${lowerPath} Z`
  const meanPath = samples.map((s, i) => `${i === 0 ? 'M' : 'L'}${xPx(s.n).toFixed(2)},${yPx(s.mean).toFixed(2)}`).join(' ')

  const yTicks = [0.25, 0.5, 0.75].map((q) => yMin + q * (yMax - yMin))
  const zeroVisible = yMin <= 0 && yMax >= 0

  // X tick labels — round numbers along the axis
  const xTickCount = 4
  const xTicks = Array.from({ length: xTickCount + 1 }, (_, i) => Math.round((i / xTickCount) * Nview))

  return (
    <div className={`border-2 ${t.border} bg-slate-950/70 p-5 sm:p-6`}>
      <div className="flex items-baseline justify-between gap-4 mb-4">
        <p className={`font-mono text-[10px] tracking-[0.32em] uppercase ${t.accent}`}>▌ kelly convergence · log-wealth band</p>
        <p className="font-mono text-[9px] tracking-[0.32em] uppercase text-slate-700">b=1.00 · 95% ci</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
        <Slider
          label="win_prob"
          min={0.52}
          max={0.75}
          step={0.01}
          value={p}
          onChange={setP}
          format={(v) => `${(v * 100).toFixed(0)}%`}
          accent={t.accent}
          hex={t.hex}
        />
        <Slider
          label="margin"
          min={0.005}
          max={0.5}
          step={0.005}
          value={margin}
          onChange={setMargin}
          format={(v) => `${(v * 100).toFixed(1)}%`}
          accent={t.accent}
          hex={t.hex}
        />
      </div>

      <div className="mt-6 grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="f*" value={fStar.toFixed(2)} unit="optimal kelly" accent={t.accent} />
        <Stat label="g" value={`${(g * 100).toFixed(2)}%`} unit="growth per bet" accent={t.accent} />
        <Stat label="σ" value={sigma.toFixed(3)} unit="log-return stdev" accent={t.accent} />
        <Stat label="n*" value={nStar.toLocaleString()} unit="bets to converge" accent={t.accent} />
      </div>

      <div className="mt-6">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto block" preserveAspectRatio="none" aria-hidden>
          {/* y-axis gridlines */}
          {yTicks.map((y) => {
            const py = yPx(y)
            return (
              <g key={y}>
                <line x1={PAD_X_L} x2={W - PAD_X_R} y1={py} y2={py} stroke="#1e293b" strokeWidth={1} strokeDasharray="2 4" />
                <text x={W - PAD_X_R + 4} y={py + 3} fontSize={8} fill="#475569" fontFamily="ui-monospace, monospace">
                  {(y * 100).toFixed(0)}%
                </text>
              </g>
            )
          })}

          {/* zero baseline (when in range) */}
          {zeroVisible && (
            <line
              x1={PAD_X_L}
              x2={W - PAD_X_R}
              y1={yPx(0)}
              y2={yPx(0)}
              stroke="#334155"
              strokeWidth={1}
              strokeDasharray="3 3"
            />
          )}

          {/* confidence band */}
          <path d={bandPath} fill={t.fillRgba} stroke="none" />

          {/* expected log-wealth line */}
          <path d={meanPath} fill="none" stroke={t.hex} strokeWidth={1.5} />

          {/* convergence marker */}
          {nStar <= Nview && (
            <g>
              <line
                x1={xPx(nStar)}
                x2={xPx(nStar)}
                y1={PAD_Y_TOP}
                y2={H - PAD_Y_BOT}
                stroke={t.hex}
                strokeWidth={1}
                strokeDasharray="3 3"
                opacity={0.85}
              />
              <text
                x={xPx(nStar)}
                y={PAD_Y_TOP - 6}
                fontSize={9}
                fontWeight={700}
                fill={t.hex}
                fontFamily="ui-monospace, monospace"
                textAnchor="middle"
              >
                n* = {nStar.toLocaleString()}
              </text>
            </g>
          )}

          {/* x-axis ticks */}
          {xTicks.map((n) => (
            <text
              key={n}
              x={xPx(n)}
              y={H - PAD_Y_BOT + 12}
              fontSize={8}
              fill="#64748b"
              fontFamily="ui-monospace, monospace"
              textAnchor="middle"
            >
              {n.toLocaleString()}
            </text>
          ))}

          <text x={PAD_X_L} y={H - 4} fontSize={9} fill="#475569" fontFamily="ui-monospace, monospace">
            bets →
          </text>
          <text
            x={W - PAD_X_R}
            y={H - 4}
            fontSize={9}
            fill="#475569"
            fontFamily="ui-monospace, monospace"
            textAnchor="end"
          >
            log-wealth ±{(Z).toFixed(2)}σ√N
          </text>
        </svg>
      </div>

      <p className="mt-4 font-mono text-[10px] leading-relaxed text-slate-500">
        A 60% edge at even money grows your log-wealth a theoretical {(g * 100).toFixed(2)}% per bet — but the
        realized curve only tracks the line after thousands of trials. Drag <span className={t.accent}>win_prob</span>
        {' '}to feel how brutally convergence punishes thin edges; drag <span className={t.accent}>margin</span> to set
        how tightly you need the curve to hug theory.
      </p>
    </div>
  )
}

function Slider({
  label,
  min,
  max,
  step,
  value,
  onChange,
  format,
  accent,
  hex,
}: {
  label: string
  min: number
  max: number
  step: number
  value: number
  onChange: (n: number) => void
  format: (n: number) => string
  accent: string
  hex: string
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <span className="font-mono text-[10px] tracking-[0.32em] uppercase text-slate-500">{label}</span>
        <span className={`font-mono text-base font-black tabular-nums ${accent}`}>{format(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
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
