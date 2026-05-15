import type { PoolClient } from 'pg'
import { cfg } from '../config'
import { fetchNbaSharpSnapshots, type ApiSportsSnapshot } from './sources/api-sports'
import { fetchNflSharpSnapshots } from './sources/api-sports-nfl'
import { fetchMlbSharpSnapshots } from './sources/api-sports-mlb'
import { fetchNbaRetailSnapshots, type ParlaySnapshot } from './sources/parlay'
import { fetchNflRetailSnapshots } from './sources/parlay-nfl'
import { fetchMlbRetailSnapshots } from './sources/parlay-mlb'
import { fetchNbaPredictionSnapshots, type ProphetXSnapshot } from './sources/prophet-x'
import { fetchNflPredictionSnapshots } from './sources/prophet-x-nfl'
import { fetchMlbPredictionSnapshots } from './sources/prophet-x-mlb'
import { getOrCreateTeamId } from './teams'
import { toColorTier } from './scale'
import { overroundScore } from './metrics/overround'
import { consensusScore } from './metrics/consensus'
import { steamScore } from './metrics/steam'
import { deltaScore } from './metrics/delta'
import { publicGravityScore } from './metrics/public-gravity'
import { whaleScore } from './metrics/whale'
import { lockScore } from './metrics/lock'
import { leadPctScore } from './metrics/lead-pct'
import { sma10Score } from './metrics/sma10'
import { compositeScore } from './metrics/composite'

// Sports ingestion loop. Pulls three independent feeds (API-Sports,
// ParlayAPI, ProphetX) in parallel, derives the 1–10 signals per game
// side, and persists ONLY the scores + small numeric inputs. No raw
// upstream payload is ever written to Postgres.
//
// Parameterized per league: invoke run('nba'|'nfl'|'mlb') for each
// league you want to tick. The metric math (overround / consensus /
// steam / delta / lead_pct / sma10 / composite) is league-agnostic.

export type League = 'nba' | 'nfl' | 'mlb'

type SourceFan = {
  sharp: ApiSportsSnapshot[]
  retail: ParlaySnapshot[]
  prediction: ProphetXSnapshot[]
}

type Side = 'home' | 'away'
type GameKey = string

const SHARP_FETCHERS: Record<League, () => Promise<ApiSportsSnapshot[] | null>> = {
  nba: fetchNbaSharpSnapshots,
  nfl: fetchNflSharpSnapshots,
  mlb: fetchMlbSharpSnapshots,
}
const RETAIL_FETCHERS: Record<League, () => Promise<ParlaySnapshot[] | null>> = {
  nba: fetchNbaRetailSnapshots,
  nfl: fetchNflRetailSnapshots,
  mlb: fetchMlbRetailSnapshots,
}
const PREDICTION_FETCHERS: Record<League, () => Promise<ProphetXSnapshot[] | null>> = {
  nba: fetchNbaPredictionSnapshots,
  nfl: fetchNflPredictionSnapshots,
  mlb: fetchMlbPredictionSnapshots,
}

export class SportsLoop {
  constructor(private readonly db: PoolClient) {}

  async run(league: League = 'nba'): Promise<{ logMessage: string; logType: 'info' | 'success' | 'warn' } | null> {
    if (process.env.ENABLE_SPORTS_LOOP !== 'true') return null
    if (!await this.shouldRunCycle()) return null

    const fan = await this.fanOut(league)
    if (!fan.sharp.length && !fan.retail.length && !fan.prediction.length) {
      await this.markRan()
      return { logMessage: `Sports[${league}]: no feeds available (set API keys).`, logType: 'info' }
    }

    const games = this.alignSnapshots(fan)
    let written = 0
    for (const game of games.values()) {
      try {
        await this.persistGame(game, league)
        written++
      } catch (e) {
        // One bad game must not abort the loop.
        await this.db.query(
          `INSERT INTO lila_log (message, type) VALUES ($1, 'warn')`,
          [`Sports[${league}]: ${game.home.city} vs ${game.away.city}: ${String(e).slice(0, 200)}`],
        )
      }
    }
    await this.markRan()
    return {
      logMessage: `Sports[${league}]: scored ${written} game-sides across ${games.size} games.`,
      logType: written ? 'success' : 'info',
    }
  }

  private async shouldRunCycle(): Promise<boolean> {
    const tickMs = cfg.SPORTS_TICK_MS ?? 60_000
    const { rows } = await this.db.query<{ updated_at: string }>(
      `SELECT MAX(updated_at) AS updated_at FROM sports_game_view`,
    )
    const last = rows[0]?.updated_at ? new Date(rows[0].updated_at).getTime() : 0
    return Date.now() - last >= tickMs
  }

  private async markRan(): Promise<void> {
    // No dedicated state table; sports_game_view.updated_at is the gate.
    return
  }

