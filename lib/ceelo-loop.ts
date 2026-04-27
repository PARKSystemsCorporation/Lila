import OpenAI from 'openai'
import type { PoolClient } from 'pg'
import { cfg } from './config'
import { llmCall, LLMBudgetExceeded } from './llm'
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
  private ai: OpenAI | null

  constructor(db: PoolClient) {
    this.db = db
    this.ai = process.env.DEEPSEEK_API_KEY
      ? new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com/v1' })
      : null
  }

  async shouldRunCycle(): Promise<boolean> {
    const { rows: [s] } = await this.db.query('SELECT last_run_at FROM ceelo_state WHERE id=1')
    if (!s?.last_run_at) return true
    return (Date.now() - new Date(s.last_run_at).getTime()) / 60_000 >= cfg.CEELO_RUN_MIN
  }

  // Runs every tick. Chat handling is fast and ungated; the heavy data
  // cycle (C0-C5) only runs when CEELO_RUN_MIN has elapsed.
  async run(): Promise<{ logMessage: string; logType: 'info' | 'success' | 'warn' } | null> {
    const chatMsg = await this.handleChat().catch((e) => `chat err: ${err(e)}`)
    const cycleMsg = (await this.shouldRunCycle()) ? await this.runCycle() : null

    if (cycleMsg) {
      // Cycle log wins when it fires; chat reply (if any) is logged inline.
      const merged = chatMsg
        ? `${cycleMsg.logMessage} · ${chatMsg}`
        : cycleMsg.logMessage
      return { ...cycleMsg, logMessage: merged }
    }
    if (chatMsg) return { logMessage: `Ceelo — ${chatMsg}`, logType: 'info' }
    return null
  }

  private async runCycle(): Promise<{ logMessage: string; logType: 'info' | 'success' | 'warn' }> {
    const notes: string[] = []
    let warned = false
    const note = (msg: string) => { if (msg) notes.push(msg) }

    let gradedSummary = ''
    let edgeSummary   = ''

    try { note(await this.c0_refreshSchedule()) }                     catch (e) { warned = true; note(`C0 ${err(e)}`) }
    try { note(await this.c0b_refreshInjuries()) }                    catch (e) { warned = true; note(`C0b ${err(e)}`) }
    try { note(await this.c0c_autoSeed()) }                           catch (e) { warned = true; note(`C0c ${err(e)}`) }
    try { note(await this.c0d_refreshRosters()) }                     catch (e) { warned = true; note(`C0d ${err(e)}`) }
    try { gradedSummary = await this.c1_gradeFinals(); note(gradedSummary) } catch (e) { warned = true; note(`C1 ${err(e)}`) }
    try { note(await this.c2_pullBookLines()) }                       catch (e) { warned = true; note(`C2 ${err(e)}`) }
    try { note(await this.c3_computeModelLines()) }                   catch (e) { warned = true; note(`C3 ${err(e)}`) }
    try { edgeSummary = await this.c4_emitPicks(); note(edgeSummary) } catch (e) { warned = true; note(`C4 ${err(e)}`) }
    try { note(await this.c5_reconcile()) }                           catch (e) { warned = true; note(`C5 ${err(e)}`) }

    // File a Ceelo note with the cycle outcome — gives the operator a
    // human-readable trace in the Library tab.
    if (gradedSummary || edgeSummary) {
      await this.fileCycleNote(gradedSummary, edgeSummary).catch(() => {})
    }

    await this.db.query(
      `UPDATE ceelo_state SET last_run_at=NOW(), cycle=cycle+1, updated_at=NOW() WHERE id=1`
    )

    const msg = notes.filter(Boolean).join(' · ') || 'idle (no upcoming games)'
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

  // ── C0b: refresh injury report (≤ once per 12h, per team) ───────────────

  private async c0b_refreshInjuries(): Promise<string> {
    const { rows: [s] } = await this.db.query('SELECT last_injury_at FROM ceelo_state WHERE id=1')
    if (s?.last_injury_at && minutesSince(s.last_injury_at) < 12 * 60) return ''

    // Only pull for teams with upcoming games — no point updating bye-week
    // teams every cycle. Falls back to all 32 teams if the schedule is empty.
    const { rows: teamRows } = await this.db.query(
      `SELECT DISTINCT t FROM (
         SELECT home_team AS t FROM ceelo_games
         WHERE status='scheduled' AND kickoff_at BETWEEN NOW() AND NOW() + INTERVAL '14 days'
         UNION
         SELECT away_team AS t FROM ceelo_games
         WHERE status='scheduled' AND kickoff_at BETWEEN NOW() AND NOW() + INTERVAL '14 days'
       ) x`
    )
    const teams: string[] = teamRows.length
      ? teamRows.map((r: { t: string }) => r.t).filter(Boolean)
      : Array.from(NFL_TEAMS)

    let total = 0
    for (const team of teams) {
      const list = await Espn.fetchTeamInjuries(team).catch(() => [] as Espn.InjuryEntry[])
      // Wipe existing rows for this team, then insert fresh.
      await this.db.query(`DELETE FROM ceelo_injuries WHERE team=$1`, [team])
      for (const i of list) {
        await this.db.query(
          `INSERT INTO ceelo_injuries (team, player, position, status, description, fetched_at)
           VALUES ($1,$2,$3,$4,$5,NOW())
           ON CONFLICT (team, player) DO UPDATE
             SET position=EXCLUDED.position,
                 status=EXCLUDED.status,
                 description=EXCLUDED.description,
                 fetched_at=NOW()`,
          [i.team, i.player, i.position, i.status, i.description]
        )
        total++
      }
    }
    await this.db.query(`UPDATE ceelo_state SET last_injury_at=NOW() WHERE id=1`)
    return total > 0 ? `C0b ${total} injuries` : ''
  }

  // ── C0d: refresh rosters (≤ once per 7 days, per team) ──────────────────

  private async c0d_refreshRosters(): Promise<string> {
    const { rows: [s] } = await this.db.query('SELECT last_roster_at FROM ceelo_state WHERE id=1')
    if (s?.last_roster_at && minutesSince(s.last_roster_at) < 7 * 24 * 60) return ''

    // Refresh teams with upcoming games first; if nothing scheduled, hit
    // all 32 (offseason rosters are still useful for chat answers).
    const { rows: teamRows } = await this.db.query(
      `SELECT DISTINCT t FROM (
         SELECT home_team AS t FROM ceelo_games
         WHERE status='scheduled' AND kickoff_at BETWEEN NOW() AND NOW() + INTERVAL '21 days'
         UNION
         SELECT away_team AS t FROM ceelo_games
         WHERE status='scheduled' AND kickoff_at BETWEEN NOW() AND NOW() + INTERVAL '21 days'
       ) x`
    )
    const teams: string[] = teamRows.length
      ? teamRows.map((r: { t: string }) => r.t).filter(Boolean)
      : Array.from(NFL_TEAMS)

    let total = 0
    for (const team of teams) {
      const list = await Espn.fetchTeamRoster(team).catch(() => [] as Espn.RosterEntry[])
      if (!list.length) continue
      // Wipe team's existing roster, then insert fresh.
      await this.db.query(`DELETE FROM ceelo_rosters WHERE team=$1`, [team])
      for (const r of list) {
        await this.db.query(
          `INSERT INTO ceelo_rosters (team, player, position, jersey, height, weight, experience, college, fetched_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
           ON CONFLICT (team, player) DO UPDATE
             SET position=EXCLUDED.position,
                 jersey=EXCLUDED.jersey,
                 height=EXCLUDED.height,
                 weight=EXCLUDED.weight,
                 experience=EXCLUDED.experience,
                 college=EXCLUDED.college,
                 fetched_at=NOW()`,
          [r.team, r.player, r.position, r.jersey, r.height, r.weight, r.experience, r.college]
        )
        total++
      }
    }
    await this.db.query(`UPDATE ceelo_state SET last_roster_at=NOW() WHERE id=1`)
    return total > 0 ? `C0d ${total} roster` : ''
  }

  // ── C0c: auto-seed historical data if empty ─────────────────────────────

  private async c0c_autoSeed(): Promise<string> {
    const { rows: [{ count }] } = await this.db.query(
      `SELECT COUNT(*) as count FROM ceelo_team_ratings`
    )
    if (Number(count) > 0) return ''

    // No teams rated! Let's auto-seed the database using the same logic as the API.
    // We fetch to localhost since this runs within the node server context,
    // but the safest approach is to hit the internal logic. Wait, this is a local loop.
    // We can just call the POST /api/ceelo/seed endpoint via localhost.
    try {
      const res = await fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/api/ceelo/seed?seasons=3', { method: 'POST' })
      if (!res.ok) throw new Error(`Status ${res.status}`)
      const data = await res.json()
      return `C0c auto-seeded ${data.games_graded} games`
    } catch (e) {
      return `C0c auto-seed failed: ${err(e)}`
    }
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

      // Emit a real-time broadcast alert for the operator
      const alertMsg = `🚨 Ceelo Edge Alert\n${game_label} — ${side}\n\nModel: ${fmtSpread(model)}\nBook: ${fmtSpread(book)} (${r.book})\nEdge: ${Math.abs(edge).toFixed(1)} pts (${conf})`
      await this.db.query(
        `INSERT INTO broadcasts (channel, content, status, scheduled_publish_at)
         VALUES ('telegram', $1, 'pending_publish', NOW())`,
        [alertMsg]
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

  // ── chat: one-on-one with the operator (thread='ceelo') ─────────────────

  private async handleChat(): Promise<string> {
    if (!this.ai) return ''

    // Find the latest user message. If a ceelo reply already exists after
    // it, we've already responded.
    const { rows: latest } = await this.db.query(
      `SELECT id, sender, content
       FROM chat_messages
       WHERE thread='ceelo'
       ORDER BY id DESC LIMIT 1`
    )
    if (!latest.length) return ''
    const last = latest[0]
    if (last.sender !== 'user') return ''

    // Pull last 10 messages for context (oldest → newest).
    const { rows: history } = await this.db.query(
      `SELECT sender, content
       FROM chat_messages
       WHERE thread='ceelo'
       ORDER BY id DESC LIMIT 10`
    )
    const transcript = history
      .reverse()
      .map((m: { sender: string; content: string }) => `[${m.sender.toUpperCase()}]: ${m.content}`)
      .join('\n')

    // Snapshot of Ceelo's current world: top-rated teams, open picks, freshness.
    const [topRated, openPicks, status, keyInjuries] = await Promise.all([
      this.db.query(
        `SELECT team, rating, games_played FROM ceelo_team_ratings
         WHERE games_played > 0
         ORDER BY rating DESC LIMIT 8`
      ),
      this.db.query(
        `SELECT game_label, market, side, model_spread, book_spread, edge_points, confidence
         FROM ceelo_picks
         WHERE status='open'
         ORDER BY ABS(COALESCE(edge_points, 0)) DESC LIMIT 6`
      ),
      this.db.query(
        `SELECT cycle,
                (SELECT COUNT(*) FROM ceelo_team_ratings WHERE games_played > 0) AS rated,
                (SELECT COUNT(*) FROM ceelo_games WHERE status='scheduled' AND kickoff_at > NOW()) AS upcoming,
                (SELECT COUNT(*) FROM ceelo_injuries WHERE status IN ('Out','Doubtful','IR')) AS hurt,
                (SELECT COUNT(*) FROM ceelo_games WHERE status='final' AND closing_spread IS NOT NULL) AS historical_with_lines,
                (SELECT COUNT(*) FROM ceelo_games WHERE status='final' AND graded_at IS NOT NULL) AS historical_graded,
                (SELECT MIN(season) FROM ceelo_games WHERE graded_at IS NOT NULL) AS oldest_season,
                (SELECT MAX(season) FROM ceelo_games WHERE graded_at IS NOT NULL) AS newest_season,
                (SELECT COUNT(*) FROM ceelo_rosters) AS rostered_players,
                (SELECT COUNT(DISTINCT team) FROM ceelo_rosters) AS rostered_teams,
                (SELECT COUNT(*) FROM ceelo_lines) AS live_book_lines
         FROM ceelo_state WHERE id=1`
      ),
      // Surface key injuries — Out / Doubtful / IR — for teams with upcoming games.
      // Caps at 12 entries; the LLM doesn't need every depth-chart-3 sprained ankle.
      this.db.query(
        `SELECT i.team, i.player, i.position, i.status
         FROM ceelo_injuries i
         WHERE i.status IN ('Out','Doubtful','IR','PUP')
           AND i.team IN (
             SELECT DISTINCT t FROM (
               SELECT home_team AS t FROM ceelo_games
               WHERE status='scheduled' AND kickoff_at BETWEEN NOW() AND NOW() + INTERVAL '14 days'
               UNION
               SELECT away_team AS t FROM ceelo_games
               WHERE status='scheduled' AND kickoff_at BETWEEN NOW() AND NOW() + INTERVAL '14 days'
             ) x
           )
         ORDER BY
           CASE i.position
             WHEN 'QB' THEN 0
             WHEN 'RB' THEN 1
             WHEN 'WR' THEN 1
             WHEN 'TE' THEN 2
             ELSE 3
           END,
           i.team
         LIMIT 12`
      ),
    ])

    const topRatedStr = topRated.rows.length
      ? topRated.rows.map((r: { team: string; rating: string; games_played: number }) =>
          `${r.team} ${Number(r.rating).toFixed(0)} (${r.games_played}g)`
        ).join(', ')
      : '(none yet — Elo cold-start)'
    const openPicksStr = openPicks.rows.length
      ? openPicks.rows.map((p: { game_label: string; side: string; model_spread: string | null; book_spread: string | null; edge_points: string | null; confidence: string }) => {
          const m = p.model_spread != null ? Number(p.model_spread).toFixed(1) : '?'
          const b = p.book_spread  != null ? Number(p.book_spread).toFixed(1)  : '?'
          const e = p.edge_points  != null ? Number(p.edge_points).toFixed(1)  : '?'
          return `${p.side} (${p.game_label}) — model ${m}, book ${b}, edge ${e}pt [${p.confidence}]`
        }).join('\n  ')
      : '(no open picks)'
    const s = status.rows[0] ?? {}

    const injuryStr = keyInjuries.rows.length
      ? keyInjuries.rows.map((i: { team: string; player: string; position: string | null; status: string }) =>
          `${i.team} ${i.player} (${i.position ?? '?'}) — ${i.status}`
        ).join('\n  ')
      : '(no key injuries on tracked teams)'

    const oldestSeason = s.oldest_season != null ? Number(s.oldest_season) : null
    const newestSeason = s.newest_season != null ? Number(s.newest_season) : null
    const seasonRange = oldestSeason && newestSeason
      ? (oldestSeason === newestSeason ? `${oldestSeason}` : `${oldestSeason}-${newestSeason}`)
      : 'none'

    const prompt = `You are Ceelo, the NFL handicapper on Lila's team. The operator is talking to you one-on-one.

Voice: dry, sharp, numbers-first. Short replies (1-3 sentences usually). No exclamation points. No hype. Be CONFIDENT about what you have — don't undersell. Only say you're missing data if it's literally not in the inventory below.

DATA YOU ACTUALLY HAVE (use it — these are real, queried just now):
- 32-team Elo ratings: ${Number(s.rated ?? 0)}/32 walked from real completed games (regular + postseason).
- Historical games graded: ${Number(s.historical_graded ?? 0)} across seasons ${seasonRange}.
- Historical closing spreads + closing totals: ${Number(s.historical_with_lines ?? 0)} games. (Source: nflverse — same dataset 538 / professional shops use.) These ARE the historical Vegas lines.
- Current schedule + final scores from ESPN (refreshed hourly).
- Current rosters: ${Number(s.rostered_players ?? 0)} players across ${Number(s.rostered_teams ?? 0)} teams (ESPN, refreshed weekly).
- Active injury reports: ${Number(s.hurt ?? 0)} Out/Doubtful/IR/PUP entries on tracked teams.
- Live book lines for upcoming games: ${Number(s.live_book_lines ?? 0)} entries (${Odds.isConfigured() ? 'Odds API ENGAGED — edge gate active' : 'Odds API NOT engaged — no live book lines, edge gate dark'}).
- Model-derived spread + win-prob per upcoming game (computed each cycle from the Elo ratings).

DATA YOU DO NOT HAVE (don't pretend you do):
- Play-by-play / EPA-level data. (Could be added via nflverse pbp parquet later.)
- Depth chart starter ranks. (Have rosters but not depth order.)
- Coaching tendencies, weather forecasts, ref crews. (Not ingested.)

CURRENT STATE:
- Loop cycle: ${Number(s.cycle ?? 0)}
- Top-rated right now: ${topRatedStr}
- Open picks (model-driven, sorted by edge):
  ${openPicksStr}
- Key injuries on tracked teams:
  ${injuryStr}

When the operator asks "what do you see" or "what do you have", answer concretely from the data inventory above. Don't say "I don't have data" when you have ratings + historical lines + rosters + injuries + a model — that's a complete handicapping kit. Be honest about what's missing (play-by-play, depth charts) but don't sandbag what you have.

CONVERSATION:
${transcript}

Your reply only — no name prefix, no quotes.`

    let reply: string
    try {
      const res = await llmCall({
        ai: this.ai,
        module: 'ceelo.chat',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 260,
        temperature: 0.4,
      })
      reply = res.content.trim().slice(0, 1500)
    } catch (e) {
      if (e instanceof LLMBudgetExceeded) {
        reply = 'On the bench — daily LLM budget hit. Back online tomorrow.'
      } else {
        return `chat err: ${err(e)}`
      }
    }
    if (!reply) return ''

    await this.db.query(
      `INSERT INTO chat_messages (sender, content, thread) VALUES ('ceelo', $1, 'ceelo')`,
      [reply]
    )
    return 'replied to operator'
  }

  // Write a note summarizing the cycle's grading + edge findings.
  private async fileCycleNote(graded: string, edges: string): Promise<void> {
    const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 13)  // YYYYMMDDTHHMM
    const date = new Date().toISOString().slice(0, 10)
    const path = `ceelo/cycles/${date}-${stamp}.md`
    const body = `# Ceelo cycle ${date} ${new Date().toISOString().slice(11, 16)}\n\n` +
                 (graded ? `## Grades\n${graded}\n\n` : '') +
                 (edges  ? `## Edges\n${edges}\n\n`   : '') +
                 `_Loop is autonomous. ${Odds.isConfigured() ? 'Edge gate ARMED.' : 'Edge gate WAITING for ODDS_API_KEY.'}_`
    await this.db.query(
      `INSERT INTO analyst_notes (path, content, updated_at) VALUES ($1,$2,NOW())
       ON CONFLICT (path) DO UPDATE SET content=$2, updated_at=NOW()`,
      [path, body]
    )
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
