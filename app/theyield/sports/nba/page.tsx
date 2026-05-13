'use client'

import { LocalShell } from '@/app/_components/local/chrome'
import SlotReel from '@/app/_components/slot-reel'

const SIGNALS = [
  'Public leaning Celtics — 72% of tickets, 58% of money',
  'Model edge detected — BOS −4.5 (fair −6.1)',
  'Sharp money divergence — line moving wrong way on totals',
  'Injury/news pressure — Tatum questionable, late tip-off scratch risk',
]

type Game = {
  away: string
  home: string
  tipoff: string
  spread: string
  total: string
  ml: string
  conf: string
  confFakes: string[]
  edge: string
  edgeFakes: string[]
  label: string
}

const GAMES: Game[] = [
  {
    away: 'NYK',
    home: 'BOS',
    tipoff: '7:30 ET',
    spread: 'BOS −4.5',
    total: 'O 224.5',
    ml: 'BOS −188',
    conf: '78%',
    confFakes: ['12%', '44%', '67%', '91%', '25%', '58%'],
    edge: '+4.2u',
    edgeFakes: ['+1.1u', '−0.4u', '+2.9u', '+5.7u', '+0.3u'],
    label: 'STEAM ▲ 8',
  },
  {
    away: 'DEN',
    home: 'LAL',
    tipoff: '9:00 ET',
    spread: 'DEN −2.0',
    total: 'O 232.0',
    ml: 'DEN −135',
    conf: '64%',
    confFakes: ['18%', '39%', '82%', '51%', '73%'],
    edge: '+2.8u',
    edgeFakes: ['−0.9u', '+1.6u', '+3.4u', '+0.7u'],
    label: 'WHALE ▌',
  },
  {
    away: 'MIA',
    home: 'PHI',
    tipoff: '10:30 ET',
    spread: 'PHI −1.5',
    total: 'U 211.5',
    ml: 'PHI −115',
    conf: '71%',
    confFakes: ['22%', '55%', '38%', '89%', '46%'],
    edge: '+3.5u',
    edgeFakes: ['+0.5u', '+2.1u', '−1.2u', '+4.6u'],
    label: 'LOCK ◆',
  },
]

export default function NBAPage() {
  return (
    <LocalShell
      title="NBA"
      subtitle="live intel"
      back={{ href: '/theyield/sports', label: 'back to scoreboard' }}
      accent="amber"
    >
      <section className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8 pt-6 pb-16 space-y-8">
        <QuickSignals />
        <SlotMachine />
      </section>

      <style jsx global>{`
        @keyframes skid {
          0% {
            opacity: 0;
            transform: translate3d(-40px, 0, 0) skewX(-10deg);
          }
          60% {
            opacity: 1;
            transform: translate3d(4px, 0, 0) skewX(0);
          }
          100% {
            opacity: 1;
            transform: translate3d(0, 0, 0) skewX(0);
          }
        }
        @keyframes reel {
          0% {
            opacity: 0;
            transform: translate3d(0, -140%, 0);
            filter: blur(2px);
          }
          55% {
            opacity: 1;
            transform: translate3d(0, 14px, 0);
            filter: blur(0);
          }
          72% {
            transform: translate3d(0, -8px, 0);
          }
          88% {
            transform: translate3d(0, 3px, 0);
          }
          100% {
            transform: translate3d(0, 0, 0);
          }
        }
      `}</style>
    </LocalShell>
  )
}