  private async fanOut(league: League): Promise<SourceFan> {
    const [sharpRes, retailRes, predictionRes] = await Promise.allSettled([
      SHARP_FETCHERS[league](),
      RETAIL_FETCHERS[league](),
      PREDICTION_FETCHERS[league](),
    ])
    return {
      sharp:      sharpRes.status      === 'fulfilled' && sharpRes.value      ? sharpRes.value      : [],
      retail:     retailRes.status     === 'fulfilled' && retailRes.value     ? retailRes.value     : [],
      prediction: predictionRes.status === 'fulfilled' && predictionRes.value ? predictionRes.value : [],
    }
  }

  // Stitch the three feeds into a per-game record keyed by a normalized
  // matchup string. Each feed contributes whatever fields it has; missing
  // feeds turn into null inputs, and dependent metrics will skip.
  private alignSnapshots(fan: SourceFan): Map<GameKey, AlignedGame> {
    const games = new Map<GameKey, AlignedGame>()
    const upsert = (sharp: ApiSportsSnapshot | null, retail: ParlaySnapshot | null, pred: ProphetXSnapshot | null) => {
      const ref = sharp ?? retail ?? pred
      if (!ref) return
      const key = matchupKey(ref.home_team, ref.away_team)
      const prior = games.get(key)
      games.set(key, {
        home:     ref.home_team,
        away:     ref.away_team,
        tipoff_at: sharp?.tipoff_at ?? prior?.tipoff_at ?? new Date().toISOString(),
        status:    sharp?.status ?? prior?.status ?? 'scheduled',
        pct_game_left: sharp?.pct_game_left ?? prior?.pct_game_left ?? null,
        sharp:     sharp ?? prior?.sharp ?? null,
        retail:    retail ?? prior?.retail ?? null,
        prediction: pred ?? prior?.prediction ?? null,
      })
    }
    for (const s of fan.sharp)      upsert(s, null, null)
    for (const r of fan.retail)     upsert(null, r, null)
    for (const p of fan.prediction) upsert(null, null, p)
    return games
  }

  private async persistGame(game: AlignedGame, league: League): Promise<void> {
    const homeTeamId = await getOrCreateTeamId(this.db, { ...game.home, league })
    const awayTeamId = await getOrCreateTeamId(this.db, { ...game.away, league })
    const gameId = buildGameId(league, game.tipoff_at, game.away, game.home)

    await this.db.query(
      `INSERT INTO sports_games (game_id, league, home_team_id, away_team_id, tipoff_at, status, pct_game_left, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (game_id) DO UPDATE
           SET status        = EXCLUDED.status,
               pct_game_left = EXCLUDED.pct_game_left,
               updated_at    = NOW()`,
      [gameId, league, homeTeamId, awayTeamId, game.tipoff_at, game.status, game.pct_game_left],
    )

    const sides: Array<{ side: Side; teamId: string }> = [
      { side: 'home', teamId: homeTeamId },
      { side: 'away', teamId: awayTeamId },
    ]
    const leadSide = pickLeadSide(game)

    for (const { side, teamId } of sides) {
      const isLead = side === leadSide
      const inputs = await this.scoreSide(side, teamId, game, isLead, league)
      await this.recordSignal(gameId, teamId, 'composite', inputs.composite, inputs)
      await this.upsertView(gameId, teamId, isLead, inputs, game.pct_game_left ?? null)
    }
  }

  private async scoreSide(
    side: Side,
    teamId: string,
    game: AlignedGame,
    isLead: boolean,
    league: League,
  ): Promise<ScoredSide> {
    const sharp = game.sharp
    const retail = game.retail
    const pred = game.prediction

    const overround = pred ? overroundScore({ overround_pct: pred.overround_pct }) : null
    const consensus = pred ? consensusScore({
      overround_1to10: overround ?? 1,
      is_lead_team:    isLead,
      data_points:     2,
    }) : null

    const steam = sharp && sharp.prev_sharp_cents
      ? steamScore({
          delta_cents: Math.abs(sharp.sharp_cents[side] - sharp.prev_sharp_cents[side]) / 100,
          elapsed_ms:  Date.parse(sharp.observed_at) - Date.parse(sharp.prev_sharp_cents.observed_at),
        })
      : null

    const delta = sharp && retail
      ? deltaScore({ gap_cents: (retail.retail_cents[side] - sharp.sharp_cents[side]) / 100 })
      : null

    const public_gravity = sharp && retail
      ? publicGravityScore({
          parlay_line:     retail.retail_cents[side] / 100,
          api_sports_line: sharp.sharp_cents[side] / 100,
        })
      : null

    const whale = retail && retail.money_pct[side] != null && retail.ticket_pct[side] != null
      ? whaleScore({ money_pct: retail.money_pct[side]!, ticket_pct: retail.ticket_pct[side]! })
      : null

    const lock = sharp && retail
      ? lockScore({
          retail_cents:     retail.retail_cents[side],
          sharp_fair_cents: sharp.fair_value_cents[side],
          vig_cents:        sharp.vig_cents,
        })
      : null

    const lead_pct = isLead && game.pct_game_left != null
      ? await this.computeLeadPct(game.sharp ? buildGameId(league, game.tipoff_at, game.away, game.home) : null, teamId)
      : null

    const sma10 = await sma10Score(this.db, teamId)

    const composite = compositeScore({
      overround, consensus, steam, delta, public_gravity, whale, lock, lead_pct, sma10,
    })

    return { overround, consensus, steam, delta, public_gravity, whale, lock, lead_pct, sma10, composite }
  }

