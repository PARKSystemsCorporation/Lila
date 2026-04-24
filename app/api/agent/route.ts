import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import { runAgentTick } from '@/lib/agent-tick'

export const dynamic = 'force-dynamic'

export async function GET() {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({
      totalEarned: 0,
      activeTasks: [],
      log: [{ id: 1, message: 'No DATABASE_URL set — running in demo mode.', timestamp: Date.now(), type: 'warn' }],
    })
  }

  // Fire a tick (de-duped if one is already in flight). Don't block the UI
  // on it — LLM calls can take 5-10s, and the server-side ticker is
  // running anyway, so the next poll will see fresh state.
  runAgentTick().catch(() => {})

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)

    const { rows: [s] } = await db.query(
      'SELECT total_earned, active_tasks, bounty_turn FROM lila_state WHERE id=1'
    )
    const totalEarned = parseFloat(s?.total_earned ?? '0')
    const activeTasks: string[] = s?.active_tasks ?? []
    // Even turn → docs next; odd → security next. Used by the UI to show
    // the alternation indicator.
    const bountyMode = (s?.bounty_turn ?? 0) % 2 === 0 ? 'docs' : 'security'

    const { rows: logRows } = await db.query(
      `SELECT id, message, type, (EXTRACT(EPOCH FROM created_at)*1000)::bigint AS timestamp
       FROM lila_log ORDER BY id DESC LIMIT 50`
    )

    return NextResponse.json({
      totalEarned,
      activeTasks,
      bountyMode,
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
