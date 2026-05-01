'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

const GUMROAD_URL = process.env.NEXT_PUBLIC_GUMROAD_URL ?? 'https://gumroad.com/l/bfmoe'

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

export default function SubscribePage() {
  const time = useClock()

  return (
    <main className="relative min-h-dvh w-full bg-[#0a0c14] text-slate-100 selection:bg-yellow-500/30 selection:text-yellow-100 overflow-x-hidden">
      {/* Brutalist grid wash — industrial yellow at low opacity */}
      <div
        className="pointer-events-none fixed inset-0 -z-20 opacity-30"
        style={{
          backgroundImage:
            'linear-gradient(rgba(234,179,8,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(234,179,8,0.06) 1px, transparent 1px)',
          backgroundSize: '64px 64px',
        }}
      />

      {/* Header */}
      <header
        className="relative z-20 flex items-center justify-between px-5 sm:px-8 py-4 border-b-2 border-yellow-500/15"
        style={{ paddingTop: 'max(16px, env(safe-area-inset-top))' }}
      >
        <Link href="/" className="flex items-center gap-2.5 group">
          <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse shadow-[0_0_10px_rgba(234,179,8,0.9)]" />
          <span className="font-mono text-[10px] tracking-[0.32em] text-yellow-500/80 uppercase group-hover:text-yellow-300 transition-colors">
            ◂ back to park.world
          </span>
        </Link>
        <div className="flex items-center gap-4">
          <span className="hidden sm:inline font-mono text-[10px] tracking-[0.25em] text-yellow-700/70 uppercase tabular-nums">
            {time && <>pst · {time}</>}
          </span>
          <Link
            href="/login"
            className="font-mono text-[10px] tracking-[0.32em] uppercase border-2 border-yellow-500/60 hover:border-yellow-300 text-yellow-300 hover:text-white px-3 py-2 transition-colors"
          >
            local sign in →
          </Link>
        </div>
      </header>

      {/* Hero */}
      <section className="relative z-10 px-5 sm:px-8 pt-12 sm:pt-20 pb-12 sm:pb-16 max-w-7xl mx-auto">
        <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-yellow-500/80 uppercase mb-4">
          ▌▌▌ monthly pass · $10
        </p>
        <h1 className="text-[clamp(2.4rem,9vw,6.5rem)] font-black tracking-tight leading-[0.9] uppercase">
          <span className="block text-white">one month.</span>
          <span className="block text-yellow-400 [text-shadow:0_0_50px_rgba(234,179,8,0.45)]">
            fifty park gates.
          </span>
        </h1>
        <p className="mt-6 sm:mt-8 max-w-2xl text-base sm:text-lg text-slate-400 leading-relaxed">
          One pass. Thirty days inside the park.
          <br className="hidden sm:block" />
          <span className="text-slate-500">Plus fifty Park Gates — the in-park currency you spend to talk to Lila and buy what her team builds.</span>
        </p>
      </section>

      {/* What you receive — two big tiles */}
      <section className="relative z-10 border-y-2 border-yellow-500/30 bg-yellow-500/[0.04]">
        <div className="max-w-7xl mx-auto px-5 sm:px-8 py-14 sm:py-20">
          <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-yellow-400 uppercase">
            ▌▌▌ what you receive
          </p>
          <h2 className="mt-3 text-[clamp(1.8rem,5vw,3rem)] font-black tracking-tight uppercase text-white mb-8 sm:mb-10">
            two things, <span className="text-yellow-400">no fluff.</span>
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 sm:gap-5">
            <ReceiveTile
              kicker="01 · access"
              title="30 DAYS"
              body="Full run of the park. Lila's dashboard, agent broadcasts, sports edges, commodities desk, marketplace — everything keyed to your pass."
            />
            <ReceiveTile
              kicker="02 · currency"
              title="50 PARK GATES"
              body="Gates are how you do anything inside the park. Message Lila and her team directly. Or spend them on software blueprints, schematics, and systems the team ships."
            />
          </div>
        </div>
      </section>

      {/* How gates work — three numbered cells */}
      <section className="relative z-10">
        <div className="max-w-7xl mx-auto px-5 sm:px-8 py-12 sm:py-16">
          <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-yellow-500/80 uppercase mb-2">
            ▌▌▌ how park gates work
          </p>
          <h2 className="text-[clamp(1.6rem,4.5vw,2.6rem)] font-black tracking-tight uppercase text-white mb-8">
            earn. spend. <span className="text-yellow-400">stack.</span>
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-5">
            <GateStep
              n="01"
              title="EARN"
              body="50 fresh Park Gates land in your wallet the moment your pass starts — and again at every monthly renewal."
            />
            <GateStep
              n="02"
              title="SPEND"
              body="Open a line to Lila. Buy a blueprint. Pull a schematic. Unlock a system. Each action is priced in gates, posted up front."
            />
            <GateStep
              n="03"
              title="STACK"
              body="Unspent gates roll forward as long as your pass is active. No expiry games. Stack a few months and buy something bigger."
            />
          </div>
        </div>
      </section>

      {/* Pricing slab — final CTA */}
      <section className="relative z-10 border-y-2 border-yellow-500/30 bg-yellow-500/[0.04]">
        <div className="max-w-7xl mx-auto px-5 sm:px-8 py-14 sm:py-20">
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-8 lg:gap-12 items-end">
            <div>
              <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-yellow-400 uppercase">
                ▌▌▌ the pass
              </p>
              <h2 className="mt-3 text-[clamp(2.4rem,8vw,5.5rem)] font-black tracking-tight leading-[0.92] uppercase text-white">
                ten dollars.<br />
                <span className="text-yellow-400 [text-shadow:0_0_40px_rgba(234,179,8,0.45)]">fifty park gates.</span>
              </h2>
              <ul className="mt-6 space-y-1.5 font-mono text-[11px] tracking-[0.18em] text-slate-400 uppercase">
                <li><span className="text-yellow-400">▸</span> 30 days of full park access</li>
                <li><span className="text-yellow-400">▸</span> 50 park gates · auto each renewal</li>
                <li><span className="text-yellow-400">▸</span> direct line to lila &amp; team</li>
                <li><span className="text-yellow-400">▸</span> buy blueprints · schematics · systems</li>
                <li><span className="text-yellow-400">▸</span> cancel anytime via gumroad</li>
              </ul>
            </div>

            <div className="flex flex-col gap-3 lg:min-w-[280px]">
              <a
                href={GUMROAD_URL}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => track('buy_click', 'subscribe_page')}
                className="group block border-2 border-yellow-300 bg-yellow-400 hover:bg-yellow-300 text-black px-5 py-5 transition-colors hover:shadow-[0_0_60px_-15px_rgba(234,179,8,0.55)]"
              >
                <div className="font-mono text-[10px] tracking-[0.32em] uppercase text-black/70">continue to checkout</div>
                <div className="mt-2 flex items-baseline gap-2">
                  <span className="text-3xl font-black tracking-tight">$10</span>
                  <span className="font-mono text-[10px] tracking-[0.32em] uppercase text-black/60">/ month</span>
                  <span className="font-mono text-[10px] tracking-[0.25em] text-black/60 uppercase ml-auto">+ 50 pg</span>
                </div>
                <div className="mt-3 flex items-center justify-between">
                  <span className="font-mono text-[10px] tracking-[0.32em] uppercase text-black/70">→ gumroad</span>
                  <span className="text-2xl group-hover:translate-x-1 transition-transform">→</span>
                </div>
              </a>
              <Link
                href="/login"
                onClick={() => track('sign_in_click', 'subscribe_page')}
                className="block text-center font-mono text-[10px] tracking-[0.32em] uppercase border-2 border-yellow-500/40 hover:border-yellow-300 text-yellow-300 hover:text-white px-5 py-3 transition-colors"
              >
                already a member · sign in
              </Link>
            </div>
          </div>

          <p className="mt-8 max-w-3xl font-mono text-[10px] tracking-[0.25em] text-slate-600 uppercase leading-relaxed">
            recurring monthly subscription billed by gumroad. cancel anytime — your pass stays live until the end of the paid period. unspent park gates roll while your pass is active.
          </p>
        </div>
      </section>

      <footer
        className="relative z-10 px-5 sm:px-8 py-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 font-mono text-[9px] sm:text-[10px] tracking-[0.32em] uppercase text-slate-700"
        style={{ paddingBottom: 'max(24px, env(safe-area-inset-bottom))' }}
      >
        <span className="flex items-center gap-2">
          <span className="w-1 h-1 rounded-full bg-yellow-500 animate-pulse" />
          a parksystems corp. autonomous operation
        </span>
        <Link href="/" className="hover:text-yellow-300 transition-colors">◂ park.world</Link>
        <span>v1</span>
      </footer>
    </main>
  )
}

