import OpenAI from 'openai'
import type { PoolClient } from 'pg'
import { cfg } from './config'
import { llmCall, LLMBudgetExceeded } from './llm'
import * as Espn from './ceelo/espn'
import * as Odds from './ceelo/odds'
import * as PublicBets from './ceelo/public-bets'
import * as Nflverse from './ceelo/nflverse'
import * as TrueScore from './ceelo/true-score'
import { applyGame, modelLine, DEFAULT_RATING, SPORT_CONFIG } from './ceelo/ratings'
import {
  sierraLine, kellyUnits, applyPrUpdate,
  QB_TIER_POINTS, BLUE_CHIP_OT_PTS, BLUE_CHIP_EDGE_PTS, BLUE_CHIP_CB_PTS,
  CLUSTER_INJURY_TAX, DEFAULT_PR,
  type QbTier, type SituationalContext,
} from './ceelo/walters'
import { awayTurfDiscrepancy } from './ceelo/venues'
import { ALL_SPORTS, NFL_TEAMS, NBA_TEAMS, MLB_TEAMS, type Sport } from './ceelo/teams'

const TEAM_SET: Record<Sport, ReadonlySet<string>> = {
  NFL: NFL_TEAMS,
  NBA: NBA_TEAMS,
  MLB: MLB_TEAMS,
}

