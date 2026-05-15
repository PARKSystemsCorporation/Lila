// Public, unauthenticated free-preview payload for the landing page.
// Single round trip → three feature panels: 3 random games per active
// sport, 1 racecard with 6 top-scored runners, 3 daily author snippets.
//
// Each source branch is independently try/caught so any one upstream
// failure returns an empty/null for its slice rather than 500'ing the
// whole page — same graceful-degradation contract as
// app/api/horse-racing/route.ts.

import { NextResponse } from 'next/server'
import type { PoolClient } from 'pg'
import { getPool, ensureSchema } from '@/lib/db'
import { excerptOf } from '@/lib/text/excerpt'
import { toColorTier, toLabel } from '@/lib/sports/scale'
import { getHorseDataService } from '@/lib/horse-racing/data-service'
import { scoreAllRunners, type RunnerScore } from '@/lib/horse-racing/yield'
import { formScore } from '@/lib/horse-racing/factors/form'
import { weightScore } from '@/lib/horse-racing/factors/weight'
import { drawScore } from '@/lib/horse-racing/factors/draw'
import { jockeyScore, trainerScore } from '@/lib/horse-racing/factors/jockey-trainer'
import type { Race } from '@/lib/horse-racing/types'

export const dynamic = 'force-dynamic'
export const revalidate = 0

type Author = 'lila' | 'vega' | 'ceelo'
const AUTHORS: Author[] = ['lila', 'vega', 'ceelo']

type SidePayload = {
  team_id:     string
  abbrev:      string
  score_1to10: number
  color_tier:  string
  label:       string
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

type PublicArticle = {
  id:         number
  title:      string
  excerpt:    string
  author:     Author
  kind:       string
  created_ts: number
}

export async function GET() {
  const empty = {
    sports: { nfl: [] as PublicGame[], nba: [] as PublicGame[], mlb: [] as PublicGame[] },
    racing: { race: null as PublicRace | null, runners: [] as RunnerScore[] },
    yard: {
      articles: [] as PublicArticle[],
      is_stale: { lila: false, vega: false, ceelo: false } as Record<Author, boolean>,
    },
    refreshed_ts: Date.now(),
  }

  if (!process.env.DATABASE_URL) return NextResponse.json(empty)

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)

    const [nfl, nba, mlb, racing, yard] = await Promise.all([
      fetchLeagueGames(db, 'nfl').catch(() => [] as PublicGame[]),
      fetchLeagueGames(db, 'nba').catch(() => [] as PublicGame[]),
      fetchLeagueGames(db, 'mlb').catch(() => [] as PublicGame[]),
      fetchRacing(db).catch(() => ({ race: null, runners: [] as RunnerScore[] })),
      fetchYard(db).catch(() => ({
        articles: [] as PublicArticle[],
        is_stale: { lila: false, vega: false, ceelo: false },
      })),
    ])

    return NextResponse.json({
      sports: { nfl, nba, mlb },
      racing,
      yard,
      refreshed_ts: Date.now(),
    })
  } catch {
    return NextResponse.json(empty)
  } finally {
    db.release()
  }
}

// ─── Sports ───────────────────────────────────────────────────────────────

async function fetchLeagueGames(db: PoolClient, league: 'nfl' | 'nba' | 'mlb'): Promise<PublicGame[]> {
  const { rows } = await db.query<{
    game_id:         string
    tipoff_at:       Date
    pct_game_left:   string | null
    home_team_id:    string
    away_team_id:    string
    home_city:       string
    home_name:       string
    away_city:       string
    away_name:       string
    home_score:      number
    home_color:      string
    home_overround:  number | null
    home_consensus:  number | null
    home_steam:      number | null
    home_delta:      number | null
    home_lead:       string | null
    home_sma10:      number | null
    away_score:      number
    away_color:      string
    away_overround:  number | null
    away_consensus:  number | null
    away_steam:      number | null
    away_delta:      number | null
    away_lead:       string | null
    away_sma10:      number | null
  }>(
    `SELECT g.game_id,
            g.tipoff_at,
            g.pct_game_left,
            g.home_team_id, g.away_team_id,
            th.city  AS home_city, th.name AS home_name,
            ta.city  AS away_city, ta.name AS away_name,
            vh.composite_1to10 AS home_score,
            vh.color_tier      AS home_color,
            vh.overround_1to10 AS home_overround,
            vh.consensus_1to10 AS home_consensus,
            vh.steam_1to10     AS home_steam,
            vh.delta_1to10     AS home_delta,
            vh.lead_pct        AS home_lead,
            vh.sma10_1to10     AS home_sma10,
            va.composite_1to10 AS away_score,
            va.color_tier      AS away_color,
            va.overround_1to10 AS away_overround,
            va.consensus_1to10 AS away_consensus,
            va.steam_1to10     AS away_steam,
            va.delta_1to10     AS away_delta,
            va.lead_pct        AS away_lead,
            va.sma10_1to10     AS away_sma10
       FROM sports_games g
       JOIN sports_teams th     ON th.team_id = g.home_team_id
       JOIN sports_teams ta     ON ta.team_id = g.away_team_id
       JOIN sports_game_view vh ON vh.game_id = g.game_id AND vh.team_id = g.home_team_id
       JOIN sports_game_view va ON va.game_id = g.game_id AND va.team_id = g.away_team_id
      WHERE g.league = $1
        AND g.status IN ('scheduled', 'live')
      ORDER BY random()
      LIMIT 3`,
    [league],
  )

  return rows.map((r) => ({
    game_id:       r.game_id,
    tipoff_at:     r.tipoff_at.toISOString(),
    pct_game_left: r.pct_game_left == null ? null : Number(r.pct_game_left),
    home: side(r.home_team_id, r.home_city, r.home_name, Number(r.home_score), r.home_color),
    away: side(r.away_team_id, r.away_city, r.away_name, Number(r.away_score), r.away_color),
    signals: {
      overround: r.home_overround ?? r.away_overround ?? null,
      consensus: r.home_consensus ?? r.away_consensus ?? null,
      steam:     r.home_steam     ?? r.away_steam     ?? null,
      delta:     r.home_delta     ?? r.away_delta     ?? null,
      lead_pct:  r.home_lead != null ? Number(r.home_lead)
               : r.away_lead != null ? Number(r.away_lead) : null,
      sma10:     r.home_sma10     ?? r.away_sma10     ?? null,
    },
  }))
}

