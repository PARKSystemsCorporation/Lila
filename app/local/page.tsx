// Post-login landing — "the local" — the room you walk into after the door
// closes behind you. Two main doors (sports, commodities) plus the supporting
// links that used to live at /thepark. Members & operators both land here.

'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

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

export default function LocalPage() {
  const time = useClock()
  const signOut = async () => {
    await fetch('/api/viewer/login', { method: 'DELETE' }).catch(() => {})
    window.location.href = '/'
  }

  return (
    <main className="relative min-h-dvh w-full bg-[#0a0c14] text-slate-100 selection:bg-amber-500/30 selection:text-amber-100 overflow-x-hidden">
      <div
        className="pointer-events-none fixed inset-0 -z-20 opacity-30"
        style={{
          backgroundImage:
            'linear-gradient(rgba(245,158,11,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(245,158,11,0.06) 1px, transparent 1px)',
          backgroundSize: '64px 64px',
        }}
      />
      <Reticles />

      {/* Header */}
      <header
        className="sticky top-0 z-30 border-b-2 border-amber-500/15 bg-[#0a0c14]/85 backdrop-blur-md"
        style={{ paddingTop: 'env(safe-area-inset-top)' }}
      >
        <div className="mx-auto max-w-7xl px-4 sm:px-8 py-3 flex items-center justify-between">
          <Link href="/" className="group flex items-center gap-2.5">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shadow-[0_0_10px_rgba(245,158,11,0.9)]" />
            <span className="font-mono text-[10px] tracking-[0.32em] text-amber-500/80 uppercase group-hover:text-amber-300 transition-colors">
              ▓ park · local
            </span>
          </Link>
          <div className="flex items-center gap-4">
            <span className="hidden sm:inline font-mono text-[10px] tracking-[0.25em] text-amber-700/70 uppercase tabular-nums">
              {time && <>pst · {time}</>}
            </span>
            <button
              onClick={signOut}
              className="font-mono text-[10px] tracking-[0.32em] uppercase border-2 border-amber-500/40 hover:border-amber-300 text-amber-300 hover:text-white px-3 py-2 transition-colors"
            >
              sign out →
            </button>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative px-5 sm:px-8 pt-10 sm:pt-16 pb-12 max-w-5xl mx-auto text-center">
        <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-amber-500/80 uppercase mb-5">
          ▌▌▌ the local
        </p>
        <h1 className="text-[clamp(2.8rem,11vw,7.5rem)] font-black tracking-tight leading-[0.88] uppercase">
          <span className="block text-white">make every</span>
          <span className="block text-amber-400 [text-shadow:0_0_50px_rgba(245,158,11,0.5)]">
            call count
          </span>
        </h1>
        <p className="mt-6 max-w-xl mx-auto text-base sm:text-lg text-slate-400 leading-relaxed">
          Real-time signals. Sharp insights.
          <br className="hidden sm:block" />
          <span className="text-slate-500">Built for high-conviction plays.</span>
        </p>

        {/* Stat trio */}
        <div className="mt-10 sm:mt-12 grid grid-cols-3 gap-3 sm:gap-8 border-y-2 border-amber-500/15 py-6 sm:py-8">
          <StatPip icon={<IconTarget />}    label={<>predicting<br />every game</>} />
          <StatPip icon={<IconTrophy />}    label={<>all major<br />sports</>} />
          <StatPip icon={<IconDroplet />}   label={<>15 different<br />commodities</>} />
        </div>
      </section>

      {/* Two doors */}
      <section className="relative px-5 sm:px-8 pb-12 max-w-7xl mx-auto">
        <div className="text-center mb-8">
          <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-amber-500/80 uppercase">
            ▌▌▌ choose your market
          </p>
          <h2 className="mt-3 text-[clamp(1.8rem,5vw,3rem)] font-black tracking-tight uppercase text-white">
            where will you find<br />your <span className="text-amber-400">edge</span>?
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
          <MarketDoor
            href="/sports"
            kicker="live games · real-time edges"
            title="SPORTS"
            tone="amber"
            cta="explore sports →"
            icons={[<IconBasketball key="bb" />, <IconFootball key="fb" />, <IconSoccer key="sc" />, <IconBaseball key="bs" />, <IconHockey key="hk" />]}
          />
          <MarketDoor
            href="/commodities"
            kicker="track the markets · spot the moves"
            title="COMMODITIES"
            tone="orange"
            cta="explore commodities →"
            icons={[<IconDroplet key="oil" />, <IconGold key="gd" />, <IconWheat key="wt" />, <IconFlame key="ng" />, <IconBull key="bl" />]}
          />
        </div>
      </section>

      {/* Three features */}
      <section className="relative border-y-2 border-amber-500/20 bg-slate-950/40">
        <div className="mx-auto max-w-5xl px-5 sm:px-8 py-12 sm:py-16">
          <p className="text-center font-mono text-[11px] sm:text-[12px] tracking-[0.45em] text-amber-400 uppercase mb-10">
            real-time signals · built to win
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 sm:gap-10">
            <Feature
              icon={<IconBolt />}
              title="LIVE SIGNALS"
              body="As the game and markets move."
            />
            <Feature
              icon={<IconTarget />}
              title="SHARP INSIGHTS"
              body="Data-driven signals you can trust."
            />
            <Feature
              icon={<IconShield />}
              title="BUILT FOR WINNERS"
              body="High conviction plays, backed by stats."
            />
          </div>
        </div>
      </section>

      {/* Supporting doors — the legacy /thepark hub, condensed. */}
      <section className="relative px-5 sm:px-8 py-12 max-w-7xl mx-auto">
        <p className="font-mono text-[10px] tracking-[0.45em] text-amber-500/80 uppercase mb-4">
          ▌▌▌ also inside
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
          <SmallDoor href="/viewer"     kicker="board"      title="VIEWER"      body="Ceelo's edges + articles." />
          <SmallDoor href="/marketplace" kicker="park gates" title="MARKETPLACE" body="Spend PG on a DM to the desk." />
          <SmallDoor href="/thepark/operator" kicker="console" title="OPERATOR" body="Admin-gated. Operators only." />
        </div>
      </section>

      {/* CTA */}
      <section className="relative border-t-2 border-amber-500/30 bg-amber-500/[0.04]">
        <div className="mx-auto max-w-3xl px-5 sm:px-8 py-12 sm:py-16 text-center">
          <h3 className="text-[clamp(1.6rem,5vw,2.6rem)] font-black tracking-tight uppercase text-white">
            ready to get the <span className="text-amber-400">edge</span>?
          </h3>
          <p className="mt-3 text-sm sm:text-base text-slate-400 leading-relaxed">
            Join thousands of sharp bettors and traders who trust the park.
          </p>
          <Link
            href="/sports"
            className="mt-7 inline-flex items-center justify-between gap-4 bg-amber-400 hover:bg-amber-300 text-black border-2 border-amber-300 px-7 py-4 font-mono text-[11px] tracking-[0.32em] uppercase transition-colors min-w-[280px]"
          >
            <span>let&rsquo;s go</span>
            <span className="text-base">→</span>
          </Link>
        </div>
      </section>

      <footer
        className="px-5 sm:px-8 py-6 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 font-mono text-[9px] sm:text-[10px] tracking-[0.32em] uppercase text-slate-700"
        style={{ paddingBottom: 'max(24px, env(safe-area-inset-bottom))' }}
      >
        <span>© {new Date().getFullYear()} the park.world · all rights reserved</span>
        <span className="flex items-center gap-5">
          <Link href="/specs" className="hover:text-amber-300 transition-colors">terms</Link>
          <Link href="/specs" className="hover:text-amber-300 transition-colors">privacy</Link>
          <Link href="/specs" className="hover:text-amber-300 transition-colors">responsible</Link>
        </span>
      </footer>
    </main>
  )
}

