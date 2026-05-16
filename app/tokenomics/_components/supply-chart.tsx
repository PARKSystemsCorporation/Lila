'use client'

import { useEffect, useRef } from 'react'

// Circulating-supply emission curve, 36-month projection. Schedule mirrors
// the on-chain vesting math exactly:
//   base 400M at TGE · ecosystem 250M linear over 36m · team 120M and
//   seed 80M linear over 24m after a 6m cliff · treasury 150M linear over
//   24m after a 12m cliff. lightweight-charts is dynamically imported so
//   SSR never touches canvas (same pattern as the operator desk chart).

const TOTAL = 1_000_000_000

function buildSeries() {
  const eco = 250_000_000 / 36
  const team = 120_000_000 / 24
  const seed = 80_000_000 / 24
  const trea = 150_000_000 / 24
  const out: { time: string; value: number }[] = []
  for (let m = 0; m <= 36; m++) {
    let v = 400_000_000
    v += Math.min(m, 36) * eco
    v += Math.max(0, Math.min(m - 6, 24)) * team
    v += Math.max(0, Math.min(m - 6, 24)) * seed
    v += Math.max(0, Math.min(m - 12, 24)) * trea
    // TGE 2025-11-01, one point per month.
    const d = new Date(Date.UTC(2025, 10 + m, 1))
    const time = d.toISOString().slice(0, 10)
    out.push({ time, value: Math.round(Math.min(v, TOTAL)) })
  }
  return out
}

export function SupplyChart() {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!containerRef.current) return
    let chart: { remove: () => void } | null = null
    let resizeObserver: ResizeObserver | null = null
    let cancelled = false

    ;(async () => {
      const lib = await import('lightweight-charts')
      if (cancelled || !containerRef.current) return

      const c = lib.createChart(containerRef.current, {
        width: containerRef.current.clientWidth,
        height: 320,
        layout: {
          background: { type: lib.ColorType.Solid, color: 'transparent' },
          textColor: '#78716c',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 10,
        },
        grid: {
          vertLines: { color: 'rgba(245, 158, 11, 0.06)' },
          horzLines: { color: 'rgba(245, 158, 11, 0.06)' },
        },
        timeScale: { borderColor: 'rgba(245,158,11,0.25)' },
        rightPriceScale: { borderColor: 'rgba(245,158,11,0.25)' },
        crosshair: {
          vertLine: { color: 'rgba(245,158,11,0.5)', width: 1 },
          horzLine: { color: 'rgba(245,158,11,0.5)', width: 1 },
        },
        handleScroll: false,
        handleScale: false,
      })
      chart = c

      const series = c.addSeries(lib.AreaSeries, {
        lineColor: '#f59e0b',
        topColor: 'rgba(245,158,11,0.35)',
        bottomColor: 'rgba(245,158,11,0.00)',
        lineWidth: 2,
        priceFormat: { type: 'volume' },
      })
      series.setData(
        buildSeries().map(d => ({
          time: d.time as unknown as import('lightweight-charts').UTCTimestamp,
          value: d.value,
        })),
      )
      c.timeScale().fitContent()

      resizeObserver = new ResizeObserver(() => {
        if (!containerRef.current) return
        c.applyOptions({ width: containerRef.current.clientWidth })
      })
      resizeObserver.observe(containerRef.current)
    })()

    return () => {
      cancelled = true
      resizeObserver?.disconnect()
      chart?.remove()
    }
  }, [])

  return <div ref={containerRef} className="w-full" aria-label="circulating supply growth chart" />
}
