// /theyard — Vega's commodity board. Today's picks only; wipes at 00:00 UTC.
// Polls /api/yard/today every 30s. Single file, MVP-light — same vocabulary
// as /horse-racing but for analyst_picks rows where asset_class='etf/macro'.

'use client'

import { useCallback, useEffect, useState, type ReactElement } from 'react'
import { LocalShell, IconBolt, IconTarget } from '@/app/_components/local/chrome'

interface YardPick {
  id: number
  symbol: string
  direction: 'long' | 'short'
  entry_price: number | string | null
  target_price: number | string | null
  stop_loss: number | string | null
  confidence: number | string | null
  risk_level: 'low' | 'medium' | 'high' | null
  reason: string | null
  status: string | null
  created_at: string
}

interface YardStatus {
  creds_ok: boolean
  count: number
}

interface ApiResp {
  picks: YardPick[]
  generated_at: string
  status: YardStatus
}

export default function TheYardPage() {
  const [resp, setResp] = useState<ApiResp | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/yard/today', { cache: 'no-store' })
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

  const picks = resp?.picks ?? []

  return (
    <LocalShell
      title="THE YARD"
      subtitle="Vega's commodity board · wipes at 00:00 UTC"
      accent="amber"
      back={{ href: '/', label: 'back to home' }}
    >
      {/* Hero / status strip */}
      <section className="border-b border-amber-500/15 bg-slate-950/40">
        <div className="mx-auto max-w-7xl px-4 sm:px-8 py-5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="text-amber-300"><IconTarget /></span>
            <div className="min-w-0">
              <div className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-amber-500/80 uppercase">
                ▌▌▌ today&rsquo;s calls
              </div>
              <div className="text-white font-black tracking-tight uppercase text-lg sm:text-xl">
                vega · etf + macro
              </div>
            </div>
          </div>
          <StatusBadge status={resp?.status} loading={loading} />
        </div>
      </section>

      {/* Stat strip */}
      <section className="border-b border-amber-500/15">
        <div className="mx-auto max-w-7xl px-4 sm:px-8 py-4 grid grid-cols-3 gap-3">
          <Stat icon={<IconTarget />} label="calls" value={String(picks.length)} />
          <Stat icon={<IconBolt />}   label="reset"
                value={resp?.status.creds_ok ? '00:00 utc' : '—'} />
          <Stat icon={<IconBolt />}   label="updated"
                value={resp ? relative(resp.generated_at) : '—'} />
        </div>
      </section>

      {/* Picks list */}
      <section className="mx-auto max-w-3xl px-3 sm:px-6 py-6 sm:py-8">
        {loading && picks.length === 0 ? (
          <div className="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => <PickCardSkeleton key={i} />)}
          </div>
        ) : !resp?.status.creds_ok ? (
          <NoCredsPanel />
        ) : picks.length === 0 ? (
          <EmptyPanel />
        ) : (
          <div className="space-y-3 sm:space-y-4">
            {picks.map(p => <PickCard key={p.id} pick={p} />)}
          </div>
        )}
      </section>
    </LocalShell>
  )
}

// ─── Subcomponents ────────────────────────────────────────────────────────

function PickCard({ pick }: { pick: YardPick }) {
  const conf = num(pick.confidence)
  const entry = num(pick.entry_price)
  const target = num(pick.target_price)
  const stop = num(pick.stop_loss)
  const dir = (pick.direction ?? 'long').toUpperCase()
  return (
    <div className="border-2 border-amber-500/20 bg-slate-950/70 p-4 sm:p-5">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <div className="flex items-baseline gap-3 min-w-0">
          <span className="font-black text-2xl sm:text-3xl text-white tracking-tight uppercase">
            {pick.symbol}
          </span>
          <span className="font-mono text-[10px] tracking-[0.32em] uppercase text-amber-300 border border-amber-500/40 px-1.5 py-0.5">
            {dir}
          </span>
        </div>
        <RiskChip level={pick.risk_level} />
      </div>

      <div className="grid grid-cols-3 gap-2 sm:gap-3 mb-3">
        <PriceCell label="entry"  value={entry} />
        <PriceCell label="target" value={target} />
        <PriceCell label="stop"   value={stop} />
      </div>

      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="font-mono text-[10px] tracking-[0.32em] uppercase text-slate-500">
          confidence
        </div>
        <div className="font-mono text-sm text-amber-300 tabular-nums">
          {conf != null ? conf.toFixed(2) : '—'}
        </div>
      </div>

      {pick.reason && (
        <p className="text-sm text-slate-300 leading-relaxed">
          {pick.reason}
        </p>
      )}
    </div>
  )
}

function PriceCell({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="border border-amber-500/15 bg-slate-950/60 px-2.5 py-2">
      <div className="font-mono text-[9px] tracking-[0.32em] uppercase text-slate-500">{label}</div>
      <div className="font-mono text-sm sm:text-base text-white tabular-nums">
        {value != null ? value.toFixed(2) : '—'}
      </div>
    </div>
  )
}

function RiskChip({ level }: { level: YardPick['risk_level'] }) {
  if (!level) return null
  const tone = level === 'high'
    ? 'text-rose-300 border-rose-500/40'
    : level === 'medium'
      ? 'text-amber-300 border-amber-500/40'
      : 'text-emerald-300 border-emerald-500/40'
  return (
    <span className={`font-mono text-[9px] tracking-[0.32em] uppercase border px-1.5 py-0.5 ${tone}`}>
      {level} risk
    </span>
  )
}

function Stat({ icon, label, value }: { icon: ReactElement; label: string; value: string }) {
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

function StatusBadge({ status, loading }: { status?: YardStatus; loading: boolean }) {
  if (loading && !status) {
    return (
      <span className="font-mono text-[9px] tracking-[0.32em] uppercase text-slate-600 border border-slate-800 px-2 py-1">
        loading…
      </span>
    )
  }
  if (!status?.creds_ok) {
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

function PickCardSkeleton() {
  return (
    <div className="border-2 border-amber-500/15 bg-slate-950/60 p-4 sm:p-5">
      <div className="h-6 w-32 bg-slate-900 animate-pulse mb-3" />
      <div className="grid grid-cols-3 gap-2 mb-3">
        <div className="h-10 bg-slate-900 animate-pulse" />
        <div className="h-10 bg-slate-900 animate-pulse" />
        <div className="h-10 bg-slate-900 animate-pulse" />
      </div>
      <div className="h-4 w-full bg-slate-900 animate-pulse" />
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
        Set <span className="font-mono text-amber-300">DATABASE_URL</span> to wire the yard to vega&rsquo;s desk.
      </p>
    </div>
  )
}

function EmptyPanel() {
  return (
    <div className="border-2 border-amber-500/15 bg-slate-950/60 px-5 py-12 text-center">
      <p className="font-mono text-[11px] tracking-[0.45em] uppercase text-slate-500">
        ▌▌▌ board&rsquo;s still empty
      </p>
      <p className="mt-3 text-sm text-slate-400 leading-relaxed">
        Vega hasn&rsquo;t called the open yet. Resets at 00:00 utc.
      </p>
    </div>
  )
}

function num(v: number | string | null | undefined): number | null {
  if (v == null) return null
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : null
}

function relative(iso: string): string {
  const ts = new Date(iso).getTime()
  if (!Number.isFinite(ts)) return '—'
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (s < 60)   return `${s}s ago`
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  return `${Math.round(s / 3600)}h ago`
}
