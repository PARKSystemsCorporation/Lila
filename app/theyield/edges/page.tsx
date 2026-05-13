// /theyield/edges — the live edges dashboard. Real Ceelo data for NFL/NBA/MLB;
// NHL/UFC/SOCCER tabs render greyed-out "soon" placeholders.
//
// Three sections, top to bottom:
//   - BIGGEST EDGE TOP 3  ← /api/public/sports
//   - TOP 5 EDGES         ← /api/viewer/edges (flattened across active sports)
//   - THE BIGGEST STORY   ← /api/viewer/articles (newest ceelo author)

'use client'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import {
  LocalShell,
  IconBasketball, IconFootball, IconBaseball, IconHockey, IconGloves, IconSoccer,
  IconBroadcast, IconPlay,
} from '@/app/_components/local/chrome'
import { rankedSeasons } from '@/lib/season'

// ─── Types (mirror /api/public/sports + /api/viewer/edges) ────────────────

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

interface ViewerGame {
  game_id: number
  sport: 'NFL' | 'NBA' | 'MLB'
  home_team: string
  away_team: string
  kickoff_at: number
  consensus_home_spread: number | null
  model_home_spread: number | null
  model_home_prob: number | null
  edge_points: number | null
  edge_team: string | null
  light: 'green' | 'yellow' | 'grey'
}

interface ViewerArticle {
  id: number
  title: string
  content: string
  author: 'lila' | 'vega' | 'ceelo'
  kind: string
  created_ts: number
}

type Tab = 'OVERVIEW' | 'NFL' | 'NBA' | 'MLB' | 'NHL' | 'UFC' | 'SOCCER'
const TABS: Tab[] = ['OVERVIEW', 'NFL', 'NBA', 'MLB', 'NHL', 'UFC', 'SOCCER']
const LIVE_TABS: Tab[] = ['OVERVIEW', 'NFL', 'NBA', 'MLB']
const SOON_TABS: Tab[] = ['NHL', 'UFC', 'SOCCER']

const SPORT_ICON: Record<Tab, JSX.Element> = {
  OVERVIEW: <IconBroadcast />,
  NFL:    <IconFootball />,
  NBA:    <IconBasketball />,
  MLB:    <IconBaseball />,
  NHL:    <IconHockey />,
  UFC:    <IconGloves />,
  SOCCER: <IconSoccer />,
}

// ─── Page ─────────────────────────────────────────────────────────────────

