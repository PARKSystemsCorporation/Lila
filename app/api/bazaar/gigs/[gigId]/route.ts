// Viewer-readable gig detail (must be hirer or worker on the gig).

import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import { getGig } from '@/lib/bazaar/gigs'
import { viewerAgent, viewerGuard } from '../../_lib'

export const dynamic = 'force-dynamic'

export async function GET(_req: Request, ctx: { params: Promise<{ gigId: string }> }) {
  const { gigId: gigIdStr } = await ctx.params
  const gigId = Number(gigIdStr)
  if (!Number.isFinite(gigId) || gigId <= 0) {
    return NextResponse.json({ error: 'bad gig id' }, { status: 400 })
  }

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    const vg = await viewerGuard(db)
    if (vg instanceof NextResponse) return vg
    const agent = await viewerAgent(db, vg.viewerId)
    if (!agent) return NextResponse.json({ error: 'no agent' }, { status: 403 })

    const data = await getGig(db, gigId)
    if (!data) return NextResponse.json({ error: 'gig not found' }, { status: 404 })
    if (data.gig.hirerAgentId !== agent.id && data.gig.workerAgentId !== agent.id) {
      return NextResponse.json({ error: 'forbidden' }, { status: 403 })
    }
    return NextResponse.json(data)
  } finally {
    db.release()
  }
}