// Edge threshold per sport (in line points) for C4. NBA needs a wider
// gate because the lines move bigger; MLB run-line edge is tighter.
const EDGE_PT_BY_SPORT: Record<Sport, number> = {
  NFL: 1.0,
  NBA: 1.5,
  MLB: 0.5,
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
    try { note(await this.c0f_gradePlayers()) }                       catch (e) { warned = true; note(`C0f ${err(e)}`) }
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

    // NBA + MLB — ESPN date-range seed.
    for (const sport of ['NBA', 'MLB'] as const) {
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

  // ── C0f: Ceelo's auto-graded player tiers + blue-chips (NFL) ────────────
  //
  // Runs once per 24h. No operator input — Ceelo grades from the data it
  // already has (team EPA + nflverse depth charts + ESPN rosters):
  //   • QB tier: starter QB inherits team pass-EPA rank ⇒ tier 1..5.
  //   • Blue-chip OT: depth-1 LT/RT of the top-3 EPA-allowed teams.
  //   • Blue-chip EDGE / CB: depth-1 of the top-5 EPA-allowed defenses.
  // These are intentional v1 stand-ins for PFF grades — fully deterministic,
  // re-derived weekly. The rationale is stamped on each row so the operator
  // can see exactly why a player was tagged.
  private async c0f_gradePlayers(): Promise<string> {
    const { rows: [s] } = await this.db.query(
      `SELECT last_grades_at FROM ceelo_state WHERE id=1`
    )
    if (s?.last_grades_at && minutesSince(s.last_grades_at) < 24 * 60) return ''

    // Pull most-recent-season EPA per team. Order by pass_epa for QB
    // tiers, by epa_allowed for blue-chip-OT proxy (best pass-pro = lowest
    // EPA allowed).
    const { rows: epaRows } = await this.db.query(
      `SELECT team, pass_epa, epa_per_play, epa_allowed
       FROM ceelo_team_epa
       WHERE season = (SELECT MAX(season) FROM ceelo_team_epa)`
    )
    if (!epaRows.length) {
      // No EPA priors yet — touch the gate and bail. Auto-seed (C0c)
      // populates EPA, so this self-resolves once seeding completes.
      await this.db.query(`UPDATE ceelo_state SET last_grades_at=NOW() WHERE id=1`)
      return ''
    }

    type EpaRow = { team: string; pass_epa: number; epa_per_play: number; epa_allowed: number }
    const epa: EpaRow[] = epaRows.map((r: { team: string; pass_epa: string | null; epa_per_play: string | null; epa_allowed: string | null }) => ({
      team: r.team,
      pass_epa: r.pass_epa != null ? Number(r.pass_epa) : 0,
      epa_per_play: r.epa_per_play != null ? Number(r.epa_per_play) : 0,
      epa_allowed: r.epa_allowed != null ? Number(r.epa_allowed) : 0,
    }))

    // Ranks by pass_epa (descending — high = elite passing team).
    const passRank = [...epa].sort((a, b) => b.pass_epa - a.pass_epa)
    const passRankMap = new Map(passRank.map((r, i) => [r.team, i + 1]))

    // Top-3 pass-protection teams by lowest EPA-allowed get blue-chip OT
    // tags on their depth-1 LT/RT. Top-5 get blue-chip EDGE/CB tags.
    const defRank = [...epa].sort((a, b) => a.epa_allowed - b.epa_allowed)
    const blueChipOtTeams  = new Set(defRank.slice(0, 3).map(r => r.team))
    const blueChipDefTeams = new Set(defRank.slice(0, 5).map(r => r.team))

    // Pull starter-only depth chart (depth_position=1) for the positions
    // we grade.
    const { rows: depthRows } = await this.db.query(
      `SELECT team, player, position
       FROM ceelo_depth_charts
       WHERE sport='NFL'
         AND depth_position = 1
         AND position IN ('QB','LT','RT','OT','EDGE','DE','OLB','CB')`
    )

    // Wipe + re-grade — keeps the table tight and avoids stale entries
    // from rosters that have shuffled. C0d/C0e refresh the inputs on a
    // 7-day cadence; this step trails them by ≤ 24h.
    await this.db.query(`DELETE FROM ceelo_player_grades`)

    let qbCount = 0
    let bcCount = 0
    for (const d of depthRows) {
      const team = d.team as string
      const player = d.player as string
      const position = (d.position as string).toUpperCase()
      if (!player) continue

      if (position === 'QB') {
        const rank = passRankMap.get(team) ?? 32
        const tier: QbTier =
            rank <=  5 ? 1
          : rank <= 10 ? 2
          : rank <= 22 ? 3
          : rank <= 28 ? 4
          : 5
        await this.db.query(
          `INSERT INTO ceelo_player_grades (team, player, position, qb_tier, blue_chip_pts, rationale, graded_at)
           VALUES ($1,$2,'QB',$3,NULL,$4,NOW())
           ON CONFLICT (team, player) DO UPDATE
             SET position='QB', qb_tier=EXCLUDED.qb_tier, rationale=EXCLUDED.rationale, graded_at=NOW()`,
          [team, player, tier, `pass_epa rank ${rank}/${epa.length}`]
        )
        qbCount++
        continue
      }

      // Blue-chip OT — only depth-1 LT or RT on a top-3 pass-pro team.
      if ((position === 'LT' || position === 'RT' || position === 'OT') && blueChipOtTeams.has(team)) {
        await this.db.query(
          `INSERT INTO ceelo_player_grades (team, player, position, qb_tier, blue_chip_pts, rationale, graded_at)
           VALUES ($1,$2,$3,NULL,$4,$5,NOW())
           ON CONFLICT (team, player) DO UPDATE
             SET position=EXCLUDED.position, blue_chip_pts=EXCLUDED.blue_chip_pts,
                 rationale=EXCLUDED.rationale, graded_at=NOW()`,
          [team, player, position, BLUE_CHIP_OT_PTS, `top-3 pass-pro proxy (epa_allowed)`]
        )
        bcCount++
        continue
      }

      // Blue-chip edge / OLB on a top-5 defense.
      if ((position === 'EDGE' || position === 'DE' || position === 'OLB') && blueChipDefTeams.has(team)) {
        await this.db.query(
          `INSERT INTO ceelo_player_grades (team, player, position, qb_tier, blue_chip_pts, rationale, graded_at)
           VALUES ($1,$2,'EDGE',NULL,$3,$4,NOW())
           ON CONFLICT (team, player) DO UPDATE
             SET position='EDGE', blue_chip_pts=EXCLUDED.blue_chip_pts,
                 rationale=EXCLUDED.rationale, graded_at=NOW()`,
          [team, player, BLUE_CHIP_EDGE_PTS, `top-5 defense proxy (epa_allowed)`]
        )
        bcCount++
        continue
      }

      // Blue-chip CB on a top-5 defense.
      if (position === 'CB' && blueChipDefTeams.has(team)) {
        await this.db.query(
          `INSERT INTO ceelo_player_grades (team, player, position, qb_tier, blue_chip_pts, rationale, graded_at)
           VALUES ($1,$2,'CB',NULL,$3,$4,NOW())
           ON CONFLICT (team, player) DO UPDATE
             SET position='CB', blue_chip_pts=EXCLUDED.blue_chip_pts,
                 rationale=EXCLUDED.rationale, graded_at=NOW()`,
          [team, player, BLUE_CHIP_CB_PTS, `top-5 defense proxy (epa_allowed)`]
        )
        bcCount++
        continue
      }
    }

    await this.db.query(`UPDATE ceelo_state SET last_grades_at=NOW() WHERE id=1`)
    return qbCount + bcCount > 0 ? `C0f ${qbCount} QB · ${bcCount} BC` : ''
  }

  // ── C1: apply newly-completed games to ratings ──────────────────────────
  //
  // NFL: Walters PR points-update using True Score (ST TDs + late-game
  // garbage stripped). Surprise = (true_margin - expected_margin) where
  // expected_margin is derived from the closing spread. NBA / MLB: keep
  // the original Elo path — Walters' framework is football-specific.

  private async c1_gradeFinals(): Promise<string> {
    const { rows } = await this.db.query(
      `SELECT g.id, g.sport, g.espn_id, g.home_team, g.away_team,
              g.home_score, g.away_score, g.neutral_site, g.kickoff_at,
              g.closing_spread,
              (SELECT home_line FROM ceelo_lines l
                WHERE l.game_id = g.id AND l.market = 'spread'
                ORDER BY l.fetched_at DESC LIMIT 1) AS latest_spread
       FROM ceelo_games g
       WHERE g.status='final'
         AND g.graded_at IS NULL
         AND g.home_score IS NOT NULL
         AND g.away_score IS NOT NULL
       ORDER BY g.kickoff_at ASC
       LIMIT 100`
    )
    if (!rows.length) return ''

    let graded = 0
    let nflTrueScored = 0
    for (const g of rows) {
      const sport: Sport = (g.sport as Sport) ?? 'NFL'

      if (sport === 'NFL') {
        // True Score grading.
        const homeRaw = Number(g.home_score)
        const awayRaw = Number(g.away_score)
        let homeTrue = homeRaw
        let awayTrue = awayRaw

        if (g.espn_id) {
          const summary = await TrueScore.fetchScoringSummary(
            g.espn_id, g.home_team, g.away_team
          ).catch(() => null)
          if (summary) {
            const ts = TrueScore.trueScore({
              plays: summary.plays,
              homeTeam: g.home_team,
              awayTeam: g.away_team,
              finalHome: summary.finalHome ?? homeRaw,
              finalAway: summary.finalAway ?? awayRaw,
            })
            homeTrue = ts.homeTrue
            awayTrue = ts.awayTrue
            if (ts.stripped.length > 0) nflTrueScored++
          }
        }

        await this.db.query(
          `UPDATE ceelo_games SET home_true_score=$2, away_true_score=$3 WHERE id=$1`,
          [g.id, homeTrue, awayTrue]
        )

        // Expected margin from the closing line (or the latest spread we
        // captured if closing isn't recorded). Home spread is negative when
        // home is favored, so expected_margin_home = -spread.
        const spread =
          g.closing_spread != null ? Number(g.closing_spread)
          : g.latest_spread != null ? Number(g.latest_spread)
          : 0
        const expectedMarginHome = -spread
        const trueMarginHome = homeTrue - awayTrue

        const homePR = await this.getNflPR(g.home_team)
        const awayPR = await this.getNflPR(g.away_team)
        const upd = applyPrUpdate({
          homePR,
          awayPR,
          trueMarginHome,
          expectedMarginHome,
        })
        await this.upsertRating('NFL', g.home_team, upd.homeNew, g.kickoff_at)
        await this.upsertRating('NFL', g.away_team, upd.awayNew, g.kickoff_at)
      } else {
        // NBA / MLB — Elo path unchanged.
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
      }

      await this.db.query(
        `UPDATE ceelo_games SET graded_at=NOW(), updated_at=NOW() WHERE id=$1`,
        [g.id]
      )
      graded++
    }
    await this.db.query(`UPDATE ceelo_state SET last_grade_at=NOW() WHERE id=1`)
    const tsNote = nflTrueScored > 0 ? ` (${nflTrueScored} NFL stripped)` : ''
    return `C1 graded ${graded}${tsNote}`
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
  //
  // NFL: Walters Sierra Line built from PR + QB tiers + blue-chip injuries
  // + cluster taxes + situational adjustments. NBA / MLB: existing Elo
  // model line. We cache the Walters context (raw PR diff, situational sum,
  // adjustment log) per-game in memory keyed by game_id so C4 can stamp it
  // onto the pick row without re-running the math.

  // Per-cycle scratch for C4 to pull adjustment context out of C3.
  private walters: Map<number, { rawPrDiff: number; situationalSum: number; adjustmentsLabel: string }> = new Map()

  private async c3_computeModelLines(): Promise<string> {
    this.walters = new Map()

    const { rows } = await this.db.query(
      `SELECT id, sport, espn_id, home_team, away_team, neutral_site, kickoff_at, season, week
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

      if (sport === 'NFL') {
        const ctx = await this.buildWaltersContext(g)
        const result = sierraLine(ctx)
        await this.db.query(
          `INSERT INTO ceelo_model_lines (game_id, sport, model_spread, model_home_prob, computed_at)
           VALUES ($1,'NFL',$2,$3,NOW())
           ON CONFLICT (game_id) DO UPDATE
             SET model_spread=EXCLUDED.model_spread,
                 model_home_prob=EXCLUDED.model_home_prob,
                 sport='NFL',
                 computed_at=NOW()`,
          [g.id, result.sierraLine, result.homeWinProb]
        )
        const adjLabel = result.adjustments
          .filter(a => a.label !== 'Raw PR diff')
          .map(a => `${a.label} ${a.points >= 0 ? '+' : ''}${a.points.toFixed(2)}`)
          .join(', ')
        this.walters.set(Number(g.id), {
          rawPrDiff: result.rawPrDiff,
          situationalSum: result.situationalSum,
          adjustmentsLabel: adjLabel,
        })
      } else {
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
      }
      computed++
    }
    return `C3 ${computed} model`
  }

  // Resolve every Walters knob for one upcoming NFL game and call sierraLine.
  // Loads PR + QB tiers + blue-chips + injuries + previous-week margins.
  private async buildWaltersContext(g: {
    id: number
    espn_id: string | null
    home_team: string
    away_team: string
    neutral_site: boolean
    kickoff_at: string
    season: number | null
    week: number | null
  }): Promise<Parameters<typeof sierraLine>[0]> {
    const homePR = await this.getNflPR(g.home_team)
    const awayPR = await this.getNflPR(g.away_team)

    const [homeQb, awayQb, homeBc, awayBc, homeOuts, awayOuts] = await Promise.all([
      this.resolveQbPoints(g.home_team),
      this.resolveQbPoints(g.away_team),
      this.resolveBlueChipPoints(g.home_team),
      this.resolveBlueChipPoints(g.away_team),
      this.fetchOutsByUnit(g.home_team),
      this.fetchOutsByUnit(g.away_team),
    ])

    const homeClusterTax = clusterTaxFromOuts(homeOuts)
    const awayClusterTax = clusterTaxFromOuts(awayOuts)

    const kickoff = new Date(g.kickoff_at)
    // MNF kickoffs are 7-9pm ET → late-night UTC (00:00-04:00 Tue UTC) for
    // ET-zone games or simply Monday evening UTC for the rare 5pm ET start.
    // Catch both: Monday UTC, OR Tuesday UTC before noon (covers late-night
    // PT MNF that spills past midnight UTC).
    const dow = kickoff.getUTCDay()
    const isMnfWindow = dow === 1 || (dow === 2 && kickoff.getUTCHours() < 12)
    const awayIsMnfRoad = isMnfWindow

    const [homeBb, awayBb] = await Promise.all([
      this.didLoseBy19PlusLastGame(g.home_team, g.kickoff_at),
      this.didLoseBy19PlusLastGame(g.away_team, g.kickoff_at),
    ])

    const turfMismatch = awayTurfDiscrepancy({ homeTeam: g.home_team, awayTeam: g.away_team })

    // Modern game = within the last 4 calendar years. Walters' point is
    // that HFA has been dying since ~2020 (empty/limited stadiums during
    // COVID + better road QB prep eroded it). Pre-2021, lean historical 2.5.
    const FOUR_YEARS_MS = 4 * 365 * 86_400_000
    const modernGame = (Date.now() - kickoff.getTime()) <= FOUR_YEARS_MS

    const situational: SituationalContext = {
      awayIsMnfRoad,
      homeBounceback: homeBb,
      awayBounceback: awayBb,
      awayTurfDiscrepancy: turfMismatch,
      modernGame,
      neutralSite: Boolean(g.neutral_site),
    }

    return {
      homePR,
      awayPR,
      homeQbPoints: homeQb,
      awayQbPoints: awayQb,
      homeBlueChipPoints: homeBc,
      awayBlueChipPoints: awayBc,
      homeClusterTax,
      awayClusterTax,
      situational,
    }
  }

  // QB points for a team — starter unless the starter is on the Out /
  // Doubtful / IR list, in which case fall through to the depth-2 QB.
  // Returns 0 if no graded QB is found (treats team as Tier 5).
  private async resolveQbPoints(team: string): Promise<number> {
    const { rows: starterRows } = await this.db.query(
      `SELECT d.player, COALESCE(g.qb_tier, 3) AS tier,
              i.status AS injury_status
         FROM ceelo_depth_charts d
         LEFT JOIN ceelo_player_grades g ON g.team=d.team AND g.player=d.player
         LEFT JOIN ceelo_injuries i      ON i.team=d.team AND i.player=d.player
        WHERE d.sport='NFL' AND d.team=$1 AND d.position='QB'
        ORDER BY d.depth_position ASC LIMIT 2`,
      [team]
    )
    if (!starterRows.length) return QB_TIER_POINTS[3]
    const starter = starterRows[0]
    const out = ['Out', 'Doubtful', 'IR', 'PUP'].includes(String(starter.injury_status ?? ''))
    if (out && starterRows[1]) {
      const backup = starterRows[1]
      const tier = clampTier(Number(backup.tier))
      return QB_TIER_POINTS[tier]
    }
    const tier = clampTier(Number(starter.tier))
    return QB_TIER_POINTS[tier]
  }

  // Sum blue-chip points for healthy tagged players on a team. Subtract
  // points for any tagged player on the Out / Doubtful / IR list (they
  // count negatively against the side missing them).
  private async resolveBlueChipPoints(team: string): Promise<number> {
    const { rows } = await this.db.query(
      `SELECT g.player, g.blue_chip_pts, i.status AS injury_status
         FROM ceelo_player_grades g
         LEFT JOIN ceelo_injuries i
                ON i.team=g.team AND i.player=g.player
        WHERE g.team=$1 AND g.blue_chip_pts IS NOT NULL`,
      [team]
    )
    let total = 0
    for (const r of rows) {
      const pts = Number(r.blue_chip_pts ?? 0)
      const out = ['Out', 'Doubtful', 'IR', 'PUP'].includes(String(r.injury_status ?? ''))
      total += out ? -pts : pts
    }
    return +total.toFixed(2)
  }

  // How many starters per unit (OL, DB, DL, LB, WR) are Out/Doubtful/IR.
  private async fetchOutsByUnit(team: string): Promise<Record<string, number>> {
    const { rows } = await this.db.query(
      `SELECT d.position
         FROM ceelo_depth_charts d
         JOIN ceelo_injuries i
              ON i.team=d.team AND i.player=d.player
        WHERE d.sport='NFL'
          AND d.team=$1
          AND d.depth_position = 1
          AND i.status IN ('Out','Doubtful','IR','PUP')`,
      [team]
    )
    const out: Record<string, number> = {}
    for (const r of rows) {
      const unit = unitFromPosition(String(r.position ?? ''))
      if (!unit) continue
      out[unit] = (out[unit] ?? 0) + 1
    }
    return out
  }

  // Walters' bounceback rule: lost previous game by 19+.
  private async didLoseBy19PlusLastGame(team: string, kickoff: string): Promise<boolean> {
    const { rows } = await this.db.query(
      `SELECT home_team, away_team, home_score, away_score
         FROM ceelo_games
        WHERE sport='NFL' AND status='final'
          AND (home_team=$1 OR away_team=$1)
          AND kickoff_at < $2::timestamptz
        ORDER BY kickoff_at DESC LIMIT 1`,
      [team, kickoff]
    )
    if (!rows.length) return false
    const g = rows[0]
    const isHome = g.home_team === team
    const teamScore = Number(isHome ? g.home_score : g.away_score)
    const oppScore  = Number(isHome ? g.away_score : g.home_score)
    return (oppScore - teamScore) >= 19
  }

  // ── C4: diff model vs market, emit picks when |edge| ≥ threshold ────────

  private async c4_emitPicks(): Promise<string> {
    if (!Odds.isConfigured()) return ''   // can't gate without market lines

    // Latest spread per (game, book), joined with model line. Sport flows
    // through from ceelo_games so we can apply per-sport edge thresholds.
    const { rows } = await this.db.query(
      `WITH latest AS (
         SELECT DISTINCT ON (game_id, book)
                game_id, book, home_line, home_odds, away_odds, fetched_at
         FROM ceelo_lines
         WHERE market='spread' AND home_line IS NOT NULL
         ORDER BY game_id, book, fetched_at DESC
       )
       SELECT g.id AS game_id, g.sport, g.home_team, g.away_team, g.kickoff_at,
              m.model_spread, m.model_home_prob,
              l.book, l.home_line AS book_spread,
              l.home_odds, l.away_odds
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

      const sideProb = takeHome
        ? Number(r.model_home_prob)
        : +(1 - Number(r.model_home_prob)).toFixed(3)
      const sideOdds = takeHome ? Number(r.home_odds ?? -110) : Number(r.away_odds ?? -110)
      const units = sport === 'NFL' ? kellyUnits(sideProb, sideOdds) : 1.0

      // Pull the Walters block stamped in C3 (NFL only). NBA/MLB picks
      // skip these fields and fall back to the simpler reasoning string.
      const w = sport === 'NFL' ? this.walters.get(Number(r.game_id)) : null

      const reasoning = w
        ? `Sierra ${fmtSpread(model)} vs book ${fmtSpread(book)} (${r.book}). Raw PR diff ${signedFixed(w.rawPrDiff, 2)}. Situational sum ${signedFixed(w.situationalSum, 2)} (${w.adjustmentsLabel || 'none'}). Edge ${Math.abs(edge).toFixed(1)} pts toward ${takeHome ? 'home' : 'away'}. Kelly ${units}u.`
        : `Model ${fmtSpread(model)} (home), book ${fmtSpread(book)} from ${r.book}. Edge ${Math.abs(edge).toFixed(1)} pts toward ${takeHome ? 'home' : 'away'}.`

      await this.db.query(
        `INSERT INTO ceelo_picks
           (sport, game_id, game_label, kickoff_at, market, side,
            model_prob, model_spread, book_spread, book_name,
            edge_points, fair_line, min_odds, edge_pct,
            reasoning, confidence, status, source,
            raw_pr_diff, situational_sum, kelly_units)
         VALUES ($1,$2,$3,$4,'spread',$5,$6,$7,$8,$9,$10,$11,$12,NULL,$13,$14,'open','model',$15,$16,$17)`,
        [
          sport, r.game_id, game_label, r.kickoff_at, side,
          sideProb,
          model, book, r.book, Math.abs(edge),
          fmtSpread(model), sideOdds, reasoning, conf,
          w?.rawPrDiff ?? null, w?.situationalSum ?? null, units,
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
    const [topRated, openPicks, status, perSport, keyInjuries, epaTop, epaBottom, epaSeasonInfo, qbGrades, blueChips] = await Promise.all([
      // Sport-partitioned top teams. NFL rows are now on the Walters PR scale
      // (DEFAULT_PR ≈ 17), NBA/MLB rows still on Elo (~1500). We pull both
      // top groups so the chat can report each correctly.
      this.db.query(
        `(SELECT sport, team, rating, games_played FROM ceelo_team_ratings
          WHERE sport='NFL' AND games_played > 0
          ORDER BY rating DESC LIMIT 6)
         UNION ALL
         (SELECT sport, team, rating, games_played FROM ceelo_team_ratings
          WHERE sport <> 'NFL' AND games_played > 0
          ORDER BY rating DESC LIMIT 6)`
      ),
      this.db.query(
        `SELECT game_label, market, side, model_spread, book_spread, edge_points, confidence,
                raw_pr_diff, situational_sum, kelly_units
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
         FROM (VALUES ('NFL'),('NBA'),('MLB')) AS s(sport)`
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
      // Walters QB tiers — Ceelo's auto-graded starter pool per team.
      this.db.query(
        `SELECT team, player, qb_tier, rationale
         FROM ceelo_player_grades
         WHERE qb_tier IS NOT NULL
         ORDER BY qb_tier ASC, team ASC`
      ),
      // Walters blue-chip players — Wirfs-tier OTs + top edge / CB.
      this.db.query(
        `SELECT team, player, position, blue_chip_pts, rationale
         FROM ceelo_player_grades
         WHERE blue_chip_pts IS NOT NULL
         ORDER BY blue_chip_pts DESC, team ASC`
      ),
    ])

    // NFL rows live on the Walters PR scale (≈ 17 baseline); NBA/MLB on Elo
    // (≈ 1500). Format each with the precision that matches its scale.
    const topRatedStr = topRated.rows.length
      ? topRated.rows.map((r: { sport: string; team: string; rating: string; games_played: number }) => {
          const sport = r.sport ?? 'NFL'
          const rating = Number(r.rating)
          const fmt = sport === 'NFL' ? rating.toFixed(1) : rating.toFixed(0)
          const label = sport === 'NFL' ? 'PR' : 'Elo'
          return `${sport}/${r.team} ${label} ${fmt} (${r.games_played}g)`
        }).join(', ')
      : '(none yet — cold-start across all sports)'
    const openPicksStr = openPicks.rows.length
      ? openPicks.rows.map((p: { game_label: string; side: string; model_spread: string | null; book_spread: string | null; edge_points: string | null; confidence: string; raw_pr_diff: string | null; situational_sum: string | null; kelly_units: string | null }) => {
          const m = p.model_spread != null ? Number(p.model_spread).toFixed(1) : '?'
          const b = p.book_spread  != null ? Number(p.book_spread).toFixed(1)  : '?'
          const e = p.edge_points  != null ? Number(p.edge_points).toFixed(1)  : '?'
          const k = p.kelly_units  != null ? `${Number(p.kelly_units).toFixed(1)}u` : '—'
          const pr = p.raw_pr_diff != null ? `PR Δ ${signed(p.raw_pr_diff)}` : ''
          const sit = p.situational_sum != null ? `sit ${signed(p.situational_sum)}` : ''
          const extras = [pr, sit].filter(Boolean).join(', ')
          return `${p.side} (${p.game_label}) — sierra ${m}, book ${b}, edge ${e}pt [${p.confidence}, ${k}]${extras ? ` · ${extras}` : ''}`
        }).join('\n  ')
      : '(no open picks)'

    const qbTiersStr = qbGrades.rows.length
      ? qbGrades.rows.slice(0, 12).map((q: { team: string; player: string; qb_tier: number; rationale: string | null }) =>
          `T${q.qb_tier} ${q.team} ${q.player}${q.rationale ? ` (${q.rationale})` : ''}`
        ).join(', ')
      : '(no QB grades yet — C0f hasn\'t run, or no EPA priors)'
    const blueChipsStr = blueChips.rows.length
      ? blueChips.rows.slice(0, 8).map((b: { team: string; player: string; position: string; blue_chip_pts: string; rationale: string | null }) =>
          `${b.team} ${b.player} (${b.position}, ${Number(b.blue_chip_pts).toFixed(1)}pt)`
        ).join(', ')
      : '(none tagged yet)'
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

    const depthCount = Number(s.depth_chart_rows ?? 0)
    const prompt = `You are Ceelo, the multi-sport handicapper on Lila's team (NFL + NBA + MLB). The operator is talking to you one-on-one.

Voice: dry, sharp, numbers-first. Short replies (1-3 sentences usually). No exclamation points. No hype. Be CONFIDENT about what you have — don't undersell. Only say you're missing data if it's literally not in the inventory below.

FRAMEWORK (NFL):
You handicap NFL games using Billy Walters' point-rating framework. Every input is a numerical point value; if it can't be quantified, it gets discarded. Your output protocol per game is: Raw PR Diff, Situational Sum, Sierra Line (your spread), Market Edge (book vs Sierra), Kelly Sizing (0.5–3.0u, ¼-Kelly).

Walters knobs you operate on:
- QB tiers — T1 Elite 7.5 / T2 High 5.0 / T3 Avg 2.5 / T4 Below 1.0 / T5 Backup 0.0. Injury swing is starter_pts − backup_pts.
- Blue-chip OT (Wirfs-tier): 1.4. Top edge / CB: 0.9. All other positions 0 unless cluster injury.
- Cluster injury tax: 3+ starters out in one unit ⇒ −1.5.
- HFA: 2.5 historical, capped 1.25 for last 4 yrs (HFA is dying).
- Situational: MNF road −0.75, blowout-bounceback +1.0 (lost previous by 19+), turf discrepancy −0.5 against away.
- True Score: ratings update on points-with-ST-TDs-stripped, not raw final. One bad bounce doesn't ricochet through next week's PR.

NBA + MLB still run on the Elo path — Walters' weights are NFL-specific.

DATA YOU ACTUALLY HAVE (use it — these are real, queried just now):
- Power Ratings: NFL on Walters PR scale (≈ 17 baseline), NBA/MLB on Elo (~1500). ${Number(s.rated ?? 0)} teams walked from real completed games.
- Historical games graded: ${Number(s.historical_graded ?? 0)} across seasons ${seasonRange}.
- Historical closing spreads + closing totals: ${Number(s.historical_with_lines ?? 0)} games (NFL via nflverse — same dataset 538 / professional shops use). NBA + MLB historical lines aren't ingested yet.
- EPA / play-by-play aggregates (NFL): ${epaRows} team-season rows across ${epaSeasons} seasons${epaLatestSeason ? ` (latest ${epaLatestSeason})` : ''}. Per-team: net_epa, epa_per_play (offense), pass_epa, rush_epa, success_rate, epa_allowed (defense). NBA + MLB EPA aren't ingested.
- Depth charts (NFL): ${depthCount} starter+backup entries via nflverse. NBA + MLB depth ranks not ingested.
- Auto-graded QB tiers + blue-chip tags (NFL): refreshed once per 24h from EPA + depth (no operator input needed). v1 proxy for PFF grades.
- Current schedule + final scores from ESPN (refreshed hourly per sport). NFL finals also get scoring-summary stripped to compute True Scores for PR updates.
- Current rosters: ${Number(s.rostered_players ?? 0)} players across ${Number(s.rostered_teams ?? 0)} teams (ESPN, weekly).
- Active injury reports: ${Number(s.hurt ?? 0)} Out/Doubtful/IR/PUP entries on tracked teams.
- Sierra Line per upcoming NFL game (Raw PR + situational adjustments). Elo model line for NBA / MLB.
- Odds API: ${Odds.isConfigured() ? 'KEY PRESENT' : 'NO KEY — edge gate dark'}.

PER-SPORT BREAKDOWN (be specific when asked about a single sport):
${perSportLines}

DATA YOU DO NOT HAVE (don't pretend you do):
- NBA / MLB historical book lines, EPA, depth charts. NFL has all three; the others stop at Elo + games + rosters.
- Coaching tendencies, weather forecasts, ref crews. (Not ingested.)
- In-season weekly EPA snapshots. (Have season totals; no week-by-week trend yet.)

CURRENT STATE:
- Loop cycle: ${Number(s.cycle ?? 0)}
- Top-rated: ${topRatedStr}
- QB tiers (auto-graded): ${qbTiersStr}
- Blue-chip tags: ${blueChipsStr}
- Top-5 by net EPA${epaLatestSeason ? ` (${epaLatestSeason})` : ''}:
  ${epaTopStr}
${epaBottomStr ? `- Bottom-5 by net EPA: ${epaBottomStr}\n` : ''}- Open picks (model-driven, sorted by edge — Sierra Line, Raw PR Δ, situational, Kelly):
  ${openPicksStr}
- Key injuries on tracked teams:
  ${injuryStr}

When the operator asks "what do you see" or "what do you have", answer concretely from the data inventory above. For NFL, frame answers in Walters' protocol: PR diff, situational adjustments, Sierra Line, edge vs book, Kelly sizing. For NBA / MLB, the existing Elo model line is the answer.

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

  // NFL-specific cold start: PRs live in the same `rating` column but on
  // a 0..30 points scale (DEFAULT_PR ≈ 17), not the 1500 Elo scale. If a
  // row exists with the legacy Elo default (1500), reset it to DEFAULT_PR
  // so the points-update path doesn't start from a 1500-pt advantage.
  private async getNflPR(team: string): Promise<number> {
    const { rows: [r] } = await this.db.query(
      `SELECT rating FROM ceelo_team_ratings WHERE sport='NFL' AND team=$1`, [team]
    )
    if (!r) return DEFAULT_PR
    const v = Number(r.rating)
    // Legacy Elo rows: anything > 100 is on the old scale. Reset.
    if (v > 100) return DEFAULT_PR
    return v
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

function fmtAmericanOdds(o: number): string {
  if (!Number.isFinite(o) || o === 0) return '?'
  return o > 0 ? `+${Math.round(o)}` : `${Math.round(o)}`
}

function signedFixed(n: number, p: number): string {
  return (n >= 0 ? '+' : '') + n.toFixed(p)
}

function clampTier(n: number): QbTier {
  if (!Number.isFinite(n)) return 3
  const i = Math.round(n)
  if (i <= 1) return 1
  if (i >= 5) return 5
  return i as QbTier
}

// Map a depth-chart position abbreviation to a Walters cluster-injury unit.
// Returns null for positions we don't track (QB/RB/WR/TE/K/P).
function unitFromPosition(pos: string): 'OL' | 'DB' | 'DL' | 'LB' | null {
  const p = pos.toUpperCase()
  if (['LT', 'RT', 'OT', 'LG', 'RG', 'C', 'OG', 'OL'].includes(p)) return 'OL'
  if (['CB', 'S', 'FS', 'SS', 'NCB', 'DB'].includes(p)) return 'DB'
  if (['DE', 'DT', 'NT', 'EDGE', 'DL'].includes(p)) return 'DL'
  if (['ILB', 'OLB', 'MLB', 'LB', 'WLB', 'SLB'].includes(p)) return 'LB'
  return null
}

// Walters' cluster-injury rule: 3+ starters out in any one unit ⇒ -1.5 tax.
function clusterTaxFromOuts(outs: Record<string, number>): number {
  for (const unit of Object.keys(outs)) {
    if (outs[unit] >= 3) return CLUSTER_INJURY_TAX
  }
  return 0
}

// American-odds payout calc — exposed so the picks API uses the same math.
// Returns NET profit on a winning bet (does not include stake).
export function netProfit(stake: number, odds: number): number {
  if (odds < 0) return +(stake * (100 / Math.abs(odds))).toFixed(2)
  return +(stake * (odds / 100)).toFixed(2)
}
