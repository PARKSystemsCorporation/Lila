// Public conversion tracking. Fires once per session per event from the
// landing — currently just `buy_click`. No PII, no IP retention; we
// hash the user-agent for soft dedupe. Failures are silent: tracking
// must never block the actual click.

import { NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { getPool, ensureSchema } from '@/lib/db'

export const dynamic = 'force-dynamic'

const ALLOWED_EVENTS = new Set(['buy_click', 'sign_in_click', 'sport_click', 'agent_dm_open'])

export async function POST(req: Request) {
  if (!process.env.DATABASE_URL) {
    // Tracking is best-effort. Always 204 so the client can fire-and-forget.
    return new NextResponse(null, { status: 204 })
  }

  const body = await req.json().catch(() => null) as { event?: string; ref?: string } | null
  const event = String(body?.event ?? '').slice(0, 32)
  const ref   = body?.ref ? String(body.ref).slice(0, 64) : null
  if (!event || !ALLOWED_EVENTS.has(event)) {
    return new NextResponse(null, { status: 204 })
  }

  const ua = req.headers.get('user-agent') ?? ''
  const uaHash = ua ? createHash('sha256').update(ua).digest('hex').slice(0, 16) : null

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    await db.query(
      `INSERT INTO landing_events (event, ref, ua_hash) VALUES ($1, $2, $3)`,
      [event, ref, uaHash],
    )
  } catch {
    // Swallow — analytics never breaks the page.
  } finally {
    db.release()
  }
  return new NextResponse(null, { status: 204 })
}
