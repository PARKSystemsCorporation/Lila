import Link from 'next/link'
import { notFound } from 'next/navigation'
import { PLAYBOOK } from '@/app/_components/strategy/copy'
import { TONE as STRATEGY_TONE } from '@/app/_components/strategy/tone'
import { WorkedExample } from '@/app/_components/strategy/worked-example'
import { KellyCard } from '@/app/_components/strategy/kelly-card'
import { KellyConvergence } from '@/app/_components/strategy/kelly-convergence'
import { NoVigBar } from '@/app/_components/strategy/no-vig-bar'
import { KeyNumbers } from '@/app/_components/strategy/key-numbers'
import SportSculpture from '@/app/_components/strategy/sport-sculpture-client'
import { seasonStateFor, type SportKey } from '@/lib/season'

export const dynamic = 'force-static'

const LEAGUES: Record<string, { sport: SportKey; full: string; tone: 'amber' | 'orange' | 'red' }> = {
  nfl: { sport: 'NFL', full: 'National Football League', tone: 'red' },
  nba: { sport: 'NBA', full: 'National Basketball Association', tone: 'orange' },
  nhl: { sport: 'NHL', full: 'National Hockey League', tone: 'amber' },
  mlb: { sport: 'MLB', full: 'Major League Baseball', tone: 'orange' },
}

const HERO_TONE: Record<'amber' | 'orange' | 'red', { accent: string; glow: string }> = {
  amber:  { accent: 'text-amber-400',  glow: '' },
  orange: { accent: 'text-orange-400', glow: '' },
  red:    { accent: 'text-red-400',    glow: '' },
}

export function generateStaticParams() {
  return Object.keys(LEAGUES).map((league) => ({ league }))
}

