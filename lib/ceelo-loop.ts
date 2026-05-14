import OpenAI from 'openai'
import type { PoolClient } from 'pg'
import { cfg } from './config'
import { llmCall, LLMBudgetExceeded } from './llm'
import * as Racing from './horse-racing/racing-api'
import { calculateYield } from './horse-racing/yield'
import type { Race, RaceResult, Runner } from './horse-racing/types'

// ── Ceelo: thoroughbred-racing yield engine, autonomy loop ────────────────
//
// Math-driven, no LLM in the picks path. Each cycle does six idempotent
// steps; each step is internally time-gated.
//
//   C0 — Refresh today's racecards from The Racing API.
//   C1 — Grade races whose off time has passed; stamp model_outcome on
//        any source='model' picks for those races.
//   C2 — Snapshot per-runner odds for races within the next 6h.
//   C3 — Compute fair odds + edge_pct per runner via the yield engine.
//   C4 — Emit a 'win'-market pick per race when intensity ≥ threshold.
//   C5 — Reconcile: cancel open picks whose race has gone off.
//
// LLM is NOT in the picks path. Reasoning text comes from the yield engine
// (deterministic templates). LLM only runs in handleChat() for operator Q&A.

const SCHEDULE_REFRESH_MIN = 5    // racecards change inside the day
const ODDS_REFRESH_MIN     = 1    // racing odds drift fast
const GRADE_REFRESH_MIN    = 30
const INTENSITY_THRESHOLD  = 6    // yield engine 1..10; ≥6 fires a pick
const GREEN_INTENSITY      = 8    // ≥8 → 'green' confidence

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

  async run(): Promise<{ logMessage: string; logType: 'info' | 'success' | 'warn' } | null> {
    const chatMsg = await this.handleChat().catch((e) => `chat err: ${err(e)}`)
    const cycleMsg = (await this.shouldRunCycle()) ? await this.runCycle() : null

    if (cycleMsg) {
      const merged = chatMsg ? `${cycleMsg.logMessage} · ${chatMsg}` : cycleMsg.logMessage
      return { ...cycleMsg, logMessage: merged }
    }
    if (chatMsg) return { logMessage: `Ceelo — ${chatMsg}`, logType: 'info' }
    return null
  }

  private async runCycle(): Promise<{ logMessage: string; logType: 'info' | 'success' | 'warn' }> {
    if (!Racing.isConfigured()) {
      await this.db.query(
        `UPDATE ceelo_state SET last_run_at=NOW(), cycle=cycle+1, updated_at=NOW() WHERE id=1`
      )
      return {
        logMessage: 'Ceelo — RACING_API_USERNAME / RACING_API_PASSWORD not set; loop idle.',
        logType: 'info',
      }
    }

    const notes: string[] = []
    let warned = false
    const note = (msg: string) => { if (msg) notes.push(msg) }

    let gradedSummary = ''
    let edgeSummary   = ''

    try { note(await this.c0_refreshCards()) }                       catch (e) { warned = true; note(`C0 ${err(e)}`) }
    try { gradedSummary = await this.c1_gradeResults(); note(gradedSummary) } catch (e) { warned = true; note(`C1 ${err(e)}`) }
    const refreshedRaces = await this.c2_snapshotOdds().catch((e) => { warned = true; note(`C2 ${err(e)}`); return [] as Race[] })
    if (refreshedRaces.length) note(`C2 odds ${refreshedRaces.length}`)
    try { note(await this.c3_computeYield(refreshedRaces)) }         catch (e) { warned = true; note(`C3 ${err(e)}`) }
    try { edgeSummary = await this.c4_emitPicks(refreshedRaces); note(edgeSummary) } catch (e) { warned = true; note(`C4 ${err(e)}`) }
    try { note(await this.c5_reconcile()) }                          catch (e) { warned = true; note(`C5 ${err(e)}`) }

    await this.db.query(
      `UPDATE ceelo_state SET last_run_at=NOW(), cycle=cycle+1, updated_at=NOW() WHERE id=1`
    )

    const msg = notes.filter(Boolean).join(' · ') || 'idle (no races on the board)'
    return { logMessage: `Ceelo — ${msg}`, logType: warned ? 'warn' : 'info' }
  }

  // ── C0: refresh today's racecards ───────────────────────────────────────
  // Upserts ceelo_races + ceelo_runners. Gate: SCHEDULE_REFRESH_MIN.

  private async c0_refreshCards(): Promise<string> {
    const { rows: [s] } = await this.db.query('SELECT last_schedule_at FROM ceelo_state WHERE id=1')
    if (s?.last_schedule_at && minutesSince(s.last_schedule_at) < SCHEDULE_REFRESH_MIN) return ''

    const races = await Racing.getTodayRacecards()
    let races_upserted = 0
    let runners_upserted = 0
    const meet_ids = new Set<string>()
    for (const r of races) {
      if (!r.race_id) continue
      // NA race_id is "${meet_id}:${race_number}"; UK race_id has no
      // colon. Both shapes survive this prefix extraction.
      const colon = r.race_id.lastIndexOf(':')
      meet_ids.add(colon > 0 ? r.race_id.slice(0, colon) : r.race_id)
      await this.db.query(
        `INSERT INTO ceelo_races
           (race_id, course, country, off_dt, off_time, race_name, distance, going, type,
            field_size, status, refreshed_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'scheduled',NOW())
         ON CONFLICT (race_id) DO UPDATE
           SET course      = EXCLUDED.course,
               country     = EXCLUDED.country,
               off_dt      = EXCLUDED.off_dt,
               off_time    = EXCLUDED.off_time,
               race_name   = EXCLUDED.race_name,
               distance    = EXCLUDED.distance,
               going       = EXCLUDED.going,
               type        = EXCLUDED.type,
               field_size  = EXCLUDED.field_size,
               refreshed_at = NOW()`,
        [r.race_id, r.course, r.country ?? null, isoOrNow(r.off_dt), r.off_time, r.race_name,
         r.distance, r.going, r.type, r.runners.length]
      )
      races_upserted++

      for (const runner of r.runners) {
        if (!runner.horse_id) continue
        await this.db.query(
          `INSERT INTO ceelo_runners
             (race_id, horse_id, horse, number, draw, jockey, trainer, age, weight_lbs, form)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (race_id, horse_id) DO UPDATE
             SET horse=EXCLUDED.horse,
                 number=EXCLUDED.number,
                 draw=EXCLUDED.draw,
                 jockey=EXCLUDED.jockey,
                 trainer=EXCLUDED.trainer,
                 age=EXCLUDED.age,
                 weight_lbs=EXCLUDED.weight_lbs,
                 form=EXCLUDED.form`,
          [r.race_id, runner.horse_id, runner.horse, runner.number, runner.draw,
           runner.jockey, runner.trainer, runner.age, runner.weight_lbs, runner.form]
        )
        runners_upserted++
      }
    }
    await this.db.query(`UPDATE ceelo_state SET last_schedule_at=NOW() WHERE id=1`)
    if (races_upserted === 0) return ''
    const meetCount = meet_ids.size
    return meetCount > 1 || (meetCount === 1 && races_upserted > 1)
      ? `C0 cards ${races_upserted} races / ${meetCount} meet${meetCount === 1 ? '' : 's'} (${runners_upserted} runners)`
      : `C0 cards ${races_upserted}/${runners_upserted}`
  }

  // ── C1: grade finished races ────────────────────────────────────────────
  // Pick scheduled races whose off_dt was at least 30 min ago, pull results,
  // stamp ceelo_results + ceelo_picks.model_outcome.

  private async c1_gradeResults(): Promise<string> {
    const { rows: [s] } = await this.db.query('SELECT last_grade_at FROM ceelo_state WHERE id=1')
    if (s?.last_grade_at && minutesSince(s.last_grade_at) < GRADE_REFRESH_MIN) return ''

    const { rows: pending } = await this.db.query<{ race_id: string }>(
      `SELECT race_id FROM ceelo_races
       WHERE status='scheduled' AND off_dt < NOW() - INTERVAL '20 minutes'
       ORDER BY off_dt ASC LIMIT 30`
    )

    let graded = 0
    let modelGraded = 0
    for (const p of pending) {
      const result: RaceResult | null = await Racing.getResult(p.race_id).catch(() => null)
      if (!result || result.finishers.length === 0) continue
      const winner = result.finishers[0]
      await this.db.query(
        `INSERT INTO ceelo_results (race_id, finished_at, winner_id, winner_sp, finishers)
         VALUES ($1,$2,$3,$4,$5::jsonb)
         ON CONFLICT (race_id) DO UPDATE
           SET finished_at=EXCLUDED.finished_at,
               winner_id=EXCLUDED.winner_id,
               winner_sp=EXCLUDED.winner_sp,
               finishers=EXCLUDED.finishers`,
        [p.race_id, isoOrNow(result.finished_at), winner.horse_id, winner.sp_decimal,
         JSON.stringify(result.finishers)]
      )
      await this.db.query(
        `UPDATE ceelo_races SET status='final', finished_at=$2 WHERE race_id=$1`,
        [p.race_id, isoOrNow(result.finished_at)]
      )
      const graded_res = await this.db.query(
        `UPDATE ceelo_picks
         SET model_outcome   = CASE WHEN horse_id=$2 THEN 'win' ELSE 'loss' END,
             model_graded_at = NOW(),
             updated_at      = NOW()
         WHERE race_id=$1 AND source='model' AND model_outcome IS NULL`,
        [p.race_id, winner.horse_id]
      )
      modelGraded += graded_res.rowCount ?? 0
      graded++
    }
    await this.db.query(`UPDATE ceelo_state SET last_grade_at=NOW() WHERE id=1`)
    if (!graded) return ''
    return modelGraded > 0
      ? `C1 graded ${graded} races · ${modelGraded} model picks`
      : `C1 graded ${graded} races`
  }

  // ── C2: snapshot per-runner odds ────────────────────────────────────────
  // For every race within ±6h of now whose status != 'final', refresh from
  // the per-race endpoint and insert a row in ceelo_runner_odds per runner.
  // Returns the refreshed Race objects so C3 can compute yield without
  // re-fetching.

  private async c2_snapshotOdds(): Promise<Race[]> {
    const { rows: [s] } = await this.db.query('SELECT last_odds_at FROM ceelo_state WHERE id=1')
    if (s?.last_odds_at && minutesSince(s.last_odds_at) < ODDS_REFRESH_MIN) return []

    const { rows: targets } = await this.db.query<{ race_id: string }>(
      `SELECT race_id FROM ceelo_races
       WHERE status='scheduled'
         AND off_dt BETWEEN NOW() - INTERVAL '30 minutes' AND NOW() + INTERVAL '6 hours'
       ORDER BY off_dt ASC LIMIT 40`
    )
    if (!targets.length) {
      await this.db.query(`UPDATE ceelo_state SET last_odds_at=NOW() WHERE id=1`)
      return []
    }

    const refreshed: Race[] = []
    for (const t of targets) {
      const race = await Racing.getRacecard(t.race_id).catch(() => null)
      if (!race) continue
      let any = false
      for (const runner of race.runners) {
        if (runner.odds_decimal == null) continue
        await this.db.query(
          `INSERT INTO ceelo_runner_odds (race_id, horse_id, odds_decimal, fetched_at)
           VALUES ($1,$2,$3,NOW())`,
          [race.race_id, runner.horse_id, runner.odds_decimal]
        )
        any = true
      }
      if (any) refreshed.push(race)
    }
    await this.db.query(`UPDATE ceelo_state SET last_odds_at=NOW() WHERE id=1`)
    return refreshed
  }

  // ── C3: compute fair odds + edge ────────────────────────────────────────
  // Walks the races refreshed in C2, computes yield, stamps fair_decimal +
  // edge_pct back onto the just-inserted ceelo_runner_odds rows.

  private async c3_computeYield(races: Race[]): Promise<string> {
    if (!races.length) return ''
    let updated = 0
    for (const race of races) {
      const signal = calculateYield(race)
      const overround = race.runners
        .filter(r => r.odds_decimal != null && r.odds_decimal > 1)
        .reduce((s, r) => s + 1 / (r.odds_decimal as number), 0)
      if (overround <= 0) continue
      for (const runner of race.runners) {
        if (runner.odds_decimal == null) continue
        const fairProb = (1 / runner.odds_decimal) / overround
        const fairDecimal = +(1 / fairProb).toFixed(2)
        const edgePct = +(((fairDecimal - runner.odds_decimal) / runner.odds_decimal) * 100).toFixed(2)
        const res = await this.db.query(
          `UPDATE ceelo_runner_odds
           SET fair_decimal=$3, edge_pct=$4
           WHERE id = (
             SELECT id FROM ceelo_runner_odds
             WHERE race_id=$1 AND horse_id=$2
             ORDER BY fetched_at DESC LIMIT 1
           )`,
          [race.race_id, runner.horse_id, fairDecimal, edgePct]
        )
        updated += res.rowCount ?? 0
      }
      // Touch signal so it's available to fileCycleNote in the future.
      void signal
    }
    return updated > 0 ? `C3 yield ${updated}` : ''
  }

  // ── C4: emit picks ──────────────────────────────────────────────────────
  // For each refreshed race whose signal clears INTENSITY_THRESHOLD, emit a
  // 'win' pick on the top runner (unless one already exists for this race).

  private async c4_emitPicks(races: Race[]): Promise<string> {
    if (!races.length) return ''
    let emitted = 0
    let green = 0
    for (const race of races) {
      const signal = calculateYield(race)
      if (!signal.top_runner) continue
      if (signal.intensity < INTENSITY_THRESHOLD) continue

      const { rows: existing } = await this.db.query(
        `SELECT 1 FROM ceelo_picks WHERE race_id=$1 AND status='open' LIMIT 1`,
        [race.race_id]
      )
      if (existing.length) continue

      const top = signal.top_runner
      const runner = race.runners.find(r => r.horse_id === top.horse_id)
      const fair = top.fair_decimal ?? null
      const book = top.odds_decimal ?? null
      const modelProb = fair != null && fair > 1 ? +(1 / fair).toFixed(3) : null
      const confidence = signal.intensity >= GREEN_INTENSITY ? 'green' : 'yellow'
      if (confidence === 'green') green++

      const raceLabel = formatRaceLabel(race)
      await this.db.query(
        `INSERT INTO ceelo_picks
           (race_id, horse_id, race_label, horse_name, market, off_dt,
            model_prob, fair_decimal, book_decimal, edge_pct,
            intensity, velocity, reasoning, confidence, source, status)
         VALUES ($1,$2,$3,$4,'win',$5,$6,$7,$8,$9,$10,$11,$12,$13,'model','open')`,
        [
          race.race_id, top.horse_id, raceLabel, top.horse, isoOrNull(race.off_dt),
          modelProb, fair, book, top.edge_pct,
          signal.intensity, signal.velocity, signal.reasoning, confidence,
        ]
      )
      void runner
      emitted++
    }
    if (!emitted) return ''
    return green > 0 ? `C4 picks ${emitted} (${green} green)` : `C4 picks ${emitted}`
  }

  // ── C5: reconcile ───────────────────────────────────────────────────────
  // Auto-skip any open pick whose race has already started — the operator
  // missed the window. Mirrors the old CeeloLoop's reconcile semantics.

  private async c5_reconcile(): Promise<string> {
    const res = await this.db.query(
      `UPDATE ceelo_picks
       SET status='skipped', updated_at=NOW()
       WHERE status='open' AND off_dt IS NOT NULL AND off_dt < NOW()`
    )
    const n = res.rowCount ?? 0
    return n > 0 ? `C5 auto-skipped ${n} (went off)` : ''
  }

  // ── chat: operator Q&A on thread='ceelo' ────────────────────────────────

  private async handleChat(): Promise<string> {
    if (!this.ai) return ''

    const { rows: latest } = await this.db.query(
      `SELECT id, sender, content
       FROM chat_messages
       WHERE thread='ceelo'
       ORDER BY id DESC LIMIT 1`
    )
    if (!latest.length) return ''
    const last = latest[0]
    if (last.sender !== 'user') return ''

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

    // Snapshot Ceelo's world: today's races + top yield runners + open picks.
    // Sequentialized per b5b845b on main (pg DEP_PG_QUERY_CONCURRENT).
    const topYield = await this.db.query(
      `SELECT r.course, r.off_time, r.race_name, run.horse, latest.edge_pct,
              latest.odds_decimal, latest.fair_decimal
       FROM ceelo_races r
       JOIN LATERAL (
         SELECT ro.horse_id, ro.odds_decimal, ro.fair_decimal, ro.edge_pct
         FROM ceelo_runner_odds ro
         WHERE ro.race_id = r.race_id AND ro.edge_pct IS NOT NULL
         ORDER BY ro.edge_pct DESC NULLS LAST, ro.fetched_at DESC
         LIMIT 1
       ) latest ON true
       JOIN ceelo_runners run ON run.race_id = r.race_id AND run.horse_id = latest.horse_id
       WHERE r.status='scheduled' AND r.off_dt BETWEEN NOW() AND NOW() + INTERVAL '8 hours'
       ORDER BY latest.edge_pct DESC NULLS LAST
       LIMIT 8`
    )
    const openPicks = await this.db.query(
      `SELECT race_label, horse_name, fair_decimal, book_decimal, edge_pct, intensity, velocity
       FROM ceelo_picks
       WHERE status='open'
       ORDER BY intensity DESC NULLS LAST, created_at DESC
       LIMIT 6`
    )
    const status = await this.db.query(
      `SELECT cycle,
              (SELECT COUNT(*) FROM ceelo_races WHERE status='scheduled' AND off_dt > NOW()) AS upcoming_races,
              (SELECT COUNT(*) FROM ceelo_races WHERE status='final')                         AS final_races,
              (SELECT COUNT(*) FROM ceelo_runner_odds WHERE fetched_at > NOW() - INTERVAL '30 minutes') AS recent_odds_snapshots,
              (SELECT COUNT(*) FROM ceelo_picks WHERE status='open')                          AS open_picks,
              (SELECT COUNT(*) FROM ceelo_picks WHERE source='model' AND model_outcome='win') AS model_wins,
              (SELECT COUNT(*) FROM ceelo_picks WHERE source='model' AND model_outcome='loss') AS model_losses
       FROM ceelo_state WHERE id=1`
    )

    const s = status.rows[0] ?? {}
    const yieldLines = topYield.rows.length
      ? topYield.rows.map((r: { course: string; off_time: string; horse: string; edge_pct: string | null; odds_decimal: string | null; fair_decimal: string | null }) =>
          `  ${r.off_time} ${r.course} — ${r.horse} (book ${numOrDash(r.odds_decimal)} / fair ${numOrDash(r.fair_decimal)} / edge ${signedFixed(parseFloat(r.edge_pct ?? '0'), 1)}%)`).join('\n')
      : '  (no live yield on the board)'

    const pickLines = openPicks.rows.length
      ? openPicks.rows.map((p: { race_label: string; horse_name: string; fair_decimal: string | null; book_decimal: string | null; edge_pct: string | null; intensity: number | null; velocity: string | null }) =>
          `  ${p.race_label} — ${p.horse_name} (book ${numOrDash(p.book_decimal)} / fair ${numOrDash(p.fair_decimal)} / edge ${signedFixed(parseFloat(p.edge_pct ?? '0'), 1)}%, int ${p.intensity ?? '?'}/10 ${p.velocity ?? '?'})`).join('\n')
      : '  (no open picks)'

    const system = [
      'You are Ceelo, a thoroughbred-racing yield engine. You answer the operator on the chat thread.',
      'Voice: terse, plainspoken, no fluff. Mention yields and edges in concrete numbers, not adjectives.',
      'Rules:',
      '  • The pick path is deterministic — yield engine math, NO LLM. You only chat ABOUT picks.',
      '  • If asked about non-racing sports, say "Ceelo retired NFL/NBA/MLB; horses only now."',
      '  • If RACING_API_USERNAME / RACING_API_PASSWORD is unset the loop is idle; say so.',
      '  • Edge% is fair_decimal vs book_decimal: positive = value side, negative = overlay risk.',
      '',
      `Current state (cycle ${s.cycle ?? 0}):`,
      `  upcoming races=${s.upcoming_races ?? 0}, final today=${s.final_races ?? 0}, fresh odds snapshots (30m)=${s.recent_odds_snapshots ?? 0}`,
      `  open picks=${s.open_picks ?? 0}, model record=${s.model_wins ?? 0}W-${s.model_losses ?? 0}L`,
      '',
      'Top yield runners (next 8h):',
      yieldLines,
      '',
      'Open picks:',
      pickLines,
      '',
      'Recent transcript:',
      transcript,
      '',
      `OPERATOR: ${last.content}`,
      'CEELO:',
    ].join('\n')

    try {
      const reply = await llmCall({
        ai: this.ai,
        module: 'ceelo.chat',
        model: 'deepseek-chat',
        messages: [{ role: 'system', content: system }],
        max_tokens: 220,
        temperature: 0.4,
        critical: true,
      })
      const text = reply.content.trim()
      if (!text) return ''
      await this.db.query(
        `INSERT INTO chat_messages (thread, sender, content) VALUES ('ceelo','ceelo',$1)`,
        [text]
      )
      return text.slice(0, 80)
    } catch (e) {
      if (e instanceof LLMBudgetExceeded) return 'chat skipped (budget)'
      return `chat err: ${err(e)}`
    }
  }
}

