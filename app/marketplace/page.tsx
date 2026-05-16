'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'

interface Item {
  slug: string
  title: string
  blurb: string
  gate_cost: number
  owned: boolean
}

export default function MarketplacePage() {
  const [items, setItems] = useState<Item[]>([])
  const [balance, setBalance] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/marketplace/catalog', { cache: 'no-store' })
      if (!r.ok) {
        setError(r.status === 401 ? 'Sign in to browse the marketplace.' : 'Could not load the catalog.')
        return
      }
      const d = await r.json()
      setBalance(Number(d.balance ?? 0))
      setItems(Array.isArray(d.items) ? d.items : [])
      setError(null)
    } catch {
      setError('Could not load the catalog.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const buy = useCallback(async (slug: string) => {
    setBusy(slug)
    try {
      const r = await fetch('/api/marketplace/purchase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slug }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) {
        setError(
          d?.error === 'insufficient'
            ? `Not enough Park Gates (need ${d.cost}).`
            : (d?.error ?? 'Purchase failed.'),
        )
      } else {
        setError(null)
        await load()
      }
    } catch {
      setError('Purchase failed.')
    } finally {
      setBusy(null)
    }
  }, [load])

  return (
    <main className="relative min-h-screen bg-[#0a0c14] text-slate-100 overflow-x-hidden">
      <header className="sticky top-0 z-30 border-b-2 border-yellow-500/15 bg-[#0a0c14]/85 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto px-5 sm:px-8 py-3 flex items-center justify-between gap-4">
          <Link href="/thepark" className="font-mono text-[10px] tracking-[0.32em] uppercase text-yellow-300 hover:text-white transition-colors">
            ← the park
          </Link>
          <span className="font-mono text-[10px] tracking-[0.45em] uppercase text-yellow-500/80">
            ▌▌▌ marketplace
          </span>
          <span className="font-mono text-[10px] tracking-[0.32em] uppercase text-yellow-300">
            {balance === null ? '— pg' : `${balance} pg`}
          </span>
        </div>
      </header>

      <section className="max-w-7xl mx-auto px-5 sm:px-8 pt-12 sm:pt-16 pb-8">
        <h1 className="text-[clamp(2rem,7vw,4.5rem)] font-black tracking-tight leading-[0.92] uppercase text-white">
          blueprints.<br />
          <span className="text-yellow-400">schematics. systems.</span>
        </h1>
        <p className="mt-5 max-w-2xl text-base text-slate-400 leading-relaxed">
          Operator-curated builds. Spend Park Gates to unlock the download. Each
          item lists its gate cost up front; what you own stays yours.
        </p>
      </section>

      <section className="max-w-7xl mx-auto px-5 sm:px-8 pb-20">
        {error && (
          <p className="mb-6 font-mono text-[11px] tracking-[0.18em] uppercase text-red-400/80">
            {error}
          </p>
        )}
        {loading ? (
          <p className="font-mono text-[11px] tracking-[0.18em] uppercase text-slate-500">loading catalog…</p>
        ) : items.length === 0 && !error ? (
          <p className="font-mono text-[11px] tracking-[0.18em] uppercase text-slate-500">
            nothing on the shelf yet — check back soon
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-5">
            {items.map((it) => (
              <div key={it.slug} className="flex flex-col border-2 border-yellow-500/30 bg-[#0a0c14]/60 p-6">
                <h3 className="text-xl font-black tracking-tight uppercase text-white">{it.title}</h3>
                <p className="mt-3 flex-1 text-sm text-slate-400 leading-relaxed">{it.blurb}</p>
                <div className="mt-5 flex items-center justify-between">
                  <span className="font-mono text-[11px] tracking-[0.18em] uppercase text-yellow-300">
                    {it.gate_cost} pg
                  </span>
                  {it.owned ? (
                    <a
                      href={`/api/marketplace/download/${encodeURIComponent(it.slug)}`}
                      className="font-mono text-[10px] tracking-[0.32em] uppercase border-2 border-emerald-400/60 text-emerald-300 hover:bg-emerald-400 hover:text-black px-4 py-2 transition-colors"
                    >
                      download →
                    </a>
                  ) : (
                    <button
                      type="button"
                      disabled={busy === it.slug}
                      onClick={() => buy(it.slug)}
                      className="font-mono text-[10px] tracking-[0.32em] uppercase border-2 border-yellow-300 text-yellow-300 hover:bg-yellow-400 hover:text-black px-4 py-2 transition-colors disabled:opacity-50"
                    >
                      {busy === it.slug ? 'buying…' : 'buy'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </main>
  )
}