// ─── Subcomponents ────────────────────────────────────────────────────────

function StatPip({ icon, label }: { icon: JSX.Element; label: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <span className="text-amber-400 [filter:drop-shadow(0_0_8px_rgba(245,158,11,0.5))]">{icon}</span>
      <span className="font-mono text-[9px] sm:text-[10px] tracking-[0.32em] uppercase text-slate-300 leading-tight">
        {label}
      </span>
    </div>
  )
}

function MarketDoor({
  href, kicker, title, tone, cta, icons,
}: {
  href: string
  kicker: string
  title: string
  tone: 'amber' | 'orange'
  cta: string
  icons: JSX.Element[]
}) {
  const c = tone === 'amber'
    ? { border: 'border-amber-500/60 hover:border-amber-300', text: 'text-amber-300', glow: 'hover:shadow-[0_0_80px_-20px_rgba(245,158,11,0.65)]', titleGlow: '[text-shadow:0_0_40px_rgba(245,158,11,0.5)]' }
    : { border: 'border-orange-500/60 hover:border-orange-300', text: 'text-orange-300', glow: 'hover:shadow-[0_0_80px_-20px_rgba(251,146,60,0.65)]', titleGlow: '[text-shadow:0_0_40px_rgba(251,146,60,0.5)]' }

  return (
    <Link
      href={href}
      className={`group relative border-2 ${c.border} bg-slate-950/70 p-6 sm:p-8 flex flex-col items-center text-center transition-all duration-300 hover:-translate-y-1 ${c.glow}`}
    >
      <div className={`text-[clamp(2.4rem,6vw,3.6rem)] font-black tracking-tight uppercase text-white leading-[0.95] ${c.titleGlow}`}>
        {title}
      </div>
      <p className={`mt-2 font-mono text-[10px] sm:text-[11px] tracking-[0.25em] uppercase ${c.text}`}>
        {kicker}
      </p>

      <div className="my-6 sm:my-8 h-32 sm:h-44 w-full flex items-center justify-center text-slate-700 group-hover:text-slate-500 transition-colors">
        <svg viewBox="0 0 200 100" className="w-full h-full opacity-40 group-hover:opacity-70 transition-opacity">
          <defs>
            <radialGradient id={`g-${tone}`} cx="50%" cy="50%">
              <stop offset="0%" stopColor={tone === 'amber' ? '#f59e0b' : '#fb923c'} stopOpacity="0.35" />
              <stop offset="100%" stopColor={tone === 'amber' ? '#f59e0b' : '#fb923c'} stopOpacity="0" />
            </radialGradient>
          </defs>
          <circle cx="100" cy="50" r="40" fill={`url(#g-${tone})`} />
          <circle cx="100" cy="50" r="36" fill="none" stroke="currentColor" strokeWidth="0.5" />
          <circle cx="100" cy="50" r="24" fill="none" stroke="currentColor" strokeWidth="0.5" />
          <circle cx="100" cy="50" r="12" fill="none" stroke="currentColor" strokeWidth="0.5" />
          <circle cx="100" cy="50" r="2"  fill="currentColor" />
        </svg>
      </div>

      <div className={`w-full border-2 ${c.border} py-3 flex items-center justify-between px-4 mb-5 group-hover:bg-slate-950 transition-colors`}>
        <span className="font-mono text-[10px] sm:text-[11px] tracking-[0.32em] uppercase text-white">{cta.replace(' →', '')}</span>
        <span className={`${c.text} group-hover:translate-x-0.5 transition-transform`}>›</span>
      </div>

      <div className={`flex items-center gap-4 ${c.text}`}>
        {icons.map((ic, i) => <span key={i} className="opacity-70 group-hover:opacity-100 transition-opacity">{ic}</span>)}
      </div>
    </Link>
  )
}