// ── helpers (free) ────────────────────────────────────────────────────────

function minutesSince(ts: Date | string): number {
  const t = typeof ts === 'string' ? new Date(ts).getTime() : ts.getTime()
  return (Date.now() - t) / 60_000
}

function err(e: unknown): string {
  return String(e instanceof Error ? e.message : e).slice(0, 120)
}

function isoOrNull(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isFinite(d.getTime()) ? d.toISOString() : null
}

function isoOrNow(iso: string | null | undefined): string {
  return isoOrNull(iso) ?? new Date().toISOString()
}

function numOrDash(v: string | number | null | undefined): string {
  if (v == null || v === '') return '—'
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n.toFixed(2) : '—'
}

function signedFixed(n: number, p: number): string {
  if (!Number.isFinite(n)) return '?'
  return (n >= 0 ? '+' : '') + n.toFixed(p)
}

function formatRaceLabel(race: Race): string {
  const parts: string[] = [`${race.off_time} ${race.course}`]
  if (race.going) parts.push(race.going)
  if (race.distance) parts.push(race.distance)
  return parts.join(' · ')
}

// Decimal-odds payout calc — exposed so /api/picks settle math reuses it.
// Returns NET profit on a winning bet (excludes stake).
export function netProfit(stake: number, decimalOdds: number): number {
  if (!Number.isFinite(stake) || !Number.isFinite(decimalOdds) || decimalOdds <= 1) return 0
  return +(stake * (decimalOdds - 1)).toFixed(2)
}