  private async computeLeadPct(gameId: string | null, teamId: string): Promise<number | null> {
    if (!gameId) return null
    const { rows } = await this.db.query<{ e_lead: string; e_total: string; during_pull: boolean }>(
      `SELECT
          COUNT(*) FILTER (WHERE team_in_lead AND team_id = $2) AS e_lead,
          COUNT(*) AS e_total,
          COALESCE(BOOL_OR(during_pull) FILTER (WHERE team_id = $2), FALSE) AS during_pull
         FROM sports_game_events
         WHERE game_id = $1`,
      [gameId, teamId],
    )
    const row = rows[0]
    if (!row || Number(row.e_total) === 0) return null
    return leadPctScore({
      e_lead:      Number(row.e_lead),
      e_total:     Number(row.e_total),
      during_pull: row.during_pull,
    })
  }

  private async recordSignal(gameId: string, teamId: string, metric: string, score: number, inputs: object) {
    await this.db.query(
      `INSERT INTO sports_signals (game_id, team_id, metric, score, inputs)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [gameId, teamId, metric, score, JSON.stringify(inputs)],
    )
  }

  private async upsertView(
    gameId: string,
    teamId: string,
    isLead: boolean,
    s: ScoredSide,
    pctGameLeft: number | null,
  ): Promise<void> {
    const tier = toColorTier(s.composite)
    await this.db.query(
      `INSERT INTO sports_game_view (
          game_id, team_id, is_lead_team,
          overround_1to10, consensus_1to10, pct_game_left, lead_pct,
          sma10_1to10, steam_1to10, delta_1to10,
          composite_1to10, color_tier, updated_at
       ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW()
       )
       ON CONFLICT (game_id, team_id) DO UPDATE SET
          is_lead_team    = EXCLUDED.is_lead_team,
          overround_1to10 = EXCLUDED.overround_1to10,
          consensus_1to10 = EXCLUDED.consensus_1to10,
          pct_game_left   = EXCLUDED.pct_game_left,
          lead_pct        = EXCLUDED.lead_pct,
          sma10_1to10     = EXCLUDED.sma10_1to10,
          steam_1to10     = EXCLUDED.steam_1to10,
          delta_1to10     = EXCLUDED.delta_1to10,
          composite_1to10 = EXCLUDED.composite_1to10,
          color_tier      = EXCLUDED.color_tier,
          updated_at      = NOW()`,
      [
        gameId, teamId, isLead,
        s.overround, s.consensus, pctGameLeft, fractionFromLeadScore(s.lead_pct),
        s.sma10, s.steam, s.delta,
        s.composite, tier,
      ],
    )
  }
}

type AlignedGame = {
  home:           { city: string; name: string }
  away:           { city: string; name: string }
  tipoff_at:      string
  status:         'scheduled' | 'live' | 'final'
  pct_game_left:  number | null
  sharp:          ApiSportsSnapshot | null
  retail:         ParlaySnapshot | null
  prediction:     ProphetXSnapshot | null
}

type ScoredSide = {
  overround:      number | null
  consensus:      number | null
  steam:          number | null
  delta:          number | null
  public_gravity: number | null
  whale:          number | null
  lock:           number | null
  lead_pct:       number | null
  sma10:          number | null
  composite:      number
}

function matchupKey(home: { city: string; name: string }, away: { city: string; name: string }): string {
  return `${slug(away.city)}_${slug(away.name)}_at_${slug(home.city)}_${slug(home.name)}`
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function buildGameId(
  league: string,
  tipoff: string,
  away: { city: string; name: string },
  home: { city: string; name: string },
): string {
  const ymd = tipoff.slice(0, 10).replace(/-/g, '')
  return `${league}_${ymd}_${slug(away.name)}_${slug(home.name)}`
}

// Pick a "lead team" deterministically: ProphetX's higher implied prob, or
// (fallback) API-Sports' more-negative sharp side. If neither feed is
// present, default to home.
function pickLeadSide(game: AlignedGame): Side {
  if (game.prediction) {
    return game.prediction.implied_prob.home >= game.prediction.implied_prob.away ? 'home' : 'away'
  }
  if (game.sharp) {
    return game.sharp.sharp_cents.home <= game.sharp.sharp_cents.away ? 'home' : 'away'
  }
  return 'home'
}

// The view stores lead_pct as the 0..1 fraction; lead_pct_score is the
// 1..10. Translate back so the column matches the schema's intent.
function fractionFromLeadScore(score: number | null): number | null {
  if (score == null) return null
  return Math.min(0.99, Math.max(0.01, score / 10))
}
