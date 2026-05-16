// Operator-curated marketplace catalog for the signed-in viewer. Returns
// the active items, the viewer's Park Gates balance, and which items they
// already own (so the UI can show Download instead of Buy).

import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getPool, ensureSchema } from '@/lib/db'
import { verifyViewerCookie } from '@/lib/viewer-auth'

export const dynamic = 'force-dynamic'

export async function GET() {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'database unavailable' }, { status: 503 })
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
    const v = await db.query(
      `SELECT id, park_gates FROM viewers WHERE license_key = $1`,
      [payload.key],
    )
    if (v.rowCount === 0) {
      return NextResponse.json({ error: 'viewer not found' }, { status: 404 })
    }
    const viewerId = Number(v.rows[0].id)
    const balance = Number(v.rows[0].park_gates ?? 0)

    const items = await db.query(
      `SELECT i.slug, i.title, i.blurb, i.gate_cost,
              (p.id IS NOT NULL) AS owned
         FROM marketplace_items i
         LEFT JOIN marketplace_purchases p
           ON p.item_id = i.id AND p.viewer_id = $1
        WHERE i.active = TRUE
        ORDER BY i.gate_cost ASC, i.title ASC`,
      [viewerId],
    )

    return NextResponse.json({
      balance,
      items: items.rows.map((r) => ({
        slug: String(r.slug),
        title: String(r.title),
        blurb: String(r.blurb ?? ''),
        gate_cost: Number(r.gate_cost),
        owned: r.owned === true,
      })),
    })
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 200) }, { status: 500 })
  } finally {
    db.release()
  }
}