export default function LocalSports() {
  const [tab, setTab] = useState<Tab>('OVERVIEW')
  const [topEdges, setTopEdges] = useState<TopEdge[] | null>(null)
  const [edges, setEdges] = useState<ViewerGame[]>([])
  const [article, setArticle] = useState<ViewerArticle | null>(null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      const [pubR, edgesR, artR] = await Promise.all([
        fetch('/api/public/sports', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null),
        Promise.all(['NFL', 'NBA', 'MLB'].map(s =>
          fetch(`/api/viewer/edges?sport=${s}&days=7`, { cache: 'no-store' })
            .then(r => r.ok ? r.json() : null)
            .catch(() => null)
        )),
        fetch('/api/viewer/articles', { cache: 'no-store' }).then(r => r.ok ? r.json() : null).catch(() => null),
      ])
      if (!alive) return
      setTopEdges(pubR?.top_edges ?? [])
      const flat: ViewerGame[] = edgesR.flatMap(r => Array.isArray(r?.games) ? r.games as ViewerGame[] : [])
      flat.sort((a, b) => Math.abs(b.edge_points ?? 0) - Math.abs(a.edge_points ?? 0))
      setEdges(flat)
      const ceeloFirst = (artR?.articles ?? [])
        .filter((a: ViewerArticle) => a.author === 'ceelo')
        .sort((a: ViewerArticle, b: ViewerArticle) => b.created_ts - a.created_ts)
      setArticle(ceeloFirst[0] ?? (artR?.articles ?? [])[0] ?? null)
    }
    load()
    const id = setInterval(load, 30_000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  const filteredEdges = useMemo(() => {
    const base = tab === 'OVERVIEW' ? edges : edges.filter(g => g.sport === tab)
    return base.slice(0, 5)
  }, [edges, tab])

  const filteredTop = useMemo(() => {
    if (!topEdges) return null
    const base = tab === 'OVERVIEW' ? topEdges : topEdges.filter(e => e.sport === tab)
    return base.slice(0, 3)
  }, [topEdges, tab])

  return (
    <LocalShell
      title="SPORTS"
      subtitle="Live games. Real-time edges."
      accent="amber"
      back={{ href: '/theyield', label: 'back to the yield' }}
      hero={<HeroSport />}
    >
      {/* Tabs */}
      <nav className="border-b border-amber-500/15 bg-slate-950/40">
        <div className="mx-auto max-w-7xl px-2 sm:px-8 overflow-x-auto">
          <ul className="flex items-center gap-1 sm:gap-2 min-w-min">
            {TABS.map(t => {
              const soon = SOON_TABS.includes(t)
              const active = t === tab
              return (
                <li key={t} className="shrink-0">
                  <button
                    type="button"
                    disabled={soon}
                    onClick={() => !soon && setTab(t)}
                    title={soon ? 'No live coverage yet — coming soon' : undefined}
                    className={[
                      'px-3 sm:px-4 py-3 font-mono text-[10px] sm:text-[11px] tracking-[0.32em] uppercase border-b-2 transition-colors',
                      active
                        ? 'border-amber-300 text-amber-300'
                        : soon
                          ? 'border-transparent text-slate-700 cursor-not-allowed'
                          : 'border-transparent text-slate-500 hover:text-amber-300',
                    ].join(' ')}
                  >
                    <span className="inline-flex items-center gap-2">
                      {t}
                      {soon && (
                        <span className="text-[8px] tracking-[0.25em] text-slate-700 border border-slate-800 px-1 py-[1px]">soon</span>
                      )}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      </nav>

      {SOON_TABS.includes(tab) ? (
        <SoonPanel label={tab} />
      ) : (
        <>
          {/* BIGGEST EDGE TOP 3 */}
          <section className="mx-auto max-w-7xl px-5 sm:px-8 pt-10 sm:pt-14">
            <SectionHead title="biggest edge" badge="top 3 ⚡" />
            <div className="mt-5 grid grid-cols-1 md:grid-cols-3 gap-3 sm:gap-4">
              {filteredTop === null
                ? Array.from({ length: 3 }).map((_, i) => <TopEdgeSkeleton key={i} />)
                : filteredTop.length === 0
                  ? <EmptyCard span={3} body="No open picks yet — Ceelo's still scanning." />
                  : filteredTop.map((e, i) => <TopEdgeCard key={e.id} rank={i + 1} edge={e} />)}
            </div>
          </section>

          {/* TOP 5 EDGES */}
          <section className="mx-auto max-w-7xl px-5 sm:px-8 pt-10 sm:pt-14">
            <SectionHead title="upcoming edges" badge="top 5" live />
            <div className="mt-5 border-2 border-amber-500/15 bg-slate-950/60 divide-y divide-amber-500/10">
              {filteredEdges.length === 0 && filteredTop !== null && (
                <div className="px-5 py-8 text-center font-mono text-[11px] tracking-[0.25em] uppercase text-slate-600">
                  No games on the board for {tab.toLowerCase()}.
                </div>
              )}
              {filteredEdges.map((g, i) => <EdgeRow key={g.game_id} rank={i + 1} game={g} />)}
              {filteredEdges.length === 0 && filteredTop === null && Array.from({ length: 5 }).map((_, i) => <EdgeRowSkeleton key={i} />)}
            </div>
          </section>

          {/* THE BIGGEST STORY */}
          <section className="mx-auto max-w-7xl px-5 sm:px-8 pt-10 sm:pt-14 pb-14">
            <SectionHead title="the biggest story" />
            <div className="mt-5">
              {article ? <StoryCard article={article} /> : <EmptyStory />}
            </div>
          </section>

          {/* Season belt */}
          <section className="border-t-2 border-amber-500/15 bg-slate-950/40">
            <div className="mx-auto max-w-7xl px-5 sm:px-8 py-6 grid grid-cols-2 sm:grid-cols-4 gap-3 font-mono text-[10px] tracking-[0.32em] uppercase">
              {rankedSeasons().map(s => (
                <div key={s.sport} className="flex items-center justify-between border border-amber-500/15 px-3 py-2">
                  <span className="text-slate-500">{s.sport}</span>
                  <span className={
                    s.phase === 'regular'  ? 'text-amber-300' :
                    s.phase === 'playoffs' ? 'text-red-300'   :
                                             'text-slate-700'
                  }>
                    {s.phase}
                  </span>
                </div>
              ))}
            </div>
          </section>
        </>
      )}
    </LocalShell>
  )
}

// ─── Section bits ─────────────────────────────────────────────────────────

function SectionHead({ title, badge, live }: { title: string; badge?: string; live?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <div className="flex items-baseline gap-3">
        <h2 className="font-mono text-[11px] sm:text-[12px] tracking-[0.45em] uppercase text-white">{title}</h2>
        {badge && (
          <span className="font-mono text-[9px] tracking-[0.32em] uppercase text-amber-400">
            {live && <span className="inline-flex items-center gap-1.5 mr-2"><span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" /><span>live</span></span>}
            {badge}
          </span>
        )}
      </div>
      <Link
        href="/viewer"
        className="font-mono text-[9px] sm:text-[10px] tracking-[0.32em] uppercase text-amber-400/80 hover:text-amber-300 transition-colors"
      >
        view all →
      </Link>
    </div>
  )
}

function HeroSport() {
  return (
    <svg viewBox="0 0 200 140" width="220" height="150" className="text-amber-500/30" aria-hidden>
      <defs>
        <radialGradient id="hero-sport-glow" cx="50%" cy="50%">
          <stop offset="0%" stopColor="#f59e0b" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#f59e0b" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="120" cy="70" r="70" fill="url(#hero-sport-glow)" />
      <g fill="none" stroke="currentColor" strokeWidth="0.6">
        <circle cx="120" cy="70" r="56" />
        <circle cx="120" cy="70" r="36" />
        <circle cx="120" cy="70" r="18" />
        <path d="M120 14v112M64 70h112M86 36l68 68M154 36l-68 68" />
      </g>
      <g stroke="#f59e0b" strokeWidth="1.4" fill="none">
        <path d="M168 22l8 0M176 22l0 8M32 118l-8 0M24 118l0-8" />
      </g>
    </svg>
  )
}

// ─── Cards & rows ─────────────────────────────────────────────────────────

function TopEdgeCard({ rank, edge }: { rank: number; edge: TopEdge }) {
  const tone =
    edge.confidence === 'high'   ? { txt: 'text-amber-300',  border: 'border-amber-500/40 hover:border-amber-300',   glow: '', big: 'text-amber-300' } :
    edge.confidence === 'medium' ? { txt: 'text-orange-300', border: 'border-orange-500/40 hover:border-orange-300', glow: '', big: 'text-orange-300' } :
                                   { txt: 'text-red-300',    border: 'border-red-500/40 hover:border-red-300',       glow: '',  big: 'text-red-300' }

  const ko = formatKickoff(edge.kickoff_ts)
  const edgePct = edge.edge_pct != null ? Math.round(edge.edge_pct) : null

  return (
    <Link
      href="/viewer"
      className={`group relative block border-2 ${tone.border} bg-slate-950/70 p-5 sm:p-6 transition-all duration-300 hover:-translate-y-0.5 ${tone.glow}`}
    >
      <div className="flex items-baseline justify-between mb-4">
        <span className={`font-mono text-2xl font-black tabular-nums ${tone.txt}`}>{String(rank).padStart(2, '0')}</span>
        <div className="text-right font-mono text-[10px] tracking-[0.32em] uppercase">
          <div className="text-white">{edge.sport}</div>
          {ko && <div className="text-slate-500">{ko}</div>}
        </div>
      </div>

      <div className="text-lg sm:text-xl font-black tracking-tight text-white leading-tight">
        {edge.game_label || '—'}
      </div>
      <div className={`mt-1 font-mono text-[11px] tracking-[0.25em] uppercase ${tone.txt}`}>
        {edge.side}
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 font-mono text-[10px] uppercase tracking-[0.25em]">
        <div>
          <div className="text-slate-600">spread</div>
          <div className="mt-1 text-white tabular-nums text-base font-bold normal-case tracking-tight">
            {edge.book_spread != null ? formatSpread(edge.book_spread) : '—'}
          </div>
        </div>
        <div className="text-right">
          <div className="text-slate-600">sharp edge</div>
          <div className={`mt-1 text-2xl font-black tabular-nums tracking-tight ${tone.big}`}>
            {edgePct != null ? `${edgePct}%` : '—'}
          </div>
        </div>
      </div>
    </Link>
  )
}

function EdgeRow({ rank, game }: { rank: number; game: ViewerGame }) {
  const dim = game.light === 'grey'
  const lightCls =
    game.light === 'green'  ? 'text-emerald-300' :
    game.light === 'yellow' ? 'text-amber-300'   :
                              'text-slate-600'
  const edgePts = game.edge_points
  const edgeMag = edgePts != null ? Math.abs(edgePts) : null

  return (
    <Link
      href="/viewer"
      className={`group grid grid-cols-[auto_1.4fr_1fr_auto_auto] sm:grid-cols-[auto_2fr_1.2fr_1fr_1fr_auto] items-center gap-3 sm:gap-5 px-4 sm:px-5 py-3 sm:py-4 hover:bg-slate-900/60 transition-colors ${dim ? 'opacity-60' : ''}`}
    >
      <span className="font-mono text-lg sm:text-xl font-black text-amber-300 tabular-nums w-7">
        {String(rank).padStart(2, '0')}
      </span>

      <div className="min-w-0">
        <div className="font-mono text-[9px] tracking-[0.32em] uppercase text-slate-500 mb-0.5 flex items-center gap-1.5">
          <span>{game.sport}</span>
          <span className={`w-1.5 h-1.5 rounded-full ${lightCls.replace('text-', 'bg-')}`} />
        </div>
        <div className="font-bold text-sm sm:text-base text-white truncate">
          {game.away_team} <span className="text-slate-600">@</span> {game.home_team}
        </div>
      </div>

      <div className="font-mono text-[10px] tracking-[0.2em] uppercase text-slate-500 hidden sm:block">
        {new Date(game.kickoff_at).toLocaleString('en-US', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false })}
      </div>

      <div className="font-mono text-[10px] tracking-[0.2em] uppercase text-slate-500 text-right">
        <div className="text-slate-700 text-[9px]">spread</div>
        <div className="text-white tabular-nums">
          {game.consensus_home_spread != null ? formatSpread(game.consensus_home_spread) : '—'}
        </div>
      </div>

      <div className="font-mono text-right hidden sm:block">
        <div className="text-[9px] tracking-[0.32em] uppercase text-slate-700">edge</div>
        <div className={`tabular-nums text-lg font-black ${lightCls}`}>
          {edgeMag != null ? `${edgeMag.toFixed(1)}` : '—'}
        </div>
      </div>

      <span className="text-slate-700 group-hover:text-amber-300 transition-colors border border-slate-800 group-hover:border-amber-500/40 px-2 py-1">
        <IconPlay />
      </span>
    </Link>
  )
}

function StoryCard({ article }: { article: ViewerArticle }) {
  const excerpt = excerptOf(article.content, 180)
  const when = new Date(article.created_ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  return (
    <Link
      href="/viewer"
      className="group block border-2 border-amber-500/30 hover:border-amber-300 bg-slate-950/70 transition-colors"
    >
      <div className="relative overflow-hidden border-b border-amber-500/15 px-5 sm:px-8 py-8 sm:py-12">
        <div
          className="absolute inset-0 -z-10 opacity-40"
          style={{
            background: 'radial-gradient(ellipse at 70% 50%, rgba(245,158,11,0.18), transparent 60%)',
          }}
        />
        <div className="flex items-center gap-3 mb-4">
          <span className="bg-amber-400 text-black font-mono text-[10px] tracking-[0.32em] uppercase px-2 py-1">breaking</span>
          <span className="font-mono text-[10px] tracking-[0.32em] uppercase text-amber-500/60">{article.author} · {when}</span>
        </div>
        <h3 className="text-[clamp(1.4rem,3.5vw,2.2rem)] font-black tracking-tight uppercase text-white leading-[1.05] max-w-3xl">
          {article.title}
        </h3>
        <p className="mt-3 max-w-2xl text-sm text-slate-400 leading-relaxed">{excerpt}</p>
        <div className="mt-5 font-mono text-[10px] tracking-[0.32em] uppercase text-amber-400 group-hover:text-amber-300">
          read the dispatch →
        </div>
      </div>
    </Link>
  )
}

function EmptyStory() {
  return (
    <div className="border-2 border-dashed border-amber-500/20 bg-slate-950/40 px-5 sm:px-8 py-10 text-center">
      <p className="font-mono text-[11px] tracking-[0.32em] uppercase text-slate-500">
        awaiting the next dispatch
      </p>
    </div>
  )
}

function EmptyCard({ span, body }: { span: number; body: string }) {
  return (
    <div
      className="border-2 border-dashed border-amber-500/20 bg-slate-950/40 px-5 py-10 text-center font-mono text-[11px] tracking-[0.25em] uppercase text-slate-500"
      style={{ gridColumn: `span ${span} / span ${span}` }}
    >
      {body}
    </div>
  )
}

function SoonPanel({ label }: { label: Tab }) {
  return (
    <section className="mx-auto max-w-3xl px-5 sm:px-8 py-20 sm:py-28 text-center">
      <div className="inline-flex items-center justify-center mb-6 text-amber-500/40">
        {SPORT_ICON[label]}
      </div>
      <h2 className="text-[clamp(1.6rem,5vw,2.4rem)] font-black tracking-tight uppercase text-white">
        {label} · <span className="text-amber-400">soon</span>
      </h2>
      <p className="mt-4 max-w-md mx-auto text-sm text-slate-500 leading-relaxed">
        Ceelo doesn&rsquo;t cover {label.toLowerCase()} yet. We&rsquo;ll wire the feed once the model has enough data to call edges with conviction.
      </p>
      <Link
        href="/theyield/edges"
        onClick={(e) => { e.preventDefault(); }}
        className="mt-7 inline-block font-mono text-[10px] tracking-[0.32em] uppercase border-2 border-amber-500/30 text-amber-300/60 px-4 py-3 cursor-not-allowed"
      >
        no live coverage yet
      </Link>
    </section>
  )
}

// ─── Skeletons ────────────────────────────────────────────────────────────

function TopEdgeSkeleton() {
  return (
    <div className="border-2 border-amber-500/10 bg-slate-950/40 p-5 sm:p-6">
      <div className="h-6 w-12 bg-slate-900 animate-pulse mb-4" />
      <div className="h-5 w-3/4 bg-slate-900 animate-pulse mb-2" />
      <div className="h-3 w-1/2 bg-slate-900 animate-pulse mb-6" />
      <div className="h-8 w-1/3 bg-slate-900 animate-pulse ml-auto" />
    </div>
  )
}

function EdgeRowSkeleton() {
  return (
    <div className="grid grid-cols-[auto_2fr_1fr_auto] gap-3 px-5 py-4 items-center">
      <div className="h-5 w-5 bg-slate-900 animate-pulse" />
      <div className="h-4 w-3/4 bg-slate-900 animate-pulse" />
      <div className="h-4 w-12 bg-slate-900 animate-pulse" />
      <div className="h-5 w-8 bg-slate-900 animate-pulse" />
    </div>
  )
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function formatSpread(s: number): string {
  if (!Number.isFinite(s)) return '—'
  const sign = s > 0 ? '+' : ''
  return `${sign}${s.toFixed(1)}`
}

function formatKickoff(ts: number | null): string | null {
  if (!ts) return null
  return new Date(ts).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

function excerptOf(content: string, max = 200): string {
  const stripped = content
    .replace(/^#.+$/gm, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[*_`>#-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (stripped.length <= max) return stripped
  return stripped.slice(0, max).replace(/\s+\S*$/, '') + '…'
}
