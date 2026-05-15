// Rolling 30-day jockey + trainer strike-rate rollup. Joins
// ceelo_results.finishers (one row per finished race) against
// ceelo_runners for the same race to recover jockey/trainer attribution
// per finisher, then upserts the aggregated counts into jockey_stats /
// trainer_stats.
//
// Idempotent: each row is a primary-key upsert. Safe to re-run on the
// same window — counts are recomputed from scratch each pass, not
// incremented.

import type { PoolClient } from 'pg'

interface RollupResult {
  jockeysScored: number
  trainersScored: number
  racesConsidered: number
}

export async function rollupJockeyTrainerStats(
  db: PoolClient,
  opts: { windowDays?: number } = {},
): Promise<RollupResult> {
  const windowDays = opts.windowDays ?? 30

  // Single CTE that flattens finishers JSONB into one row per (race,
  // horse, position), joins back to ceelo_runners for connections, then
  // aggregates per jockey + per trainer in two passes (UNION ALL would
  // collapse — we want them in separate tables).
  const cutoff = `NOW() - INTERVAL '${Number(windowDays)} days'`

  // --- Jockeys ------------------------------------------------------------
  const jockeyAggregate = await db.query<{ jockey: string; runs: string; wins: string }>(
    `WITH window_results AS (
       SELECT race_id, finishers
         FROM ceelo_results
         WHERE finished_at >= ${cutoff}
     ),
     flattened AS (
       SELECT w.race_id,
              (f->>'horse_id') AS horse_id,
              ((f->>'position')::int) AS position
         FROM window_results w,
              jsonb_array_elements(w.finishers) f
     )
     SELECT r.jockey AS jockey,
            COUNT(*)::text AS runs,
            COUNT(*) FILTER (WHERE fl.position = 1)::text AS wins
       FROM flattened fl
       JOIN ceelo_runners r
         ON r.race_id = fl.race_id AND r.horse_id = fl.horse_id
      WHERE r.jockey IS NOT NULL AND r.jockey <> ''
      GROUP BY r.jockey`,
  )

  // Snapshot table — wipe before write so rows for jockeys who stopped
  // riding inside the window drop out naturally.
  await db.query(`DELETE FROM jockey_stats`)
  for (const row of jockeyAggregate.rows) {
    const runs = Number(row.runs)
    const wins = Number(row.wins)
    const winRate = runs > 0 ? wins / runs : null
    await db.query(
      `INSERT INTO jockey_stats (name, runs_30d, wins_30d, win_rate, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (name) DO UPDATE
         SET runs_30d = EXCLUDED.runs_30d,
             wins_30d = EXCLUDED.wins_30d,
             win_rate = EXCLUDED.win_rate,
             updated_at = NOW()`,
      [row.jockey, runs, wins, winRate],
    )
  }

  // --- Trainers -----------------------------------------------------------
  const trainerAggregate = await db.query<{ trainer: string; runs: string; wins: string }>(
    `WITH window_results AS (
       SELECT race_id, finishers
         FROM ceelo_results
         WHERE finished_at >= ${cutoff}
     ),
     flattened AS (
       SELECT w.race_id,
              (f->>'horse_id') AS horse_id,
              ((f->>'position')::int) AS position
         FROM window_results w,
              jsonb_array_elements(w.finishers) f
     )
     SELECT r.trainer AS trainer,
            COUNT(*)::text AS runs,
            COUNT(*) FILTER (WHERE fl.position = 1)::text AS wins
       FROM flattened fl
       JOIN ceelo_runners r
         ON r.race_id = fl.race_id AND r.horse_id = fl.horse_id
      WHERE r.trainer IS NOT NULL AND r.trainer <> ''
      GROUP BY r.trainer`,
  )

  await db.query(`DELETE FROM trainer_stats`)
  for (const row of trainerAggregate.rows) {
    const runs = Number(row.runs)
    const wins = Number(row.wins)
    const winRate = runs > 0 ? wins / runs : null
    await db.query(
      `INSERT INTO trainer_stats (name, runs_30d, wins_30d, win_rate, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (name) DO UPDATE
         SET runs_30d = EXCLUDED.runs_30d,
             wins_30d = EXCLUDED.wins_30d,
             win_rate = EXCLUDED.win_rate,
             updated_at = NOW()`,
      [row.trainer, runs, wins, winRate],
    )
  }

  const { rows: [racesRow] } = await db.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM ceelo_results WHERE finished_at >= ${cutoff}`,
  )

  return {
    jockeysScored: jockeyAggregate.rows.length,
    trainersScored: trainerAggregate.rows.length,
    racesConsidered: Number(racesRow?.n ?? 0),
  }
}
