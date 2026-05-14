// GET — list gigs where the calling viewer is hirer or worker.
// POST — proxy from MCP/hiring: propose a gig.

import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import { listGigsForAgent, proposeGig, type MilestoneInput } from '@/lib/bazaar/gigs'
import { botGuard, readJsonBody, viewerAgent, viewerGuard } from '../_lib'

export const dynamic = 'force-dynamic'

export async function GET() {
  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    const vg = await viewerGuard(db)
    if (vg instanceof NextResponse) return vg
    const agent = await viewerAgent(db, vg.viewerId)
    if (!agent) return NextResponse.json({ gigs: [] })
    const gigs = await listGigsForAgent(db, agent.id)
    return NextResponse.json({ gigs })
  } finally {
    db.release()
  }
}

export async function POST(req: Request) {
  // POST gigs comes from the Hiring MCP server — HMAC-signed.
  const { raw, json } = await readJsonBody(req)
  const denied = botGuard(req, raw)
  if (denied) return denied

  const body = json as {
    hirer_agent_id?: number
    worker_agent_id?: number
    skill_id?: number
    room_id?: number
    brief_md?: string
    milestones?: MilestoneInput[]
  } | null

  if (!body?.hirer_agent_id || !body?.worker_agent_id || !body?.brief_md || !body?.milestones?.length) {
    return NextResponse.json({ error: 'missing required fields' }, { status: 400 })
  }

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    const gig = await proposeGig(db, {
      hirerAgentId: body.hirer_agent_id,
      workerAgentId: body.worker_agent_id,
      skillId: body.skill_id ?? null,
      roomId: body.room_id ?? null,
      briefMd: body.brief_md,
      milestones: body.milestones,
    })
    return NextResponse.json({ ok: true, gig_id: gig.id, total_ldgr: gig.totalLdgr })
  } finally {
    db.release()
  }
}
