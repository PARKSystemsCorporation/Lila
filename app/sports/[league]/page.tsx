import Link from 'next/link'
import { notFound } from 'next/navigation'
import LeagueEdgeGraph from '@/app/_components/edge-graph-league'
import { seasonStateFor, type SportKey } from '@/lib/season'

export const dynamic = 'force-static'

const LEAGUES: Record<string, { sport: SportKey; full: string; tone: 'amber' | 'orange' | 'red' }> = {
  nfl: { sport: 'NFL', full: 'National Football League', tone: 'red' },
  nba: { sport: 'NBA', full: 'National Basketball Association', tone: 'orange' },
  nhl: { sport: 'NHL', full: 'National Hockey League', tone: 'amber' },
  mlb: { sport: 'MLB', full: 'Major League Baseball', tone: 'orange' },
}

const TONE_CLASSES: Record<'amber' | 'orange' | 'red', { accent: string; border: string; glow: string; ring: string }> = {
  amber:  { accent: 'text-amber-400',  border: 'border-amber-500/40',  glow: '[text-shadow:0_0_40px_rgba(245,158,11,0.45)]', ring: 'border-amber-500/30' },
  orange: { accent: 'text-orange-400', border: 'border-orange-500/40', glow: '[text-shadow:0_0_40px_rgba(251,146,60,0.45)]', ring: 'border-orange-500/30' },
  red:    { accent: 'text-red-400',    border: 'border-red-500/40',    glow: '[text-shadow:0_0_40px_rgba(239,68,68,0.45)]', ring: 'border-red-500/30' },
}

export function generateStaticParams() {
  return Object.keys(LEAGUES).map((league) => ({ league }))
}

export default function LeaguePage({ params }: { params: { league: string } }) {
  const cfg = LEAGUES[params.league]
  if (!cfg) notFound()

  const tone = TONE_CLASSES[cfg.tone]
  const state = seasonStateFor(cfg.sport)
  const phaseLabel =
    state.phase === 'regular' ? `regular · ${state.pctRemaining?.toFixed(0)}% remaining` :
    state.phase === 'playoffs' ? 'playoffs · live' : 'off season'

  return (
    <main className="min-h-dvh w-full bg-[#0a0c14] text-slate-100 selection:bg-amber-500/30">
      <div
        className="pointer-events-none fixed inset-0 -z-10 opacity-30"
        style={{
          backgroundImage:
            'linear-gradient(rgba(245,158,11,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(245,158,11,0.06) 1px, transparent 1px)',
          backgroundSize: '64px 64px',
        }}
      />

      <header className="sticky top-0 z-30 border-b-2 border-amber-500/20 bg-[#0a0c14]/85 backdrop-blur-md">
        <div className="mx-auto max-w-7xl px-4 sm:px-8 py-3 flex items-center justify-between">
          <Link href="/sports" className="font-mono text-[10px] tracking-[0.32em] text-amber-500/80 hover:text-amber-300 uppercase">
            ← all sports
          </Link>
          <span className={`font-mono text-[10px] tracking-[0.32em] uppercase ${tone.accent}`}>
            ▓ {cfg.sport}
          </span>
        </div>
      </header>

      <section className="mx-auto max-w-7xl px-4 sm:px-8 pt-12 sm:pt-20 pb-10">
        <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-slate-500 uppercase mb-4">
          ▌▌▌ {cfg.full}
        </p>
        <h1 className={`text-[clamp(3.4rem,16vw,11rem)] font-black tracking-tight leading-[0.85] uppercase text-white`}>
          <span className={`${tone.accent} ${tone.glow}`}>{cfg.sport}</span>
          <span className="text-slate-700">.</span>
        </h1>
        <p className="mt-5 font-mono text-[10px] sm:text-[11px] tracking-[0.3em] text-slate-500 uppercase">
          {phaseLabel}
        </p>
      </section>

      <section className="mx-auto max-w-7xl px-4 sm:px-8 pb-12">
        <div className={`border-2 ${tone.ring} bg-slate-950/60 p-6 sm:p-10`}>
          <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-5 mb-6 sm:mb-8">
            <div>
              <p className={`font-mono text-[10px] tracking-[0.3em] uppercase ${tone.accent}`}>ceelo · 2025</p>
              <h2 className="mt-2 text-2xl sm:text-4xl font-black tracking-tight uppercase text-white">
                {cfg.sport} edge graph
              </h2>
              <p className="mt-3 max-w-xl text-sm sm:text-base text-slate-400 leading-relaxed">
                Cumulative edge points across the 2025 calendar year. Pick log,
                model spreads and per-market splits wire up next.
              </p>
            </div>
            <div className="font-mono text-[10px] tracking-[0.3em] text-slate-500 uppercase">
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shadow-[0_0_10px_rgba(245,158,11,0.9)]" />
                teaser
              </div>
            </div>
          </div>

          <LeagueEdgeGraph sport={cfg.sport} tone={cfg.tone} />
        </div>
      </section>

      <footer className="mx-auto max-w-7xl px-4 sm:px-8 py-7 flex items-center justify-between">
        <Link
          href="/"
          className="group flex items-center gap-3 font-mono text-[11px] tracking-[0.32em] text-amber-500 uppercase hover:text-amber-300 transition-colors"
        >
          <span className="text-2xl leading-none transition-transform group-hover:-translate-x-0.5">←</span>
          thepark.world
        </Link>
        <Link href="/sports" className="font-mono text-[10px] tracking-[0.32em] text-slate-500 hover:text-amber-300 uppercase transition-colors">
          all sports →
        </Link>
      </footer>
    </main>
  )
}
