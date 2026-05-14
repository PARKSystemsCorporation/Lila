// /theyield — the yield hub. Two doors: SPORTS (the scoreboard) and
// HORSE RACING (the gates).

'use client'

import Link from 'next/link'
import {
  LocalShell,
  IconBasketball, IconFootball, IconBaseball, IconHockey,
  IconBolt, IconTarget, IconTrophy,
} from '@/app/_components/local/chrome'

export default function TheYieldHub() {
  return (
    <LocalShell
      title="THE YIELD"
      subtitle="Sports and the gates. The full board."
      accent="amber"
      back={{ href: '/', label: 'back to home' }}
    >
      <section className="relative px-5 sm:px-8 pt-10 sm:pt-14 pb-6 max-w-5xl mx-auto text-center">
        <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-amber-500/80 uppercase mb-4">
          ▌▌▌ choose your floor
        </p>
        <h1 className="text-[clamp(2rem,6vw,3.4rem)] font-black tracking-tight uppercase text-white leading-[0.95]">
          where will you<br />work the <span className="text-amber-400">yield</span>?
        </h1>
        <p className="mt-4 max-w-xl mx-auto text-sm sm:text-base text-slate-400 leading-relaxed">
          Two floors, one room. Live spreads on one side, live gates on the other.
        </p>
      </section>

      <section className="relative px-5 sm:px-8 pb-14 max-w-7xl mx-auto">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
          <YieldDoor
            href="/theyield/sports"
            kicker="live games · spreads + totals"
            title="SPORTS"
            tone="amber"
            cta="open the scoreboard →"
            icons={[
              <IconBasketball key="bb" />,
              <IconFootball key="fb" />,
              <IconBaseball key="bs" />,
              <IconHockey key="hk" />,
            ]}
          />
          <YieldDoor
            href="/horse-racing"
            kicker="thoroughbreds · live yields"
            title="HORSE RACING"
            tone="orange"
            cta="enter the gates →"
            icons={[
              <IconBolt key="bt" />,
              <IconTarget key="tg" />,
              <IconTrophy key="tr" />,
            ]}
          />
        </div>
      </section>
    </LocalShell>
  )
}

function YieldDoor({
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
    ? { border: 'border-amber-500/60 hover:border-amber-300', text: 'text-amber-300', glow: '', titleGlow: '' }
    : { border: 'border-orange-500/60 hover:border-orange-300', text: 'text-orange-300', glow: '', titleGlow: '' }

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
            <radialGradient id={`yield-g-${tone}`} cx="50%" cy="50%">
              <stop offset="0%" stopColor={tone === 'amber' ? '#f59e0b' : '#fb923c'} stopOpacity="0.35" />
              <stop offset="100%" stopColor={tone === 'amber' ? '#f59e0b' : '#fb923c'} stopOpacity="0" />
            </radialGradient>
          </defs>
          <circle cx="100" cy="50" r="40" fill={`url(#yield-g-${tone})`} />
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
