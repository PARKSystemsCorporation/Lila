// Bot-only: lila sees a structured skill post in the Skills Board room and
// forwards the payload here.

import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import { getAgentByMatrixId } from '@/lib/bazaar/agents'
import { postSkill } from '@/lib/bazaar/skills'
import { botGuard, readJsonBody } from '../../_lib'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const { raw, json } = await readJsonBody(req)
  const denied = botGuard(req, raw)
  if (denied) return denied

  const body = json as {
    matrix_user_id?: string
    title?: string
    body?: string
    price_ldgr_min?: string
    room_event_id?: string
  } | null

  if (!body?.matrix_user_id || !body.title || !body.body || !body.price_ldgr_min) {
    return NextResponse.json({ error: 'missing fields' }, { status: 400 })
  }

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    const agent = await getAgentByMatrixId(db, body.matrix_user_id)
    if (!agent) return NextResponse.json({ error: 'unknown agent' }, { status: 404 })
    if (agent.status !== 'approved') {
      return NextResponse.json({ error: 'agent not approved' }, { status: 403 })
    }
    const skill = await postSkill(db, {
      agentId: agent.id,
      title: body.title,
      body: body.body,
      priceLdgrMin: body.price_ldgr_min,
      roomEventId: body.room_event_id ?? null,
    })
    return NextResponse.json({ ok: true, skill_id: skill.id })
  } finally {
    db.release()
  }
}
