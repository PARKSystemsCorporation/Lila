import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import * as Desk from '@/lib/desk'

export const dynamic = 'force-dynamic'

// GET  /api/desk?status=pending|approved|denied|reported|all
//                 [&direction=to_operator|to_lila|to_agent]
//                 [&category=code-request|help-request|web-post|...]
//   → { items: [...], counts: { pending, approved, reported, denied } }
//
// POST /api/desk  { from, title, summary?, body, kind?,
//                   direction?, to_agent?, category?, payload? }
//   → { ok: true, id }   filing endpoint — used by operator UI for the
//                        inbound (to_lila) request form, and by tooling.

const VALID_DIRECTIONS = new Set(['to_operator', 'to_lila', 'to_agent'])

export async function GET(req: Request) {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ items: [], counts: { pending: 0, approved: 0, reported: 0, denied: 0 } })
  }

  const url = new URL(req.url)
  const status = (url.searchParams.get('status') ?? 'pending').toLowerCase()
  const direction = url.searchParams.get('direction')
  const category = url.searchParams.get('category')

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)

    const conds: string[] = []
    const params: unknown[] = []
    if (status !== 'all') { params.push(status); conds.push(`status = $${params.length}`) }
    if (direction && VALID_DIRECTIONS.has(direction)) { params.push(direction); conds.push(`direction = $${params.length}`) }
    if (category) { params.push(category); conds.push(`category = $${params.length}`) }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''

    const { rows } = await db.query(
      `SELECT id, from_agent, to_agent, direction, category, payload,
              title, summary, body, kind, status,
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
        to_agent: r.to_agent,
        direction: r.direction,
        category: r.category,
        payload: r.payload,
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

  // Two filing flavours:
  //   - direction='to_lila' (operator inbound): from='operator' is virtual;
  //     we accept any from value and store 'lila' as the from_agent so the
  //     row is recognisable without breaking the existing CHECK on agent
  //     names. The operator's intent is captured in payload.
  //   - default: legacy agent→operator filing, requires from ∈ valid set.
  const direction = String(body.direction ?? 'to_operator')
  if (!VALID_DIRECTIONS.has(direction)) {
    return NextResponse.json({ error: 'bad direction' }, { status: 400 })
  }

  const title = String(body.title ?? '').trim()
  const content = String(body.body ?? '').trim()
  if (!title || !content) return NextResponse.json({ error: 'title + body required' }, { status: 400 })

  let from = String(body.from ?? '').toLowerCase()
  if (direction === 'to_lila') {
    // Operator-side filing — we don't require a real agent name. Coerce
    // to 'lila' so the from_agent CHECK (if any) stays satisfied; the
    // direction column is the disambiguator.
    from = 'lila'
  } else if (!['lila','cipher','vega','scout','ceelo'].includes(from)) {
    return NextResponse.json({ error: 'bad from agent' }, { status: 400 })
  }

  const toAgentRaw = body.to_agent ? String(body.to_agent).toLowerCase() : null
  const toAgent = (toAgentRaw && ['lila','cipher','vega','scout','ceelo'].includes(toAgentRaw))
    ? toAgentRaw as Desk.DeskAgent
    : undefined

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
      direction: direction as Desk.DeskDirection,
      toAgent,
      category: body.category,
      payload: body.payload,
    })
    return NextResponse.json({ ok: true, id: r.id })
  } finally { db.release() }
}
