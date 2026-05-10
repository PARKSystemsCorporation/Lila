import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import { resetTreeState } from '@/lib/autonomy/loop'

export const dynamic = 'force-dynamic'

// GET  /api/autonomy
//   → { paused: boolean, paused_at: number | null }
//
// POST /api/autonomy  { action: 'pause' | 'resume' }
//   → { ok: true, paused: boolean }
//
// Operator-facing stop switch. middleware.ts already guards this path
// behind the operator cookie (same as /api/desk, /api/notes — no
// explicit auth needed in the handler).

export async function GET() {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ paused: false, paused_at: null })
  }
  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    const { rows: [row] } = await db.query(
      `SELECT autonomy_paused,
              (EXTRACT(EPOCH FROM paused_at) * 1000)::bigint AS paused_ts
         FROM lila_state WHERE id=1`
    )
    return NextResponse.json({
      paused:    !!row?.autonomy_paused,
      paused_at: row?.paused_ts != null ? Number(row.paused_ts) : null,
    })
  } finally { db.release() }
}

export async function POST(req: Request) {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'no db' }, { status: 503 })
  }
  const body = await req.json().catch(() => ({}))
  const action = String(body.action ?? '').toLowerCase()
  if (action !== 'pause' && action !== 'resume') {
    return NextResponse.json({ error: 'action must be pause or resume' }, { status: 400 })
  }

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    if (action === 'pause') {
      await db.query(
        `UPDATE lila_state
            SET autonomy_paused=TRUE, paused_at=NOW(), updated_at=NOW()
          WHERE id=1`
      )
      return NextResponse.json({ ok: true, paused: true })
    } else {
      // Resume: clear the flag AND reset Lila's tree working state so
      // the next tick re-routes fresh. Subloops keep their own state.
      await db.query(
        `UPDATE lila_state
            SET autonomy_paused=FALSE, paused_at=NULL, updated_at=NOW()
          WHERE id=1`
      )
      await resetTreeState(db)
      return NextResponse.json({ ok: true, paused: false })
    }
  } finally { db.release() }
}
