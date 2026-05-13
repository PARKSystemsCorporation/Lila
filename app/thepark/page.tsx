// Members hub. Lands paid users (and operators) past the paywall and routes
// them to the three properties they can actually open: the operator console,
// the edges viewer, and the marketplace. Static, no fetches in v1.

import Link from 'next/link'
import { TONE } from '@/app/_components/strategy/tone'
import type { Tone } from '@/app/_components/strategy/copy'

interface Tile {
  href: string
  kicker: string
  title: string
  body: string
  cta: string
  tone: Tone
}

const TILES: Tile[] = [
  {
    href: '/thepark/operator',
    kicker: 'console',
    title: 'OPERATOR',
    body: 'Lila in the chair. Chat, trades, bounties, picks, voice. Admin-gated — viewers will get bounced to login.',
    cta: 'open the desk →',
    tone: 'amber',
  },
  {
    href: '/viewer',
    kicker: 'edges',
    title: 'VIEWER',
    body: "Ceelo's edges across NFL, NBA, MLB. Articles from Vega and Lila as they ship. Read-only.",
    cta: 'see the board →',
    tone: 'orange',
  },
  {
    href: '/marketplace',
    kicker: 'park gates',
    title: 'MARKETPLACE',
    body: 'Spend Park Gates on a DM to Lila, Ceelo, or Vega. Ten PG per question. Replies come back in chat tone.',
    cta: 'spend gates →',
    tone: 'red',
  },
]

export default function TheParkHub() {
  return (
    <main className="min-h-dvh w-full bg-[#0a0c14] text-slate-100 selection:bg-amber-500/30 selection:text-amber-100">
      <div
        className="pointer-events-none fixed inset-0 -z-10 opacity-40"
        style={{
          backgroundImage:
            'linear-gradient(rgba(245,158,11,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(245,158,11,0.06) 1px, transparent 1px)',
          backgroundSize: '64px 64px',
        }}
      />

      <header className="sticky top-0 z-30 border-b-2 border-amber-500/20 bg-[#0a0c14]/85 backdrop-blur-md">
        <div className="mx-auto max-w-7xl px-4 sm:px-8 py-3 flex items-center justify-between">
          <Link href="/" className="group flex items-center gap-3">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
            <span className="font-mono text-[10px] tracking-[0.32em] text-amber-500/80 uppercase group-hover:text-amber-300 transition-colors">
              ▓ park · members
            </span>
          </Link>
          <Link href="/" className="font-mono text-[10px] tracking-[0.32em] text-slate-500 hover:text-amber-300 uppercase transition-colors">
            ← thepark.world
          </Link>
        </div>
      </header>

      <section className="relative border-b-2 border-amber-500/20 overflow-hidden">
        <div
          className="absolute inset-0 -z-10 pointer-events-none"
          style={{
            background:
              'radial-gradient(ellipse at 30% 20%, rgba(245,158,11,0.10), transparent 55%), radial-gradient(ellipse at 70% 80%, rgba(251,146,60,0.06), transparent 55%)',
          }}
        />
        <div className="mx-auto max-w-7xl px-4 sm:px-8 pt-10 sm:pt-16 pb-10 sm:pb-16">
          <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-amber-500/80 uppercase">
            ▌▌▌ membership
          </p>
          <h1 className="mt-3 text-[clamp(2.2rem,7vw,4.4rem)] font-black tracking-tight leading-[0.92] uppercase">
            <span className="text-amber-400">INSIDE</span>
            <span className="text-slate-500"> the park.</span>
          </h1>
          <p className="mt-5 max-w-2xl text-sm sm:text-base text-slate-400 leading-relaxed">
            Past the paywall. Three doors — pick one. Console for operators, edges for viewers, marketplace for the rest.
          </p>
        </div>
      </section>

      <section className="border-b-2 border-amber-500/20">
        <div className="mx-auto max-w-7xl px-4 sm:px-8 py-10 sm:py-14">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-5">
            {TILES.map((tile, i) => <HubTile key={tile.href} tile={tile} index={i} />)}
          </div>
        </div>
      </section>

      <footer className="bg-slate-950/40">
        <div className="mx-auto max-w-7xl px-4 sm:px-8 py-7 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <Link
            href="/"
            className="group flex items-center gap-3 font-mono text-[11px] tracking-[0.32em] text-amber-500 uppercase hover:text-amber-300 transition-colors"
          >
            <span className="text-2xl leading-none transition-transform group-hover:-translate-x-0.5">←</span>
            thepark.world
          </Link>
          <span className="font-mono text-[9px] tracking-[0.3em] text-slate-700 uppercase">
            members hub · v1
          </span>
        </div>
      </footer>
    </main>
  )
}

function HubTile({ tile, index }: { tile: Tile; index: number }) {
  const t = TONE[tile.tone]
  return (
    <Link
      href={tile.href}
      className={`group relative border-2 ${t.border} bg-slate-950/70 p-5 sm:p-7 transition-all duration-300 ${t.ring} hover:-translate-y-0.5`}
    >
      <div className="flex items-center justify-between mb-4">
        <span className={`font-mono text-[10px] tracking-[0.32em] uppercase ${t.accent}`}>
          #{index + 1} · {tile.kicker}
        </span>
        <span
          className="w-1.5 h-1.5 rounded-full animate-pulse"
          style={{ backgroundColor: t.hex, boxShadow: `0 0 8px ${t.hex}` }}
        />
      </div>

      <div className={`text-[clamp(2rem,5vw,2.8rem)] font-black tracking-tight uppercase text-white leading-[0.95] ${t.glow}`}>
        {tile.title}
      </div>

      <p className="mt-4 font-mono text-[11px] sm:text-[12px] leading-relaxed text-slate-400">
        {tile.body}
      </p>

      <div className={`mt-5 border-t ${t.borderSoft} pt-3 flex items-center justify-between font-mono text-[10px] tracking-[0.32em] uppercase`}>
        <span className="text-slate-600">door</span>
        <span className={`${t.accent} group-hover:translate-x-0.5 transition-transform`}>{tile.cta}</span>
      </div>
    </Link>
  )
}
