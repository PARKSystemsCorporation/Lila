// Lists the signed-in viewer's recent DMs (queued + answered).

import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getPool, ensureSchema } from '@/lib/db'
import { verifyViewerCookie } from '@/lib/viewer-auth'

export const dynamic = 'force-dynamic'

export async function GET() {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ dms: [] })
  }
  const secret = process.env.VIEWER_COOKIE_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'viewer auth not configured' }, { status: 503 })
  }
  const viewerCookie = (await cookies()).get('lila_viewer')?.value
  const payload = await verifyViewerCookie(viewerCookie, secret)
  if (!payload) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    const v = await db.query(`SELECT id FROM viewers WHERE license_key = $1`, [payload.key])
    if (v.rowCount === 0) return NextResponse.json({ dms: [] })
    const r = await db.query(
      `SELECT id, agent, prompt, reply, cost_pg, status,
              (EXTRACT(EPOCH FROM created_at)  * 1000)::bigint AS created_ts,
              (EXTRACT(EPOCH FROM answered_at) * 1000)::bigint AS answered_ts
         FROM viewer_dms
        WHERE viewer_id = $1
        ORDER BY created_at DESC
        LIMIT 30`,
      [Number(v.rows[0].id)],
    )
    return NextResponse.json({
      dms: r.rows.map((row) => ({
        id:           Number(row.id),
        agent:        String(row.agent),
        prompt:       String(row.prompt),
        reply:        row.reply ?? null,
        cost_pg:      Number(row.cost_pg ?? 0),
        status:       String(row.status),
        created_ts:   Number(row.created_ts),
        answered_ts:  row.answered_ts ? Number(row.answered_ts) : null,
      })),
    })
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 200) }, { status: 500 })
  } finally {
    db.release()
  }
}
