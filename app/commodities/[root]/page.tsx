import Link from 'next/link'
import { notFound } from 'next/navigation'
import {
  CONTRACTS,
  PLAYBOOKS,
  CATEGORY_META,
  type Tone,
} from '@/lib/commodities'
import { TONE as STRATEGY_TONE } from '@/app/_components/strategy/tone'
import { WorkedExample } from '@/app/_components/strategy/worked-example'
import { StakeCard } from '@/app/_components/commodities/stake-card'

export const dynamic = 'force-static'

type HeadlineRoot = 'CL' | 'GC' | 'ZC' | 'KC' | 'LE'

const ROOTS: Record<string, { root: HeadlineRoot; tone: Tone }> = {
  cl: { root: 'CL', tone: CATEGORY_META.energy.tone },
  gc: { root: 'GC', tone: CATEGORY_META.metals.tone },
  zc: { root: 'ZC', tone: CATEGORY_META.grains.tone },
  kc: { root: 'KC', tone: CATEGORY_META.softs.tone },
  le: { root: 'LE', tone: CATEGORY_META.livestock.tone },
}

const HERO_TONE: Record<Tone, { accent: string; glow: string }> = {
  amber:  { accent: 'text-amber-400',  glow: '' },
  orange: { accent: 'text-orange-400', glow: '' },
  red:    { accent: 'text-red-400',    glow: '' },
}

export function generateStaticParams() {
  return Object.keys(ROOTS).map((root) => ({ root }))
}

