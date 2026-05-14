'use client'

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import { rankedSeasons, type SeasonState, type SportKey } from '@/lib/season'

const LandingSculpture = dynamic(() => import('./landing-sculpture'), {
  ssr: false,
  loading: () => null,
})
const LandingTicker = dynamic(() => import('./landing-ticker'), {
  ssr: false,
  loading: () => null,
})

const SPORT_HREF: Record<SportKey, string> = {
  NFL: '/sports/nfl',
  NBA: '/sports/nba',
  NHL: '/sports/nhl',
  MLB: '/sports/mlb',
}

// Custom-drawn ball glyphs — league logos are trademarked and not
// commercially safe, so we render neutral sport icons inline.
const BALL: Record<SportKey, ReactElement> = {
  NFL: (
    <svg viewBox="0 0 32 32" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <ellipse cx="16" cy="16" rx="13" ry="7" />
      <path d="M9 16h14M11 13l1 6M15 12l1 8M19 12l1 8M23 13l1 6" />
    </svg>
  ),
  NBA: (
    <svg viewBox="0 0 32 32" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="16" cy="16" r="12" />
      <path d="M4 16h24M16 4v24M7.5 7.5c4 4 4 13 0 17M24.5 7.5c-4 4-4 13 0 17" />
    </svg>
  ),
  NHL: (
    <svg viewBox="0 0 32 32" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <ellipse cx="16" cy="20" rx="11" ry="4" />
      <path d="M5 20v-6c0-2.2 4.9-4 11-4s11 1.8 11 4v6" />
      <ellipse cx="16" cy="14" rx="11" ry="4" />
    </svg>
  ),
  MLB: (
    <svg viewBox="0 0 32 32" className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="16" cy="16" r="12" />
      <path d="M7 9c4 2 6 6 6 14M25 9c-4 2-6 6-6 14" />
    </svg>
  ),
}

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
  const seasons = useMemo(() => rankedSeasons(), [])

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

      {/* Sports teaser strip */}
      <section className="relative z-10 border-y-2 border-amber-500/15 bg-slate-950/40 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto px-5 sm:px-8 py-10 sm:py-14">
          <div className="flex items-baseline justify-between gap-4 mb-6 sm:mb-8">
            <div>
              <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-orange-400/80 uppercase">
                ▌▌▌ what&rsquo;s in play
              </p>
              <h2 className="mt-2 text-[clamp(1.8rem,5vw,3rem)] font-black tracking-tight uppercase text-white">
                every <span className="text-amber-400">sport</span>, every season.
              </h2>
            </div>
            <Link
              href="/sports"
              className="hidden sm:inline-flex font-mono text-[10px] tracking-[0.32em] uppercase border-2 border-amber-500/40 hover:border-amber-300 text-amber-300 hover:text-white px-3 py-2 transition-colors"
            >
              all sports →
            </Link>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
            {seasons.map((s, i) => <SportTile key={s.sport} state={s} index={i} />)}
          </div>

          <div className="sm:hidden mt-4">
            <Link
              href="/sports"
              className="block w-full text-center font-mono text-[10px] tracking-[0.32em] uppercase border-2 border-amber-500/40 text-amber-300 px-3 py-3"
            >
              all sports →
            </Link>
          </div>
        </div>
      </section>

      {/* Three properties */}
      <section className="relative z-10">
        <div className="max-w-7xl mx-auto px-5 sm:px-8 py-12 sm:py-16">
          <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-amber-500/80 uppercase mb-2">
            ▌▌▌ what lives here
          </p>
          <h2 className="text-[clamp(1.8rem,5vw,3rem)] font-black tracking-tight uppercase text-white mb-8">
            three <span className="text-amber-400">desks</span>, one ticker.
          </h2>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-5">
            <PropertyTile href="/thepark"     kicker="members" title="THEPARK"     body="Members hub. The console, edges, and marketplace — past the paywall." accent="amber" />
            <PropertyTile href="/commodities" kicker="futures" title="COMMODITIES" body="Daily futures notes from the desk. Markdown, not noise." accent="orange" />
            <PropertyTile href="/sports"      kicker="edges"   title="SPORTS"      body="Ceelo's NFL handicapper. Math vs. the book line, every cycle." accent="red" />
          </div>

          <Link
            href="/bounty"
            className="group mt-6 sm:mt-8 inline-flex items-center gap-2 font-mono text-[10px] sm:text-[11px] tracking-[0.32em] uppercase text-slate-500 hover:text-amber-300 transition-colors"
          >
            <span className="text-amber-500/60 group-hover:text-amber-300 transition-colors">▌</span>
            <span>how the bounty pipeline works</span>
            <span className="group-hover:translate-x-0.5 transition-transform">→</span>
          </Link>
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

