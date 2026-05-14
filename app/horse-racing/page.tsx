// /horse-racing — long vertical list of race cards. Polls
// /api/horse-racing every 30s (matches the cadence the rest of the
// app uses; see app/theyield/sports/page.tsx).
//
// Beta: one card per race. Each card shows course / off-time / race
// name / field size / top-yield runner pill (intensity bar + velocity
// arrow). "view field →" is a stub button — drill-in lands later.

'use client'

import { useCallback, useEffect, useState } from 'react'
import { LocalShell, IconBolt, IconTarget, IconTrophy } from '@/app/_components/local/chrome'
import { RaceCard } from './_components/race-card'

interface RaceSignal {
  top_runner: {
    horse_id: string
    horse: string
    number: number | null
    odds_decimal: number | null
    fair_decimal: number | null
    edge_pct: number | null
  } | null
  intensity: number
  velocity: 'up' | 'down' | 'flat'
  reasoning: string
}

export interface Race {
  race_id: string
  course: string
  off_time: string
  off_dt: string
  race_name: string
  distance: string | null
  going: string | null
  type: string | null
  field_size: number
  signal: RaceSignal
}

interface Status {
  creds_ok: boolean
  cache_size: number
  last_refresh_ts: number | null
  live_sources: Array<{ name: string; kind: string }>
  error?: string
}

interface ApiResp {
  races: Race[]
  status: Status
  generated_at: number
}

export default function HorseRacingPage() {
  const [resp, setResp] = useState<ApiResp | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/horse-racing', { cache: 'no-store' })
      if (!r.ok) { setResp(null); return }
      setResp(await r.json())
    } catch {
      setResp(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [load])

  const races = resp?.races ?? []
  // Sort: hottest signal first, then by scheduled off time.
  const sorted = [...races].sort((a, b) => {
    const i = (b.signal?.intensity ?? 0) - (a.signal?.intensity ?? 0)
    if (i !== 0) return i
    return (a.off_dt ?? '').localeCompare(b.off_dt ?? '')
  })

  return (
    <LocalShell
      title="HORSE RACING"
      subtitle="Thoroughbreds. Live yields."
      accent="amber"
      back={{ href: '/', label: 'back to the park' }}
    >
      {/* Hero / status strip */}
      <section className="border-b border-amber-500/15 bg-slate-950/40">
        <div className="mx-auto max-w-7xl px-4 sm:px-8 py-5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="text-amber-300"><IconTrophy /></span>
            <div className="min-w-0">
              <div className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-amber-500/80 uppercase">
                ▌▌▌ the gates
              </div>
              <div className="text-white font-black tracking-tight uppercase text-lg sm:text-xl">
                today&rsquo;s card
              </div>
            </div>
          </div>
          <StatusBadge status={resp?.status} />
        </div>
      </section>

      {/* Stat strip */}
      <section className="border-b border-amber-500/15">
        <div className="mx-auto max-w-7xl px-4 sm:px-8 py-4 grid grid-cols-3 gap-3">
          <Stat icon={<IconTarget />} label="races" value={String(races.length)} />
          <Stat icon={<IconBolt />}   label="live sources" value={String(resp?.status.live_sources.length ?? 0)} />
          <Stat icon={<IconTrophy />} label="updated"
                value={resp ? relative(resp.generated_at) : '—'} />
        </div>
      </section>

      {/* Race list */}
      <section className="mx-auto max-w-3xl px-3 sm:px-6 py-6 sm:py-8">
        {loading && races.length === 0 ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => <RaceCardSkeleton key={i} />)}
          </div>
        ) : !resp?.status.creds_ok ? (
          <NoCredsPanel />
        ) : sorted.length === 0 ? (
          <EmptyPanel />
        ) : (
          <div className="space-y-3 sm:space-y-4">
            {sorted.map(r => <RaceCard key={r.race_id} race={r} />)}
          </div>
        )}
      </section>
    </LocalShell>
  )
}

// ─── Subcomponents ────────────────────────────────────────────────────────

function Stat({ icon, label, value }: { icon: JSX.Element; label: string; value: string }) {
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

function StatusBadge({ status }: { status?: Status }) {
  if (!status) {
    return (
      <span className="font-mono text-[9px] tracking-[0.32em] uppercase text-slate-600 border border-slate-800 px-2 py-1">
        loading…
      </span>
    )
  }
  if (!status.creds_ok) {
    return (
      <span className="font-mono text-[9px] tracking-[0.32em] uppercase text-rose-300 border border-rose-500/40 px-2 py-1">
        no feed
      </span>
    )
  }
  return (
    <span className="font-mono text-[9px] tracking-[0.32em] uppercase text-amber-300 border border-amber-500/40 px-2 py-1">
      live
    </span>
  )
}

function RaceCardSkeleton() {
  return (
    <div className="border-2 border-amber-500/15 bg-slate-950/60 p-4 sm:p-5">
      <div className="h-4 w-40 bg-slate-900 animate-pulse mb-3" />
      <div className="h-6 w-64 bg-slate-900 animate-pulse mb-4" />
      <div className="h-10 w-full bg-slate-900 animate-pulse" />
    </div>
  )
}

function NoCredsPanel() {
  return (
    <div className="border-2 border-rose-500/30 bg-slate-950/60 px-5 py-10 text-center">
      <h2 className="font-mono text-[11px] sm:text-[12px] tracking-[0.45em] uppercase text-rose-300 mb-3">
        ▌▌▌ feed offline
      </h2>
      <p className="text-sm text-slate-400 leading-relaxed max-w-md mx-auto">
        Set <span className="font-mono text-amber-300">RACING_API_USERNAME</span> and{' '}
        <span className="font-mono text-amber-300">RACING_API_PASSWORD</span> to bring the gates online.
      </p>
    </div>
  )
}

function EmptyPanel() {
  return (
    <div className="border-2 border-amber-500/15 bg-slate-950/60 px-5 py-12 text-center">
      <p className="font-mono text-[11px] tracking-[0.45em] uppercase text-slate-500">
        ▌▌▌ no cards on the board
      </p>
      <p className="mt-3 text-sm text-slate-400 leading-relaxed">
        Check back closer to the first off.
      </p>
    </div>
  )
}

function relative(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60)   return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}