function Feature({ icon, title, body }: { icon: JSX.Element; title: string; body: string }) {
  return (
    <div className="flex flex-col items-center text-center gap-3">
      <span className="text-amber-400 [filter:drop-shadow(0_0_8px_rgba(245,158,11,0.5))]">{icon}</span>
      <h4 className="font-mono text-[11px] tracking-[0.32em] uppercase text-white">{title}</h4>
      <p className="text-xs sm:text-sm text-slate-400 leading-relaxed max-w-[18ch]">{body}</p>
    </div>
  )
}

function SmallDoor({ href, kicker, title, body }: { href: string; kicker: string; title: string; body: string }) {
  return (
    <Link
      href={href}
      className="group block border-2 border-amber-500/30 hover:border-amber-300 bg-slate-950/70 p-4 sm:p-5 transition-all duration-300 hover:-translate-y-0.5"
    >
      <div className="flex items-center justify-between mb-2">
        <span className="font-mono text-[10px] tracking-[0.32em] uppercase text-amber-300">{kicker}</span>
        <span className="text-slate-600 group-hover:text-amber-300 transition-colors">→</span>
      </div>
      <div className="text-xl font-black tracking-tight uppercase text-white">{title}</div>
      <p className="mt-1 font-mono text-[10px] sm:text-[11px] text-slate-500 leading-relaxed">{body}</p>
    </Link>
  )
}

