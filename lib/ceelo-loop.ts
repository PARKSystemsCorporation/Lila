import type { PoolClient } from 'pg'
import { cfg } from './config'
import * as Espn from './ceelo/espn'
import * as Odds from './ceelo/odds'
import { applyGame, modelLine, DEFAULT_RATING } from './ceelo/ratings'
import { NFL_TEAMS } from './ceelo/teams'

// ── Ceelo: NFL handicapper, autonomy loop ─────────────────────────────────
//
// Math-driven model on a 30-min cycle. Each cycle does up to six
// idempotent steps; each step is internally time-gated so we don't pound
// upstream sources.
//
//   C0 — Refresh schedule from ESPN (≤ once per 60 min).
//   C1 — Apply newly-completed games to Elo ratings (always).
//   C2 — Pull current book lines (≤ once per CEELO_ODDS_REFRESH_MIN).
//        Stubbed until ODDS_API_KEY is set.
//   C3 — Compute model spread/win-prob per upcoming game (always; cheap).
//   C4 — Diff model vs market lines; emit a pick when |edge| ≥ 1.0 pt.
//        No-op until C2 has data.
//   C5 — Reconcile: cancel open picks whose game has kicked off or whose
//        line has moved past the edge.
//
// LLM is NOT in the picks path. Reasoning text is auto-generated from
// the math; that keeps picks deterministic and cheap.

const ODDS_REFRESH_MIN  = 30
const SCHEDULE_REFRESH_MIN = 60
const EDGE_THRESHOLD_PTS = 1.0

export class CeeloLoop {
  private db: PoolClient

  constructor(db: PoolClient) {
    this.db = db
  }

  async shouldRun(): Promise<boolean> {
    const { rows: [s] } = await this.db.query('SELECT last_run_at FROM ceelo_state WHERE id=1')
    if (!s?.last_run_at) return true
    return (Date.now() - new Date(s.last_run_at).getTime()) / 60_000 >= cfg.CEELO_RUN_MIN
  }

  async run(): Promise<{ logMessage: string; logType: 'info' | 'success' | 'warn' } | null> {
    if (!(await this.shouldRun())) return null

    const notes: string[] = []
    let warned = false
    const note = (msg: string) => { if (msg) notes.push(msg) }

    try { note(await this.c0_refreshSchedule()) }   catch (e) { warned = true; note(`C0 ${err(e)}`) }
    try { note(await this.c1_gradeFinals()) }       catch (e) { warned = true; note(`C1 ${err(e)}`) }
    try { note(await this.c2_pullBookLines()) }     catch (e) { warned = true; note(`C2 ${err(e)}`) }
    try { note(await this.c3_computeModelLines()) } catch (e) { warned = true; note(`C3 ${err(e)}`) }
    try { note(await this.c4_emitPicks()) }         catch (e) { warned = true; note(`C4 ${err(e)}`) }
    try { note(await this.c5_reconcile()) }         catch (e) { warned = true; note(`C5 ${err(e)}`) }

    await this.db.query(
      `UPDATE ceelo_state SET last_run_at=NOW(), cycle=cycle+1, updated_at=NOW() WHERE id=1`
    )

    const msg = notes.join(' · ') || 'Ceelo: idle (no upcoming games).'
    return { logMessage: `Ceelo — ${msg}`, logType: warned ? 'warn' : 'info' }
  }

  // ── C0: refresh schedule ────────────────────────────────────────────────

  private async c0_refreshSchedule(): Promise<string> {
    const { rows: [s] } = await this.db.query('SELECT last_schedule_at FROM ceelo_state WHERE id=1')
    if (s?.last_schedule_at && minutesSince(s.last_schedule_at) < SCHEDULE_REFRESH_MIN) return ''

    let games: Espn.EspnGame[] = []
    try {
      games = await Espn.fetchCurrent()
    } catch (e) {
      return `C0 ESPN error: ${String(e).slice(0, 120)}`
    }

    let upserted = 0
    for (const g of games) {
      // Sanity: only ingest games where both teams normalized to known abbrs.
      if (!NFL_TEAMS.has(g.home_team) || !NFL_TEAMS.has(g.away_team)) continue
      await this.db.query(
        `INSERT INTO ceelo_games
           (espn_id, season, week, season_type, home_team, away_team, kickoff_at,
            status, home_score, away_score, neutral_site, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
         ON CONFLICT (espn_id) DO UPDATE
           SET status=EXCLUDED.status,
               home_score=EXCLUDED.home_score,
               away_score=EXCLUDED.away_score,
               kickoff_at=EXCLUDED.kickoff_at,
               updated_at=NOW()`,
        [g.espn_id, g.season, g.week, g.season_type, g.home_team, g.away_team,
         g.kickoff_at, g.status, g.home_score, g.away_score, g.neutral_site]
      )
      upserted++
    }

    await this.db.query(
      `UPDATE ceelo_state SET last_schedule_at=NOW() WHERE id=1`
    )
    return upserted > 0 ? `C0 ${upserted} games` : 'C0 no games'
  }

