import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import { BroadcastLoop } from '@/lib/broadcast-loop'
import { cfg } from '@/lib/config'

export const dynamic = 'force-dynamic'

export async function GET() {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({
      channels: BroadcastLoop.enabledChannels(),
      interval_min: cfg.BROADCAST_INTERVAL_MIN,
      preview_window_min: cfg.BROADCAST_PREVIEW_WINDOW_MIN,
      enabled: cfg.ENABLE_BROADCAST,
      recent: [],
      pending: [],
      last_broadcast_at: null,
    })
  }

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)

    const { rows: recent } = await db.query(
      `SELECT id, channel, content, status, external_id, error,
              (EXTRACT(EPOCH FROM created_at)             * 1000)::bigint AS ts,
              (EXTRACT(EPOCH FROM scheduled_publish_at)   * 1000)::bigint AS scheduled_ts
       FROM broadcasts
       WHERE status IN ('posted','failed','cancelled')
       ORDER BY id DESC
       LIMIT 20`
    )
    // Pending rows grouped later by content so the UI can show one preview
    // card per composed post (not one per channel).
    const { rows: pending } = await db.query(
      `SELECT id, channel, content, status, error,
              (EXTRACT(EPOCH FROM created_at)             * 1000)::bigint AS ts,
              (EXTRACT(EPOCH FROM scheduled_publish_at)   * 1000)::bigint AS scheduled_ts
       FROM broadcasts
       WHERE status = 'pending_publish'
       ORDER BY scheduled_publish_at ASC`
    )
    const { rows: [state] } = await db.query(
      `SELECT (EXTRACT(EPOCH FROM last_broadcast_at) * 1000)::bigint AS ts FROM broadcast_state WHERE id=1`
    )

    const mapRow = (r: Record<string, unknown>) => ({
      id: Number(r.id),
      channel: String(r.channel),
      content: String(r.content),
      status: String(r.status),
      external_id: r.external_id ? String(r.external_id) : null,
      error: r.error ? String(r.error) : null,
      ts: r.ts ? Number(r.ts) : null,
      scheduled_ts: r.scheduled_ts ? Number(r.scheduled_ts) : null,
    })

    return NextResponse.json({
      channels: BroadcastLoop.enabledChannels(),
      interval_min: cfg.BROADCAST_INTERVAL_MIN,
      preview_window_min: cfg.BROADCAST_PREVIEW_WINDOW_MIN,
      enabled: cfg.ENABLE_BROADCAST,
      recent: recent.map(mapRow),
      pending: pending.map(mapRow),
      last_broadcast_at: state?.ts ? Number(state.ts) : null,
    })
  } finally { db.release() }
}

// POST actions:
//   {} or no action              → compose + queue (manual trigger)
//   { override: '...' }          → publish exact text immediately
//   { action: 'publish_now', id }→ publish a pending row right away
//   { action: 'cancel', id }     → cancel a pending row
//   { action: 'cancel_text', content } → cancel all pending rows sharing this content
export async function POST(req: Request) {
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: 'no db' }, { status: 503 })
  const body = await req.json().catch(() => ({}))
  const action = typeof body.action === 'string' ? body.action : undefined
  const override = typeof body.override === 'string' ? body.override : undefined

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    const loop = new BroadcastLoop(db)

    if (action === 'publish_now') {
      const id = Number(body.id)
      if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
      const r = await loop.publishPending(id)
      return NextResponse.json(r, { status: r.ok ? 200 : 502 })
    }

    if (action === 'cancel') {
      const id = Number(body.id)
      if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
      const r = await loop.cancelPending(id)
      return NextResponse.json(r)
    }

    if (action === 'cancel_text') {
      const text = typeof body.content === 'string' ? body.content : null
      if (!text) return NextResponse.json({ error: 'content required' }, { status: 400 })
      const n = await loop.cancelPendingByText(text)
      return NextResponse.json({ ok: true, cancelled: n })
    }

    // Manual "post now" button: bypass the preview window.
    const result = await loop.runManual(override, true)
    return NextResponse.json(result)
  } finally { db.release() }
}