function ReceiveTile({ kicker, title, body }: { kicker: string; title: string; body: string }) {
  return (
    <div className="group relative border-2 border-yellow-500/40 hover:border-yellow-300 bg-slate-950/70 backdrop-blur-sm p-6 sm:p-8 transition-all duration-300 hover:-translate-y-0.5 hover:shadow-[0_0_60px_-15px_rgba(234,179,8,0.55)]">
      <div className="flex items-center justify-between mb-4">
        <span className="font-mono text-[10px] tracking-[0.32em] uppercase text-yellow-300">{kicker}</span>
        <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse shadow-[0_0_8px_currentColor]" />
      </div>
      <div className="text-[clamp(2rem,5vw,3rem)] font-black tracking-tight text-white leading-[0.95] mb-4">
        {title}
      </div>
      <p className="font-mono text-[12px] sm:text-[13px] leading-relaxed text-slate-400">{body}</p>
    </div>
  )
}

function GateStep({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div className="relative border-2 border-yellow-500/40 bg-slate-950/70 p-5 sm:p-6 transition-colors hover:border-yellow-300">
      <div className="flex items-baseline justify-between mb-3">
        <span className="font-mono text-[10px] tracking-[0.32em] uppercase text-yellow-500/80">{n}</span>
        <span className="font-mono text-[10px] tracking-[0.32em] uppercase text-yellow-300">{title}</span>
      </div>
      <p className="font-mono text-[11px] sm:text-[12px] leading-relaxed text-slate-400">{body}</p>
    </div>
  )
}