function QuickSignals() {
  return (
    <div className="border-2 border-amber-500/40 bg-slate-950/70 shadow-[0_6px_0_0_rgba(0,0,0,0.6)]">
      <div className="flex items-center justify-between border-b-2 border-amber-500/30 bg-amber-500/5 px-4 py-2">
        <span className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] uppercase text-amber-400">
          ▌▌▌ NBA quick signals
        </span>
        <span className="font-mono text-[9px] sm:text-[10px] tracking-[0.4em] uppercase text-amber-500/60">
          live · session-only
        </span>
      </div>
      <ul className="divide-y divide-amber-500/10">
        {SIGNALS.map((s, i) => (
          <li
            key={i}
            className="motion-safe:opacity-0 motion-safe:animate-[skid_0.5s_cubic-bezier(0.2,0.9,0.1,1.05)_both]"
            style={{ animationDelay: `${60 + i * 110}ms` }}
          >
            <a
              href="#"
              onClick={(e) => e.preventDefault()}
              className="group flex items-center gap-3 px-4 py-3 hover:bg-amber-500/5 focus-visible:bg-amber-500/10 outline-none transition-colors"
            >
              <span className="font-mono text-amber-400 text-xs">▶</span>
              <span className="font-mono text-sm sm:text-base font-bold uppercase tracking-wide text-slate-100 group-hover:text-amber-200">
                {s}
              </span>
            </a>
          </li>
        ))}
      </ul>
    </div>
  )
}

function SlotMachine() {
  return (
    <div>
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] uppercase text-amber-400">
          ▌▌▌ tonight&rsquo;s slots
        </h2>
        <span className="font-mono text-[9px] sm:text-[10px] tracking-[0.4em] uppercase text-amber-500/60">
          3 games · auto-refresh
        </span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 sm:gap-5">
        {GAMES.map((g, i) => (
          <article
            key={i}
            className="motion-safe:opacity-0 motion-safe:animate-[reel_1.1s_cubic-bezier(0.16,1,0.3,1)_both]
                       border-2 border-amber-500/50 bg-gradient-to-b from-slate-900 to-slate-950
                       shadow-[0_10px_0_0_rgba(0,0,0,0.55)] overflow-hidden"
            style={{ animationDelay: `${i * 220}ms` }}
          >
            <header className="flex items-baseline justify-between border-b-2 border-amber-500/30 bg-amber-500/5 px-4 py-3">
              <span className="font-mono text-[10px] tracking-[0.4em] uppercase text-amber-400">
                slot {i + 1}
              </span>
              <span className="font-mono text-[10px] tracking-[0.3em] uppercase text-orange-300">
                {g.label}
              </span>
            </header>

            <div className="px-4 py-5 space-y-1">
              <div className="text-2xl sm:text-3xl font-black tracking-tight text-slate-100">
                {g.away} <span className="text-amber-500">@</span> {g.home}
              </div>
              <div className="font-mono text-[11px] tracking-[0.3em] uppercase text-slate-500">
                tip-off · {g.tipoff}
              </div>
            </div>

            <dl className="grid grid-cols-3 border-y-2 border-amber-500/20 divide-x divide-amber-500/20 text-center">
              {(
                [
                  ['spread', g.spread],
                  ['total', g.total],
                  ['ml', g.ml],
                ] as const
              ).map(([k, v]) => (
                <div key={k} className="px-2 py-3">
                  <dt className="font-mono text-[9px] tracking-[0.3em] uppercase text-slate-500">
                    {k}
                  </dt>
                  <dd className="mt-1 font-mono text-sm font-bold text-amber-200">{v}</dd>
                </div>
              ))}
            </dl>

            <div className="px-4 py-4 space-y-3">
              <div className="flex items-baseline justify-between">
                <span className="font-mono text-[10px] tracking-[0.3em] uppercase text-slate-400">
                  edge
                </span>
                <SlotReel
                  final={g.edge}
                  fakes={g.edgeFakes}
                  delay={i * 220 + 750}
                  duration={520}
                  className="text-lg font-black text-amber-300"
                />
              </div>
              <div className="flex items-baseline justify-between">
                <span className="font-mono text-[10px] tracking-[0.3em] uppercase text-slate-400">
                  confidence
                </span>
                <SlotReel
                  final={g.conf}
                  fakes={g.confFakes}
                  delay={i * 220 + 900}
                  duration={520}
                  className="text-lg font-black text-orange-300"
                />
              </div>
            </div>

            <button
              type="button"
              className="block w-full border-t-2 border-amber-500/40 bg-amber-500 hover:bg-amber-300
                         text-black font-black uppercase tracking-[0.25em] text-sm py-3 transition-colors
                         focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-200"
            >
              view pick →
            </button>
          </article>
        ))}
      </div>
    </div>
  )
}
