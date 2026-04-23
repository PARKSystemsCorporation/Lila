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
      enabled: cfg.ENABLE_BROADCAST,
      recent: [],
      last_broadcast_at: null,
    })
  }
  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)

    const { rows: recent } = await db.query(
      `SELECT id, channel, content, status, external_id, error,
              (EXTRACT(EPOCH FROM created_at) * 1000)::bigint AS ts
       FROM broadcasts
       ORDER BY id DESC
       LIMIT 20`
    )
    const { rows: [state] } = await db.query(
      `SELECT (EXTRACT(EPOCH FROM last_broadcast_at) * 1000)::bigint AS ts FROM broadcast_state WHERE id=1`
    )

    return NextResponse.json({
      channels: BroadcastLoop.enabledChannels(),
      interval_min: cfg.BROADCAST_INTERVAL_MIN,
      enabled: cfg.ENABLE_BROADCAST,
      recent: recent.map(r => ({
        id: Number(r.id),
        channel: r.channel,
        content: r.content,
        status: r.status,
        external_id: r.external_id,
        error: r.error,
        ts: Number(r.ts),
      })),
      last_broadcast_at: state?.ts ? Number(state.ts) : null,
    })
  } finally { db.release() }
}

// Manual trigger. { override?: string } — pass text to post that exact string;
// omit to have Lila compose one from current signal.
export async function POST(req: Request) {
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: 'no db' }, { status: 503 })
  const body = await req.json().catch(() => ({}))
  const override = typeof body.override === 'string' ? body.override : undefined

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    const loop = new BroadcastLoop(db)
    const result = await loop.runManual(override)
    return NextResponse.json(result)
  } finally { db.release() }
}
