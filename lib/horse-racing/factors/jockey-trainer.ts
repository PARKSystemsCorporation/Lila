// Jockey / trainer modifiers backed by the rolling 30-day win-rate
// rolled up nightly into `jockey_stats` / `trainer_stats`. Cold-start
// rows return null so the composite blend renormalises around the
// remaining factors instead of penalising new connections.
//
// Map win_rate ∈ [0, 0.30] linearly onto 1..10 then clamp. A 30%+
// strike-rate puts a jockey/trainer in the top tier (Frankie Dettori
// at his peak, Aidan O'Brien on his good two-year-olds).

import type { PoolClient } from 'pg'

const MAX_RATE = 0.30

export async function jockeyScore(name: string | null | undefined, db: PoolClient): Promise<number | null> {
  return readStat(db, 'jockey_stats', name)
}

export async function trainerScore(name: string | null | undefined, db: PoolClient): Promise<number | null> {
  return readStat(db, 'trainer_stats', name)
}

async function readStat(db: PoolClient, table: 'jockey_stats' | 'trainer_stats', name: string | null | undefined): Promise<number | null> {
  if (!name) return null
  // Table name is a static literal — the union narrows it before
  // interpolation, so SQL injection is not reachable here.
  const { rows } = await db.query<{ win_rate: string | null; runs_30d: number }>(
    `SELECT win_rate, runs_30d FROM ${table} WHERE name = $1`,
    [name],
  )
  const row = rows[0]
  if (!row || row.win_rate == null) return null
  // Require at least 10 mounts/runners before we trust the rate; small
  // samples produce noisy 100% strike rates that would dominate the
  // composite.
  if (row.runs_30d < 10) return null
  const rate = Number(row.win_rate)
  if (!Number.isFinite(rate)) return null
  const scaled = (rate / MAX_RATE) * 10
  return clamp(Math.round(scaled), 1, 10)
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}