  // ── C1: apply newly-completed games to Elo ratings ──────────────────────

  private async c1_gradeFinals(): Promise<string> {
    const { rows } = await this.db.query(
      `SELECT id, home_team, away_team, home_score, away_score, neutral_site, kickoff_at
       FROM ceelo_games
       WHERE status='final'
         AND graded_at IS NULL
         AND home_score IS NOT NULL
         AND away_score IS NOT NULL
       ORDER BY kickoff_at ASC
       LIMIT 100`
    )
    if (!rows.length) return ''

    let graded = 0
    for (const g of rows) {
      const homeR = await this.getRating(g.home_team)
      const awayR = await this.getRating(g.away_team)
      const upd = applyGame({
        homeRating: homeR,
        awayRating: awayR,
        homeScore: Number(g.home_score),
        awayScore: Number(g.away_score),
        neutralSite: Boolean(g.neutral_site),
      })
      await this.upsertRating(g.home_team, upd.homeNew, g.kickoff_at)
      await this.upsertRating(g.away_team, upd.awayNew, g.kickoff_at)
      await this.db.query(
        `UPDATE ceelo_games SET graded_at=NOW(), updated_at=NOW() WHERE id=$1`,
        [g.id]
      )
      graded++
    }
    await this.db.query(`UPDATE ceelo_state SET last_grade_at=NOW() WHERE id=1`)
    return `C1 graded ${graded}`
  }

  // ── C2: pull current book lines (stubbed until ODDS_API_KEY) ────────────

  private async c2_pullBookLines(): Promise<string> {
    if (!Odds.isConfigured()) return ''   // silent — expected pre-key

    const { rows: [s] } = await this.db.query('SELECT last_lines_at FROM ceelo_state WHERE id=1')
    if (s?.last_lines_at && minutesSince(s.last_lines_at) < ODDS_REFRESH_MIN) return ''

    const lines = await Odds.fetchNflLines()
    let stored = 0
    for (const l of lines) {
      // Match on (home, away, kickoff) since the Odds API doesn't share ESPN's id.
      const { rows: [g] } = await this.db.query(
        `SELECT id FROM ceelo_games
         WHERE home_team=$1 AND away_team=$2
           AND kickoff_at BETWEEN $3::timestamptz - INTERVAL '6 hours'
                              AND $3::timestamptz + INTERVAL '6 hours'
         ORDER BY ABS(EXTRACT(EPOCH FROM (kickoff_at - $3::timestamptz)))
         LIMIT 1`,
        [l.home_team, l.away_team, l.kickoff_at]
      )
      if (!g) continue
      await this.db.query(
        `INSERT INTO ceelo_lines
           (game_id, book, market, home_line, total_line,
            home_odds, away_odds, over_odds, under_odds, fetched_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())`,
        [g.id, l.book, l.market, l.home_line, l.total_line,
         l.home_odds, l.away_odds, l.over_odds, l.under_odds]
      )
      stored++
    }
    await this.db.query(`UPDATE ceelo_state SET last_lines_at=NOW() WHERE id=1`)
    return stored > 0 ? `C2 ${stored} lines` : ''
  }

  // ── C3: compute model lines for upcoming games ──────────────────────────

  private async c3_computeModelLines(): Promise<string> {
    const { rows } = await this.db.query(
      `SELECT id, home_team, away_team, neutral_site
       FROM ceelo_games
       WHERE status='scheduled'
         AND kickoff_at > NOW()
         AND kickoff_at < NOW() + INTERVAL '14 days'
       ORDER BY kickoff_at ASC LIMIT 64`
    )
    if (!rows.length) return ''

    let computed = 0
    for (const g of rows) {
      const homeR = await this.getRating(g.home_team)
      const awayR = await this.getRating(g.away_team)
      const m = modelLine({
        homeRating: homeR,
        awayRating: awayR,
        neutralSite: Boolean(g.neutral_site),
      })
      await this.db.query(
        `INSERT INTO ceelo_model_lines (game_id, model_spread, model_home_prob, computed_at)
         VALUES ($1,$2,$3,NOW())
         ON CONFLICT (game_id) DO UPDATE
           SET model_spread=EXCLUDED.model_spread,
               model_home_prob=EXCLUDED.model_home_prob,
               computed_at=NOW()`,
        [g.id, m.modelSpread, m.modelHomeProb]
      )
      computed++
    }
    return `C3 ${computed} model`
  }

  // ── C4: diff model vs market, emit picks when |edge| ≥ threshold ────────

