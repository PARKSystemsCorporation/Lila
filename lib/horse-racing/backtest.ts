// Backtest framework — replays the yield engine against our own
// ceelo_runner_odds + ceelo_results snapshots. NO upstream calls (free
// tier is 1 RPS; a 30-day historical pull would block the loop for ~20
// min). The math is just calculateYield() applied to a Race rebuilt from
// the latest pre-off snapshot per runner. Flat unit stake (1).
//
// Pure function: takes a PoolClient + window + intensity threshold,
// returns a typed envelope suitable for the /api/ceelo/backtest route.
// Unit-testable: backtestRaces() accepts an in-memory list so vitest
// can exercise the math without a live database.

import type { PoolClient } from 'pg'
import { calculateYield } from './yield'
import type { Race, Runner } from './types'

export interface BacktestInput {
  from: Date
  to: Date
  intensity: number     // 1..10 threshold; signals below this don't emit a pick
}

export interface BacktestPick {
  race_id: string
  course: string
  country: string | null
  off_dt: string
  horse_id: string
  horse: string
  intensity: number
  edge_pct: number | null
  odds_decimal: number | null
  won: boolean
  profit: number        // unit stake — net P&L on this pick (excludes stake)
}

export interface BacktestSummary {
  window: { from: string; to: string }
  intensity: number
  races_considered: number
  picks_emitted: number
  wins: number
  losses: number
  roi_pct: number       // total_profit / total_stake * 100, 1dp
  hit_rate: number      // wins / (wins + losses) * 100, 1dp
  by_intensity: Record<string, { picks: number; wins: number; roi_pct: number }>
  by_country: Record<string, { picks: number; wins: number; roi_pct: number }>
  picks: BacktestPick[] // capped to 100 for the API envelope
}

// 30 days hard cap. Operator-passed range is silently clamped — the API
// returns the clamped window in the envelope so the UI can show it.
export const MAX_WINDOW_DAYS = 30

// Row shape coming back from the DB query that reconstructs each race's
// final pre-off snapshot. Reused by tests via the pure backtestRaces().
export interface BacktestRaceFixture {
  race_id: string
  course: string
  country: string | null
  off_dt: string
  field_size: number
  winner_id: string | null
  runners: Runner[]
}

export function clampWindow(from: Date, to: Date): { from: Date; to: Date } {
  if (to.getTime() < from.getTime()) [from, to] = [to, from]
  const span = (to.getTime() - from.getTime()) / 86_400_000
  if (span > MAX_WINDOW_DAYS) {
    return { from: new Date(to.getTime() - MAX_WINDOW_DAYS * 86_400_000), to }
  }
  return { from, to }
}

// Core math — pure. Operates on a list of pre-built fixtures so vitest
// can exercise it directly. The DB loader (loadFixtures) is the only
// side-effectful piece.
export function backtestRaces(
  fixtures: BacktestRaceFixture[],
  intensity: number,
  window: { from: string; to: string },
): BacktestSummary {
  const picks: BacktestPick[] = []
  let wins = 0
  let losses = 0
  let totalProfit = 0
  let totalStake = 0
  const byIntensity = new Map<number, { picks: number; wins: number; profit: number }>()
  const byCountry = new Map<string, { picks: number; wins: number; profit: number }>()

  for (const f of fixtures) {
    if (!f.winner_id) continue
    const race: Race = {
      race_id: f.race_id,
      course: f.course,
      country: f.country,
      off_time: '',
      off_dt: f.off_dt,
      race_name: '',
      distance: null,
      going: null,
      type: null,
      field_size: f.field_size,
      runners: f.runners,
    }
    const signal = calculateYield(race)
    if (!signal.top_runner) continue
    if (signal.intensity < intensity) continue

    const won = signal.top_runner.horse_id === f.winner_id
    const odds = signal.top_runner.odds_decimal
    // Profit on a unit stake: (odds - 1) on a win, -1 on a loss.
    const profit = odds != null && won ? +(odds - 1).toFixed(4) : (won ? 0 : -1)

    if (won) wins++; else losses++
    totalProfit += profit
    totalStake += 1

    const bIn = byIntensity.get(signal.intensity) ?? { picks: 0, wins: 0, profit: 0 }
    bIn.picks++; if (won) bIn.wins++; bIn.profit += profit
    byIntensity.set(signal.intensity, bIn)

    const countryKey = f.country ?? 'UNK'
    const bC = byCountry.get(countryKey) ?? { picks: 0, wins: 0, profit: 0 }
    bC.picks++; if (won) bC.wins++; bC.profit += profit
    byCountry.set(countryKey, bC)

    picks.push({
      race_id: f.race_id,
      course: f.course,
      country: f.country,
      off_dt: f.off_dt,
      horse_id: signal.top_runner.horse_id,
      horse: signal.top_runner.horse,
      intensity: signal.intensity,
      edge_pct: signal.top_runner.edge_pct,
      odds_decimal: signal.top_runner.odds_decimal,
      won,
      profit,
    })
  }

  const roi_pct = totalStake > 0 ? +((totalProfit / totalStake) * 100).toFixed(1) : 0
  const hit_rate = picks.length > 0 ? +((wins / picks.length) * 100).toFixed(1) : 0

  return {
    window,
    intensity,
    races_considered: fixtures.length,
    picks_emitted: picks.length,
    wins,
    losses,
    roi_pct,
    hit_rate,
    by_intensity: Object.fromEntries(
      [...byIntensity.entries()]
        .sort(([a], [b]) => a - b)
        .map(([k, v]) => [
          String(k),
          { picks: v.picks, wins: v.wins, roi_pct: +((v.profit / v.picks) * 100).toFixed(1) },
        ])
    ),
    by_country: Object.fromEntries(
      [...byCountry.entries()].map(([k, v]) => [
        k,
        { picks: v.picks, wins: v.wins, roi_pct: +((v.profit / v.picks) * 100).toFixed(1) },
      ])
    ),
    picks: picks.slice(0, 100),
  }
}

