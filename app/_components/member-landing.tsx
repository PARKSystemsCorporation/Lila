// Post-login landing — the room you walk into after signing in. Two main
// doors (the yield + horse racing) plus supporting links. Rendered at `/`
// for any visitor with a viewer or operator cookie.

'use client'

import Link from 'next/link'
import {
  LocalShell,
  IconTarget, IconTrophy, IconDroplet, IconBolt, IconShield,
  IconBasketball, IconFootball, IconBaseball, IconBull,
} from '@/app/_components/local/chrome'

export default function MemberLanding() {
  return (
    <LocalShell>
      {/* Hero */}
      <section className="relative px-5 sm:px-8 pt-10 sm:pt-16 pb-12 max-w-5xl mx-auto text-center">
        <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-amber-500/80 uppercase mb-5">
          ▌▌▌ the park · members
        </p>
        <h1 className="text-[clamp(2.8rem,11vw,7.5rem)] font-black tracking-tight leading-[0.88] uppercase">
          <span className="block text-white">make every</span>
          <span className="block text-amber-400">
            call count
          </span>
        </h1>
        <p className="mt-6 max-w-xl mx-auto text-base sm:text-lg text-slate-400 leading-relaxed">
          Real-time signals. Sharp insights.
          <br className="hidden sm:block" />
          <span className="text-slate-500">Built for high-conviction plays.</span>
        </p>

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
            href="/theyield"
            kicker="sports + commodities · live edges"
            title="THE YIELD"
            tone="orange"
            cta="enter the yield →"
            icons={[<IconBasketball key="bb" />, <IconFootball key="fb" />, <IconBaseball key="bs" />, <IconDroplet key="oil" />, <IconBull key="bl" />]}
          />
          <MarketDoor
            href="/horse-racing"
            kicker="thoroughbreds · live yields"
            title="HORSE RACING"
            tone="amber"
            cta="enter the gates →"
            icons={[<IconBolt key="bt" />, <IconTarget key="tg" />, <IconTrophy key="tr" />]}
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

      {/* The locals — people who work the room. */}
      <section className="relative px-5 sm:px-8 py-12 max-w-7xl mx-auto">
        <div className="mb-6 flex items-baseline justify-between gap-4">
          <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-rose-400/90 uppercase">
            ▌▌▌ the locals
          </p>
          <p className="hidden sm:block font-mono text-[10px] tracking-[0.32em] text-slate-500 uppercase">
            people · around · the · park
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-5">
          <LocalCard
            href="/handicappers"
            name="Morgan Tanaka"
            role="handicapper · the fade"
            tagline="Fades the public opinion."
            initials="MT"
            chip="fade"
          />
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
            href="/theyield"
            className="mt-7 inline-flex items-center justify-between gap-4 bg-amber-400 hover:bg-amber-300 text-black border-2 border-amber-300 px-7 py-4 font-mono text-[11px] tracking-[0.32em] uppercase transition-colors min-w-[280px]"
          >
            <span>let&rsquo;s go</span>
            <span className="text-base">→</span>
          </Link>
        </div>
      </section>
    </LocalShell>
  )
}

// ─── Page-local subcomponents ─────────────────────────────────────────────

function StatPip({ icon, label }: { icon: JSX.Element; label: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      <span className="text-amber-400">{icon}</span>
      <span className="font-mono text-[9px] sm:text-[10px] tracking-[0.32em] uppercase text-slate-300 leading-tight">
        {label}
      </span>
    </div>
  )
}

