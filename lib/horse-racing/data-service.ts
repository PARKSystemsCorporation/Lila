// Thin facade over racing-api.ts so consumers (API route, CeeloLoop)
// don't import the upstream adapter directly. Keeps the swap-out path
// clean if we ever introduce additional retail feeds.
//
// The odds-history reader is DB-backed (ceelo_runner_odds), not upstream:
// the drill-in page wants every snapshot the C2 phase has collected, and
// the upstream only exposes the current price.

import type { PoolClient } from 'pg'
import * as racing from './racing-api'
import type { Race, RaceResult, Runner } from './types'

let lastRefreshTs = 0

export interface OddsHistoryPoint {
  t: number          // ms epoch
  decimal: number | null
  fair: number | null
  edge: number | null
}

export class HorseDataService {
  isConfigured(): boolean {
    return racing.isConfigured()
  }

  async getTodayRacecards(): Promise<Race[]> {
    const races = await racing.getTodayRacecards()
    if (races.length > 0) lastRefreshTs = Date.now()
    return races
  }

  async getRacecard(raceId: string): Promise<Race | null> {
    return racing.getRacecard(raceId)
  }

  async getResult(raceId: string): Promise<RaceResult | null> {
    return racing.getResult(raceId)
  }

  // Hydrate a Race entirely from our DB (ceelo_races + ceelo_runners +
  // latest ceelo_runner_odds row per runner). Used by /api/horse-racing/[raceId]
  // as a fallback when upstream creds are missing — keeps the drill-in
  // exercisable from seeded fixtures alone.
  async getRacecardFromDb(db: PoolClient, raceId: string): Promise<Race | null> {
    const raceRes = await db.query<{
      race_id: string
      course: string
      country: string | null
      off_dt: string | null
      off_time: string
      race_name: string
      distance: string | null
      going: string | null
      type: string | null
      field_size: number
    }>(
      `SELECT race_id, course, country,
              to_char(off_dt AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS off_dt,
              off_time, race_name, distance, going, type, field_size
       FROM ceelo_races WHERE race_id=$1`,
      [raceId]
    )
    const r = raceRes.rows[0]
    if (!r) return null

    const runnersRes = await db.query<{
      horse_id: string
      horse: string
      number: string | null
      draw: number | null
      jockey: string | null
      trainer: string | null
      age: number | null
      weight_lbs: number | null
      form: string | null
      odds_decimal: string | number | null
    }>(
      `SELECT run.horse_id, run.horse, run.number, run.draw, run.jockey, run.trainer,
              run.age, run.weight_lbs, run.form,
              latest.odds_decimal
       FROM ceelo_runners run
       LEFT JOIN LATERAL (
         SELECT odds_decimal FROM ceelo_runner_odds ro
         WHERE ro.race_id=run.race_id AND ro.horse_id=run.horse_id
         ORDER BY ro.fetched_at DESC LIMIT 1
       ) latest ON true
       WHERE run.race_id=$1
       ORDER BY COALESCE(NULLIF(regexp_replace(run.number, '\\D', '', 'g'), '')::int, 999)`,
      [raceId]
    )
    const runners: Runner[] = runnersRes.rows.map((row) => ({
      horse_id: row.horse_id,
      horse: row.horse,
      number: row.number,
      draw: row.draw,
      jockey: row.jockey,
      trainer: row.trainer,
      age: row.age,
      weight_lbs: row.weight_lbs,
      form: row.form,
      odds_decimal: row.odds_decimal == null
        ? null
        : (typeof row.odds_decimal === 'number' ? row.odds_decimal : parseFloat(row.odds_decimal)),
    }))

    return {
      race_id: r.race_id,
      course: r.course,
      country: r.country,
      off_time: r.off_time,
      off_dt: r.off_dt ?? '',
      race_name: r.race_name,
      distance: r.distance,
      going: r.going,
      type: r.type,
      field_size: r.field_size,
      runners,
    }
  }

  // Per-runner odds history from ceelo_runner_odds, oldest first. When
  // horseId is omitted, returns a horse_id → series[] map for the whole
  // race. Window cap (rows) keeps a wild C2 storm from dragging the API.
  async getOddsHistory(
    db: PoolClient,
    raceId: string,
    horseId?: string,
    limitPerRunner = 240,
  ): Promise<Record<string, OddsHistoryPoint[]>> {
    const rows = await db.query<{
      horse_id: string
      t: string
      odds_decimal: string | number | null
      fair_decimal: string | number | null
      edge_pct: string | number | null
    }>(
      `SELECT horse_id,
              (EXTRACT(EPOCH FROM fetched_at) * 1000)::bigint::text AS t,
              odds_decimal, fair_decimal, edge_pct
       FROM ceelo_runner_odds
       WHERE race_id = $1
         AND ($2::text IS NULL OR horse_id = $2)
       ORDER BY horse_id, fetched_at ASC`,
      [raceId, horseId ?? null]
    )
    const out: Record<string, OddsHistoryPoint[]> = {}
    for (const r of rows.rows) {
      const series = out[r.horse_id] ?? (out[r.horse_id] = [])
      series.push({
        t: Number(r.t),
        decimal: numOrNull(r.odds_decimal),
        fair: numOrNull(r.fair_decimal),
        edge: numOrNull(r.edge_pct),
      })
    }
    // Per-runner cap (apply after grouping to keep the SQL simple).
    for (const k of Object.keys(out)) {
      if (out[k].length > limitPerRunner) out[k] = out[k].slice(-limitPerRunner)
    }
    return out
  }

  status() {
    return {
      creds_ok: racing.isConfigured(),
      cache_size: racing.cacheSize(),
      last_refresh_ts: lastRefreshTs || null,
    }
  }
}

function numOrNull(v: string | number | null | undefined): number | null {
  if (v == null) return null
  const n = typeof v === 'number' ? v : parseFloat(v)
  return Number.isFinite(n) ? n : null
}

let svc: HorseDataService | null = null

export function getHorseDataService(): HorseDataService {
  if (!svc) svc = new HorseDataService()
  return svc
}
