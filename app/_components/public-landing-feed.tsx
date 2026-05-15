'use client'

import { useEffect, useState } from 'react'
import { ExplainBox } from './landing/explain-box'
import { ReturnToTop } from './landing/return-to-top'

type SidePayload = {
  team_id:     string
  abbrev:      string
  score_1to10: number
  color_tier:  'red' | 'yellow' | 'green' | 'purple'
  label:       'AVOID' | 'CAUTIOUS' | 'BET IT' | 'FULL SEND'
}

type PublicGame = {
  game_id:       string
  tipoff_at:     string
  pct_game_left: number | null
  away:          SidePayload
  home:          SidePayload
  signals: {
    overround: number | null
    consensus: number | null
    steam:     number | null
    delta:     number | null
    lead_pct:  number | null
    sma10:     number | null
  }
}

type PublicRunner = {
  horse_id: string
  horse: string
  number: string | null
  jockey: string | null
  trainer: string | null
  odds_decimal: number | null
  fair_decimal: number | null
  edge_pct: number | null
  fair_prob: number | null
  edge_component:    number | null
  form_component:    number | null
  weight_component:  number | null
  draw_component:    number | null
  jockey_component:  number | null
  trainer_component: number | null
  composite_score: number
  reasoning: string
}

type PublicRace = {
  race_id:    string
  course:     string
  off_time:   string
  off_dt:     string
  race_name:  string
  distance:   string | null
  going:      string | null
  type:       string | null
  field_size: number
}

type Author = 'lila' | 'vega' | 'ceelo'
type PublicArticle = {
  id: number
  title: string
  excerpt: string
  author: Author
  kind: string
  created_ts: number
}

type Payload = {
  sports: { nfl: PublicGame[]; nba: PublicGame[]; mlb: PublicGame[] }
  racing: { race: PublicRace | null; runners: PublicRunner[] }
  yard: { articles: PublicArticle[]; is_stale: Record<Author, boolean> }
  refreshed_ts: number
}

const TIER_TEXT: Record<SidePayload['color_tier'], string> = {
  red:    'text-red-400',
  yellow: 'text-amber-400',
  green:  'text-emerald-400',
  purple: 'text-fuchsia-400',
}
const TIER_BORDER: Record<SidePayload['color_tier'], string> = {
  red:    'border-red-500/40',
  yellow: 'border-amber-500/40',
  green:  'border-emerald-500/40',
  purple: 'border-fuchsia-500/40',
}

export default function PublicLandingFeed() {
  const [data, setData] = useState<Payload | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch('/api/public/landing', { cache: 'no-store' })
      .then(r => r.json() as Promise<Payload>)
      .then(p => { if (!cancelled) setData(p) })
      .catch(e => { if (!cancelled) setError(String(e)) })
    return () => { cancelled = true }
  }, [])

  return (
    <>
      <SportsSection data={data} error={error} />
      <RacingSection data={data} error={error} />
      <YardSection data={data} error={error} />
    </>
  )
}

// ─── Sports ────────────────────────────────────────────────────────────────

function SportsSection({ data, error }: { data: Payload | null; error: string | null }) {
  return (
    <section id="sports" className="relative z-10 border-t-2 border-amber-500/30 bg-amber-500/[0.02]">
      <div className="max-w-7xl mx-auto px-5 sm:px-8 py-14 sm:py-20">
        <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-amber-400 uppercase">
          ▌▌▌ free sample · sports
        </p>
        <h2 className="mt-3 text-[clamp(2.4rem,8vw,5.5rem)] font-black tracking-tight leading-[0.92] uppercase text-white">
          three games.<br />
          <span className="text-amber-400">every active sport.</span>
        </h2>

        {error && (
          <p className="mt-6 font-mono text-[11px] tracking-[0.18em] uppercase text-red-400/80">
            couldn't reach the floor — try refresh
          </p>
        )}

        {(['nfl', 'nba', 'mlb'] as const).map((league) => (
          <LeagueBlock key={league} league={league} games={data?.sports[league] ?? null} />
        ))}

        <ExplainBox title="how to trade this">
          <p>
            Every game shows a <span className="text-amber-300">1–10 score</span> per side derived
            from three independent feeds: a sharp anchor (where the sharpest books sit), a retail
            sensor (how the public is pricing it), and a prediction-market check
            (peer-to-peer implied probability).
          </p>
          <ul className="mt-3 space-y-1 font-mono text-[11px] tracking-[0.18em] uppercase text-slate-400">
            <li><span className="text-emerald-400">▸</span> 8–10 · FULL SEND — heaviest edge, conviction high</li>
            <li><span className="text-emerald-400">▸</span> 6–7  · BET IT — positive expected value</li>
            <li><span className="text-amber-400">▸</span>   3–5  · CAUTIOUS — fair or thin edge</li>
            <li><span className="text-red-400">▸</span>     1–2  · AVOID — book has you</li>
          </ul>
          <p className="mt-3 text-slate-400">
            On the pass you also see the per-metric breakdown (steam, delta vs retail, in-game
            lead %, 10-game SMA) plus an alert when the score crosses a tier line.
          </p>
        </ExplainBox>

        <ReturnToTop />
      </div>
    </section>
  )
}