// Faint corner-reticles, mirroring the reference's "radar" feel.
function Reticles() {
  return (
    <svg
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10 w-full h-full opacity-40"
      preserveAspectRatio="none"
    >
      <defs>
        <radialGradient id="reticle-fade" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.5" />
          <stop offset="60%" stopColor="#f59e0b" stopOpacity="0" />
        </radialGradient>
      </defs>
      <g stroke="rgba(245,158,11,0.18)" fill="none" strokeWidth="0.5">
        <circle cx="8%"  cy="14%" r="60" />
        <circle cx="8%"  cy="14%" r="32" />
        <circle cx="8%"  cy="14%" r="12" />
        <circle cx="92%" cy="34%" r="70" />
        <circle cx="92%" cy="34%" r="38" />
        <circle cx="92%" cy="34%" r="14" />
        <circle cx="94%" cy="88%" r="50" />
        <circle cx="94%" cy="88%" r="26" />
      </g>
      <g fill="#f59e0b">
        <circle cx="8%"  cy="14%" r="1.5" />
        <circle cx="92%" cy="34%" r="1.5" />
        <circle cx="94%" cy="88%" r="1.5" />
      </g>
    </svg>
  )
}

// ─── Inline icons (no external deps; keep them small and consistent) ──────

const STROKE = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

function IconTarget() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" {...STROKE}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
    </svg>
  )
}
function IconTrophy() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" {...STROKE}>
      <path d="M7 4h10v4a5 5 0 0 1-10 0V4z" />
      <path d="M17 5h3v2a3 3 0 0 1-3 3M7 5H4v2a3 3 0 0 0 3 3" />
      <path d="M9 18h6M10 18v3h4v-3M12 14v4" />
    </svg>
  )
}
function IconDroplet() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" {...STROKE}>
      <path d="M12 3s-6 7-6 11a6 6 0 0 0 12 0c0-4-6-11-6-11z" />
    </svg>
  )
}
function IconBolt() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" {...STROKE}>
      <path d="M13 3 5 14h6l-1 7 8-11h-6l1-7z" />
    </svg>
  )
}
function IconShield() {
  return (
    <svg viewBox="0 0 24 24" width="28" height="28" {...STROKE}>
      <path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6l-8-3z" />
      <path d="m9 12 2 2 4-4" />
    </svg>
  )
}
function IconBasketball() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" {...STROKE}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3v18M5.6 5.6c3 3 3 9.8 0 12.8M18.4 5.6c-3 3-3 9.8 0 12.8" />
    </svg>
  )
}
function IconFootball() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" {...STROKE}>
      <ellipse cx="12" cy="12" rx="9" ry="5" />
      <path d="M7 12h10M9 10v4M12 9.5v5M15 10v4" />
    </svg>
  )
}
function IconSoccer() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" {...STROKE}>
      <circle cx="12" cy="12" r="9" />
      <path d="m12 7 4 3-1.5 5h-5L8 10z" />
      <path d="M12 3v4M3 12h5M21 12h-5M7 21l1-6M17 21l-1-6" />
    </svg>
  )
}
function IconBaseball() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" {...STROKE}>
      <circle cx="12" cy="12" r="9" />
      <path d="M6 6c2 2 3 4 3 6s-1 4-3 6M18 6c-2 2-3 4-3 6s1 4 3 6" />
    </svg>
  )
}
function IconHockey() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" {...STROKE}>
      <ellipse cx="12" cy="15" rx="9" ry="3" />
      <path d="M3 15v-3M21 15v-3" />
      <ellipse cx="12" cy="12" rx="9" ry="3" />
    </svg>
  )
}
function IconGold() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" {...STROKE}>
      <path d="M4 18h16l-3-8H7l-3 8z" />
      <path d="M7 10V7h10v3" />
    </svg>
  )
}
function IconWheat() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" {...STROKE}>
      <path d="M12 21V8" />
      <path d="M12 8c-2-2-4-2-5-1 1 2 3 3 5 3M12 8c2-2 4-2 5-1-1 2-3 3-5 3M12 13c-2-2-4-2-5-1 1 2 3 3 5 3M12 13c2-2 4-2 5-1-1 2-3 3-5 3M12 17c-2-2-4-2-5-1 1 2 3 3 5 3M12 17c2-2 4-2 5-1-1 2-3 3-5 3" />
    </svg>
  )
}
function IconFlame() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" {...STROKE}>
      <path d="M12 3s-1 3 1 6 3 4 3 7a4 4 0 0 1-8 0c0-2 1-3 2-4-1 0-3-1-3-3 0 0 5-1 5-6z" />
    </svg>
  )
}
function IconBull() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" {...STROKE}>
      <circle cx="12" cy="14" r="6" />
      <path d="M6 8 3 5M18 8l3-3M9 13h.01M15 13h.01M10 17c1 1 3 1 4 0" />
    </svg>
  )
}
