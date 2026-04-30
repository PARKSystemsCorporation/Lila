import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import * as Gumroad from '@/lib/gumroad'
import { signViewerCookie, VIEWER_COOKIE_TTL_SECONDS } from '@/lib/viewer-auth'
import { grantMonthlyIfDue } from '@/lib/viewers'

export const dynamic = 'force-dynamic'

// POST /api/viewer/login  { license_key }
//   - Verifies the key against Gumroad's license API.
//   - Confirms purchase isn't refunded / cancelled / ended.
//   - Stores/updates the viewers row.
//   - Sets the lila_viewer cookie (HMAC-signed, 30-day TTL).
//
// Configuration required: GUMROAD_PRODUCT_ID + VIEWER_COOKIE_SECRET.

export async function POST(req: Request) {
  if (!Gumroad.isConfigured()) {
    return NextResponse.json(
      { error: 'Viewer access not configured (set GUMROAD_PRODUCT_ID + VIEWER_COOKIE_SECRET).' },
      { status: 503 }
    )
  }

  const body = await req.json().catch(() => ({}))
  const licenseKey = String(body.license_key ?? '').trim()
  if (!licenseKey) {
    return NextResponse.json({ error: 'license_key required' }, { status: 400 })
  }

  const productId = process.env.GUMROAD_PRODUCT_ID!
  const secret    = process.env.VIEWER_COOKIE_SECRET!

  const result = await Gumroad.verifyLicense(productId, licenseKey, { incrementUses: false })
  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? 'Gumroad rejected the key.' }, { status: 401 })
  }
  if (!result.active) {
    const reason =
        result.refunded  ? 'refunded'
      : result.cancelled ? 'subscription cancelled'
      : result.failed    ? 'subscription failed'
      : result.ended     ? 'subscription ended'
      : 'inactive'
    return NextResponse.json({ error: `Subscription not active (${reason}).` }, { status: 402 })
  }

  // Persist / refresh the viewers row, then grant the monthly 50 PG if due.
  if (process.env.DATABASE_URL) {
    const pool = getPool()
    const db = await pool.connect()
    try {
      await ensureSchema(db)
      const upsert = await db.query(
        `INSERT INTO viewers (license_key, gumroad_product_id, gumroad_subscription_id, email, verified_at, last_seen_at, active)
         VALUES ($1,$2,$3,$4,NOW(),NOW(),TRUE)
         ON CONFLICT (license_key) DO UPDATE
           SET gumroad_subscription_id = COALESCE(EXCLUDED.gumroad_subscription_id, viewers.gumroad_subscription_id),
               email                   = COALESCE(EXCLUDED.email, viewers.email),
               verified_at = NOW(),
               last_seen_at = NOW(),
               active = TRUE
         RETURNING id`,
        [licenseKey, result.productId, result.subscriptionId, result.email]
      )
      const viewerId = Number(upsert.rows[0].id)
      try {
        await grantMonthlyIfDue(db, viewerId)
      } catch {
        // Wallet failure shouldn't block sign-in. Ledger row is the source of
        // truth; a future visit will grant the missed month.
      }
    } finally { db.release() }
  }

  // Sign cookie.
  const exp = Math.floor(Date.now() / 1000) + VIEWER_COOKIE_TTL_SECONDS
  const cookie = await signViewerCookie({ key: licenseKey, exp }, secret)

  const res = NextResponse.json({ ok: true })
  res.cookies.set('lila_viewer', cookie, {
    httpOnly: true,
    sameSite: 'lax',
    secure:   true,
    path:     '/',
    maxAge:   VIEWER_COOKIE_TTL_SECONDS,
  })
  return res
}

export async function DELETE() {
  // Sign out — clear the cookie.
  const res = NextResponse.json({ ok: true })
  res.cookies.set('lila_viewer', '', { httpOnly: true, path: '/', maxAge: 0 })
  return res
}
