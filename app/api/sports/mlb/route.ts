// Live MLB portal payload — mirrors app/api/sports/nba/route.ts but
// scoped to g.league = 'mlb'. Gated by the same lila_viewer cookie.

import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getPool, ensureSchema } from '@/lib/db'
import { verifyViewerCookie } from '@/lib/viewer-auth'
import { toColorTier, toLabel } from '@/lib/sports/scale'

export const dynamic = 'force-dynamic'

type SidePayload = {
  team_id:     string
  abbrev:      string
  score_1to10: number
  color_tier:  string
  label:       string
}

type SignalSet = {
  overround: number | null
  consensus: number | null
  steam:     number | null
  delta:     number | null
  lead_pct:  number | null
  sma10:     number | null
}

type GamePayload = {
  game_id:       string
  tipoff_at:     string
  pct_game_left: number | null
  away:          SidePayload
  home:          SidePayload
  signals:       SignalSet
}

export async function GET() {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'database unavailable' }, { status: 503 })
  }
  const secret = process.env.VIEWER_COOKIE_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'viewer auth not configured' }, { status: 503 })
  }
  const cookieStore = await cookies()
  const viewerCookie = cookieStore.get('lila_viewer')?.value
  const payload = await verifyViewerCookie(viewerCookie, secret)
  if (!payload) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    const rows = await db.query<{
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
        WHERE g.league = 'mlb'
          AND g.status IN ('scheduled', 'live')
        ORDER BY g.tipoff_at ASC
        LIMIT 20`,
    )

    const games: GamePayload[] = rows.rows.map((r) => ({
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

    return NextResponse.json({ games })
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 200) }, { status: 500 })
  } finally {
    db.release()
  }
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
