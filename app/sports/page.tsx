'use client'

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import SlotReel from '../_components/slot-reel'
import { PLAYBOOK, type Sport as PlaybookSport } from '../_components/strategy/copy'
import { TONE as STRATEGY_TONE } from '../_components/strategy/tone'
import { rankedSeasons, type SeasonState, type SportKey } from '@/lib/season'

const SportsTicker = dynamic(() => import('../_components/sports-ticker'), { ssr: false, loading: () => null })

interface TopEdge {
  id: number
  sport: string
  game_label: string
  market: string
  side: string
  edge_pct: number | null
  edge_points: number | null
  model_prob: number | null
  book_spread: number | null
  model_spread: number | null
  kickoff_ts: number | null
  confidence: string
}

interface ArticleTeaser {
  id: number
  title: string
  excerpt: string
  author: string
  kind: string
  created_ts: number
}

const FAKE_TEAMS = ['KC @ BUF', 'LAL @ BOS', 'DAL @ PHI', 'NYY @ HOU', 'GSW @ DEN', 'TB @ NO', 'TOR @ MTL', 'EDM @ COL', 'SF @ LAR', 'MIA @ DET', 'OAK @ SEA', 'CHC @ STL']
const FAKE_LINES = ['+3.5', '+2.8', '+2.1', '+4.0', '+1.9', '+5.5', '+3.0', '+2.4', '+1.7', '+6.1']
const FAKE_PCTS  = ['18%', '12%', '9%', '24%', '7%', '15%', '21%', '11%']

const PLACEHOLDER_EDGES: TopEdge[] = [
  { id: -1, sport: 'NBA', game_label: 'BOS @ NYK', market: 'spread', side: 'BOS -3.5', edge_pct: 12.4, edge_points: 3.2, model_prob: 0.61, book_spread: -3.5, model_spread: -6.7, kickoff_ts: null, confidence: 'high' },
  { id: -2, sport: 'NHL', game_label: 'COL @ DAL', market: 'spread', side: 'COL +1.5', edge_pct:  9.8, edge_points: 2.4, model_prob: 0.54, book_spread:  1.5, model_spread: -0.9, kickoff_ts: null, confidence: 'medium' },
  { id: -3, sport: 'MLB', game_label: 'NYY @ HOU', market: 'total',  side: 'Over 8.5',  edge_pct:  7.1, edge_points: 1.8, model_prob: 0.57, book_spread: null, model_spread: null, kickoff_ts: null, confidence: 'medium' },
]

