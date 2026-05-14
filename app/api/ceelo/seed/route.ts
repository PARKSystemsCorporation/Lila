import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'

export const dynamic = 'force-dynamic'

// POST /api/ceelo/seed
//
// Inserts deterministic racing fixtures so the drill-in page, KPIs, and
// backtest are exercisable without live Racing API creds. Idempotent —
// wipes prior rows for the seed race_ids before reinserting. Safe to
// re-run.
//
// Fixture set:
//   SEED-D1 — a final NA card (Belmont) two days ago, 6 runners, with a
//             20-snapshot pre-off odds tape and a known winner. The
//             yield engine on the latest snapshot will pick a runner
//             that ends up winning — exercises the "wins" path in the
//             backtest.
//   SEED-D2 — a final UK card (Ascot) one day ago, 6 runners, also with
//             a snapshot tape and a known winner that the yield engine
//             will NOT pick — exercises the "losses" path.
//   SEED-LIVE — an upcoming NA card off in 20 minutes with one
//             snapshot taken, no result yet. Lets /horse-racing/[raceId]
//             render a live drill-in without upstream creds.

interface SeedRunner {
  horse_id: string
  horse: string
  number: string
  jockey: string
  trainer: string
  odds_sequence: number[]    // earliest → latest decimal odds
}

interface SeedRace {
  race_id: string
  course: string
  country: string
  off_dt: Date
  off_time: string
  race_name: string
  going: string | null
  distance: string | null
  type: string | null
  status: 'final' | 'scheduled'
  winner_horse_id: string | null
  runners: SeedRunner[]
}

function buildFixtures(now: number): SeedRace[] {
  const d = (offsetMinutes: number) => new Date(now + offsetMinutes * 60_000)
  return [
    {
      race_id: 'SEED-D1',
      course: 'Belmont Park',
      country: 'USA',
      off_dt: d(-2 * 24 * 60),       // 2 days ago
      off_time: '14:30',
      race_name: 'Seed Stakes',
      going: 'Fast',
      distance: '6f',
      type: 'STK',
      status: 'final',
      winner_horse_id: 'SEED-D1-H1',  // the favourite wins → backtest scores a "win"
      runners: [
        { horse_id: 'SEED-D1-H1', horse: 'Daybreak Charge', number: '1', jockey: 'I. Ortiz', trainer: 'C. Brown',
          odds_sequence: [3.8, 3.6, 3.4, 3.3, 3.2] },
        { horse_id: 'SEED-D1-H2', horse: 'Saratoga Sky',    number: '2', jockey: 'F. Geroux', trainer: 'B. Cox',
          odds_sequence: [5.0, 5.2, 5.5, 5.4, 5.5] },
        { horse_id: 'SEED-D1-H3', horse: 'Iron Will',       number: '3', jockey: 'L. Saez', trainer: 'T. Pletcher',
          odds_sequence: [7.0, 7.5, 8.0, 8.0, 8.5] },
        { horse_id: 'SEED-D1-H4', horse: 'Park Avenue',     number: '4', jockey: 'J. Rosario', trainer: 'C. McGaughey',
          odds_sequence: [9.0, 9.5, 9.0, 9.0, 9.5] },
        { horse_id: 'SEED-D1-H5', horse: 'Tidewater',       number: '5', jockey: 'J. Castellano', trainer: 'C. Brown',
          odds_sequence: [12, 13, 13, 14, 14] },
        { horse_id: 'SEED-D1-H6', horse: 'Final Stretch',   number: '6', jockey: 'M. Franco', trainer: 'L. Rice',
          odds_sequence: [16, 17, 18, 18, 18] },
      ],
    },
    {
      race_id: 'SEED-D2',
      course: 'Ascot',
      country: 'GBR',
      off_dt: d(-1 * 24 * 60),       // 1 day ago
      off_time: '15:05',
      race_name: 'Seed Handicap',
      going: 'Soft',
      distance: '7f',
      type: 'Flat',
      status: 'final',
      winner_horse_id: 'SEED-D2-H4',  // longshot wins → backtest scores a "loss"
      runners: [
        { horse_id: 'SEED-D2-H1', horse: 'Westminster',   number: '1', jockey: 'R. Moore', trainer: 'A. O\'Brien',
          odds_sequence: [3.0, 2.9, 2.8, 2.7] },
        { horse_id: 'SEED-D2-H2', horse: 'Highland Star', number: '2', jockey: 'W. Buick', trainer: 'C. Appleby',
          odds_sequence: [4.5, 4.5, 4.6, 4.5] },
        { horse_id: 'SEED-D2-H3', horse: 'Cotswold',      number: '3', jockey: 'O. Murphy', trainer: 'A. Balding',
          odds_sequence: [6.0, 6.5, 7.0, 7.0] },
        { horse_id: 'SEED-D2-H4', horse: 'River Severn',  number: '4', jockey: 'T. Marquand', trainer: 'W. Haggas',
          odds_sequence: [9.0, 9.5, 9.0, 10] },
        { horse_id: 'SEED-D2-H5', horse: 'Wessex',        number: '5', jockey: 'J. Crowley', trainer: 'R. Hannon',
          odds_sequence: [11, 12, 12, 13] },
        { horse_id: 'SEED-D2-H6', horse: 'Solent',        number: '6', jockey: 'D. Probert', trainer: 'C. Hills',
          odds_sequence: [21, 22, 23, 25] },
      ],
    },
    {
      race_id: 'SEED-LIVE',
      course: 'Saratoga',
      country: 'USA',
      off_dt: d(20),                  // 20 minutes from now
      off_time: '17:45',
      race_name: 'Seed Live Allowance',
      going: 'Fast',
      distance: '1m',
      type: 'ALW',
      status: 'scheduled',
      winner_horse_id: null,
      runners: [
        { horse_id: 'SEED-LV-H1', horse: 'Crescent Bay', number: '1', jockey: 'M. Cancel',   trainer: 'C. Brown',
          odds_sequence: [4.0, 3.8, 3.6] },
        { horse_id: 'SEED-LV-H2', horse: 'Adirondack',   number: '2', jockey: 'I. Ortiz Jr', trainer: 'B. Cox',
          odds_sequence: [5.5, 5.5, 5.4] },
        { horse_id: 'SEED-LV-H3', horse: 'Hudson',       number: '3', jockey: 'F. Geroux',   trainer: 'T. Pletcher',
          odds_sequence: [6.0, 6.5, 6.5] },
        { horse_id: 'SEED-LV-H4', horse: 'Mohawk',       number: '4', jockey: 'L. Saez',     trainer: 'C. McGaughey',
          odds_sequence: [8.0, 8.5, 9.0] },
        { horse_id: 'SEED-LV-H5', horse: 'Catskill',     number: '5', jockey: 'J. Castellano', trainer: 'C. Brown',
          odds_sequence: [10, 11, 11] },
      ],
    },
  ]
}

