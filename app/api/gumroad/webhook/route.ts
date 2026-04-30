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
//
// Lookup is by subscription_id when available, falling back to
// license_key. We don't trust the body to grant Park Gates — that
// stays login-driven (idempotent monthly grant in lib/viewers.ts).

import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'

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

  let action: 'deactivate' | 'activate' | 'noop' = 'noop'
  if (DEACTIVATE_EVENTS.has(event)) action = 'deactivate'
  else if (ACTIVATE_EVENTS.has(event)) action = 'activate'

  if (action === 'noop' || !process.env.DATABASE_URL) {
    return NextResponse.json({ ok: true, event, action })
  }

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
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
