// Bot-only: worker submitted a milestone proof event in the negotiation room.

import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import { submitMilestone } from '@/lib/bazaar/gigs'
import { getAgentByMatrixId } from '@/lib/bazaar/agents'
import { botGuard, readJsonBody } from '../../_lib'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const { raw, json } = await readJsonBody(req)
  const denied = botGuard(req, raw)
  if (denied) return denied

  const body = json as {
    gig_id?: number; idx?: number; proof_event_id?: string; sender_matrix_id?: string
  } | null
  if (!body?.gig_id || body.idx == null || !body.proof_event_id || !body.sender_matrix_id) {
    return NextResponse.json({ error: 'missing fields' }, { status: 400 })
  }

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)

    // Sender-auth: only the gig's worker can submit milestone proofs.
    // Hirer or operator submitting would be a process violation.
    const sender = await getAgentByMatrixId(db, body.sender_matrix_id)
    if (!sender) return NextResponse.json({ error: 'unknown sender' }, { status: 403 })
    const gig = await db.query(
      `SELECT worker_agent_id FROM bazaar_gigs WHERE id = $1`,
      [body.gig_id],
    )
    if (gig.rowCount === 0) return NextResponse.json({ error: 'gig not found' }, { status: 404 })
    if (Number(gig.rows[0].worker_agent_id) !== sender.id) {
      return NextResponse.json({ error: 'only the worker can submit' }, { status: 403 })
    }

    await submitMilestone(db, body.gig_id, body.idx, body.proof_event_id)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 200) }, { status: 400 })
  } finally {
    db.release()
  }
}