export async function POST() {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'no DATABASE_URL' }, { status: 503 })
  }
  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    const fixtures = buildFixtures(Date.now())
    const ids = fixtures.map(f => f.race_id)

    // Wipe prior seed data so reruns are idempotent.
    await db.query(`DELETE FROM ceelo_picks       WHERE race_id = ANY($1::text[])`, [ids])
    await db.query(`DELETE FROM ceelo_results     WHERE race_id = ANY($1::text[])`, [ids])
    await db.query(`DELETE FROM ceelo_runner_odds WHERE race_id = ANY($1::text[])`, [ids])
    await db.query(`DELETE FROM ceelo_runners     WHERE race_id = ANY($1::text[])`, [ids])
    await db.query(`DELETE FROM ceelo_races       WHERE race_id = ANY($1::text[])`, [ids])

    let races_inserted = 0
    let snapshots_inserted = 0
    let results_inserted = 0

    for (const f of fixtures) {
      await db.query(
        `INSERT INTO ceelo_races
           (race_id, course, country, off_dt, off_time, race_name, distance, going, type,
            field_size, status, refreshed_at, finished_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),$12)`,
        [
          f.race_id, f.course, f.country, f.off_dt.toISOString(), f.off_time,
          f.race_name, f.distance, f.going, f.type, f.runners.length, f.status,
          f.status === 'final' ? f.off_dt.toISOString() : null,
        ]
      )
      races_inserted++

      for (const runner of f.runners) {
        await db.query(
          `INSERT INTO ceelo_runners
             (race_id, horse_id, horse, number, draw, jockey, trainer, age, weight_lbs, form)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [f.race_id, runner.horse_id, runner.horse, runner.number, null,
           runner.jockey, runner.trainer, 4, 122, null]
        )
      }

      // Snapshots are spaced evenly across the pre-off window. Each
      // snapshot computes its own fair odds + edge using the same
      // overround math the yield engine uses, so backtest + drill-in
      // have realistic values.
      const span = 60 * 60 * 1_000   // 1h window leading into the off
      const offMs = f.off_dt.getTime()
      const N = f.runners[0].odds_sequence.length
      for (let i = 0; i < N; i++) {
        const fetchedAt = new Date(offMs - span + (span * (i + 1)) / (N + 1))
        const overround = f.runners.reduce((s, r) => s + 1 / r.odds_sequence[i], 0)
        for (const r of f.runners) {
          const odds = r.odds_sequence[i]
          const fairProb = (1 / odds) / overround
          const fair = +(1 / fairProb).toFixed(2)
          const edge = +(((fair - odds) / odds) * 100).toFixed(2)
          await db.query(
            `INSERT INTO ceelo_runner_odds (race_id, horse_id, odds_decimal, fair_decimal, edge_pct, fetched_at)
             VALUES ($1,$2,$3,$4,$5,$6)`,
            [f.race_id, r.horse_id, odds, fair, edge, fetchedAt.toISOString()]
          )
          snapshots_inserted++
        }
      }

      if (f.status === 'final' && f.winner_horse_id) {
        const finishers = f.runners
          .map((r, idx) => ({
            horse_id: r.horse_id,
            horse: r.horse,
            position: r.horse_id === f.winner_horse_id ? 1 : idx + 2,
            sp_decimal: r.odds_sequence[r.odds_sequence.length - 1],
          }))
          .sort((a, b) => a.position - b.position)
          .map((row, i) => ({ ...row, position: i + 1 }))
        const winnerSp = finishers[0].sp_decimal
        await db.query(
          `INSERT INTO ceelo_results (race_id, finished_at, winner_id, winner_sp, finishers)
           VALUES ($1,$2,$3,$4,$5::jsonb)`,
          [f.race_id, f.off_dt.toISOString(), f.winner_horse_id, winnerSp, JSON.stringify(finishers)]
        )
        results_inserted++
      }
    }

    return NextResponse.json({
      ok: true,
      races_inserted,
      snapshots_inserted,
      results_inserted,
      race_ids: ids,
    })
  } catch (e) {
    console.warn('[api/ceelo/seed] error:', e)
    return NextResponse.json({ error: String(e).slice(0, 200) }, { status: 500 })
  } finally {
    db.release()
  }
}

export async function GET() {
  return NextResponse.json({
    usage: 'POST /api/ceelo/seed → idempotent racing fixtures (3 races, ~80 odds snapshots, 2 results).',
  })
}