  private async c4_emitPicks(): Promise<string> {
    if (!Odds.isConfigured()) return ''   // can't gate without market lines

    // Latest spread per (game, book), joined with model line.
    const { rows } = await this.db.query(
      `WITH latest AS (
         SELECT DISTINCT ON (game_id, book)
                game_id, book, home_line, fetched_at
         FROM ceelo_lines
         WHERE market='spread' AND home_line IS NOT NULL
         ORDER BY game_id, book, fetched_at DESC
       )
       SELECT g.id AS game_id, g.home_team, g.away_team, g.kickoff_at,
              m.model_spread, m.model_home_prob,
              l.book, l.home_line AS book_spread
       FROM ceelo_games g
       JOIN ceelo_model_lines m ON m.game_id = g.id
       JOIN latest l            ON l.game_id = g.id
       WHERE g.status='scheduled' AND g.kickoff_at > NOW() + INTERVAL '15 minutes'`
    )
    if (!rows.length) return ''

    let inserted = 0
    for (const r of rows) {
      const model = Number(r.model_spread)
      const book  = Number(r.book_spread)
      const edge  = +(book - model).toFixed(2)   // positive ⇒ home undervalued ⇒ take HOME
      if (Math.abs(edge) < EDGE_THRESHOLD_PTS) continue

      const takeHome = edge > 0
      const side = takeHome
        ? `${r.home_team} ${fmtSpread(book)}`
        : `${r.away_team} ${fmtSpread(-book)}`
      const game_label = `${r.away_team} @ ${r.home_team}`

      // Skip if we already have an open pick on this exact game/market/side.
      const dup = await this.db.query(
        `SELECT 1 FROM ceelo_picks
         WHERE game_id=$1 AND market='spread' AND side=$2 AND status IN ('open','taken')
         LIMIT 1`,
        [r.game_id, side]
      )
      if (dup.rows.length > 0) continue

      const conf = Math.abs(edge) >= 2.5 ? 'high' : Math.abs(edge) >= 1.5 ? 'medium' : 'low'
      const reasoning = `Model ${fmtSpread(model)} (home), book ${fmtSpread(book)} from ${r.book}. Edge ${Math.abs(edge).toFixed(1)} pts toward ${takeHome ? 'home' : 'away'}.`

      await this.db.query(
        `INSERT INTO ceelo_picks
           (sport, game_id, game_label, kickoff_at, market, side,
            model_prob, model_spread, book_spread, book_name,
            edge_points, fair_line, min_odds, edge_pct,
            reasoning, confidence, status, source)
         VALUES ('NFL',$1,$2,$3,'spread',$4,$5,$6,$7,$8,$9,$10,-110,NULL,$11,$12,'open','model')`,
        [
          r.game_id, game_label, r.kickoff_at, side,
          takeHome ? Number(r.model_home_prob) : +(1 - Number(r.model_home_prob)).toFixed(3),
          model, book, r.book, Math.abs(edge),
          fmtSpread(model), reasoning, conf,
        ]
      )
      inserted++
    }
    return inserted > 0 ? `C4 ${inserted} picks` : ''
  }

  // ── C5: reconcile open picks (stale lines, kicked-off games) ────────────

  private async c5_reconcile(): Promise<string> {
    // Cancel open picks for games that have already started.
    const started = await this.db.query(
      `UPDATE ceelo_picks SET status='void', updated_at=NOW(), settled_at=NOW()
       WHERE status='open' AND game_id IS NOT NULL
         AND game_id IN (
           SELECT id FROM ceelo_games
           WHERE status IN ('in_progress','final')
         )
       RETURNING id`
    )
    return started.rowCount ? `C5 voided ${started.rowCount} (kicked off)` : ''
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private async getRating(team: string): Promise<number> {
    const { rows: [r] } = await this.db.query(
      `SELECT rating FROM ceelo_team_ratings WHERE team=$1`, [team]
    )
    return r ? Number(r.rating) : DEFAULT_RATING
  }

  private async upsertRating(team: string, rating: number, lastGameAt: string): Promise<void> {
    await this.db.query(
      `INSERT INTO ceelo_team_ratings (team, rating, games_played, last_game_at, updated_at)
       VALUES ($1,$2,1,$3,NOW())
       ON CONFLICT (team) DO UPDATE
         SET rating=EXCLUDED.rating,
             games_played=ceelo_team_ratings.games_played + 1,
             last_game_at=GREATEST(ceelo_team_ratings.last_game_at, EXCLUDED.last_game_at),
             updated_at=NOW()`,
      [team, rating, lastGameAt]
    )
  }
}

// ── helpers (free) ───────────────────────────────────────────────────────

function minutesSince(ts: Date | string): number {
  const t = typeof ts === 'string' ? new Date(ts).getTime() : ts.getTime()
  return (Date.now() - t) / 60_000
}

function err(e: unknown): string {
  return String(e instanceof Error ? e.message : e).slice(0, 120)
}

// Format a home spread. Negative = home favored.
//   -3.5 → "-3.5"
//    2.5 → "+2.5"
function fmtSpread(s: number): string {
  if (s === 0) return 'PK'
  return s > 0 ? `+${s.toFixed(1)}` : s.toFixed(1)
}

// American-odds payout calc — exposed so the picks API uses the same math.
// Returns NET profit on a winning bet (does not include stake).
export function netProfit(stake: number, odds: number): number {
  if (odds < 0) return +(stake * (100 / Math.abs(odds))).toFixed(2)
  return +(stake * (odds / 100)).toFixed(2)
}
