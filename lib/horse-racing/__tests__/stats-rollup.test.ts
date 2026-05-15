import { describe, it, expect, beforeEach, vi } from 'vitest'
import { rollupJockeyTrainerStats } from '../stats-rollup'

// Minimal in-memory mock of the subset of PoolClient methods stats-rollup
// uses. We don't need a real Postgres — the SQL queries follow a fixed
// shape (results query → DELETE → INSERT/UPSERT) so we can replay them.

type Row = Record<string, unknown>

function makeMockDb(initialResults: { jockey: string; runs: number; wins: number }[],
                   initialTrainers: { trainer: string; runs: number; wins: number }[],
                   raceCount: number) {
  const jockeyStats = new Map<string, { runs: number; wins: number; rate: number | null }>()
  const trainerStats = new Map<string, { runs: number; wins: number; rate: number | null }>()
  let jockeyQueryServed = false
  let trainerQueryServed = false

  const calls: { sql: string; params?: unknown[] }[] = []

  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params })
    const text = sql.trim()
    if (text.startsWith('WITH window_results') && text.includes('jockey')) {
      const rows: Row[] = initialResults.map(r => ({
        jockey: r.jockey,
        runs: String(r.runs),
        wins: String(r.wins),
      }))
      jockeyQueryServed = true
      return { rows, rowCount: rows.length }
    }
    if (text.startsWith('WITH window_results') && text.includes('trainer')) {
      const rows: Row[] = initialTrainers.map(r => ({
        trainer: r.trainer,
        runs: String(r.runs),
        wins: String(r.wins),
      }))
      trainerQueryServed = true
      return { rows, rowCount: rows.length }
    }
    if (text.startsWith('DELETE FROM jockey_stats')) {
      jockeyStats.clear()
      return { rows: [], rowCount: 0 }
    }
    if (text.startsWith('DELETE FROM trainer_stats')) {
      trainerStats.clear()
      return { rows: [], rowCount: 0 }
    }
    if (text.startsWith('INSERT INTO jockey_stats')) {
      const [name, runs, wins, rate] = params as [string, number, number, number | null]
      jockeyStats.set(name, { runs, wins, rate })
      return { rows: [], rowCount: 1 }
    }
    if (text.startsWith('INSERT INTO trainer_stats')) {
      const [name, runs, wins, rate] = params as [string, number, number, number | null]
      trainerStats.set(name, { runs, wins, rate })
      return { rows: [], rowCount: 1 }
    }
    if (text.startsWith('SELECT COUNT(*)::text AS n FROM ceelo_results')) {
      return { rows: [{ n: String(raceCount) }], rowCount: 1 }
    }
    return { rows: [], rowCount: 0 }
  })

  return { query, jockeyStats, trainerStats, calls, get jockeyQueryServed() { return jockeyQueryServed }, get trainerQueryServed() { return trainerQueryServed } }
}

describe('rollupJockeyTrainerStats', () => {
  let mock: ReturnType<typeof makeMockDb>

  beforeEach(() => {
    mock = makeMockDb(
      [
        { jockey: 'Frankie Dettori', runs: 100, wins: 30 },  // 30% strike
        { jockey: 'Newcomer', runs: 5, wins: 1 },             // < 10 runs threshold (logic later)
      ],
      [
        { trainer: 'Aidan O\'Brien', runs: 80, wins: 24 },
      ],
      42,
    )
  })

  it('writes win-rate rows from the results query', async () => {
    // Cast our mock to PoolClient — the production type only needs .query.
    const result = await rollupJockeyTrainerStats(mock as unknown as Parameters<typeof rollupJockeyTrainerStats>[0])
    expect(result.jockeysScored).toBe(2)
    expect(result.trainersScored).toBe(1)
    expect(result.racesConsidered).toBe(42)
    expect(mock.jockeyStats.get('Frankie Dettori')?.rate).toBeCloseTo(0.30, 4)
    expect(mock.trainerStats.get("Aidan O'Brien")?.rate).toBeCloseTo(0.30, 4)
  })

  it('is idempotent across consecutive runs (DELETE-then-INSERT semantics)', async () => {
    await rollupJockeyTrainerStats(mock as unknown as Parameters<typeof rollupJockeyTrainerStats>[0])
    const firstSize = mock.jockeyStats.size
    await rollupJockeyTrainerStats(mock as unknown as Parameters<typeof rollupJockeyTrainerStats>[0])
    expect(mock.jockeyStats.size).toBe(firstSize)
    expect(mock.jockeyStats.get('Frankie Dettori')?.rate).toBeCloseTo(0.30, 4)
  })

  it('honors the custom window when supplied', async () => {
    await rollupJockeyTrainerStats(
      mock as unknown as Parameters<typeof rollupJockeyTrainerStats>[0],
      { windowDays: 7 },
    )
    const sql = mock.calls.find(c => c.sql.includes('WITH window_results'))!.sql
    expect(sql).toContain("INTERVAL '7 days'")
  })
})