function MarketDoor({
  href, kicker, title, tone, cta, icons, soon,
}: {
  href?: string
  kicker: string
  title: string
  tone: 'amber' | 'orange'
  cta: string
  icons: JSX.Element[]
  soon?: boolean
}) {
  const c = tone === 'amber'
    ? { border: 'border-amber-500/60 hover:border-amber-300', text: 'text-amber-300', glow: '', titleGlow: '' }
    : { border: 'border-orange-500/60 hover:border-orange-300', text: 'text-orange-300', glow: '', titleGlow: '' }

  const inner = (
    <>
      {soon && (
        <span className="absolute top-3 right-3 font-mono text-[9px] tracking-[0.32em] uppercase text-slate-500 border border-slate-700 px-1.5 py-0.5">
          soon
        </span>
      )}
      <div className={`text-[clamp(2.4rem,6vw,3.6rem)] font-black tracking-tight uppercase text-white leading-[0.95] ${c.titleGlow} ${soon ? 'opacity-60' : ''}`}>
        {title}
      </div>
      <p className={`mt-2 font-mono text-[10px] sm:text-[11px] tracking-[0.25em] uppercase ${c.text} ${soon ? 'opacity-60' : ''}`}>
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

      <div className={`w-full border-2 ${c.border} py-3 flex items-center justify-between px-4 mb-5 ${soon ? '' : 'group-hover:bg-slate-950'} transition-colors`}>
        <span className={`font-mono text-[10px] sm:text-[11px] tracking-[0.32em] uppercase ${soon ? 'text-slate-500' : 'text-white'}`}>
          {cta.replace(' →', '')}
        </span>
        <span className={`${soon ? 'text-slate-700' : `${c.text} group-hover:translate-x-0.5`} transition-transform`}>
          {soon ? '✕' : '›'}
        </span>
      </div>

      <div className={`flex items-center gap-4 ${c.text} ${soon ? 'opacity-50' : ''}`}>
        {icons.map((ic, i) => <span key={i} className="opacity-70 group-hover:opacity-100 transition-opacity">{ic}</span>)}
      </div>
    </>
  )

  if (soon || !href) {
    return (
      <div
        aria-disabled
        className={`group relative border-2 ${c.border} bg-slate-950/70 p-6 sm:p-8 flex flex-col items-center text-center opacity-80 cursor-not-allowed`}
      >
        {inner}
      </div>
    )
  }

  return (
    <Link
      href={href}
      className={`group relative border-2 ${c.border} bg-slate-950/70 p-6 sm:p-8 flex flex-col items-center text-center transition-all duration-300 hover:-translate-y-1 ${c.glow}`}
    >
      {inner}
    </Link>
  )
}

function Feature({ icon, title, body }: { icon: JSX.Element; title: string; body: string }) {
  return (
    <div className="flex flex-col items-center text-center gap-3">
      <span className="text-amber-400">{icon}</span>
      <h4 className="font-mono text-[11px] tracking-[0.32em] uppercase text-white">{title}</h4>
      <p className="text-xs sm:text-sm text-slate-400 leading-relaxed max-w-[18ch]">{body}</p>
    </div>
  )
}

function LocalCard({
  href, name, role, tagline, initials, chip,
}: {
  href: string
  name: string
  role: string
  tagline: string
  initials: string
  chip: string
}) {
  return (
    <Link
      href={href}
      className="group relative border-2 border-rose-500/40 hover:border-rose-300 bg-slate-950/70 backdrop-blur-sm transition-all duration-300 hover:-translate-y-0.5 overflow-hidden"
    >
      <div className="relative aspect-[3/4] overflow-hidden border-b border-slate-800/80">
        <div
          className="absolute inset-0"
          style={{
            background:
              'radial-gradient(120% 80% at 50% 0%, rgba(244,63,94,0.18), transparent 60%), linear-gradient(180deg, #15161f 0%, #0a0c14 100%)',
          }}
        />
        <div
          className="absolute inset-0 opacity-[0.12] mix-blend-overlay"
          style={{
            backgroundImage:
              'repeating-linear-gradient(45deg, rgba(255,255,255,0.6) 0 1px, transparent 1px 6px)',
          }}
        />
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="font-mono text-[clamp(4rem,12vw,7rem)] font-black tracking-tight text-white/10 group-hover:text-white/20 transition-colors leading-none">
            {initials}
          </span>
        </div>
        <div className="absolute top-3 left-3 flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-rose-400 animate-pulse" />
          <span className="font-mono text-[9px] tracking-[0.3em] uppercase text-rose-300">local</span>
        </div>
        <div
          className="absolute bottom-0 inset-x-0 h-1/2 pointer-events-none"
          style={{ background: 'linear-gradient(180deg, transparent, rgba(10,12,20,0.85) 80%)' }}
        />
      </div>

      <div className="relative p-4 sm:p-5">
        <div className="flex items-baseline justify-between gap-3 mb-2">
          <h3 className="text-xl sm:text-2xl font-black tracking-tight text-white leading-tight uppercase">
            {name}
          </h3>
          <span className="font-mono text-[9px] tracking-[0.3em] uppercase px-1.5 py-0.5 border border-rose-500/50 text-rose-200 whitespace-nowrap">
            {chip}
          </span>
        </div>
        <div className="font-mono text-[10px] sm:text-[11px] tracking-[0.3em] text-slate-500 uppercase mb-3">
          {role}
        </div>
        <p className="text-sm text-slate-300 leading-relaxed">{tagline}</p>

        <div className="mt-4 border-t border-slate-800 pt-3 flex items-center justify-between font-mono text-[9px] tracking-[0.32em] uppercase text-slate-600">
          <span>{href}</span>
          <span className="group-hover:text-rose-300 transition-colors">open →</span>
        </div>
      </div>
    </Link>
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