export default function LeaguePage({ params }: { params: { league: string } }) {
  const cfg = LEAGUES[params.league]
  if (!cfg) notFound()

  const hero = HERO_TONE[cfg.tone]
  const t = STRATEGY_TONE[cfg.tone]
  const book = PLAYBOOK[cfg.sport]
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
          <span className={`font-mono text-[10px] tracking-[0.32em] uppercase ${hero.accent}`}>
            ▓ {cfg.sport}
          </span>
        </div>
      </header>

      <section className="mx-auto max-w-7xl px-4 sm:px-8 pt-12 sm:pt-20 pb-10">
        <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-slate-500 uppercase mb-4">
          ▌▌▌ {cfg.full}
        </p>
        <h1 className={`text-[clamp(3.4rem,16vw,11rem)] font-black tracking-tight leading-[0.85] uppercase text-white`}>
          <span className={`${hero.accent} ${hero.glow}`}>{cfg.sport}</span>
          <span className="text-slate-700">.</span>
        </h1>
        <p className="mt-5 font-mono text-[10px] sm:text-[11px] tracking-[0.3em] text-slate-500 uppercase">
          {phaseLabel}
        </p>
      </section>

      <section className="relative h-[280px] sm:h-[360px] border-y-2 border-amber-500/15 overflow-hidden">
        <div className="absolute inset-0">
          <SportSculpture sport={cfg.sport} tone={cfg.tone} />
        </div>
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ background: 'linear-gradient(180deg, rgba(10,12,20,0.20), rgba(10,12,20,0.85))' }}
        />
        <div className="relative z-10 mx-auto max-w-7xl h-full px-4 sm:px-8 flex flex-col justify-end pb-6 sm:pb-8">
          <p className={`font-mono text-[10px] sm:text-[11px] tracking-[0.45em] uppercase ${t.accent}`}>
            ▌ how to play {cfg.sport.toLowerCase()}
          </p>
          <h2 className="mt-2 text-[clamp(1.6rem,5vw,3rem)] font-black tracking-tight uppercase text-white max-w-3xl leading-[0.95]">
            {book.thesis}
          </h2>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 sm:px-8 py-12 sm:py-16">
        <div className="flex items-baseline justify-between gap-4 mb-5 sm:mb-7">
          <div>
            <p className={`font-mono text-[10px] sm:text-[11px] tracking-[0.45em] uppercase ${t.accent}`}>
              ▌▌▌ where the edge lives
            </p>
            <h3 className="mt-2 text-[clamp(1.4rem,4vw,2.2rem)] font-black tracking-tight uppercase text-white">
              market <span className={`${t.accent} ${t.glow}`}>structure</span>.
            </h3>
          </div>
          <p className="hidden sm:block font-mono text-[10px] tracking-[0.32em] text-slate-500 uppercase max-w-[18rem] text-right">
            primary: {book.primaryMarket}<br />threshold: {book.edgeThreshold}
          </p>
        </div>
        <p className="max-w-3xl text-sm sm:text-base text-slate-400 leading-relaxed mb-6 sm:mb-8">
          {book.whereTheEdgeLives}
        </p>

        <SportSpecificChart sport={cfg.sport} tone={cfg.tone} />
      </section>

      <section className="mx-auto max-w-7xl px-4 sm:px-8 pb-12 sm:pb-16">
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-5 sm:gap-7">
          <div className="lg:col-span-2">
            <p className={`font-mono text-[10px] sm:text-[11px] tracking-[0.45em] uppercase ${t.accent}`}>
              ▌▌▌ how to read ceelo&rsquo;s signal
            </p>
            <h3 className="mt-2 text-[clamp(1.4rem,4vw,2.2rem)] font-black tracking-tight uppercase text-white">
              seven <span className={`${t.accent} ${t.glow}`}>fields</span>.
            </h3>
            <ul className="mt-5 space-y-3">
              {book.readSignal.map((row) => (
                <li key={row.field} className={`border-l-2 ${t.borderSoft} pl-3`}>
                  <p className={`font-mono text-[11px] tracking-wider ${t.accent}`}>{row.field}</p>
                  <p className="font-mono text-[11px] leading-relaxed text-slate-400 mt-0.5">{row.meaning}</p>
                </li>
              ))}
            </ul>
          </div>
          <div className="lg:col-span-3">
            <KellyCard tone={cfg.tone} />
          </div>
        </div>
      </section>

      {cfg.sport === 'NFL' && (
        <section className="mx-auto max-w-7xl px-4 sm:px-8 pb-12 sm:pb-16">
          <div className="flex items-baseline justify-between gap-4 mb-5 sm:mb-7">
            <div>
              <p className={`font-mono text-[10px] sm:text-[11px] tracking-[0.45em] uppercase ${t.accent}`}>
                ▌▌▌ when kelly converges
              </p>
              <h3 className="mt-2 text-[clamp(1.4rem,4vw,2.2rem)] font-black tracking-tight uppercase text-white">
                sample <span className={`${t.accent} ${t.glow}`}>size</span>.
              </h3>
            </div>
            <p className="hidden sm:block font-mono text-[10px] tracking-[0.32em] text-slate-500 uppercase max-w-[18rem] text-right">
              clt confidence band<br />on log-wealth
            </p>
          </div>
          <KellyConvergence tone={cfg.tone} />
        </section>
      )}

      <section className="mx-auto max-w-7xl px-4 sm:px-8 pb-12 sm:pb-16 space-y-5 sm:space-y-7">
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <p className={`font-mono text-[10px] sm:text-[11px] tracking-[0.45em] uppercase ${t.accent}`}>
              ▌▌▌ primary strategy
            </p>
            <h3 className="mt-2 text-[clamp(1.4rem,4vw,2.2rem)] font-black tracking-tight uppercase text-white">
              {book.primary.market} <span className={`${t.accent} ${t.glow}`}>—</span> worked.
            </h3>
          </div>
          <p className="hidden sm:block font-mono text-[10px] tracking-[0.32em] text-slate-500 uppercase max-w-[16rem] text-right">
            when: {book.primary.threshold}
          </p>
        </div>
        <WorkedExample strategy={book.primary} tone={cfg.tone} />
      </section>

      <section className="mx-auto max-w-7xl px-4 sm:px-8 pb-12 sm:pb-16 space-y-5 sm:space-y-7">
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <p className={`font-mono text-[10px] sm:text-[11px] tracking-[0.45em] uppercase ${t.accent}`}>
              ▌▌▌ sub-strategy
            </p>
            <h3 className="mt-2 text-[clamp(1.4rem,4vw,2.2rem)] font-black tracking-tight uppercase text-white">
              {book.sub.market} <span className={`${t.accent} ${t.glow}`}>—</span> when it fits.
            </h3>
          </div>
          <p className="hidden sm:block font-mono text-[10px] tracking-[0.32em] text-slate-500 uppercase max-w-[16rem] text-right">
            when: {book.sub.threshold}
          </p>
        </div>
        <WorkedExample strategy={book.sub} tone={cfg.tone} />
      </section>

      <section className="mx-auto max-w-7xl px-4 sm:px-8 pb-14 sm:pb-20">
        <div className={`border-2 ${t.border} bg-slate-950/70 p-6 sm:p-8`}>
          <p className={`font-mono text-[10px] tracking-[0.45em] uppercase ${t.accent}`}>
            ▌ what ceelo won&rsquo;t do
          </p>
          <ul className="mt-4 space-y-3">
            {book.anti.map((line, i) => (
              <li key={i} className="flex gap-3">
                <span className={`font-mono text-[11px] ${t.accent} mt-0.5`}>×</span>
                <p className="font-mono text-[11px] sm:text-[12px] leading-relaxed text-slate-300">{line}</p>
              </li>
            ))}
          </ul>
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

function SportSpecificChart({ sport, tone }: { sport: SportKey; tone: 'amber' | 'orange' | 'red' }) {
  if (sport === 'NFL') return <KeyNumbers tone={tone} />
  if (sport === 'NBA') {
    return (
      <NoVigBar
        tone={tone}
        modelProb={0.566}
        americanOdds={-110}
        marketLabel="BOS @ DEN · Over 228.5"
        caption="No-vig is the price the bet would carry if the book had zero margin. Ceelo's edge is the gap between that and his model_prob."
      />
    )
  }
  if (sport === 'NHL') {
    return (
      <NoVigBar
        tone={tone}
        modelProb={0.68}
        americanOdds={-165}
        marketLabel="COL +1.5 puck line"
        caption="On the puck line, Ceelo's 0.47 ML probability translates to ~0.68 PL probability. That conversion is where the edge lives."
      />
    )
  }
  return (
    <NoVigBar
      tone={tone}
      modelProb={0.555}
      americanOdds={-115}
      marketLabel="NYY F5 ML · Cole start"
      caption="F5 markets close after the starters' best 5 innings — exactly the part of the game Ceelo's model has an edge on."
    />
  )
}
