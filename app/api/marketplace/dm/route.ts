// Marketplace product: 1 DM to an agent for 10 Park Gates.
//
// Atomic: spendGates() is a single conditional UPDATE so two concurrent
// requests can't double-debit. Only after the spend succeeds do we
// queue the DM row. If the queue insert fails for any reason we issue
// a refund ledger row + park_gates += amount in the same connection.

import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { getPool, ensureSchema } from '@/lib/db'
import { verifyViewerCookie } from '@/lib/viewer-auth'
import { spendGates } from '@/lib/viewers'

export const dynamic = 'force-dynamic'

const DM_COST = 10
const AGENTS = new Set(['lila', 'ceelo', 'vega'])
const MAX_PROMPT_LEN = 1200

export async function POST(req: Request) {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'database unavailable' }, { status: 503 })
  }
  const secret = process.env.VIEWER_COOKIE_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'viewer auth not configured' }, { status: 503 })
  }

  const viewerCookie = cookies().get('lila_viewer')?.value
  const payload = await verifyViewerCookie(viewerCookie, secret)
  if (!payload) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const body = await req.json().catch(() => null) as { agent?: string; prompt?: string } | null
  const agent  = String(body?.agent ?? '').toLowerCase()
  const prompt = String(body?.prompt ?? '').trim().slice(0, MAX_PROMPT_LEN)
  if (!AGENTS.has(agent)) {
    return NextResponse.json({ error: 'invalid agent' }, { status: 400 })
  }
  if (prompt.length < 4) {
    return NextResponse.json({ error: 'prompt too short' }, { status: 400 })
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

    const spend = await spendGates(db, viewerId, DM_COST, 'spend', `dm:${agent}`)
    if (!spend.ok) {
      return NextResponse.json(
        { error: spend.reason ?? 'spend_failed', remaining: spend.remaining, cost: DM_COST },
        { status: spend.reason === 'insufficient' ? 402 : 403 },
      )
    }

    let dmId: number
    try {
      const ins = await db.query(
        `INSERT INTO viewer_dms (viewer_id, agent, prompt, cost_pg, status)
         VALUES ($1, $2, $3, $4, 'queued')
         RETURNING id`,
        [viewerId, agent, prompt, DM_COST],
      )
      dmId = Number(ins.rows[0].id)
    } catch (e) {
      // Queue insert failed — issue refund so the spend isn't dropped.
      await db.query(
        `UPDATE viewers SET park_gates = park_gates + $2 WHERE id = $1`,
        [viewerId, DM_COST],
      )
      await db.query(
        `INSERT INTO park_gates_ledger (viewer_id, delta, reason, ref)
         VALUES ($1, $2, 'refund', $3)`,
        [viewerId, DM_COST, `dm:${agent}:queue_failed`],
      )
      return NextResponse.json({ error: 'queue_failed', detail: String(e).slice(0, 120) }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      dm_id: dmId,
      cost: DM_COST,
      remaining: spend.remaining,
    })
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 200) }, { status: 500 })
  } finally {
    db.release()
  }
}

export async function GET() {
  return NextResponse.json({ cost: DM_COST, agents: Array.from(AGENTS) })
}
