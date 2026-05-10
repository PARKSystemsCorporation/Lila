// Local verification harness for the autonomy tree.
//
// Run with: LILA_DRY_RUN=true LILA_AUTONOMY_TREE=true \
//           DATABASE_URL=... DEEPSEEK_API_KEY=... \
//           npx tsx scripts/dev-autonomy-tick.ts
//
// 1. ensureSchema applies the new ALTERs.
// 2. Seeds one inbound desk row (direction='to_lila', category='help-request').
// 3. Runs AutonomyLoop once → expects 10 lila_tasks rows queued.
// 4. Runs AutonomyLoop a second time → expects step 1 to transition to done.
// 5. Cleans up the seeded rows.

import { getPool, ensureSchema } from '../lib/db'
import { AutonomyLoop } from '../lib/autonomy/loop'

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL required'); process.exit(1)
  }
  if (process.env.LILA_DRY_RUN !== 'true') {
    console.warn('warning: LILA_DRY_RUN is not "true" — tools will produce real side effects')
  }

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)

    // 1. Seed an inbound help-request.
    const seedTitle = `[dev-autonomy-tick] seed ${new Date().toISOString()}`
    const { rows: [seed] } = await db.query(
      `INSERT INTO desk_items
         (from_agent, direction, category, title, summary, body, kind, status, payload)
       VALUES ('lila', 'to_lila', 'help-request', $1, 'seed', $2, 'doc', 'pending', $3)
       RETURNING id`,
      [seedTitle, '## seed body\nwhat is X?', JSON.stringify({ question: 'what is X?' })]
    )
    const seedId = Number(seed.id)
    console.log(`[seed] inbound desk #${seedId} created`)

    // 2. First tick — expect a 10-step plan to be queued.
    const loop = new AutonomyLoop(db)
    const r1 = await loop.run()
    console.log(`[tick 1] ${r1?.logMessage ?? 'null'}`)
    const { rows: stepRows } = await db.query(
      `SELECT plan_id, branch_path, status, step_no, tool
         FROM lila_tasks
        WHERE created_at > NOW() - INTERVAL '5 minutes'
        ORDER BY plan_id, step_no`
    )
    if (stepRows.length === 0) {
      console.error('[fail] no lila_tasks rows after tick 1')
      process.exit(2)
    }
    console.log(`[tick 1] ${stepRows.length} steps queued (path=${stepRows[0].branch_path})`)

    // 3. Second tick — expect step 1 → done.
    const r2 = await loop.run()
    console.log(`[tick 2] ${r2?.logMessage ?? 'null'}`)
    const { rows: [step1] } = await db.query(
      `SELECT status, result FROM lila_tasks
        WHERE plan_id=$1 AND step_no=1`,
      [stepRows[0].plan_id]
    )
    console.log(`[tick 2] step 1 status=${step1?.status} result="${(step1?.result ?? '').slice(0, 80)}"`)

    // 4. Cleanup seed + the freshly queued plan so re-runs are idempotent.
    await db.query(`DELETE FROM lila_tasks WHERE plan_id=$1`, [stepRows[0].plan_id])
    await db.query(`DELETE FROM desk_items WHERE id=$1`, [seedId])
    console.log('[cleanup] seed + plan removed')
  } finally {
    db.release()
    await pool.end()
  }
}

main().catch(e => { console.error(e); process.exit(1) })
