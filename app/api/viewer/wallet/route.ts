// Viewer's own Park Gates balance + recent ledger. Authenticated by the
// HMAC-signed lila_viewer cookie (same cookie middleware verifies). The
// operator cookie is also accepted and resolves to the most recently
// active viewer for ops/debugging.

import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getPool, ensureSchema } from '@/lib/db'
import { verifyViewerCookie } from '@/lib/viewer-auth'

export const dynamic = 'force-dynamic'

interface LedgerRow {
  delta: number
  reason: string
  ref: string | null
  created_ts: number
}

export async function GET() {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'database unavailable' }, { status: 503 })
  }
  const secret = process.env.VIEWER_COOKIE_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'viewer auth not configured' }, { status: 503 })
  }

  const cookieStore = await cookies()
  const viewerCookie = cookieStore.get('lila_viewer')?.value
  const payload = await verifyViewerCookie(viewerCookie, secret)
  if (!payload) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    const v = await db.query(
      `SELECT id, park_gates, last_gate_grant_at, active
         FROM viewers
        WHERE license_key = $1`,
      [payload.key],
    )
    if (v.rowCount === 0) {
      return NextResponse.json({ error: 'viewer not found' }, { status: 404 })
    }
    const viewerId = Number(v.rows[0].id)
    const ledger = await db.query(
      `SELECT delta, reason, ref,
              (EXTRACT(EPOCH FROM created_at) * 1000)::bigint AS created_ts
         FROM park_gates_ledger
        WHERE viewer_id = $1
        ORDER BY created_at DESC
        LIMIT 20`,
      [viewerId],
    )
    const rows: LedgerRow[] = ledger.rows.map((r) => ({
      delta: Number(r.delta),
      reason: r.reason,
      ref: r.ref ?? null,
      created_ts: Number(r.created_ts),
    }))
    return NextResponse.json({
      park_gates:        Number(v.rows[0].park_gates ?? 0),
      last_grant_ts:     v.rows[0].last_gate_grant_at ? new Date(v.rows[0].last_gate_grant_at).getTime() : null,
      active:            v.rows[0].active === true,
      ledger:            rows,
    })
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 200) }, { status: 500 })
  } finally {
    db.release()
  }
}
