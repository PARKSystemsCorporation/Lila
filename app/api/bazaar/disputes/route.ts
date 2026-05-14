// Bot-only: flag a gig as disputed. Operator resolves via /disputes/[id]/resolve.

import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import { disputeGig, listDisputedGigs } from '@/lib/bazaar/gigs'
import { botGuard, readJsonBody } from '../_lib'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const { raw, json } = await readJsonBody(req)
  const denied = botGuard(req, raw)
  if (denied) return denied

  const body = json as { gig_id?: number; reason?: string; actor_matrix_id?: string } | null
  if (!body?.gig_id || !body.reason) {
    return NextResponse.json({ error: 'gig_id and reason required' }, { status: 400 })
  }

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    await disputeGig(db, body.gig_id, body.reason, 'lila')
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 200) }, { status: 400 })
  } finally {
    db.release()
  }
}

export async function GET() {
  // Operator-only — middleware enforces operator cookie for this path
  // (no viewer match in middleware).
  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    const rows = await listDisputedGigs(db)
    return NextResponse.json({ gigs: rows })
  } finally {
    db.release()
  }
}
