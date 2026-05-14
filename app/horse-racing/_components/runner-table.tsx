'use client'

// Full-field sortable table for the drill-in page. Renders one row per
// runner with number, name, jockey, trainer, odds, fair odds, edge, and
// a small odds-history sparkline. Column sort cycles asc → desc → none
// on header click.
//
// Mobile: the wrapper allows horizontal scroll; the body is laid out so
// the runner name + program number cluster stays sticky-left where
// supported. Sparkline cell hides on the narrowest breakpoint.

import { useState, useMemo } from 'react'
import type { Runner } from '@/lib/horse-racing/types'
import type { OddsHistoryPoint } from '@/lib/horse-racing/data-service'
import { RunnerOddsSpark } from './runner-odds-spark'

interface RunnerWithEdge extends Runner {
  fair_decimal: number | null
  edge_pct: number | null
}

interface Props {
  runners: RunnerWithEdge[]
  oddsHistory: Record<string, OddsHistoryPoint[]>
  topRunnerId: string | null
}

type SortKey = 'number' | 'edge' | 'odds' | 'horse'
type SortDir = 'asc' | 'desc'

const NUMERIC_COLS: SortKey[] = ['number', 'edge', 'odds']

export function RunnerTable({ runners, oddsHistory, topRunnerId }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('edge')
  const [sortDir, setSortDir] = useState<SortDir>('desc')

  const sorted = useMemo(() => {
    const arr = [...runners]
    arr.sort((a, b) => cmp(a, b, sortKey, sortDir))
    return arr
  }, [runners, sortKey, sortDir])

  const onHeaderClick = (k: SortKey) => {
    if (k === sortKey) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(k)
      setSortDir(NUMERIC_COLS.includes(k) && k !== 'number' ? 'desc' : 'asc')
    }
  }

  return (
    <div className="border-2 border-amber-500/15 bg-slate-950/70">
      <div className="overflow-x-auto">
        <table className="w-full text-sm font-mono tabular-nums">
          <thead>
            <tr className="border-b border-amber-500/20 text-[10px] tracking-[0.32em] uppercase text-slate-500">
              <Th label="#" k="number" sortKey={sortKey} sortDir={sortDir} onClick={onHeaderClick} className="w-12 text-left" />
              <Th label="runner" k="horse" sortKey={sortKey} sortDir={sortDir} onClick={onHeaderClick} className="text-left" />
              <th className="px-2 py-2 text-left font-normal hidden sm:table-cell">jockey · trainer</th>
              <Th label="odds" k="odds" sortKey={sortKey} sortDir={sortDir} onClick={onHeaderClick} className="text-right" />
              <th className="px-2 py-2 text-right font-normal hidden md:table-cell">fair</th>
              <Th label="edge" k="edge" sortKey={sortKey} sortDir={sortDir} onClick={onHeaderClick} className="text-right" />
              <th className="px-2 py-2 text-right font-normal hidden sm:table-cell">history</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(r => {
              const isTop = r.horse_id === topRunnerId
              const edge = r.edge_pct
              const edgeColor =
                edge == null ? 'text-slate-500'
                : edge >  3 ? 'text-amber-300'
                : edge < -3 ? 'text-rose-300'
                : 'text-slate-400'
              return (
                <tr
                  key={r.horse_id}
                  className={`border-b border-slate-900 last:border-b-0 ${isTop ? 'bg-amber-500/[0.04]' : ''}`}
                >
                  <td className="px-2 py-2 text-left text-amber-300 whitespace-nowrap">
                    {r.number ?? '—'}
                    {isTop && <span className="ml-1 text-[8px] tracking-[0.32em] text-amber-400/80">▌</span>}
                  </td>
                  <td className="px-2 py-2 text-left text-white truncate max-w-[160px]">
                    {r.horse}
                  </td>
                  <td className="px-2 py-2 text-left text-slate-500 hidden sm:table-cell truncate max-w-[200px]">
                    {[r.jockey, r.trainer].filter(Boolean).join(' · ') || '—'}
                  </td>
                  <td className="px-2 py-2 text-right text-slate-200">
                    {r.odds_decimal != null ? r.odds_decimal.toFixed(2) : '—'}
                  </td>
                  <td className="px-2 py-2 text-right text-slate-500 hidden md:table-cell">
                    {r.fair_decimal != null ? r.fair_decimal.toFixed(2) : '—'}
                  </td>
                  <td className={`px-2 py-2 text-right ${edgeColor}`}>
                    {edge != null ? `${edge >= 0 ? '+' : ''}${edge.toFixed(1)}%` : '—'}
                  </td>
                  <td className="px-2 py-2 text-right hidden sm:table-cell">
                    <div className="inline-block align-middle">
                      <RunnerOddsSpark series={oddsHistory[r.horse_id] ?? []} />
                    </div>
                  </td>
                </tr>
              )
            })}
            {sorted.length === 0 && (
              <tr>
                <td colSpan={7} className="px-2 py-6 text-center text-slate-500 text-[10px] tracking-[0.32em] uppercase">
                  no runners on the card
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Th({
  label, k, sortKey, sortDir, onClick, className,
}: {
  label: string
  k: SortKey
  sortKey: SortKey
  sortDir: SortDir
  onClick: (k: SortKey) => void
  className?: string
}) {
  const active = sortKey === k
  return (
    <th className={`px-2 py-2 font-normal cursor-pointer select-none ${className ?? ''}`} onClick={() => onClick(k)}>
      <span className={active ? 'text-amber-300' : ''}>
        {label}
        {active && <span className="ml-1">{sortDir === 'asc' ? '▲' : '▼'}</span>}
      </span>
    </th>
  )
}

function cmp(a: RunnerWithEdge, b: RunnerWithEdge, key: SortKey, dir: SortDir): number {
  const sign = dir === 'asc' ? 1 : -1
  switch (key) {
    case 'horse':
      return sign * a.horse.localeCompare(b.horse)
    case 'odds': {
      const av = a.odds_decimal ?? Number.POSITIVE_INFINITY
      const bv = b.odds_decimal ?? Number.POSITIVE_INFINITY
      return sign * (av - bv)
    }
    case 'edge': {
      const av = a.edge_pct ?? Number.NEGATIVE_INFINITY
      const bv = b.edge_pct ?? Number.NEGATIVE_INFINITY
      return sign * (av - bv)
    }
    case 'number': {
      const an = parseInt((a.number ?? '999').replace(/\D/g, ''), 10) || 999
      const bn = parseInt((b.number ?? '999').replace(/\D/g, ''), 10) || 999
      return sign * (an - bn)
    }
  }
}
