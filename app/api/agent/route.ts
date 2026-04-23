import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import { runAgentTick } from '@/lib/agent-tick'

export const dynamic = 'force-dynamic'

export async function GET() {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({
      totalEarned: 0,
      activeTasks: [],
      lastBounty: { name: 'None yet. Scanning platforms.', value: 0, time: Date.now() },
      log: [{ id: 1, message: 'No DATABASE_URL set — running in demo mode.', timestamp: Date.now(), type: 'warn' }],
    })
  }

  // Fire a tick (de-duped if one is already in flight). Don't block the UI
  // on it — Lila can take 5-10s for LLM calls. The ticker is also running
  // server-side, so the UI will see fresh state on the next poll.
  runAgentTick().catch(() => {})

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)

    const { rows: [s] } = await db.query(
      'SELECT total_earned, active_tasks, last_bounty FROM lila_state WHERE id=1'
    )
    const totalEarned = parseFloat(s?.total_earned ?? '0')
    const activeTasks: string[] = s?.active_tasks ?? []
    const lastBounty = s?.last_bounty ?? { name: 'None yet. Scanning platforms.', value: 0, time: Date.now() }

    const { rows: logRows } = await db.query(
      `SELECT id, message, type, (EXTRACT(EPOCH FROM created_at)*1000)::bigint AS timestamp
       FROM lila_log ORDER BY id DESC LIMIT 50`
    )

    return NextResponse.json({
      totalEarned,
      activeTasks,
      lastBounty,
      log: logRows.map(r => ({
        id: Number(r.id),
        message: r.message,
        type: r.type,
        timestamp: Number(r.timestamp),
      })),
    })
  } finally {
    db.release()
  }
}