function side(teamId: string, city: string, name: string, score: number, color: string): SidePayload {
  const tier = (['red', 'yellow', 'green', 'purple'].includes(color) ? color : toColorTier(score)) as
    'red' | 'yellow' | 'green' | 'purple'
  return {
    team_id:     teamId,
    abbrev:      abbrev(city, name),
    score_1to10: score,
    color_tier:  tier,
    label:       toLabel(score),
  }
}

function abbrev(city: string, name: string): string {
  const fromCity = city.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase()
  if (fromCity.length === 3) return fromCity
  return name.replace(/[^A-Za-z]/g, '').slice(0, 3).toUpperCase()
}

// ─── Racing ───────────────────────────────────────────────────────────────

async function fetchRacing(db: PoolClient): Promise<{ race: PublicRace | null; runners: RunnerScore[] }> {
  const svc = getHorseDataService()
  let races: Race[] = []
  try {
    races = await svc.getTodayRacecards()
  } catch {
    return { race: null, runners: [] }
  }

  // Soonest off race today with a field of at least 6.
  const now = Date.now()
  const usable = races
    .filter(r => r.field_size >= 6 && (!r.off_dt || Date.parse(r.off_dt) >= now - 60 * 60_000))
    .sort((a, b) => Date.parse(a.off_dt || '') - Date.parse(b.off_dt || ''))
  const race = usable[0] ?? races.find(r => r.field_size >= 6) ?? null
  if (!race) return { race: null, runners: [] }

  // Precompute factor scores for each runner so scoreAllRunners stays
  // synchronous and pure. Jockey + trainer scores hit the DB.
  const extras: Record<string, {
    form?: number | null
    weight?: number | null
    draw?: number | null
    jockey?: number | null
    trainer?: number | null
  }> = {}
  for (const r of race.runners) {
    const [j, t] = await Promise.all([
      jockeyScore(r.jockey, db).catch(() => null),
      trainerScore(r.trainer, db).catch(() => null),
    ])
    extras[r.horse_id] = {
      form:    formScore(r.form),
      weight:  weightScore(r, race.runners),
      draw:    drawScore(r, race),
      jockey:  j,
      trainer: t,
    }
  }

  // Pull aux quotes for this race (sharp / prediction stubs return null
  // until creds land; the blend falls back to retail alone).
  let aux: Awaited<ReturnType<typeof svc.getRaceWithAux>>['aux'] = []
  try {
    const withAux = await svc.getRaceWithAux(race.race_id)
    aux = withAux.aux
  } catch {
    aux = []
  }

  const all = scoreAllRunners(race, aux, extras)
  const runners = all.slice(0, 6)

  const publicRace: PublicRace = {
    race_id:    race.race_id,
    course:     race.course,
    off_time:   race.off_time,
    off_dt:     race.off_dt,
    race_name:  race.race_name,
    distance:   race.distance,
    going:      race.going,
    type:       race.type,
    field_size: race.field_size,
  }
  return { race: publicRace, runners }
}

// ─── Yard ─────────────────────────────────────────────────────────────────

async function fetchYard(db: PoolClient): Promise<{ articles: PublicArticle[]; is_stale: Record<Author, boolean> }> {
  // For each author, prefer today's published noon-report; fall back to
  // their most recent published article and mark it stale.
  const out: PublicArticle[] = []
  const stale: Record<Author, boolean> = { lila: false, vega: false, ceelo: false }

  for (const author of AUTHORS) {
    const today = await db.query<{
      id: string; title: string; content: string; kind: string; created_ts: string
    }>(
      `SELECT id::text, title, content, kind,
              (EXTRACT(EPOCH FROM created_at) * 1000)::bigint::text AS created_ts
         FROM articles
        WHERE status='published'
          AND author=$1
          AND kind='noon-report'
          AND created_at::date = (NOW() AT TIME ZONE 'UTC')::date
        ORDER BY created_at DESC
        LIMIT 1`,
      [author],
    )
    let row = today.rows[0]
    if (!row) {
      const fallback = await db.query<{
        id: string; title: string; content: string; kind: string; created_ts: string
      }>(
        `SELECT id::text, title, content, kind,
                (EXTRACT(EPOCH FROM created_at) * 1000)::bigint::text AS created_ts
           FROM articles
          WHERE status='published' AND author=$1
          ORDER BY created_at DESC
          LIMIT 1`,
        [author],
      )
      row = fallback.rows[0]
      if (row) stale[author] = true
    }
    if (!row) continue
    out.push({
      id:         Number(row.id),
      title:      row.title,
      excerpt:    excerptOf(row.content, 250),
      author,
      kind:       row.kind ?? 'noon-report',
      created_ts: Number(row.created_ts),
    })
  }

  return { articles: out, is_stale: stale }
}