export default async function CommodityPage({ params }: { params: Promise<{ root: string }> }) {
  const { root } = await params
  const cfg = ROOTS[root]
  if (!cfg) notFound()

  const hero = HERO_TONE[cfg.tone]
  const t = STRATEGY_TONE[cfg.tone]
  const book = PLAYBOOKS[cfg.root]
  const contract = CONTRACTS.find((c) => c.root === cfg.root)
  if (!contract) notFound()

  return (
    <main className="min-h-dvh w-full bg-[#0a0c14] text-slate-100 selection:bg-orange-500/30">
      <div
        className="pointer-events-none fixed inset-0 -z-10 opacity-30"
        style={{
          backgroundImage:
            'linear-gradient(rgba(245,158,11,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(245,158,11,0.06) 1px, transparent 1px)',
          backgroundSize: '64px 64px',
        }}
      />

      <header className="sticky top-0 z-30 border-b-2 border-orange-500/20 bg-[#0a0c14]/85 backdrop-blur-md">
        <div className="mx-auto max-w-7xl px-4 sm:px-8 py-3 flex items-center justify-between">
          <Link href="/commodities" className="font-mono text-[10px] tracking-[0.32em] text-orange-500/80 hover:text-orange-300 uppercase">
            ← all commodities
          </Link>
          <span className={`font-mono text-[10px] tracking-[0.32em] uppercase ${hero.accent}`}>
            ▓ {cfg.root}
          </span>
        </div>
      </header>

      <section className="mx-auto max-w-7xl px-4 sm:px-8 pt-12 sm:pt-20 pb-10">
        <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-slate-500 uppercase mb-4">
          ▌▌▌ {book.name}
        </p>
        <h1 className="text-[clamp(3.4rem,16vw,11rem)] font-black tracking-tight leading-[0.85] uppercase text-white">
          <span className={`${hero.accent} ${hero.glow}`}>{cfg.root}</span>
          <span className="text-slate-700">.</span>
        </h1>
        <p className="mt-5 font-mono text-[10px] sm:text-[11px] tracking-[0.3em] text-slate-500 uppercase">
          {contract.exchange} · {book.category}
        </p>
      </section>

      <section className="mx-auto max-w-7xl px-4 sm:px-8 pb-10">
        <div className={`grid grid-cols-2 lg:grid-cols-5 border ${t.borderSoft} bg-slate-950/40`}>
          <SpecCell label="contract size" value={`${contract.contractSize.toLocaleString()} ${contract.contractUnit}`} accent={t.accent} borderSoft={t.borderSoft} />
          <SpecCell label="tick size"     value={contract.tickSize.toString()}                                          accent={t.accent} borderSoft={t.borderSoft} />
          <SpecCell label="$/tick"        value={`$${contract.tickValue.toFixed(2)}`}                                   accent={t.accent} borderSoft={t.borderSoft} />
          <SpecCell label="exchange"      value={contract.exchange}                                                     accent={t.accent} borderSoft={t.borderSoft} />
          <SpecCell label="sessions"      value={contract.sessions}                                                     accent={t.accent} borderSoft={t.borderSoft} fullWidth />
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
            primary: {book.primaryTrade}<br />trigger: {book.edgeTrigger}
          </p>
        </div>
        <p className="max-w-3xl text-sm sm:text-base text-slate-400 leading-relaxed">
          {book.whereTheEdgeLives}
        </p>
      </section>

      <section className="mx-auto max-w-7xl px-4 sm:px-8 pb-12 sm:pb-16">
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-5 sm:gap-7">
          <div className="lg:col-span-2">
            <p className={`font-mono text-[10px] sm:text-[11px] tracking-[0.45em] uppercase ${t.accent}`}>
              ▌▌▌ how to read the desk
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
            <StakeCard tone={cfg.tone} spec={contract} />
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 sm:px-8 pb-12 sm:pb-16 space-y-5 sm:space-y-7">
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <p className={`font-mono text-[10px] sm:text-[11px] tracking-[0.45em] uppercase ${t.accent}`}>
              ▌▌▌ primary trade
            </p>
            <h3 className="mt-2 text-[clamp(1.4rem,4vw,2.2rem)] font-black tracking-tight uppercase text-white">
              {book.primary.market} <span className={`${t.accent} ${t.glow}`}>—</span> worked.
            </h3>
          </div>
          <p className="hidden sm:block font-mono text-[10px] tracking-[0.32em] text-slate-500 uppercase max-w-[18rem] text-right">
            when: {book.primary.threshold}
          </p>
        </div>
        <WorkedExample strategy={book.primary} tone={cfg.tone} />
      </section>

      <section className="mx-auto max-w-7xl px-4 sm:px-8 pb-12 sm:pb-16 space-y-5 sm:space-y-7">
        <div className="flex items-baseline justify-between gap-4">
          <div>
            <p className={`font-mono text-[10px] sm:text-[11px] tracking-[0.45em] uppercase ${t.accent}`}>
              ▌▌▌ secondary trade
            </p>
            <h3 className="mt-2 text-[clamp(1.4rem,4vw,2.2rem)] font-black tracking-tight uppercase text-white">
              {book.sub.market} <span className={`${t.accent} ${t.glow}`}>—</span> when it fits.
            </h3>
          </div>
          <p className="hidden sm:block font-mono text-[10px] tracking-[0.32em] text-slate-500 uppercase max-w-[18rem] text-right">
            when: {book.sub.threshold}
          </p>
        </div>
        <WorkedExample strategy={book.sub} tone={cfg.tone} />
      </section>

      <section className="mx-auto max-w-7xl px-4 sm:px-8 pb-14 sm:pb-20">
        <div className={`border-2 ${t.border} bg-slate-950/70 p-6 sm:p-8`}>
          <p className={`font-mono text-[10px] tracking-[0.45em] uppercase ${t.accent}`}>
            ▌ what the desk won&rsquo;t do
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
          className="group flex items-center gap-3 font-mono text-[11px] tracking-[0.32em] text-orange-500 uppercase hover:text-orange-300 transition-colors"
        >
          <span className="text-2xl leading-none transition-transform group-hover:-translate-x-0.5">←</span>
          thepark.world
        </Link>
        <Link href="/commodities" className="font-mono text-[10px] tracking-[0.32em] text-slate-500 hover:text-orange-300 uppercase transition-colors">
          all commodities →
        </Link>
      </footer>
    </main>
  )
}

function SpecCell({ label, value, accent, borderSoft, fullWidth }: {
  label: string
  value: string
  accent: string
  borderSoft: string
  fullWidth?: boolean
}) {
  return (
    <div className={`px-4 sm:px-5 py-5 border-r border-b ${borderSoft} ${fullWidth ? 'col-span-2 lg:col-span-1' : ''}`}>
      <p className="font-mono text-[9px] tracking-[0.32em] uppercase text-slate-500">{label}</p>
      <p className={`font-mono text-base sm:text-lg font-black tabular-nums leading-tight mt-1.5 ${accent}`}>{value}</p>
    </div>
  )
}
