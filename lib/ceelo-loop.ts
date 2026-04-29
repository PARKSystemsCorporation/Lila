import OpenAI from 'openai'
import type { PoolClient } from 'pg'
import { cfg } from './config'
import { llmCall, LLMBudgetExceeded } from './llm'
import * as Espn from './ceelo/espn'
import * as Odds from './ceelo/odds'
import * as PublicBets from './ceelo/public-bets'
import * as Nflverse from './ceelo/nflverse'
import { applyGame, modelLine, DEFAULT_RATING, SPORT_CONFIG } from './ceelo/ratings'
import { ALL_SPORTS, NFL_TEAMS, NBA_TEAMS, MLB_TEAMS, NHL_TEAMS, type Sport } from './ceelo/teams'

const TEAM_SET: Record<Sport, ReadonlySet<string>> = {
  NFL: NFL_TEAMS,
  NBA: NBA_TEAMS,
  MLB: MLB_TEAMS,
  NHL: NHL_TEAMS,
}

// Edge threshold per sport (in line points) for C4. NBA needs a wider
// gate because the lines move bigger; MLB run-line edge is tighter.
// NHL puck line is fixed at ±1.5, so the edge gate operates on goal
// differential — a half-goal threshold mirrors MLB's run-line cadence.
const EDGE_PT_BY_SPORT: Record<Sport, number> = {
  NFL: 1.0,
  NBA: 1.5,
  MLB: 0.5,
  NHL: 0.5,
}

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
    try { note(await this.c0e_refreshDepthCharts()) }                 catch (e) { warned = true; note(`C0e ${err(e)}`) }
    try { gradedSummary = await this.c1_gradeFinals(); note(gradedSummary) } catch (e) { warned = true; note(`C1 ${err(e)}`) }
    try { note(await this.c2_pullBookLines()) }                       catch (e) { warned = true; note(`C2 ${err(e)}`) }
    try { note(await this.c2b_pullPublicBets()) }                     catch (e) { warned = true; note(`C2b ${err(e)}`) }
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

    let totalUpserted = 0
    const sportNotes: string[] = []
    for (const sport of ALL_SPORTS) {
      let games: Espn.EspnGame[] = []
      try {
        // NBA + MLB are daily, so pull a wider window (a week ahead).
        // NFL falls back to the default current-week scoreboard.
        games = sport === 'NFL'
          ? await Espn.fetchCurrent('NFL')
          : await Espn.fetchUpcoming(sport, 7)
      } catch (e) {
        sportNotes.push(`${sport} ESPN err`)
        continue
      }

      let upserted = 0
      for (const g of games) {
        if (!TEAM_SET[sport].has(g.home_team) || !TEAM_SET[sport].has(g.away_team)) continue
        await this.db.query(
          `INSERT INTO ceelo_games
             (espn_id, sport, season, week, season_type, home_team, away_team, kickoff_at,
              status, home_score, away_score, neutral_site, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
           ON CONFLICT (espn_id) DO UPDATE
             SET status=EXCLUDED.status,
                 home_score=EXCLUDED.home_score,
                 away_score=EXCLUDED.away_score,
                 kickoff_at=EXCLUDED.kickoff_at,
                 sport=EXCLUDED.sport,
                 updated_at=NOW()`,
          [g.espn_id, sport, g.season, g.week, g.season_type, g.home_team, g.away_team,
           g.kickoff_at, g.status, g.home_score, g.away_score, g.neutral_site]
        )
        upserted++
      }
      totalUpserted += upserted
      if (upserted > 0) sportNotes.push(`${sport} ${upserted}`)
    }

    await this.db.query(`UPDATE ceelo_state SET last_schedule_at=NOW() WHERE id=1`)
    return totalUpserted > 0 ? `C0 ${sportNotes.join(' ')}` : 'C0 no games'
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

  // ── C0e: NFL depth charts via nflverse (≤ once per 7 days) ──────────────
  // Pulls the latest week of starter + immediate-backup depth from nflverse.
  // Skips silently in offseason (nflverse releases the next season's file
  // around July) — fetch error is non-fatal.

  private async c0e_refreshDepthCharts(): Promise<string> {
    const { rows: [s] } = await this.db.query('SELECT last_depth_at FROM ceelo_state WHERE id=1')
    if (s?.last_depth_at && minutesSince(s.last_depth_at) < 7 * 24 * 60) return ''

    const season = new Date().getUTCFullYear()
    let entries: Nflverse.DepthEntry[] = []
    try {
      entries = await Nflverse.fetchDepthCharts(season)
    } catch {
      // Try previous season — nflverse releases lag. Silent fail if both miss.
      try { entries = await Nflverse.fetchDepthCharts(season - 1) } catch { /* ignore */ }
    }
    if (!entries.length) {
      // Touch the gate so we don't hammer 404s every cycle in offseason.
      await this.db.query(`UPDATE ceelo_state SET last_depth_at=NOW() WHERE id=1`)
      return ''
    }

    // Wipe + re-insert NFL depth (table-wide unique key handles dedup but
    // wipe keeps the table tidy when rosters shuffle).
    await this.db.query(`DELETE FROM ceelo_depth_charts WHERE sport='NFL'`)
    let inserted = 0
    for (const d of entries) {
      await this.db.query(
        `INSERT INTO ceelo_depth_charts
           (sport, season, week, team, player, position, depth_position, formation, fetched_at)
         VALUES ('NFL',$1,$2,$3,$4,$5,$6,$7,NOW())
         ON CONFLICT (sport, team, position, formation, depth_position) DO UPDATE
           SET player=EXCLUDED.player,
               season=EXCLUDED.season,
               week=EXCLUDED.week,
               fetched_at=NOW()`,
        [d.season, d.week, d.team, d.player, d.position, d.depth_position, d.formation]
      )
      inserted++
    }
    await this.db.query(`UPDATE ceelo_state SET last_depth_at=NOW() WHERE id=1`)
    return inserted > 0 ? `C0e ${inserted} depth (NFL)` : ''
  }

  // ── C0c: auto-seed historical data per sport when empty ─────────────────
  // Per-sport check: any sport with zero rated teams gets auto-seeded.
  // NFL uses the rich nflverse seed (closing lines + EPA + Elo). NBA + MLB
  // use ESPN's date-range seed via /api/ceelo/seed-prev (Elo + games only —
  // historical book lines aren't free for those sports yet).

  private async c0c_autoSeed(): Promise<string> {
    const { rows } = await this.db.query(
      `SELECT sport, COUNT(*) AS rated
       FROM ceelo_team_ratings
       GROUP BY sport`
    )
    const ratedBySport = new Map<string, number>(
      rows.map((r: { sport: string; rated: number }) => [r.sport, Number(r.rated)])
    )

    const notes: string[] = []
    const port = process.env.PORT || '3000'

    // NFL — nflverse seed (richer dataset).
    if ((ratedBySport.get('NFL') ?? 0) === 0) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/ceelo/seed?seasons=3`, { method: 'POST' })
        if (res.ok) {
          const d = await res.json()
          notes.push(`NFL ${d.games_graded ?? 0}g`)
        } else notes.push(`NFL err${res.status}`)
      } catch (e) { notes.push(`NFL ${err(e).slice(0,30)}`) }
    }

    // NBA + MLB + NHL — ESPN date-range seed.
    for (const sport of ['NBA', 'MLB', 'NHL'] as const) {
      if ((ratedBySport.get(sport) ?? 0) > 0) continue
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/ceelo/seed-prev?sport=${sport}`, { method: 'POST' })
        if (res.ok) {
          const d = await res.json()
          const r = d.results?.[0]
          notes.push(`${sport} ${r?.graded ?? 0}g`)
        } else notes.push(`${sport} err${res.status}`)
      } catch (e) { notes.push(`${sport} ${err(e).slice(0,30)}`) }
    }

    return notes.length > 0 ? `C0c seeded ${notes.join(' · ')}` : ''
  }

  // ── C1: apply newly-completed games to Elo ratings ──────────────────────

  private async c1_gradeFinals(): Promise<string> {
    const { rows } = await this.db.query(
      `SELECT id, sport, home_team, away_team, home_score, away_score, neutral_site, kickoff_at
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
      const sport: Sport = (g.sport as Sport) ?? 'NFL'
      const homeR = await this.getRating(sport, g.home_team)
      const awayR = await this.getRating(sport, g.away_team)
      const upd = applyGame({
        homeRating: homeR,
        awayRating: awayR,
        homeScore: Number(g.home_score),
        awayScore: Number(g.away_score),
        neutralSite: Boolean(g.neutral_site),
        sport,
      })
      await this.upsertRating(sport, g.home_team, upd.homeNew, g.kickoff_at)
      await this.upsertRating(sport, g.away_team, upd.awayNew, g.kickoff_at)
      await this.db.query(
        `UPDATE ceelo_games SET graded_at=NOW(), updated_at=NOW() WHERE id=$1`,
        [g.id]
      )

      // RL feedback: grade the pre-kickoff model_spread against the
      // actual home margin. C3 only refreshes 'scheduled' rows so the
      // value sitting on ceelo_model_lines now is the last projection
      // before the game tipped off.
      //
      // Convention: model_spread is a HOME spread (negative = home
      // favored). Predicted home margin = -model_spread. Error is
      // signed so a positive value = model was too low on the home team.
      const actualMargin = Number(g.home_score) - Number(g.away_score)
      await this.db.query(
        `UPDATE ceelo_model_lines
            SET actual_margin = $1,
                margin_error  = $1 - (-model_spread),
                graded_at     = NOW()
          WHERE game_id = $2 AND model_spread IS NOT NULL AND graded_at IS NULL`,
        [actualMargin, g.id]
      )
      graded++
    }
    await this.db.query(`UPDATE ceelo_state SET last_grade_at=NOW() WHERE id=1`)
    return `C1 graded ${graded}`
  }

  // ── C2: pull current book lines (per-sport gate, derived from data) ─────
  //
  // Gate per-sport from the lines table itself (max(fetched_at) per sport).
  // Old behavior used a single `last_lines_at` column on ceelo_state which
  // meant NFL's offseason no-data return blocked NBA + MLB for 30 minutes
  // each cycle. Each sport now has its own freshness window.

  private async c2_pullBookLines(): Promise<string> {
    if (!Odds.isConfigured()) return ''   // silent — expected pre-key

    const { rows: freshRows } = await this.db.query(
      `SELECT sport, MAX(fetched_at) AS last
       FROM ceelo_lines
       GROUP BY sport`
    )
    const lastBySport = new Map<string, Date>(
      freshRows.map((r: { sport: string; last: Date }) => [r.sport, new Date(r.last)])
    )

    let totalStored = 0
    const sportNotes: string[] = []
    let calls = 0

    for (const sport of ALL_SPORTS) {
      const last = lastBySport.get(sport)
      if (last && minutesSince(last) < ODDS_REFRESH_MIN) continue

      calls++
      let lines: Odds.BookLine[] = []
      try {
        lines = await Odds.fetchLines(sport)
      } catch (e) {
        sportNotes.push(`${sport} err`)
        continue
      }

      let stored = 0
      for (const l of lines) {
        const { rows: [g] } = await this.db.query(
          `SELECT id FROM ceelo_games
           WHERE sport=$1 AND home_team=$2 AND away_team=$3
             AND kickoff_at BETWEEN $4::timestamptz - INTERVAL '6 hours'
                                AND $4::timestamptz + INTERVAL '6 hours'
           ORDER BY ABS(EXTRACT(EPOCH FROM (kickoff_at - $4::timestamptz)))
           LIMIT 1`,
          [sport, l.home_team, l.away_team, l.kickoff_at]
        )
        if (!g) continue
        await this.db.query(
          `INSERT INTO ceelo_lines
             (game_id, sport, book, market, home_line, total_line,
              home_odds, away_odds, over_odds, under_odds, fetched_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW())`,
          [g.id, sport, l.book, l.market, l.home_line, l.total_line,
           l.home_odds, l.away_odds, l.over_odds, l.under_odds]
        )
        stored++
      }
      totalStored += stored
      // Always log — even '0' for a sport that returned nothing — so the
      // operator can see that we tried + the upstream returned empty.
      sportNotes.push(`${sport} ${stored}`)
    }

    if (calls > 0) {
      await this.db.query(`UPDATE ceelo_state SET last_lines_at=NOW() WHERE id=1`)
    }
    return calls > 0 ? `C2 ${sportNotes.join(' · ')}` : ''
  }

  // ── C2b: public-betting % per game (free Action Network web API) ────────
  // Latest public bets/money split per game. Stamped onto the most-recent
  // ceelo_lines row per (game, book) so the EdgeBoard can render the
  // BETS%/MONEY% columns. Stays NULL if the source is unreachable.

  private async c2b_pullPublicBets(): Promise<string> {
    let totalUpdated = 0
    const sportNotes: string[] = []
    for (const sport of ALL_SPORTS) {
      const today = new Date()
      // Action Network's date param is the slate date — pull today + 1
      // so we cover same-day late tip-offs as well as next-day games.
      const tomorrow = new Date(today.getTime() + 86_400_000)
      const entries = [
        ...await PublicBets.fetchPublicBets(sport, today).catch(() => [] as PublicBets.PublicBetEntry[]),
        ...await PublicBets.fetchPublicBets(sport, tomorrow).catch(() => [] as PublicBets.PublicBetEntry[]),
      ]
      let updated = 0
      for (const e of entries) {
        if (e.public_bets_pct == null) continue
        const res = await this.db.query(
          `UPDATE ceelo_lines SET
              public_bets_pct = $1,
              public_money_pct = $2,
              public_side = $3
           WHERE id IN (
             SELECT id FROM ceelo_lines
             WHERE sport = $4
               AND market = 'spread'
               AND game_id IN (
                 SELECT id FROM ceelo_games
                 WHERE sport = $4
                   AND home_team = $5
                   AND away_team = $6
                   AND kickoff_at BETWEEN $7::timestamptz - INTERVAL '6 hours'
                                      AND $7::timestamptz + INTERVAL '6 hours'
               )
             ORDER BY fetched_at DESC
             LIMIT 8
           )`,
          [
            e.public_bets_pct, e.public_money_pct, e.public_side,
            sport, e.home_team, e.away_team, e.kickoff_at,
          ]
        )
        if ((res.rowCount ?? 0) > 0) updated++
      }
      if (updated > 0) sportNotes.push(`${sport} ${updated}`)
      totalUpdated += updated
    }
    return totalUpdated > 0 ? `C2b ${sportNotes.join(' ')}` : ''
  }

  // ── C3: compute model lines for upcoming games ──────────────────────────

  private async c3_computeModelLines(): Promise<string> {
    const { rows } = await this.db.query(
      `SELECT id, sport, home_team, away_team, neutral_site
       FROM ceelo_games
       WHERE status='scheduled'
         AND kickoff_at > NOW()
         AND kickoff_at < NOW() + INTERVAL '14 days'
       ORDER BY kickoff_at ASC LIMIT 200`
    )
    if (!rows.length) return ''

    let computed = 0
    for (const g of rows) {
      const sport: Sport = (g.sport as Sport) ?? 'NFL'
      const homeR = await this.getRating(sport, g.home_team)
      const awayR = await this.getRating(sport, g.away_team)
      const m = modelLine({
        homeRating: homeR,
        awayRating: awayR,
        neutralSite: Boolean(g.neutral_site),
        sport,
      })
      await this.db.query(
        `INSERT INTO ceelo_model_lines (game_id, sport, model_spread, model_home_prob, computed_at)
         VALUES ($1,$2,$3,$4,NOW())
         ON CONFLICT (game_id) DO UPDATE
           SET model_spread=EXCLUDED.model_spread,
               model_home_prob=EXCLUDED.model_home_prob,
               sport=EXCLUDED.sport,
               computed_at=NOW()`,
        [g.id, sport, m.modelSpread, m.modelHomeProb]
      )
      computed++
    }
    return `C3 ${computed} model`
  }

  // ── C4: diff model vs market, emit picks when |edge| ≥ threshold ────────

  private async c4_emitPicks(): Promise<string> {
    if (!Odds.isConfigured()) return ''   // can't gate without market lines

    // Latest spread per (game, book), joined with model line. Sport flows
    // through from ceelo_games so we can apply per-sport edge thresholds.
    const { rows } = await this.db.query(
      `WITH latest AS (
         SELECT DISTINCT ON (game_id, book)
                game_id, book, home_line, fetched_at
         FROM ceelo_lines
         WHERE market='spread' AND home_line IS NOT NULL
         ORDER BY game_id, book, fetched_at DESC
       )
       SELECT g.id AS game_id, g.sport, g.home_team, g.away_team, g.kickoff_at,
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
      const sport: Sport = (r.sport as Sport) ?? 'NFL'
      const model = Number(r.model_spread)
      const book  = Number(r.book_spread)
      const edge  = +(book - model).toFixed(2)   // positive ⇒ home undervalued ⇒ take HOME
      const threshold = EDGE_PT_BY_SPORT[sport]
      if (Math.abs(edge) < threshold) continue

      const takeHome = edge > 0
      const side = takeHome
        ? `${r.home_team} ${fmtSpread(book)}`
        : `${r.away_team} ${fmtSpread(-book)}`
      const game_label = `${r.away_team} @ ${r.home_team}`

      const dup = await this.db.query(
        `SELECT 1 FROM ceelo_picks
         WHERE game_id=$1 AND market='spread' AND side=$2 AND status IN ('open','taken')
         LIMIT 1`,
        [r.game_id, side]
      )
      if (dup.rows.length > 0) continue

      const conf = Math.abs(edge) >= 2.5 * threshold ? 'high'
                 : Math.abs(edge) >= 1.5 * threshold ? 'medium'
                 : 'low'
      const reasoning = `Model ${fmtSpread(model)} (home), book ${fmtSpread(book)} from ${r.book}. Edge ${Math.abs(edge).toFixed(1)} pts toward ${takeHome ? 'home' : 'away'}.`

      await this.db.query(
        `INSERT INTO ceelo_picks
           (sport, game_id, game_label, kickoff_at, market, side,
            model_prob, model_spread, book_spread, book_name,
            edge_points, fair_line, min_odds, edge_pct,
            reasoning, confidence, status, source)
         VALUES ($1,$2,$3,$4,'spread',$5,$6,$7,$8,$9,$10,$11,-110,NULL,$12,$13,'open','model')`,
        [
          sport, r.game_id, game_label, r.kickoff_at, side,
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

    // Auto-grade model picks (source='model') against final scores.
    // Separate from operator's W/L tracking — measures Ceelo's hypothetical
    // accuracy per sport regardless of whether the operator took the bet.
    const { rows: ungraded } = await this.db.query(
      `SELECT p.id, p.side, p.book_spread, p.game_id,
              g.home_team, g.away_team, g.home_score, g.away_score
       FROM ceelo_picks p
       JOIN ceelo_games g ON g.id = p.game_id
       WHERE p.source = 'model'
         AND p.model_outcome IS NULL
         AND g.status = 'final'
         AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
       LIMIT 200`
    )

    let modelGraded = 0
    for (const r of ungraded) {
      const homeSpread = r.book_spread != null ? Number(r.book_spread) : null
      if (homeSpread == null) continue
      const margin = Number(r.home_score) - Number(r.away_score)
      // pick.side begins with the team the pick is on. Match by abbr.
      const side = String(r.side ?? '').trim()
      const onHome = side.startsWith(r.home_team + ' ')
      const onAway = side.startsWith(r.away_team + ' ')
      if (!onHome && !onAway) continue   // can't tell which side — skip

      // For a HOME pick at home_spread S (e.g. -3.5): wins if margin + S > 0.
      // For an AWAY pick at away_spread -S: equivalently, wins if margin + S < 0.
      // Push when margin + S === 0 (only possible on whole-number spreads).
      const adjusted = onHome ? (margin + homeSpread) : -(margin + homeSpread)
      const outcome = adjusted > 0.001 ? 'win' : adjusted < -0.001 ? 'loss' : 'push'
      await this.db.query(
        `UPDATE ceelo_picks
         SET model_outcome = $1, model_graded_at = NOW()
         WHERE id = $2`,
        [outcome, r.id]
      )
      modelGraded++
    }

    const parts: string[] = []
    if (started.rowCount) parts.push(`voided ${started.rowCount} (kicked off)`)
    if (modelGraded)      parts.push(`graded ${modelGraded} model picks`)
    return parts.length ? `C5 ${parts.join(' · ')}` : ''
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
    const [topRated, openPicks, status, perSport, keyInjuries, epaTop, epaBottom, epaSeasonInfo, projAccuracy, projRecent] = await Promise.all([
      this.db.query(
        `SELECT sport, team, rating, games_played FROM ceelo_team_ratings
         WHERE games_played > 0
         ORDER BY rating DESC LIMIT 12`
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
                (SELECT COUNT(*) FROM ceelo_lines) AS live_book_lines,
                (SELECT COUNT(*) FROM ceelo_depth_charts) AS depth_chart_rows
         FROM ceelo_state WHERE id=1`
      ),
      // Per-sport breakdown — answers Ceelo's "what's actually flowing"
      // question by sport instead of conflating NFL offseason with NBA.
      this.db.query(
        `SELECT sport,
                (SELECT COUNT(*) FROM ceelo_team_ratings r
                 WHERE r.sport=s.sport AND r.games_played > 0) AS rated,
                (SELECT COUNT(*) FROM ceelo_games g
                 WHERE g.sport=s.sport AND g.status='scheduled' AND g.kickoff_at > NOW()) AS upcoming,
                (SELECT COUNT(DISTINCT game_id) FROM ceelo_lines l
                 WHERE l.sport=s.sport AND l.fetched_at > NOW() - INTERVAL '24 hours') AS lines_24h,
                (SELECT MAX(fetched_at) FROM ceelo_lines l WHERE l.sport=s.sport) AS last_lines_at
         FROM (VALUES ('NFL'),('NBA'),('MLB'),('NHL')) AS s(sport)`
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
      // EPA top & bottom of the most recent season we have. Net EPA per
      // play is the headline handicapping number — these are the cleanest
      // priors for any matchup conversation.
      this.db.query(
        `SELECT team, season, net_epa, epa_per_play, epa_allowed
         FROM ceelo_team_epa
         WHERE season = (SELECT MAX(season) FROM ceelo_team_epa)
         ORDER BY net_epa DESC LIMIT 5`
      ),
      this.db.query(
        `SELECT team, season, net_epa, epa_per_play, epa_allowed
         FROM ceelo_team_epa
         WHERE season = (SELECT MAX(season) FROM ceelo_team_epa)
         ORDER BY net_epa ASC LIMIT 5`
      ),
      this.db.query(
        `SELECT MAX(season) AS latest_season,
                COUNT(DISTINCT season) AS seasons,
                COUNT(*) AS rows
         FROM ceelo_team_epa`
      ),
      // Projection-vs-actual aggregate per sport (last 60 days). This is
      // Ceelo's RL feedback channel: every game he projected gets graded
      // against the final score, so we can show him calibration drift —
      // not just the picks that crossed the edge gate.
      this.db.query(
        `SELECT g.sport,
                COUNT(*)                                AS games,
                ROUND(AVG(ABS(m.margin_error))::numeric, 2) AS mae,
                ROUND(AVG(m.margin_error)::numeric, 2)      AS bias,
                COUNT(*) FILTER (
                  WHERE SIGN(m.actual_margin) = SIGN(-m.model_spread)
                )                                       AS side_correct
         FROM ceelo_model_lines m
         JOIN ceelo_games g ON g.id = m.game_id
         WHERE m.graded_at IS NOT NULL
           AND m.graded_at > NOW() - INTERVAL '60 days'
         GROUP BY g.sport`
      ),
      // Worst-miss recent projections — concrete examples Ceelo can
      // reference when explaining his model's calibration.
      this.db.query(
        `SELECT g.sport, g.home_team, g.away_team,
                m.model_spread, m.actual_margin, m.margin_error
         FROM ceelo_model_lines m
         JOIN ceelo_games g ON g.id = m.game_id
         WHERE m.graded_at IS NOT NULL
           AND m.graded_at > NOW() - INTERVAL '14 days'
         ORDER BY ABS(m.margin_error) DESC
         LIMIT 5`
      ),
    ])

    const topRatedStr = topRated.rows.length
      ? topRated.rows.map((r: { sport: string; team: string; rating: string; games_played: number }) =>
          `${r.sport ?? 'NFL'}/${r.team} ${Number(r.rating).toFixed(0)} (${r.games_played}g)`
        ).join(', ')
      : '(none yet — Elo cold-start across all sports)'
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

    // EPA inventory + leaderboard
    const epaMeta = epaSeasonInfo.rows[0] ?? {}
    const epaSeasons = Number(epaMeta.seasons ?? 0)
    const epaRows = Number(epaMeta.rows ?? 0)
    const epaLatestSeason = epaMeta.latest_season != null ? Number(epaMeta.latest_season) : null
    const epaTopStr = epaTop.rows.length
      ? epaTop.rows.map((r: { team: string; net_epa: string; epa_per_play: string; epa_allowed: string }) =>
          `${r.team} net=${signed(r.net_epa)} (off ${signed(r.epa_per_play)}, def_allowed ${signed(r.epa_allowed)})`
        ).join('\n  ')
      : '(no EPA data — operator should hit /api/ceelo/seed)'
    const epaBottomStr = epaBottom.rows.length
      ? epaBottom.rows.map((r: { team: string; net_epa: string; epa_per_play: string; epa_allowed: string }) =>
          `${r.team} net=${signed(r.net_epa)}`
        ).join(', ')
      : ''

    // Per-sport breakdown line for the chat — gives Ceelo specific
    // numbers per sport instead of conflating them.
    const perSportLines = perSport.rows.map((r: { sport: string; rated: number; upcoming: number; lines_24h: number; last_lines_at: string | null }) => {
      const ageMin = r.last_lines_at ? Math.floor((Date.now() - new Date(r.last_lines_at).getTime()) / 60_000) : null
      const ageStr = ageMin == null ? 'never' : ageMin < 60 ? `${ageMin}m ago` : `${Math.floor(ageMin/60)}h ago`
      return `  ${r.sport}: ${Number(r.rated)} teams rated · ${Number(r.upcoming)} upcoming · ${Number(r.lines_24h)} lines in last 24h (last fetch ${ageStr})`
    }).join('\n')

    // Ceelo RL feedback — every projected game graded against actual.
    // Surfaces calibration drift even when no pick was emitted.
    const projAccuracyStr = projAccuracy.rows.length
      ? projAccuracy.rows.map((r: { sport: string; games: number; mae: string; bias: string; side_correct: number }) => {
          const games = Number(r.games)
          const sidePct = games > 0 ? ((Number(r.side_correct) / games) * 100).toFixed(0) : '0'
          return `  ${r.sport}: ${games}g · MAE ${Number(r.mae).toFixed(2)} pts · bias ${signed(r.bias)} (${Number(r.bias) > 0 ? 'home-skewed' : Number(r.bias) < 0 ? 'away-skewed' : 'centered'}) · side ${sidePct}%`
        }).join('\n')
      : '  (no graded projections yet — every C1 finalize stamps actual margin onto its model_lines row)'
    const projRecentStr = projRecent.rows.length
      ? projRecent.rows.map((r: { sport: string; home_team: string; away_team: string; model_spread: string; actual_margin: string; margin_error: string }) => {
          const predictedMargin = -Number(r.model_spread)
          return `  ${r.sport} ${r.away_team}@${r.home_team}: predicted ${signed(predictedMargin)} · actual ${signed(r.actual_margin)} · err ${signed(r.margin_error)}`
        }).join('\n')
      : ''

    const depthCount = Number(s.depth_chart_rows ?? 0)
    const prompt = `You are Ceelo, the multi-sport handicapper on Lila's team (NFL + NBA + MLB + NHL). The operator is talking to you one-on-one.

Voice: dry, sharp, numbers-first. Short replies (1-3 sentences usually). No exclamation points. No hype. Be CONFIDENT about what you have — don't undersell. Only say you're missing data if it's literally not in the inventory below.

DATA YOU ACTUALLY HAVE (use it — these are real, queried just now):
- Elo ratings across all sports: ${Number(s.rated ?? 0)} teams walked from real completed games.
- Historical games graded: ${Number(s.historical_graded ?? 0)} across seasons ${seasonRange}.
- Historical closing spreads + closing totals: ${Number(s.historical_with_lines ?? 0)} games (NFL via nflverse — same dataset 538 / professional shops use). NBA + MLB historical lines aren't ingested yet.
- EPA / play-by-play aggregates (NFL): ${epaRows} team-season rows across ${epaSeasons} seasons${epaLatestSeason ? ` (latest ${epaLatestSeason})` : ''}. Per-team: net_epa, epa_per_play (offense), pass_epa, rush_epa, success_rate, epa_allowed (defense). NBA + MLB EPA aren't ingested.
- Depth charts (NFL): ${depthCount} starter+backup entries via nflverse. NBA + MLB depth ranks not ingested.
- Current schedule + final scores from ESPN (refreshed hourly per sport).
- Current rosters: ${Number(s.rostered_players ?? 0)} players across ${Number(s.rostered_teams ?? 0)} teams (ESPN, weekly).
- Active injury reports: ${Number(s.hurt ?? 0)} Out/Doubtful/IR/PUP entries on tracked teams.
- Model-derived spread + win-prob per upcoming game (computed each cycle from the Elo ratings).
- Projection-vs-actual feedback: every game you projected gets graded against the final score (margin error stored on ceelo_model_lines). This is your reinforcement signal — use it to talk about calibration honestly.
- Odds API: ${Odds.isConfigured() ? 'KEY PRESENT' : 'NO KEY — edge gate dark'}.

PER-SPORT BREAKDOWN (be specific when asked about a single sport):
${perSportLines}

MODEL CALIBRATION (last 60 days, per sport — this is your RL feedback):
${projAccuracyStr}${projRecentStr ? `

WORST RECENT MISSES (cite these if asked about the model's blind spots):
${projRecentStr}` : ''}

DATA YOU DO NOT HAVE (don't pretend you do):
- NBA / MLB historical book lines, EPA, depth charts. NFL has all three; the others stop at Elo + games + rosters.
- Coaching tendencies, weather forecasts, ref crews. (Not ingested.)
- In-season weekly EPA snapshots. (Have season totals; no week-by-week trend yet.)

CURRENT STATE:
- Loop cycle: ${Number(s.cycle ?? 0)}
- Top-rated by Elo: ${topRatedStr}
- Top-5 by net EPA${epaLatestSeason ? ` (${epaLatestSeason})` : ''}:
  ${epaTopStr}
${epaBottomStr ? `- Bottom-5 by net EPA: ${epaBottomStr}\n` : ''}- Open picks (model-driven, sorted by edge):
  ${openPicksStr}
- Key injuries on tracked teams:
  ${injuryStr}

When the operator asks "what do you see" or "what do you have", answer concretely from the data inventory above. Don't say "I don't have data" when you have Elo + historical lines + rosters + injuries + EPA + a model — that's a complete handicapping kit. Be honest about what's missing (depth charts, weekly EPA trend) but don't sandbag what you have.

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

  private async getRating(sport: Sport, team: string): Promise<number> {
    const { rows: [r] } = await this.db.query(
      `SELECT rating FROM ceelo_team_ratings WHERE sport=$1 AND team=$2`, [sport, team]
    )
    return r ? Number(r.rating) : DEFAULT_RATING
  }

  private async upsertRating(sport: Sport, team: string, rating: number, lastGameAt: string): Promise<void> {
    await this.db.query(
      `INSERT INTO ceelo_team_ratings (sport, team, rating, games_played, last_game_at, updated_at)
       VALUES ($1,$2,$3,1,$4,NOW())
       ON CONFLICT (sport, team) DO UPDATE
         SET rating=EXCLUDED.rating,
             games_played=ceelo_team_ratings.games_played + 1,
             last_game_at=GREATEST(ceelo_team_ratings.last_game_at, EXCLUDED.last_game_at),
             updated_at=NOW()`,
      [sport, team, rating, lastGameAt]
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
// Format a numeric EPA-ish value with leading sign (and short precision).
function signed(v: string | number | null | undefined): string {
  if (v == null) return '?'
  const n = typeof v === 'number' ? v : parseFloat(v)
  if (!Number.isFinite(n)) return '?'
  return (n >= 0 ? '+' : '') + n.toFixed(3)
}

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
