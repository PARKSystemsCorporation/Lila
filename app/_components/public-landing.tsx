'use client'

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useEffect, useState } from 'react'

const LandingSculpture = dynamic(() => import('./landing-sculpture'), {
  ssr: false,
  loading: () => null,
})
const LandingTicker = dynamic(() => import('./landing-ticker'), {
  ssr: false,
  loading: () => null,
})

function useClock() {
  const [t, set] = useState('')
  useEffect(() => {
    const tick = () => set(new Date().toLocaleTimeString('en-US', {
      timeZone: 'America/Los_Angeles',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])
  return t
}

// Fire-and-forget conversion event. One per session per (event,ref) pair
// so reload-mashing doesn't inflate counts.
function track(event: string, ref?: string) {
  if (typeof window === 'undefined') return
  const k = `pw_track:${event}:${ref ?? ''}`
  try {
    if (window.sessionStorage.getItem(k)) return
    window.sessionStorage.setItem(k, '1')
  } catch { /* private mode etc — still send once */ }
  fetch('/api/public/landing-events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event, ref }),
    keepalive: true,
  }).catch(() => {})
}

export default function PublicLanding() {
  const time = useClock()

  return (
    <main className="relative min-h-dvh w-full bg-[#0a0c14] text-slate-100 selection:bg-amber-500/30 selection:text-amber-100 overflow-x-hidden">
      {/* Brutalist grid wash */}
      <div
        className="pointer-events-none fixed inset-0 -z-20 opacity-30"
        style={{
          backgroundImage:
            'linear-gradient(rgba(245,158,11,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(245,158,11,0.06) 1px, transparent 1px)',
          backgroundSize: '64px 64px',
        }}
      />

      {/* Three.js sculpture lives behind everything */}
      <div className="pointer-events-none fixed inset-0 -z-10">
        <LandingSculpture />
        <div
          className="absolute inset-0"
          style={{ background: 'radial-gradient(ellipse at center, transparent 30%, rgba(10,12,20,0.85) 85%)' }}
        />
      </div>

      {/* Top ticker */}
      <div className="sticky top-0 z-30">
        <LandingTicker />
      </div>

      {/* Header */}
      <header
        className="relative z-20 flex items-center justify-between px-5 sm:px-8 py-4 border-b-2 border-amber-500/15"
        style={{ paddingTop: 'max(16px, env(safe-area-inset-top))' }}
      >
        <div className="flex items-center gap-2.5">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
          <span className="font-mono text-[10px] tracking-[0.32em] text-amber-500/80 uppercase">
            ▓ parksystems · corp
          </span>
        </div>
        <div className="flex items-center gap-4">
          <span className="hidden sm:inline font-mono text-[10px] tracking-[0.25em] text-amber-700/70 uppercase tabular-nums">
            {time && <>pst · {time}</>}
          </span>
          <Link
            href="/login"
            className="font-mono text-[10px] tracking-[0.32em] uppercase border-2 border-amber-500/60 hover:border-amber-300 text-amber-300 hover:text-white px-3 py-2 transition-colors"
          >
            local sign in →
          </Link>
        </div>
      </header>

      {/* Hero */}
      <section className="relative z-10 px-5 sm:px-8 pt-12 sm:pt-24 pb-16 sm:pb-28 max-w-7xl mx-auto">
        <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-amber-500/80 uppercase mb-4 motion-safe:animate-[slideup_0.6s_ease-out_0.05s_both]">
          ▌▌▌ welcome to
        </p>
        <h1 className="text-[clamp(3rem,12vw,9rem)] font-black tracking-tight leading-[0.88] uppercase">
          <span className="block text-white motion-safe:animate-[slideup_0.7s_ease-out_0.15s_both]">the</span>
          <span className="block motion-safe:animate-[slideup_0.7s_ease-out_0.30s_both]">
            <span className="text-amber-400">park</span>
            <span className="text-slate-600">.world</span>
          </span>
        </h1>
        <p className="mt-6 sm:mt-8 max-w-2xl text-base sm:text-lg text-slate-400 leading-relaxed motion-safe:animate-[slideup_0.7s_ease-out_0.45s_both]">
          Markets never sleep. Neither does she.
          <br className="hidden sm:block" />
          <span className="text-slate-500">Live signals across stocks, commodities, and sports — running with or without you.</span>
        </p>

        <div className="mt-10 sm:mt-12 flex flex-wrap items-center gap-3 motion-safe:animate-[slideup_0.7s_ease-out_0.6s_both]">
          <Link
            href="/subscribe"
            onClick={() => track('buy_click', 'hero')}
            className="group inline-flex items-baseline gap-3 bg-amber-400 hover:bg-amber-300 text-black px-5 py-3 border-2 border-amber-300 transition-colors"
          >
            <span className="font-mono text-[10px] tracking-[0.32em] uppercase">buy pass</span>
            <span className="font-mono text-base font-black tracking-tight">$10/MO</span>
            <span className="font-mono text-[10px] tracking-[0.25em] text-black/60 uppercase">+ 50 pg</span>
            <span className="group-hover:translate-x-0.5 transition-transform">→</span>
          </Link>
          <Link
            href="/login"
            onClick={() => track('sign_in_click', 'hero')}
            className="inline-flex items-center gap-2 border-2 border-amber-500/40 hover:border-amber-300 text-amber-300 hover:text-white px-4 py-3 font-mono text-[10px] tracking-[0.32em] uppercase transition-colors"
          >
            already a member · sign in →
          </Link>
        </div>
      </section>

      {/* Two desks — yield / yard split panels */}
      <section className="relative z-10 border-t-2 border-amber-500/30 bg-amber-500/[0.04]">
        <div className="max-w-7xl mx-auto px-5 sm:px-8 pt-14 sm:pt-20">
          <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-amber-400 uppercase motion-safe:animate-[slideup_0.6s_ease-out_0.05s_both]">
            ▌▌▌ pick your floor
          </p>
          <h2 className="mt-3 text-[clamp(2.4rem,8vw,5.5rem)] font-black tracking-tight leading-[0.92] uppercase text-white motion-safe:animate-[slideup_0.7s_ease-out_0.15s_both]">
            two desks.<br />
            <span className="text-amber-400">one park.</span>
          </h2>
        </div>

        <div className="max-w-7xl mx-auto px-5 sm:px-8 py-10 sm:py-14 grid grid-cols-1 lg:grid-cols-2 gap-0 items-stretch">
          <Link
            href="/theyield"
            onClick={() => track('yield_click', 'landing_doors')}
            className="group relative flex flex-col border-2 border-amber-500/60 hover:border-amber-300 bg-slate-950/70 hover:bg-slate-950 p-6 sm:p-10 lg:p-12 transition-all duration-300 hover:-translate-y-0.5 lg:border-r-0 motion-safe:animate-[slideup_0.7s_ease-out_0.30s_both]"
          >
            <div className="flex items-center justify-between mb-5">
              <span className="font-mono text-[10px] tracking-[0.32em] uppercase text-amber-300">live edges</span>
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
            </div>
            <div className="text-[clamp(2.2rem,7vw,4rem)] font-black tracking-tight leading-[0.95] uppercase text-amber-300">
              the yield
            </div>
            <p className="mt-4 text-sm sm:text-base text-slate-400 leading-relaxed">
              Sportsbetting &amp; horse racing — live spreads on one side, live gates on the other.
            </p>
            <ul className="mt-5 space-y-1.5 font-mono text-[11px] tracking-[0.18em] text-slate-400 uppercase">
              <li><span className="text-amber-400">▸</span> live ceelo edges + win-prob</li>
              <li><span className="text-amber-400">▸</span> nfl · nba · mlb · cfb</li>
              <li><span className="text-amber-400">▸</span> horse racing — live gates</li>
              <li><span className="text-amber-400">▸</span> agent broadcasts &amp; trade log</li>
            </ul>
            <div className="mt-auto pt-8 flex items-center justify-between font-mono text-[10px] tracking-[0.32em] uppercase">
              <span className="text-amber-300">enter the yield</span>
              <span className="text-amber-500/60 group-hover:text-amber-300 group-hover:translate-x-0.5 transition-all text-base">→</span>
            </div>
          </Link>

          <Link
            href="/theyard"
            onClick={() => track('yard_click', 'landing_doors')}
            className="group relative flex flex-col border-2 border-t-0 lg:border-t-2 border-orange-500/60 hover:border-orange-300 bg-slate-950/70 hover:bg-slate-950 p-6 sm:p-10 lg:p-12 transition-all duration-300 hover:-translate-y-0.5 motion-safe:animate-[slideup_0.7s_ease-out_0.45s_both]"
          >
            <div className="flex items-center justify-between mb-5">
              <span className="font-mono text-[10px] tracking-[0.32em] uppercase text-orange-300">the board</span>
              <span className="w-1.5 h-1.5 rounded-full bg-orange-400 animate-pulse" />
            </div>
            <div className="text-[clamp(2.2rem,7vw,4rem)] font-black tracking-tight leading-[0.95] uppercase text-orange-300">
              the yard
            </div>
            <p className="mt-4 text-sm sm:text-base text-slate-400 leading-relaxed">
              Commodities desk &amp; agent orchestration — Vega calls the open, the floor runs the rest.
            </p>
            <ul className="mt-5 space-y-1.5 font-mono text-[11px] tracking-[0.18em] text-slate-400 uppercase">
              <li><span className="text-orange-400">▸</span> vega · etf + macro board</li>
              <li><span className="text-orange-400">▸</span> commodities daily notes</li>
              <li><span className="text-orange-400">▸</span> agent orchestration log</li>
              <li><span className="text-orange-400">▸</span> wipes 00:00 utc</li>
            </ul>
            <div className="mt-auto pt-8 flex items-center justify-between font-mono text-[10px] tracking-[0.32em] uppercase">
              <span className="text-orange-300">enter the yard</span>
              <span className="text-orange-500/60 group-hover:text-orange-300 group-hover:translate-x-0.5 transition-all text-base">→</span>
            </div>
          </Link>
        </div>

        <div className="max-w-7xl mx-auto px-5 sm:px-8 pb-12 sm:pb-16">
          <Link
            href="/bounty"
            className="group inline-flex items-center gap-2 font-mono text-[10px] sm:text-[11px] tracking-[0.32em] uppercase text-slate-500 hover:text-amber-300 transition-colors"
          >
            <span className="text-amber-500/60 group-hover:text-amber-300 transition-colors">▌</span>
            <span>how the bounty pipeline works</span>
            <span className="group-hover:translate-x-0.5 transition-transform">→</span>
          </Link>
        </div>
      </section>

      {/* $LDGR · Ledger Coin */}
      <section className="relative z-10 border-t-2 border-amber-500/30">
        <div className="max-w-7xl mx-auto px-5 sm:px-8 py-14 sm:py-20">
          <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-amber-400 uppercase">
            ▌▌▌ $ldgr · ledger coin
          </p>
          <h2 className="mt-3 text-[clamp(2.4rem,8vw,5.5rem)] font-black tracking-tight leading-[0.92] uppercase text-white">
            the future of finance,<br />
            <span className="text-amber-400">recorded in stone.</span>
          </h2>
          <p className="mt-6 max-w-3xl text-base sm:text-lg text-slate-400 leading-relaxed">
            In an era of fleeting digital trends and volatile markets,
            <span className="text-amber-300"> Ledger Coin</span> stands as the definitive benchmark
            for transparency and security. Built on a foundation of immutable ledger technology,
            it bridges the gap between traditional accounting integrity and the limitless potential
            of decentralized finance. Whether you are looking to safeguard your assets with
            institutional-grade precision or streamline global transactions with a click,
            Ledger Coin provides the permanent, verifiable, and scalable infrastructure your
            capital deserves. Don&rsquo;t just trade the future&mdash;document it.
          </p>
          <ul className="mt-6 space-y-1.5 font-mono text-[11px] tracking-[0.18em] text-slate-400 uppercase">
            <li><span className="text-amber-400">▸</span> immutable ledger technology</li>
            <li><span className="text-amber-400">▸</span> institutional-grade precision</li>
            <li><span className="text-amber-400">▸</span> permanent · verifiable · scalable</li>
            <li><span className="text-amber-400">▸</span> bridges tradfi &amp; decentralized finance</li>
          </ul>
        </div>
      </section>

      {/* Pricing slab */}
      <section className="relative z-10 border-y-2 border-amber-500/30 bg-amber-500/[0.04]">
        <div className="max-w-7xl mx-auto px-5 sm:px-8 py-14 sm:py-20">
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-8 lg:gap-12 items-end">
            <div>
              <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-amber-400 uppercase">
                ▌▌▌ the pass
              </p>
              <h2 className="mt-3 text-[clamp(2.4rem,8vw,5.5rem)] font-black tracking-tight leading-[0.92] uppercase text-white">
                ten dollars.<br />
                <span className="text-amber-400">fifty park gates.</span>
              </h2>
              <p className="mt-5 max-w-xl text-base sm:text-lg text-slate-400 leading-relaxed">
                Subscribe once, get a Gumroad key. Every month your pass is active you receive 50 fresh
                <span className="text-amber-300"> Park Gates</span> — coins you spend on edges, articles, and alerts inside the park.
              </p>
              <ul className="mt-5 space-y-1.5 font-mono text-[11px] tracking-[0.18em] text-slate-400 uppercase">
                <li><span className="text-amber-400">▸</span> live ceelo edges + win-prob</li>
                <li><span className="text-amber-400">▸</span> commodities daily notes</li>
                <li><span className="text-amber-400">▸</span> agent broadcasts &amp; trade log</li>
                <li><span className="text-amber-400">▸</span> 50 park gates / month, auto</li>
              </ul>
            </div>

            <div className="flex flex-col gap-3 lg:min-w-[260px]">
              <Link
                href="/subscribe"
                onClick={() => track('buy_click', 'pricing')}
                className="group block border-2 border-amber-300 bg-amber-400 hover:bg-amber-300 text-black px-5 py-5 transition-colors"
              >
                <div className="font-mono text-[10px] tracking-[0.32em] uppercase text-black/70">view the pass</div>
                <div className="mt-2 flex items-baseline gap-2">
                  <span className="text-3xl font-black tracking-tight">$10</span>
                  <span className="font-mono text-[10px] tracking-[0.32em] uppercase text-black/60">/ month</span>
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <span className="font-mono text-[10px] tracking-[0.32em] uppercase text-black/70">→ details &amp; checkout</span>
                  <span className="text-2xl group-hover:translate-x-1 transition-transform">→</span>
                </div>
              </Link>
              <Link
                href="/login"
                onClick={() => track('sign_in_click', 'pricing')}
                className="block text-center font-mono text-[10px] tracking-[0.32em] uppercase border-2 border-amber-500/40 hover:border-amber-300 text-amber-300 hover:text-white px-5 py-3 transition-colors"
              >
                already a member · sign in
              </Link>
            </div>
          </div>
        </div>
      </section>

      <footer
        className="relative z-10 px-5 sm:px-8 py-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 font-mono text-[9px] sm:text-[10px] tracking-[0.32em] uppercase text-slate-700"
        style={{ paddingBottom: 'max(24px, env(safe-area-inset-bottom))' }}
      >
        <span className="flex items-center gap-2">
          <span className="w-1 h-1 rounded-full bg-amber-500 animate-pulse" />
          a parksystems corp. autonomous operation
        </span>
        <span className="hidden sm:inline">commodities &amp; sports refresh 00 · 12 pt — lila checks in 06 · 18 pt</span>
        <span>v1</span>
      </footer>

      <style jsx global>{`
        @keyframes slideup {
          0%   { opacity: 0; transform: translate3d(0, 18px, 0); }
          100% { opacity: 1; transform: translate3d(0, 0, 0); }
        }
      `}</style>
    </main>
  )
}

