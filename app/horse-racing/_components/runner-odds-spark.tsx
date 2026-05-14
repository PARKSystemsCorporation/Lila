// Pure SVG sparkline of a single runner's odds (decimal) over time.
// No chart deps — mirrors the style of /app/_components/strategy/kelly-convergence.tsx.
//
// Y-axis: decimal odds (inverted — lower odds = stronger market money,
// rendered at the top so a market move "up" reads visually as up).
// X-axis: time. Padded so the rightmost point sits flush with the edge.
//
// Empty / single-point series → renders a flat dim placeholder (one
// point can't be a trend).

import type { OddsHistoryPoint } from '@/lib/horse-racing/data-service'

interface Props {
  series: OddsHistoryPoint[]
  width?: number
  height?: number
}

export function RunnerOddsSpark({ series, width = 120, height = 28 }: Props) {
  const points = series.filter(p => p.decimal != null && Number.isFinite(p.decimal))
  if (points.length < 2) {
    return (
      <svg width={width} height={height} className="overflow-visible">
        <line
          x1={0} y1={height / 2}
          x2={width} y2={height / 2}
          stroke="#475569" strokeWidth={1} strokeDasharray="2 3"
        />
      </svg>
    )
  }

  const xs = points.map(p => p.t)
  const ys = points.map(p => p.decimal as number)
  const xMin = xs[0]
  const xMax = xs[xs.length - 1] || xMin + 1
  const yMin = Math.min(...ys)
  const yMax = Math.max(...ys)
  const yRange = yMax - yMin || 1

  // Lower odds (market shortening) renders at the top.
  const px = (x: number) => ((x - xMin) / Math.max(1, xMax - xMin)) * (width - 2) + 1
  const py = (y: number) => ((y - yMin) / yRange) * (height - 4) + 2

  const d = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${px(p.t).toFixed(2)} ${py(p.decimal as number).toFixed(2)}`)
    .join(' ')

  // Edge polarity colors the line — positive average edge = amber (value),
  // negative average = rose (overlay risk).
  const edges = points.map(p => p.edge ?? 0)
  const avgEdge = edges.reduce((s, e) => s + e, 0) / Math.max(1, edges.length)
  const stroke = avgEdge >= 0 ? '#fbbf24' : '#fb7185'

  const lastX = px(points[points.length - 1].t)
  const lastY = py(points[points.length - 1].decimal as number)

  return (
    <svg width={width} height={height} className="overflow-visible">
      <path d={d} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={lastX} cy={lastY} r={1.8} fill={stroke} />
    </svg>
  )
}