function SportTile({ state, index }: { state: SeasonState; index: number }) {
  const phase = state.phase
  const tone =
    phase === 'regular'  ? { border: 'border-amber-500/60 hover:border-amber-300', text: 'text-amber-300', dot: 'bg-amber-400', glow: '' } :
    phase === 'playoffs' ? { border: 'border-red-500/60 hover:border-red-300',     text: 'text-red-300',   dot: 'bg-red-400',   glow: '' } :
                           { border: 'border-slate-700 hover:border-slate-500',     text: 'text-slate-500', dot: 'bg-slate-600', glow: '' }

  const fillPct = phase === 'regular' && state.pctRemaining != null ? state.pctRemaining : 0

  return (
    <Link
      href={SPORT_HREF[state.sport]}
      className={`group relative border-2 ${tone.border} bg-slate-950/70 p-4 sm:p-5 transition-all duration-300 hover:-translate-y-0.5 ${tone.glow}`}
    >
      <div className="flex items-center justify-between mb-3 sm:mb-4">
        <span className={`font-mono text-[9px] tracking-[0.3em] uppercase ${tone.text}`}>#{index + 1}</span>
        <span className={`w-1.5 h-1.5 rounded-full ${tone.dot} ${phase !== 'offseason' ? 'animate-pulse' : ''}`} />
      </div>

      <div className="flex items-center gap-3">
        <span className={tone.text}>{BALL[state.sport]}</span>
        <span className="text-[clamp(1.6rem,4vw,2.4rem)] font-black tracking-tight text-white leading-[0.95]">
          {state.label}
        </span>
      </div>

      <div className="mt-4 sm:mt-5">
        {phase === 'regular' ? (
          <>
            <div className="flex items-baseline justify-between font-mono text-[10px] tracking-[0.25em] uppercase mb-2">
              <span className={tone.text}>regular</span>
              <span className="tabular-nums text-white font-bold">{state.pctRemaining?.toFixed(0)}%</span>
            </div>
            <div className="h-1.5 bg-slate-800/70 relative overflow-hidden">
              <div
                className="absolute inset-y-0 left-0 bg-gradient-to-r from-amber-500 to-orange-400 transition-all duration-1000"
                style={{ width: `${fillPct}%`, boxShadow: '0 0 12px rgba(245,158,11,0.7)' }}
              />
            </div>
            <div className="font-mono text-[9px] tracking-[0.25em] text-slate-500 uppercase mt-2 tabular-nums">
              {state.daysRemaining}d to playoffs
            </div>
          </>
        ) : phase === 'playoffs' ? (
          <>
            <div className="font-mono text-[10px] tracking-[0.3em] text-red-300 uppercase">playoffs · live</div>
            <div className="font-mono text-[9px] tracking-[0.25em] text-slate-500 uppercase mt-2 tabular-nums">
              {state.daysRemaining}d remaining
            </div>
          </>
        ) : (
          <>
            <div className="font-mono text-[10px] tracking-[0.3em] text-slate-500 uppercase">off season</div>
            {state.next && (
              <div className="font-mono text-[9px] tracking-[0.25em] text-slate-700 uppercase mt-2 tabular-nums">
                returns {state.next.on}
              </div>
            )}
          </>
        )}
      </div>

      <div className="absolute bottom-2 right-2 font-mono text-[10px] text-slate-700 group-hover:text-amber-300 transition-colors">→</div>
    </Link>
  )
}

interface PropertyTileProps {
  href: string
  kicker: string
  title: string
  body: string
  accent: 'amber' | 'orange' | 'red'
}

const PROP_TONE: Record<PropertyTileProps['accent'], { ring: string; text: string; glow: string; dot: string }> = {
  amber:  { ring: 'border-amber-500/40 hover:border-amber-300', text: 'text-amber-300',  glow: '', dot: 'bg-amber-400' },
  orange: { ring: 'border-orange-500/40 hover:border-orange-300', text: 'text-orange-300', glow: '', dot: 'bg-orange-400' },
  red:    { ring: 'border-red-500/40 hover:border-red-300',     text: 'text-red-300',    glow: '',  dot: 'bg-red-400' },
}

function PropertyTile({ href, kicker, title, body, accent }: PropertyTileProps) {
  const c = PROP_TONE[accent]
  return (
    <Link
      href={href}
      className={`group relative block border-2 ${c.ring} bg-slate-950/70 backdrop-blur-sm p-5 sm:p-6 transition-all duration-300 hover:-translate-y-0.5 ${c.glow}`}
    >
      <div className="flex items-center justify-between mb-4">
        <span className={`font-mono text-[10px] tracking-[0.32em] uppercase ${c.text}`}>{kicker}</span>
        <span className={`w-1.5 h-1.5 rounded-full ${c.dot} animate-pulse`} />
      </div>
      <div className={`text-[clamp(1.8rem,4.5vw,2.6rem)] font-black tracking-tight ${c.text} leading-[0.95] mb-3`}>
        {title}
      </div>
      <p className="font-mono text-[11px] leading-relaxed text-slate-400">{body}</p>
      <div className="absolute bottom-3 right-3 font-mono text-sm text-slate-700 group-hover:text-white transition-colors group-hover:translate-x-0.5">→</div>
    </Link>
  )
}
