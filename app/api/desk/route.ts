import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import * as Desk from '@/lib/desk'

export const dynamic = 'force-dynamic'

// GET  /api/desk?status=pending|approved|denied|reported|all
//   → { items: [...], counts: { pending, approved, reported, denied } }
//
// POST /api/desk  { from, title, summary?, body, kind? }
//   → { ok: true, id }   manual operator-side filing (mostly for testing)

export async function GET(req: Request) {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ items: [], counts: { pending: 0, approved: 0, reported: 0, denied: 0 } })
  }

  const url = new URL(req.url)
  const status = (url.searchParams.get('status') ?? 'pending').toLowerCase()

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)

    const where = status === 'all' ? '' : 'WHERE status = $1'
    const params = status === 'all' ? [] : [status]

    const { rows } = await db.query(
      `SELECT id, from_agent, title, summary, body, kind, status,
              operator_comment, report_message,
              (EXTRACT(EPOCH FROM created_at)  * 1000)::bigint AS created_ts,
              (EXTRACT(EPOCH FROM approved_at) * 1000)::bigint AS approved_ts,
              (EXTRACT(EPOCH FROM denied_at)   * 1000)::bigint AS denied_ts,
              (EXTRACT(EPOCH FROM reported_at) * 1000)::bigint AS reported_ts
       FROM desk_items ${where}
       ORDER BY
         CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END,
         created_at DESC
       LIMIT 100`,
      params
    )

    const { rows: [counts] } = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status='pending')  AS pending,
         COUNT(*) FILTER (WHERE status='approved') AS approved,
         COUNT(*) FILTER (WHERE status='reported') AS reported,
         COUNT(*) FILTER (WHERE status='denied')   AS denied
       FROM desk_items`
    )

    return NextResponse.json({
      items: rows.map(r => ({
        id: Number(r.id),
        from_agent: r.from_agent,
        title: r.title,
        summary: r.summary,
        body: r.body,
        kind: r.kind,
        status: r.status,
        operator_comment: r.operator_comment,
        report_message: r.report_message,
        created_ts:  r.created_ts  != null ? Number(r.created_ts)  : null,
        approved_ts: r.approved_ts != null ? Number(r.approved_ts) : null,
        denied_ts:   r.denied_ts   != null ? Number(r.denied_ts)   : null,
        reported_ts: r.reported_ts != null ? Number(r.reported_ts) : null,
      })),
      counts: {
        pending:  Number(counts?.pending  ?? 0),
        approved: Number(counts?.approved ?? 0),
        reported: Number(counts?.reported ?? 0),
        denied:   Number(counts?.denied   ?? 0),
      },
    })
  } finally { db.release() }
}

export async function POST(req: Request) {
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: 'no db' }, { status: 503 })
  const body = await req.json().catch(() => ({}))
  const from = String(body.from ?? '').toLowerCase()
  if (!['lila','cipher','vega','scout','ceelo'].includes(from)) {
    return NextResponse.json({ error: 'bad from agent' }, { status: 400 })
  }
  const title = String(body.title ?? '').trim()
  const content = String(body.body ?? '').trim()
  if (!title || !content) return NextResponse.json({ error: 'title + body required' }, { status: 400 })

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    const r = await Desk.submit(db, {
      from: from as Desk.DeskAgent,
      title,
      summary: body.summary,
      body: content,
      kind: body.kind,
    })
    return NextResponse.json({ ok: true, id: r.id })
  } finally { db.release() }
}
