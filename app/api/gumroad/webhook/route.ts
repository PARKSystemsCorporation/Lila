// Gumroad webhook ingestion. Gumroad has no native HMAC signature on
// resource subscription pings, so we authenticate by a shared secret
// embedded in the webhook URL: configure
//
//   https://thepark.world/api/gumroad/webhook?secret=<GUMROAD_WEBHOOK_SECRET>
//
// in your Gumroad product → Advanced → Resource subscriptions.
//
// Events we care about (resource_name):
//   sale                       — informational; license-verify still gates access
//   sale_refunded              — flip viewer inactive
//   subscription_cancelled     — flip viewer inactive
//   subscription_failed        — flip viewer inactive
//   subscription_ended         — flip viewer inactive
//   subscription_restarted     — flip viewer active again
//   sale                       — recurring charge → grant 50 PG for the
//                                billing period (idempotent per period;
//                                login backfill covers any the webhook
//                                misses). Lookup by subscription_id then
//                                license_key.

import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import { grantPeriod, monthRef } from '@/lib/viewers'

export const dynamic = 'force-dynamic'

const DEACTIVATE_EVENTS = new Set([
  'sale_refunded',
  'subscription_cancelled',
  'subscription_failed',
  'subscription_ended',
])
const ACTIVATE_EVENTS = new Set([
  'subscription_restarted',
])

export async function POST(req: Request) {
  const secret = process.env.GUMROAD_WEBHOOK_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'GUMROAD_WEBHOOK_SECRET not configured' }, { status: 503 })
  }

  const url = new URL(req.url)
  if (url.searchParams.get('secret') !== secret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // Gumroad sends application/x-www-form-urlencoded.
  const ct = req.headers.get('content-type') ?? ''
  let params: URLSearchParams
  if (ct.includes('application/x-www-form-urlencoded')) {
    params = new URLSearchParams(await req.text())
  } else if (ct.includes('application/json')) {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    params = new URLSearchParams()
    if (body) for (const [k, v] of Object.entries(body)) params.set(k, String(v))
  } else {
    params = new URLSearchParams(await req.text().catch(() => ''))
  }

  const event          = params.get('resource_name') ?? ''
  const subscriptionId = params.get('subscription_id') ?? ''
  const licenseKey     = params.get('license_key') ?? ''

  if (!event) {
    return NextResponse.json({ ok: true, ignored: 'no resource_name' })
  }

  let action: 'deactivate' | 'activate' | 'renewal' | 'noop' = 'noop'
  if (DEACTIVATE_EVENTS.has(event)) action = 'deactivate'
  else if (ACTIVATE_EVENTS.has(event)) action = 'activate'
  // A subscription `sale` is a recurring charge (the initial purchase too).
  else if (event === 'sale' && subscriptionId) action = 'renewal'

  if (action === 'noop' || !process.env.DATABASE_URL) {
    return NextResponse.json({ ok: true, event, action })
  }

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)

    if (action === 'renewal') {
      // Resolve the viewer (subscription_id is the stable key; license_key
      // is the fallback for rows created before we captured the sub id).
      const v = await db.query(
        `SELECT id FROM viewers
          WHERE gumroad_subscription_id = $1
             OR ($2 <> '' AND license_key = $2)
          LIMIT 1`,
        [subscriptionId, licenseKey],
      )
      if (v.rowCount === 0) {
        return NextResponse.json({ ok: true, event, action, granted: false, reason: 'viewer_not_found' })
      }
      const viewerId = Number(v.rows[0].id)
      // Period from the sale timestamp when present, else now.
      const ts = params.get('sale_timestamp') ?? ''
      const when = ts ? new Date(ts) : new Date()
      const ref = monthRef(isNaN(when.getTime()) ? new Date() : when)
      const granted = await grantPeriod(db, viewerId, ref, 'renewal_grant')
      return NextResponse.json({ ok: true, event, action, ref, granted })
    }

    const flag = action === 'activate'
    let updated = 0
    if (subscriptionId) {
      const r = await db.query(
        `UPDATE viewers SET active=$2 WHERE gumroad_subscription_id=$1`,
        [subscriptionId, flag],
      )
      updated = r.rowCount ?? 0
    }
    if (!updated && licenseKey) {
      const r = await db.query(
        `UPDATE viewers SET active=$2 WHERE license_key=$1`,
        [licenseKey, flag],
      )
      updated = r.rowCount ?? 0
    }
    return NextResponse.json({ ok: true, event, action, updated })
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 200) }, { status: 500 })
  } finally {
    db.release()
  }
}

// Some Gumroad setups GET the URL when you save it ("Send test ping").
export async function GET() {
  return NextResponse.json({ ok: true, hint: 'POST resource subscription pings here' })
}