// DB loader — reads ceelo_races (status='final', off_dt in window) joined
// to the latest per-runner ceelo_runner_odds row with fetched_at < off_dt.
export async function loadFixtures(
  db: PoolClient,
  window: { from: Date; to: Date },
): Promise<BacktestRaceFixture[]> {
  const races = await db.query<{
    race_id: string
    course: string
    country: string | null
    off_dt: string
    field_size: number
    winner_id: string | null
  }>(
    `SELECT r.race_id, r.course, r.country,
            to_char(r.off_dt AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS off_dt,
            r.field_size,
            res.winner_id
     FROM ceelo_races r
     LEFT JOIN ceelo_results res ON res.race_id = r.race_id
     WHERE r.status = 'final'
       AND r.off_dt >= $1 AND r.off_dt <= $2
     ORDER BY r.off_dt ASC`,
    [window.from.toISOString(), window.to.toISOString()]
  )
  if (races.rows.length === 0) return []

  const raceIds = races.rows.map(r => r.race_id)
  const runners = await db.query<{
    race_id: string
    horse_id: string
    horse: string
    number: string | null
    odds_decimal: string | number | null
  }>(
    `SELECT run.race_id, run.horse_id, run.horse, run.number,
            latest.odds_decimal
     FROM ceelo_runners run
     LEFT JOIN ceelo_races r ON r.race_id = run.race_id
     LEFT JOIN LATERAL (
       SELECT odds_decimal FROM ceelo_runner_odds ro
       WHERE ro.race_id = run.race_id
         AND ro.horse_id = run.horse_id
         AND ro.fetched_at < r.off_dt
       ORDER BY ro.fetched_at DESC LIMIT 1
     ) latest ON true
     WHERE run.race_id = ANY($1::text[])`,
    [raceIds]
  )

  const byRace = new Map<string, Runner[]>()
  for (const row of runners.rows) {
    const odds = row.odds_decimal == null
      ? null
      : (typeof row.odds_decimal === 'number' ? row.odds_decimal : parseFloat(row.odds_decimal))
    const list = byRace.get(row.race_id) ?? []
    list.push({
      horse_id: row.horse_id,
      horse: row.horse,
      number: row.number,
      draw: null,
      jockey: null,
      trainer: null,
      age: null,
      weight_lbs: null,
      form: null,
      odds_decimal: Number.isFinite(odds as number) ? (odds as number) : null,
    })
    byRace.set(row.race_id, list)
  }

  return races.rows.map(r => ({
    race_id: r.race_id,
    course: r.course,
    country: r.country,
    off_dt: r.off_dt,
    field_size: r.field_size,
    winner_id: r.winner_id,
    runners: byRace.get(r.race_id) ?? [],
  }))
}

export async function runBacktest(
  db: PoolClient,
  input: BacktestInput,
): Promise<BacktestSummary> {
  const window = clampWindow(input.from, input.to)
  const fixtures = await loadFixtures(db, window)
  return backtestRaces(
    fixtures,
    input.intensity,
    { from: window.from.toISOString(), to: window.to.toISOString() },
  )
}