function LeagueBlock({ league, games }: { league: 'nfl' | 'nba' | 'mlb'; games: PublicGame[] | null }) {
  return (
    <div className="mt-10">
      <div className="flex items-center justify-between mb-4">
        <span className="font-mono text-[10px] tracking-[0.32em] uppercase text-amber-300">{league}</span>
        <span className="font-mono text-[10px] tracking-[0.32em] uppercase text-slate-500">
          {games == null ? 'loading…' : games.length === 0 ? 'pipeline warming up' : `${games.length} of 3 sampled`}
        </span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {games == null && Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="border-2 border-amber-500/20 bg-slate-950/40 p-5 min-h-[180px] animate-pulse" />
        ))}
        {games != null && games.length === 0 && (
          <div className="md:col-span-3 border-2 border-amber-500/20 bg-slate-950/40 p-5 font-mono text-[11px] tracking-[0.18em] uppercase text-slate-500">
            ▌ {league.toUpperCase()} pipeline warming up — feeds wire to a parameterized loop; rows appear once a tick completes.
          </div>
        )}
        {games?.map(g => <GameCard key={g.game_id} game={g} />)}
      </div>
    </div>
  )
}

function GameCard({ game }: { game: PublicGame }) {
  return (
    <div className="border-2 border-amber-500/30 bg-slate-950/60 p-5 hover:border-amber-300 transition-colors">
      <div className="flex items-center justify-between font-mono text-[10px] tracking-[0.18em] uppercase text-slate-500">
        <span>{new Date(game.tipoff_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
        {game.pct_game_left != null && <span>{Math.round(game.pct_game_left * 100)}% left</span>}
      </div>
      <SidePill side={game.away} suffix="away" />
      <SidePill side={game.home} suffix="home" />
      <ul className="mt-4 grid grid-cols-3 gap-2 font-mono text-[10px] tracking-[0.18em] uppercase text-slate-500">
        <li>OR<br /><span className="text-slate-300 text-sm">{fmtNum(game.signals.overround)}</span></li>
        <li>STEAM<br /><span className="text-slate-300 text-sm">{fmtNum(game.signals.steam)}</span></li>
        <li>Δ<br /><span className="text-slate-300 text-sm">{fmtNum(game.signals.delta)}</span></li>
      </ul>
    </div>
  )
}

function SidePill({ side, suffix }: { side: SidePayload; suffix: 'home' | 'away' }) {
  return (
    <div className={`mt-3 flex items-center justify-between border-2 ${TIER_BORDER[side.color_tier]} px-3 py-2`}>
      <div>
        <div className="font-black text-lg tracking-tight">{side.abbrev}</div>
        <div className="font-mono text-[9px] tracking-[0.32em] uppercase text-slate-500">{suffix}</div>
      </div>
      <div className="text-right">
        <div className={`font-black text-2xl ${TIER_TEXT[side.color_tier]}`}>{side.score_1to10}</div>
        <div className={`font-mono text-[9px] tracking-[0.32em] uppercase ${TIER_TEXT[side.color_tier]}`}>{side.label}</div>
      </div>
    </div>
  )
}

function fmtNum(n: number | null): string {
  return n == null ? '—' : String(n)
}

// ─── Racing ────────────────────────────────────────────────────────────────

function RacingSection({ data, error }: { data: Payload | null; error: string | null }) {
  const race = data?.racing.race
  const runners = data?.racing.runners ?? []

  return (
    <section id="racing" className="relative z-10 border-t-2 border-amber-500/30">
      <div className="max-w-7xl mx-auto px-5 sm:px-8 py-14 sm:py-20">
        <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-amber-400 uppercase">
          ▌▌▌ free sample · horse racing
        </p>
        <h2 className="mt-3 text-[clamp(2.4rem,8vw,5.5rem)] font-black tracking-tight leading-[0.92] uppercase text-white">
          one race.<br />
          <span className="text-amber-400">six runners scored.</span>
        </h2>

        {error && (
          <p className="mt-6 font-mono text-[11px] tracking-[0.18em] uppercase text-red-400/80">
            couldn't reach the paddock — try refresh
          </p>
        )}

        {!race && data != null && (
          <p className="mt-8 font-mono text-[11px] tracking-[0.18em] uppercase text-slate-500">
            ▌ no eligible card today — the loop refreshes on its own cadence
          </p>
        )}

        {race && (
          <div className="mt-8 border-2 border-amber-500/40 bg-slate-950/60 p-5 sm:p-7">
            <div className="flex flex-wrap items-baseline justify-between gap-3 mb-5">
              <div>
                <div className="font-black text-2xl sm:text-3xl tracking-tight text-white">
                  {race.off_time} · {race.course}
                </div>
                <div className="font-mono text-[11px] tracking-[0.18em] uppercase text-slate-400 mt-1">
                  {race.race_name}
                </div>
              </div>
              <div className="font-mono text-[10px] tracking-[0.32em] uppercase text-slate-500 text-right">
                {[race.distance, race.going, race.type, `${race.field_size} runners`]
                  .filter(Boolean).join(' · ')}
              </div>
            </div>
            <ul className="space-y-2">
              {runners.map(r => <RunnerRow key={r.horse_id} r={r} />)}
            </ul>
          </div>
        )}

        <ExplainBox title="how this works">
          <p>
            Every runner gets a <span className="text-amber-300">composite score 1–10</span>
            blended from six factors:
          </p>
          <ul className="mt-3 space-y-1 font-mono text-[11px] tracking-[0.18em] uppercase text-slate-400">
            <li><span className="text-amber-400">▸</span> EDGE (55%) — book price vs our fair price across retail + sharp + prediction feeds</li>
            <li><span className="text-amber-400">▸</span> FORM (15%) — recency-weighted finish history</li>
            <li><span className="text-amber-400">▸</span> JOCKEY (10%) — rolling 30-day strike rate (min 10 mounts)</li>
            <li><span className="text-amber-400">▸</span> WEIGHT (10%) — z-score against the field median</li>
            <li><span className="text-amber-400">▸</span> DRAW (5%) — gate-position bias by field size</li>
            <li><span className="text-amber-400">▸</span> TRAINER (5%) — rolling 30-day strike rate (min 10 runners)</li>
          </ul>
          <p className="mt-3 text-slate-400">
            Components without data drop out and the remaining weights renormalise — a new
            jockey doesn't get penalised for having no history. On the pass you see velocity
            (price movement direction), intra-race odds history, and one-tap ticket logging.
          </p>
        </ExplainBox>

        <ReturnToTop />
      </div>
    </section>
  )
}

function RunnerRow({ r }: { r: PublicRunner }) {
  return (
    <li className="grid grid-cols-[1fr_auto] gap-4 items-center border-2 border-amber-500/20 hover:border-amber-300/60 bg-slate-950/40 p-4 transition-colors">
      <div className="min-w-0">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-[11px] tracking-[0.18em] uppercase text-slate-500">{r.number ?? '—'}</span>
          <span className="font-black text-base sm:text-lg tracking-tight text-white truncate">{r.horse}</span>
        </div>
        <div className="mt-1 font-mono text-[10px] tracking-[0.18em] uppercase text-slate-500">
          {r.jockey ? `J: ${r.jockey}` : 'jockey: —'} · {r.trainer ? `T: ${r.trainer}` : 'trainer: —'}
        </div>
        <div className="mt-2 grid grid-cols-3 sm:grid-cols-6 gap-2 font-mono text-[10px] tracking-[0.18em] uppercase text-slate-500">
          <ComponentCell label="edge"    v={r.edge_component} />
          <ComponentCell label="form"    v={r.form_component} />
          <ComponentCell label="weight"  v={r.weight_component} />
          <ComponentCell label="draw"    v={r.draw_component} />
          <ComponentCell label="jockey"  v={r.jockey_component} />
          <ComponentCell label="trainer" v={r.trainer_component} />
        </div>
      </div>
      <div className="text-right">
        <div className="font-black text-3xl text-amber-300 leading-none">{r.composite_score}</div>
        <div className="mt-1 font-mono text-[9px] tracking-[0.32em] uppercase text-amber-500/70">composite</div>
        <div className="mt-2 font-mono text-[10px] tracking-[0.18em] uppercase text-slate-500">
          {r.odds_decimal != null ? `book ${r.odds_decimal.toFixed(2)}` : 'no price'}
        </div>
        {r.edge_pct != null && (
          <div className={`font-mono text-[10px] tracking-[0.18em] uppercase ${r.edge_pct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
            {r.edge_pct >= 0 ? '+' : ''}{r.edge_pct.toFixed(1)}% edge
          </div>
        )}
      </div>
    </li>
  )
}

function ComponentCell({ label, v }: { label: string; v: number | null }) {
  return (
    <div>
      <div className="text-slate-600">{label}</div>
      <div className="text-slate-300 text-sm">{v == null ? '—' : v}</div>
    </div>
  )
}

// ─── Yard ─────────────────────────────────────────────────────────────────

function YardSection({ data, error }: { data: Payload | null; error: string | null }) {
  const articles = data?.yard.articles ?? null
  const stale = data?.yard.is_stale ?? { lila: false, vega: false, ceelo: false }

  return (
    <section id="yard" className="relative z-10 border-t-2 border-orange-500/30 bg-orange-500/[0.02]">
      <div className="max-w-7xl mx-auto px-5 sm:px-8 py-14 sm:py-20">
        <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-orange-400 uppercase">
          ▌▌▌ free sample · the yard
        </p>
        <h2 className="mt-3 text-[clamp(2.4rem,8vw,5.5rem)] font-black tracking-tight leading-[0.92] uppercase text-white">
          three voices.<br />
          <span className="text-orange-400">one paragraph each.</span>
        </h2>

        {error && (
          <p className="mt-6 font-mono text-[11px] tracking-[0.18em] uppercase text-red-400/80">
            couldn't reach the wire — try refresh
          </p>
        )}

        <div className="mt-8 grid grid-cols-1 lg:grid-cols-3 gap-4">
          {articles == null && Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="border-2 border-orange-500/20 bg-slate-950/40 p-5 min-h-[200px] animate-pulse" />
          ))}
          {articles?.length === 0 && (
            <div className="lg:col-span-3 border-2 border-orange-500/20 bg-slate-950/40 p-5 font-mono text-[11px] tracking-[0.18em] uppercase text-slate-500">
              ▌ no notes filed yet — the desk writes at noon and 18:00 PT
            </div>
          )}
          {articles?.map(a => (
            <ArticleCard key={`${a.author}-${a.id}`} article={a} stale={stale[a.author]} />
          ))}
        </div>

        <ExplainBox tone="orange" title="how this works">
          <p>
            Each desk voice files a <span className="text-orange-300">noon report</span> daily:
            <span className="text-orange-300"> Lila</span> on macro + research,
            <span className="text-orange-300"> Vega</span> on commodities + ETF flow,
            <span className="text-orange-300"> Ceelo</span> on racing + sports edges. On the
            pass you read the full report (700–1,100 words) plus the agent's open broadcast log.
          </p>
        </ExplainBox>

        <ReturnToTop tone="orange" />
      </div>
    </section>
  )
}

function ArticleCard({ article, stale }: { article: PublicArticle; stale: boolean }) {
  return (
    <article className="border-2 border-orange-500/30 hover:border-orange-300 bg-slate-950/60 p-5 transition-colors flex flex-col">
      <div className="flex items-center justify-between mb-3">
        <span className="font-mono text-[10px] tracking-[0.32em] uppercase text-orange-300">
          {stale ? 'latest from ' : ''}{article.author}
        </span>
        <span className="font-mono text-[9px] tracking-[0.32em] uppercase text-slate-500">
          {new Date(article.created_ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
        </span>
      </div>
      <h3 className="font-black text-lg sm:text-xl tracking-tight text-white leading-tight mb-3">
        {article.title}
      </h3>
      <p className="text-sm leading-relaxed text-slate-300 flex-1">
        {article.excerpt}
      </p>
    </article>
  )
}
