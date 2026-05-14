'use client'

// /horse-racing/<raceId> — drill-in. Header repeats the race meta from
// the card, then a full-field sortable table with per-runner edge and
// an odds-history sparkline. Polls /api/horse-racing/<raceId> every
// 30s (visibility-aware would be overkill — by the time the operator
// is on this page they're already focused).

import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { LocalShell, IconTarget, IconTrophy, IconBolt } from '@/app/_components/local/chrome'
import { RunnerTable } from '../_components/runner-table'
import type { Runner } from '@/lib/horse-racing/types'
import type { OddsHistoryPoint } from '@/lib/horse-racing/data-service'

interface RaceDetail {
  race_id: string
  course: string
  country: string | null
  off_time: string
  off_dt: string
  race_name: string
  distance: string | null
  going: string | null
  type: string | null
  field_size: number
  runners: Runner[]
}

interface Signal {
  top_runner: {
    horse_id: string
    horse: string
    number: string | null
    odds_decimal: number | null
    fair_decimal: number | null
    edge_pct: number | null
  } | null
  intensity: number
  velocity: 'up' | 'down' | 'flat'
  reasoning: string
}

interface ApiResp {
  data: {
    race: RaceDetail
    oddsHistory: Record<string, OddsHistoryPoint[]>
    signal: Signal
  } | null
  status: {
    creds_ok?: boolean
    error?: string
  }
  generated_at: number
}

export default function RaceDetailPage() {
  const { raceId } = useParams<{ raceId: string }>()
  const [resp, setResp] = useState<ApiResp | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/horse-racing/${encodeURIComponent(raceId)}`, { cache: 'no-store' })
      if (!r.ok) { setResp(null); return }
      setResp(await r.json() as ApiResp)
    } catch {
      setResp(null)
    } finally {
      setLoading(false)
    }
  }, [raceId])

  useEffect(() => {
    load()
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      load()
    }, 30_000)
    return () => clearInterval(id)
  }, [load])

  const detail = resp?.data
  const race = detail?.race
  const signal = detail?.signal

  return (
    <LocalShell
      title={race ? `${race.off_time} ${race.course}`.toUpperCase() : 'RACE DETAIL'}
      subtitle={race?.race_name ?? 'Full field, live yields.'}
      accent="amber"
      back={{ href: '/horse-racing', label: 'back to the card' }}
    >
      {/* Hero strip — meta + intensity */}
      <section className="border-b border-amber-500/15 bg-slate-950/40">
        <div className="mx-auto max-w-5xl px-4 sm:px-8 py-5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="text-amber-300"><IconTrophy /></span>
            <div className="min-w-0">
              <div className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-amber-500/80 uppercase">
                ▌▌▌ paddock
              </div>
              <div className="text-white font-black tracking-tight uppercase text-lg sm:text-xl">
                {race?.course ?? '—'}
              </div>
            </div>
          </div>
          {race && (
            <div className="font-mono text-[10px] tracking-[0.32em] uppercase text-slate-500 flex flex-wrap gap-x-3 gap-y-1">
              <span>{race.field_size}-runner</span>
              {race.distance && <span>· {race.distance}</span>}
              {race.going    && <span>· {race.going}</span>}
              {race.type     && <span>· {race.type}</span>}
              {race.country  && <span>· {race.country}</span>}
            </div>
          )}
        </div>
      </section>

      <section className="border-b border-amber-500/15">
        <div className="mx-auto max-w-5xl px-4 sm:px-8 py-4 grid grid-cols-3 gap-3">
          <Stat icon={<IconTarget />}  label="intensity" value={signal ? `${signal.intensity}/10` : '—'} />
          <Stat icon={<IconBolt />}    label="top edge" value={
            signal?.top_runner?.edge_pct != null
              ? `${signal.top_runner.edge_pct >= 0 ? '+' : ''}${signal.top_runner.edge_pct.toFixed(1)}%`
              : '—'
          } />
          <Stat icon={<IconTrophy />}  label="off"
                value={race?.off_dt ? relativeOff(race.off_dt) : '—'} />
        </div>
      </section>

      {/* Reasoning + table */}
      <section className="mx-auto max-w-5xl px-3 sm:px-6 py-6 sm:py-8 space-y-4 sm:space-y-5">
        {signal?.reasoning && (
          <p className="text-sm text-slate-400 leading-relaxed">
            {signal.reasoning}
          </p>
        )}
        {loading && !detail ? (
          <div className="h-32 bg-slate-900 animate-pulse" />
        ) : !detail ? (
          <NoDetailPanel error={resp?.status.error} />
        ) : (
          <RunnerTable
            runners={withFairAndEdge(detail.race.runners)}
            oddsHistory={detail.oddsHistory}
            topRunnerId={detail.signal.top_runner?.horse_id ?? null}
          />
        )}
      </section>
    </LocalShell>
  )
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 border border-amber-500/15 bg-slate-950/60 px-3 py-2">
      <span className="text-amber-400 shrink-0">{icon}</span>
      <div className="min-w-0">
        <div className="font-mono text-[9px] sm:text-[10px] tracking-[0.32em] uppercase text-slate-500">{label}</div>
        <div className="font-mono text-sm sm:text-base text-white tabular-nums truncate">{value}</div>
      </div>
    </div>
  )
}

function NoDetailPanel({ error }: { error?: string }) {
  return (
    <div className="border-2 border-amber-500/15 bg-slate-950/60 px-5 py-12 text-center">
      <p className="font-mono text-[11px] tracking-[0.45em] uppercase text-slate-500">
        ▌▌▌ race not on the board
      </p>
      <p className="mt-3 text-sm text-slate-400 leading-relaxed">
        {error ? `Error: ${error}` : 'No racecard or odds snapshot is available for this race id.'}
      </p>
    </div>
  )
}

// Compute fair_decimal + edge_pct per runner using the same overround
// math the yield engine uses (lib/horse-racing/yield.ts). Keeps the
// drill-in self-sufficient without sending duplicated payload from the
// server.
function withFairAndEdge(runners: Runner[]) {
  const priced = runners.filter(r => r.odds_decimal != null && (r.odds_decimal as number) > 1)
  const overround = priced.reduce((s, r) => s + 1 / (r.odds_decimal as number), 0)
  return runners.map(r => {
    if (r.odds_decimal == null || overround <= 0) {
      return { ...r, fair_decimal: null, edge_pct: null }
    }
    const fairProb = (1 / r.odds_decimal) / overround
    const fairDecimal = 1 / fairProb
    const edgePct = ((fairDecimal - r.odds_decimal) / r.odds_decimal) * 100
    return {
      ...r,
      fair_decimal: +fairDecimal.toFixed(2),
      edge_pct: +edgePct.toFixed(1),
    }
  })
}

function relativeOff(iso: string): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return '—'
  const mins = Math.round((t - Date.now()) / 60_000)
  if (mins > 60) return `in ${Math.round(mins / 60)}h`
  if (mins > 0)  return `in ${mins}m`
  if (mins > -60) return `${-mins}m ago`
  return `${Math.round(-mins / 60)}h ago`
}
