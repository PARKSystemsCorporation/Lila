'use client'

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useEffect, useState } from 'react'

const LandingScene = dynamic(() => import('./_components/landing-scene'), {
  ssr: false,
  loading: () => null,
})

interface Dest {
  href: string
  label: string
  sub: string
  tone: 'amber' | 'orange' | 'red'
  cadence: string
}

const DESTINATIONS: Dest[] = [
  { href: '/lila',        label: 'Lila',        sub: 'agent · bounties · trades',  tone: 'amber',  cadence: '06:00 · 18:00 PT' },
  { href: '/commodities', label: 'Commodities', sub: 'futures · daily markdown',   tone: 'orange', cadence: '00:00 · 12:00 PT' },
  { href: '/sports',      label: 'Sports',      sub: 'edges · NFL handicapper',    tone: 'red',    cadence: '00:00 · 12:00 PT' },
]

const TONE_CLASSES: Record<Dest['tone'], { ring: string; text: string; glow: string; dot: string }> = {
  amber:  { ring: 'border-amber-500/40 hover:border-amber-400 hover:bg-amber-500/[0.06]',   text: 'text-amber-300',  glow: 'group-hover:shadow-[0_0_60px_-10px_rgba(245,158,11,0.55)]', dot: 'bg-amber-400' },
  orange: { ring: 'border-orange-500/40 hover:border-orange-400 hover:bg-orange-500/[0.06]', text: 'text-orange-300', glow: 'group-hover:shadow-[0_0_60px_-10px_rgba(251,146,60,0.55)]', dot: 'bg-orange-400' },
  red:    { ring: 'border-red-500/40 hover:border-red-400 hover:bg-red-500/[0.06]',         text: 'text-red-300',    glow: 'group-hover:shadow-[0_0_60px_-10px_rgba(239,68,68,0.55)]',  dot: 'bg-red-400' },
}

function useClock() {
  const [now, setNow] = useState<string>('')
  useEffect(() => {
    const tick = () => {
      const t = new Date().toLocaleTimeString('en-US', {
        timeZone: 'America/Los_Angeles',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      })
      setNow(t)
    }
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [])
  return now
}

export default function Landing() {
  const time = useClock()

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-[#0a0c14] text-slate-100 select-none">
      <div className="absolute inset-0 -z-0">
        <LandingScene />
      </div>

      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(ellipse at center, transparent 35%, rgba(10,12,20,0.92) 90%)' }}
      />

      <header
        className="absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-5 sm:px-8 py-4"
        style={{ paddingTop: 'max(16px, env(safe-area-inset-top))' }}
      >
        <div className="flex items-center gap-2.5">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shadow-[0_0_10px_rgba(245,158,11,0.9)]" />
          <span className="font-mono text-[10px] tracking-[0.32em] text-amber-500/80 uppercase">
            ▓ parksystems · corp
          </span>
        </div>
        <div className="font-mono text-[10px] tracking-[0.25em] text-amber-700/70 uppercase tabular-nums">
          {time && <>pst · {time}</>}
        </div>
      </header>

      <section className="relative z-10 h-full w-full flex flex-col items-center justify-center px-5 sm:px-8 text-center">
        <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-amber-500/70 uppercase mb-3 sm:mb-4">
          welcome to
        </p>
        <h1 className="text-[clamp(2.6rem,9vw,6rem)] font-bold tracking-tight leading-[0.95] text-white">
          the&nbsp;<span className="text-amber-400 [text-shadow:0_0_40px_rgba(245,158,11,0.45)]">park</span>
          <span className="text-slate-500">.world</span>
        </h1>

        <p className="mt-4 sm:mt-5 max-w-xl text-[13px] sm:text-base text-slate-400 leading-relaxed">
          Markets never sleep. Neither does she.
          <br className="hidden sm:block" />
          <span className="text-slate-500">Live signals across stocks, commodities, and sports — running with or without you.</span>
        </p>

        <nav className="mt-10 sm:mt-14 grid grid-cols-3 gap-2 sm:gap-4 w-full max-w-3xl">
          {DESTINATIONS.map((d) => {
            const c = TONE_CLASSES[d.tone]
            return (
              <Link
                key={d.href}
                href={d.href}
                className={`group relative flex flex-col items-center gap-1.5 sm:gap-2 px-3 sm:px-5 py-4 sm:py-6 rounded-xl border bg-slate-950/50 backdrop-blur-sm transition-all duration-300 ${c.ring} ${c.glow}`}
              >
                <span className={`absolute top-2.5 right-2.5 w-1.5 h-1.5 rounded-full ${c.dot} shadow-[0_0_8px_currentColor] opacity-70 group-hover:opacity-100`} />
                <span className={`text-base sm:text-2xl font-bold tracking-tight ${c.text}`}>{d.label}</span>
                <span className="font-mono text-[9px] sm:text-[10px] tracking-widest uppercase text-slate-500 leading-tight">
                  {d.sub}
                </span>
                <span className="hidden sm:block font-mono text-[9px] tracking-widest text-slate-700 mt-1">
                  {d.cadence}
                </span>
              </Link>
            )
          })}
        </nav>
      </section>

      <footer
        className="absolute bottom-0 left-0 right-0 z-10 px-5 sm:px-8 py-4 flex items-center justify-between font-mono text-[9px] sm:text-[10px] tracking-[0.25em] uppercase text-slate-700"
        style={{ paddingBottom: 'max(16px, env(safe-area-inset-bottom))' }}
      >
        <span className="flex items-center gap-2">
          <span className="w-1 h-1 rounded-full bg-amber-500 animate-pulse" />
          autonomous · live
        </span>
        <span className="hidden sm:inline">commodities & sports refresh 00 · 12 pt — lila checks in 06 · 18 pt</span>
        <span>v1</span>
      </footer>
    </main>
  )
}