const SPORT_HREF: Record<SportKey, string> = {
  NFL: '/sports/nfl',
  NBA: '/sports/nba',
  NHL: '/sports/nhl',
  MLB: '/sports/mlb',
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function fmtEdge(e: TopEdge): string {
  if (e.edge_points != null) return `+${Math.abs(e.edge_points).toFixed(1)}`
  if (e.edge_pct != null) return `+${Math.abs(e.edge_pct).toFixed(1)}%`
  return '+--'
}

export default function SportsLanding() {
  const [edges, setEdges] = useState<TopEdge[]>([])
  const [articles, setArticles] = useState<ArticleTeaser[]>([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    let alive = true
    fetch('/api/public/sports', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d) return
        setEdges(Array.isArray(d.top_edges) ? d.top_edges : [])
        setArticles(Array.isArray(d.articles) ? d.articles : [])
      })
      .catch(() => {})
      .finally(() => alive && setLoaded(true))
    return () => { alive = false }
  }, [])

  const showEdges = edges.length > 0 ? edges : PLACEHOLDER_EDGES
  const seasons = useMemo(() => rankedSeasons(), [])

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
              ▓ park · sports
            </span>
          </Link>
          <Link href="/" className="font-mono text-[10px] tracking-[0.32em] text-slate-500 hover:text-amber-300 uppercase transition-colors">
            ← thepark.world
          </Link>
        </div>
      </header>

      <section className="relative border-b-2 border-amber-500/20 overflow-hidden">
        <div className="absolute inset-0 -z-10">
          <SportsTicker />
        </div>
        <div
          className="absolute inset-0 -z-10 pointer-events-none"
          style={{ background: 'linear-gradient(180deg, rgba(10,12,20,0.55), rgba(10,12,20,0.92))' }}
        />

        <div className="mx-auto max-w-7xl px-4 sm:px-8 pt-8 sm:pt-14 pb-10 sm:pb-16">
          <div className="flex items-baseline justify-between gap-4 mb-5 sm:mb-8">
            <div>
              <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-amber-500/80 uppercase">
                ▌▌▌ today&rsquo;s top edges
              </p>
              <h1 className="mt-2 text-[clamp(2.2rem,7vw,4.4rem)] font-black tracking-tight leading-[0.92] uppercase">
                <span className="text-white">jackpot</span>
                <span className="text-amber-400">.</span>
              </h1>
            </div>
            <div className="font-mono text-[9px] sm:text-[10px] tracking-[0.3em] text-slate-500 uppercase tabular-nums text-right">
              ceelo · {new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit' })}
              <br className="hidden sm:block" />
              <span className="hidden sm:inline">{loaded ? (edges.length ? 'live' : 'demo') : 'loading'}</span>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-5">
            {showEdges.slice(0, 3).map((e, i) => (
              <article
                key={e.id}
                className="group relative border-2 border-amber-500/40 bg-slate-950/70 backdrop-blur-sm p-4 sm:p-5 transition-all duration-300 hover:border-amber-300 hover:bg-amber-500/[0.05] hover:-translate-y-0.5"
              >
                <div className="flex items-center justify-between mb-3 sm:mb-4">
                  <span className="font-mono text-[9px] sm:text-[10px] tracking-[0.3em] text-amber-400 uppercase">
                    #{i + 1} · {e.sport}
                  </span>
                  <span className={`font-mono text-[9px] tracking-[0.3em] uppercase px-1.5 py-0.5 border ${
                    e.confidence === 'high'   ? 'text-red-300 border-red-500/50' :
                    e.confidence === 'medium' ? 'text-orange-300 border-orange-500/50' :
                                                'text-amber-300 border-amber-500/50'
                  }`}>{e.confidence}</span>
                </div>

                <div className="font-mono text-xl sm:text-2xl font-black tracking-tight text-white mb-1 leading-tight">
                  <SlotReel final={e.game_label} fakes={FAKE_TEAMS} delay={i * 220} duration={1200 + i * 200} />
                </div>
                <div className="font-mono text-[11px] sm:text-xs tracking-wider text-slate-500 uppercase mb-4 sm:mb-5">
                  {e.market} · {e.side}
                </div>

                <div className="flex items-end justify-between border-t border-amber-500/20 pt-3 sm:pt-4">
                  <div>
                    <div className="font-mono text-[9px] tracking-[0.3em] text-slate-500 uppercase">edge</div>
                    <div className="font-mono text-3xl sm:text-4xl font-black text-amber-300 tabular-nums leading-none mt-1">
                      <SlotReel final={fmtEdge(e)} fakes={FAKE_LINES} delay={300 + i * 220} duration={1500 + i * 200} />
                    </div>
                  </div>
                  {e.kickoff_ts && (
                    <div className="text-right">
                      <div className="font-mono text-[9px] tracking-[0.3em] text-slate-500 uppercase">kickoff</div>
                      <div className="font-mono text-xs text-slate-300 tabular-nums mt-1">{fmtDate(e.kickoff_ts)}</div>
                    </div>
                  )}
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className="border-b-2 border-amber-500/20">
        <div className="mx-auto max-w-7xl px-4 sm:px-8 py-10 sm:py-14">
          <div className="flex items-baseline justify-between gap-4 mb-5 sm:mb-8">
            <div>
              <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-orange-500/80 uppercase">
                ▌▌▌ all sports
              </p>
              <h2 className="mt-2 text-[clamp(1.6rem,5vw,3rem)] font-black tracking-tight uppercase text-white">
                in season<span className="text-orange-400">,</span> right now
              </h2>
            </div>
            <p className="hidden sm:block font-mono text-[10px] tracking-[0.3em] text-slate-500 uppercase max-w-[16rem] text-right">
              ordered by % of regular<br />season remaining
            </p>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
            {seasons.map((s, i) => <SportTile key={s.sport} state={s} index={i} />)}
          </div>
        </div>
      </section>

      <PlaybookSection />

      <section className="border-b-2 border-amber-500/20">
        <div className="mx-auto max-w-7xl px-4 sm:px-8 py-10 sm:py-14">
          <div className="flex items-baseline justify-between gap-4 mb-5 sm:mb-8">
            <div>
              <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-red-500/80 uppercase">
                ▌▌▌ latest from ceelo
              </p>
              <h2 className="mt-2 text-[clamp(1.6rem,5vw,3rem)] font-black tracking-tight uppercase text-white">
                the <span className="text-red-400">notebook</span>.
              </h2>
            </div>
            <Link
              href="/sports/articles"
              className="hidden sm:inline-flex items-center gap-2 font-mono text-[10px] tracking-[0.3em] text-red-300 hover:text-white uppercase border border-red-500/50 hover:border-red-300 px-3 py-2 transition-colors"
            >
              all articles →
            </Link>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 sm:gap-4">
            {articles.length > 0
              ? articles.map((a) => <ArticleCard key={a.id} a={a} />)
              : Array.from({ length: 3 }).map((_, i) => <ArticleSkeleton key={i} />)}
          </div>

          <div className="sm:hidden mt-5">
            <Link
              href="/sports/articles"
              className="block w-full text-center font-mono text-[10px] tracking-[0.3em] text-red-300 uppercase border-2 border-red-500/50 px-3 py-3 active:bg-red-500/10"
            >
              all articles →
            </Link>
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
            autonomous · ceelo handicapper · v1
          </span>
        </div>
      </footer>
    </main>
  )
}

function SportTile({ state, index }: { state: SeasonState; index: number }) {
  const phase = state.phase
  const tone =
    phase === 'regular'  ? { border: 'border-amber-500/60 hover:border-amber-300', text: 'text-amber-300',  dot: 'bg-amber-400',  glow: '' } :
    phase === 'playoffs' ? { border: 'border-red-500/60 hover:border-red-300',     text: 'text-red-300',    dot: 'bg-red-400',    glow: '' } :
                           { border: 'border-slate-700 hover:border-slate-500',     text: 'text-slate-500',  dot: 'bg-slate-600',  glow: '' }

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

      <div className="text-[clamp(2rem,5vw,3rem)] font-black tracking-tight text-white leading-[0.95]">
        {state.label}
      </div>

      <div className="mt-4 sm:mt-5">
        {phase === 'regular' ? (
          <>
            <div className="flex items-baseline justify-between font-mono text-[10px] tracking-[0.25em] uppercase mb-2">
              <span className={tone.text}>regular</span>
              <span className="tabular-nums text-white font-bold">
                {state.pctRemaining?.toFixed(0)}%
              </span>
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

function ArticleCard({ a }: { a: ArticleTeaser }) {
  return (
    <article className="group border-2 border-red-500/30 bg-slate-950/70 p-4 sm:p-5 transition-all duration-300 hover:border-red-300 hover:-translate-y-0.5">
      <div className="flex items-center justify-between mb-3">
        <span className="font-mono text-[9px] tracking-[0.3em] uppercase text-red-400">{a.author}</span>
        <span className="font-mono text-[9px] tracking-[0.3em] uppercase text-slate-600 tabular-nums">{fmtDate(a.created_ts)}</span>
      </div>
      <h3 className="text-base sm:text-lg font-bold text-white leading-tight mb-3 line-clamp-2 group-hover:text-amber-200 transition-colors">
        {a.title}
      </h3>
      <p className="font-mono text-[11px] leading-relaxed text-slate-400 line-clamp-4">
        {a.excerpt}
      </p>
    </article>
  )
}

function PlaybookSection() {
  const order: PlaybookSport[] = ['NFL', 'NBA', 'NHL', 'MLB']

  return (
    <section className="border-b-2 border-amber-500/20">
      <div className="mx-auto max-w-7xl px-4 sm:px-8 py-10 sm:py-14">
        <div className="flex items-baseline justify-between gap-4 mb-5 sm:mb-8">
          <div>
            <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-amber-500/80 uppercase">
              ▌▌▌ ceelo · the playbook
            </p>
            <h2 className="mt-2 text-[clamp(1.6rem,5vw,3rem)] font-black tracking-tight uppercase text-white">
              how to <span className="text-amber-400">read</span> it.
            </h2>
            <p className="mt-3 max-w-xl text-sm text-slate-400 leading-relaxed">
              Each sport has its own market structure and its own way to use Ceelo&rsquo;s signal.
              Pick a league for the worked-out strategy, the math, and example bets.
            </p>
          </div>
          <p className="hidden sm:block font-mono text-[10px] tracking-[0.3em] text-slate-500 uppercase max-w-[16rem] text-right">
            primary market<br />edge threshold
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          {order.map((sport, i) => (
            <PlaybookTile key={sport} sport={sport} index={i} />
          ))}
        </div>
      </div>
    </section>
  )
}

function PlaybookTile({ sport, index }: { sport: PlaybookSport; index: number }) {
  const book = PLAYBOOK[sport]
  const t = STRATEGY_TONE[book.tone]
  const ref = useRef<HTMLAnchorElement>(null)
  const [shown, setShown] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setShown(true) },
      { threshold: 0.15 },
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  const sportKey = sport as SportKey

  return (
    <Link
      ref={ref}
      href={SPORT_HREF[sportKey]}
      style={{ transitionDelay: `${index * 80}ms` }}
      className={`group relative border-2 ${t.border} bg-slate-950/70 p-4 sm:p-5 transition-all duration-500 ${t.ring} hover:-translate-y-0.5 ${
        shown ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
      }`}
    >
      <div className="flex items-center justify-between mb-3">
        <span className={`font-mono text-[10px] tracking-[0.32em] uppercase ${t.accent}`}>{sport}</span>
        <span className="font-mono text-[9px] tracking-[0.32em] uppercase text-slate-700">
          {book.primaryMarket}
        </span>
      </div>

      <div className={`text-[clamp(2rem,5vw,2.8rem)] font-black tracking-tight leading-[0.95] uppercase text-white ${t.glow}`}>
        {sport}
      </div>

      <p className="mt-3 font-mono text-[10px] sm:text-[11px] leading-relaxed text-slate-400 line-clamp-3">
        {book.thesis}
      </p>

      <div className={`mt-4 border-t ${t.borderSoft} pt-3 flex items-baseline justify-between`}>
        <span className="font-mono text-[9px] tracking-[0.32em] uppercase text-slate-500">threshold</span>
        <span className={`font-mono text-[10px] tabular-nums ${t.accent}`}>{book.edgeThreshold}</span>
      </div>

      <div className="mt-3 flex items-center justify-between font-mono text-[9px] tracking-[0.32em] uppercase text-slate-600">
        <span>{book.primary.name.toLowerCase()}</span>
        <span className={`transition-colors group-hover:${t.accent}`}>open guide →</span>
      </div>
    </Link>
  )
}

function ArticleSkeleton() {
  return (
    <article className="border-2 border-slate-800 bg-slate-950/40 p-4 sm:p-5">
      <div className="flex items-center justify-between mb-3">
        <span className="font-mono text-[9px] tracking-[0.3em] uppercase text-slate-700">ceelo</span>
        <span className="font-mono text-[9px] tracking-[0.3em] uppercase text-slate-700">--</span>
      </div>
      <div className="font-mono text-[10px] tracking-[0.25em] uppercase text-slate-700 mb-3">awaiting next note</div>
      <p className="font-mono text-[11px] leading-relaxed text-slate-700">
        <SlotReel final="The notebook fills as games settle." fakes={FAKE_PCTS} delay={0} duration={1100} />
      </p>
    </article>
  )
}
