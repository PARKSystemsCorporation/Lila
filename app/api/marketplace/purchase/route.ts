// Buy a marketplace item with Park Gates. Atomic + idempotent:
//   • already owned          → no charge, ok
//   • spendGates()           → single conditional UPDATE, no double-debit
//   • purchase insert fails  → refund ledger row + park_gates restored
// Mirrors the refund-on-failure pattern in app/api/marketplace/dm.

import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getPool, ensureSchema } from '@/lib/db'
import { verifyViewerCookie } from '@/lib/viewer-auth'
import { spendGates } from '@/lib/viewers'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
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

  const body = await req.json().catch(() => null) as { slug?: string } | null
  const slug = String(body?.slug ?? '').trim()
  if (!slug) {
    return NextResponse.json({ error: 'slug required' }, { status: 400 })
  }

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)

    const v = await db.query(`SELECT id FROM viewers WHERE license_key = $1`, [payload.key])
    if (v.rowCount === 0) {
      return NextResponse.json({ error: 'viewer not found' }, { status: 404 })
    }
    const viewerId = Number(v.rows[0].id)

    const it = await db.query(
      `SELECT id, gate_cost FROM marketplace_items WHERE slug = $1 AND active = TRUE`,
      [slug],
    )
    if (it.rowCount === 0) {
      return NextResponse.json({ error: 'item not found' }, { status: 404 })
    }
    const itemId = Number(it.rows[0].id)
    const cost = Number(it.rows[0].gate_cost)

    // Already owned → idempotent success, no second charge.
    const owned = await db.query(
      `SELECT 1 FROM marketplace_purchases WHERE viewer_id = $1 AND item_id = $2`,
      [viewerId, itemId],
    )
    if ((owned.rowCount ?? 0) > 0) {
      return NextResponse.json({ ok: true, already: true, slug })
    }

    const spend = await spendGates(db, viewerId, cost, 'marketplace', slug)
    if (!spend.ok) {
      return NextResponse.json(
        { error: spend.reason ?? 'spend_failed', remaining: spend.remaining, cost },
        { status: spend.reason === 'insufficient' ? 402 : 403 },
      )
    }

    try {
      await db.query(
        `INSERT INTO marketplace_purchases (viewer_id, item_id, ledger_ref)
         VALUES ($1, $2, $3)
         ON CONFLICT (viewer_id, item_id) DO NOTHING`,
        [viewerId, itemId, `marketplace:${slug}`],
      )
    } catch (e) {
      // Entitlement write failed — refund so the spend isn't dropped.
      await db.query(
        `UPDATE viewers SET park_gates = park_gates + $2 WHERE id = $1`,
        [viewerId, cost],
      )
      await db.query(
        `INSERT INTO park_gates_ledger (viewer_id, delta, reason, ref)
         VALUES ($1, $2, 'refund', $3)`,
        [viewerId, cost, `marketplace:${slug}:write_failed`],
      )
      return NextResponse.json({ error: 'purchase_failed', detail: String(e).slice(0, 120) }, { status: 500 })
    }

    return NextResponse.json({ ok: true, slug, cost, remaining: spend.remaining })
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 200) }, { status: 500 })
  } finally {
    db.release()
  }
}
