import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import { DiscoveryLoop } from '@/lib/discovery-loop'

export const dynamic = 'force-dynamic'

export async function GET() {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ items: [], last_run_at: null, counts: { watching: 0, promoted: 0, dismissed: 0 } })
  }
  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)

    const { rows } = await db.query(
      `SELECT id, source, external_id, name, url, chain, tvl, stars, scope, status,
              (EXTRACT(EPOCH FROM first_seen_at) * 1000)::bigint AS first_seen_ts,
              (EXTRACT(EPOCH FROM listed_at) * 1000)::bigint AS listed_ts
       FROM watch_targets
       ORDER BY
         CASE status WHEN 'watching' THEN 1 WHEN 'promoted' THEN 2 ELSE 3 END,
         first_seen_at DESC
       LIMIT 60`
    )
    const { rows: [state] } = await db.query(
      `SELECT (EXTRACT(EPOCH FROM last_run_at) * 1000)::bigint AS ts FROM discovery_state WHERE id=1`
    )
    const { rows: [counts] } = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status='watching')  AS watching,
         COUNT(*) FILTER (WHERE status='promoted')  AS promoted,
         COUNT(*) FILTER (WHERE status='dismissed') AS dismissed
       FROM watch_targets`
    )

    return NextResponse.json({
      items: rows.map(r => ({
        id: Number(r.id),
        source: r.source,
        external_id: r.external_id,
        name: r.name,
        url: r.url,
        chain: r.chain,
        tvl: r.tvl != null ? parseFloat(r.tvl) : null,
        stars: r.stars != null ? Number(r.stars) : null,
        scope: r.scope,
        status: r.status,
        first_seen_ts: r.first_seen_ts ? Number(r.first_seen_ts) : null,
        listed_ts: r.listed_ts ? Number(r.listed_ts) : null,
      })),
      last_run_at: state?.ts ? Number(state.ts) : null,
      counts: {
        watching: Number(counts.watching ?? 0),
        promoted: Number(counts.promoted ?? 0),
        dismissed: Number(counts.dismissed ?? 0),
      },
    })
  } finally { db.release() }
}

// POST /api/watchlist
//   { action: 'refresh' }                   → force a discovery pass now
//   { action: 'promote',  id: number }      → mark a watch target as promoted
//                                             (operator will manually feed it
//                                             into research via /api/bounties
//                                             assignment or similar)
//   { action: 'dismiss',  id: number }      → hide the row
//   { action: 'restore',  id: number }      → back to watching
export async function POST(req: Request) {
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: 'no db' }, { status: 503 })

  const body = await req.json().catch(() => ({}))
  const action = String(body.action ?? '')

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)

    if (action === 'refresh') {
      const loop = new DiscoveryLoop(db)
      const result = await loop.run(true)
      return NextResponse.json(result ?? { inserted: 0, skipped: 0, sources: [] })
    }

    const id = Number(body.id)
    if (!id || !['promote', 'dismiss', 'restore'].includes(action)) {
      return NextResponse.json({ error: 'bad request' }, { status: 400 })
    }
    const statusMap: Record<string, string> = {
      promote:  'promoted',
      dismiss:  'dismissed',
      restore:  'watching',
    }
    await db.query(
      `UPDATE watch_targets SET status=$1, updated_at=NOW() WHERE id=$2`,
      [statusMap[action], id]
    )
    return NextResponse.json({ ok: true })
  } finally { db.release() }
}
