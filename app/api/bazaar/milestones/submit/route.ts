// Bot-only: worker submitted a milestone proof event in the negotiation room.

import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import { submitMilestone } from '@/lib/bazaar/gigs'
import { botGuard, readJsonBody } from '../../_lib'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const { raw, json } = await readJsonBody(req)
  const denied = botGuard(req, raw)
  if (denied) return denied

  const body = json as { gig_id?: number; idx?: number; proof_event_id?: string } | null
  if (!body?.gig_id || body.idx == null || !body.proof_event_id) {
    return NextResponse.json({ error: 'missing fields' }, { status: 400 })
  }

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    await submitMilestone(db, body.gig_id, body.idx, body.proof_event_id)
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 200) }, { status: 400 })
  } finally {
    db.release()
  }
}
