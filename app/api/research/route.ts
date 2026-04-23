import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ current: null, targets: [] })
  }
  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)

    const { rows: [state] } = await db.query(
      'SELECT current_target_id FROM lila_state WHERE id=1'
    )
    let current = null
    if (state?.current_target_id) {
      const { rows } = await db.query(
        `SELECT rt.*,
                (SELECT COUNT(*) FROM research_notes rn
                   WHERE rn.target_id=rt.id AND rn.kind='hypothesis:open') AS open_hyp,
                (SELECT COUNT(*) FROM research_notes rn
                   WHERE rn.target_id=rt.id AND rn.kind='hypothesis:closed') AS closed_hyp,
                (SELECT COUNT(*) FROM research_notes rn
                   WHERE rn.target_id=rt.id AND rn.kind='finding') AS finding_cnt
         FROM research_targets rt WHERE id=$1`,
        [state.current_target_id]
      )
      current = rows[0] ?? null
    }

    const { rows: targets } = await db.query(
      `SELECT rt.id, rt.title, rt.platform_label, rt.reward, rt.chain, rt.phase,
              rt.cycles, rt.fruitless_cycles, rt.status,
              to_char(rt.first_worked_at, 'YYYY-MM-DD HH24:MI') AS first_worked_at,
              to_char(rt.last_worked_at,  'YYYY-MM-DD HH24:MI') AS last_worked_at
       FROM research_targets rt
       ORDER BY rt.last_worked_at DESC NULLS LAST, rt.id DESC
       LIMIT 20`
    )

    return NextResponse.json({ current, targets })
  } finally { db.release() }
}
