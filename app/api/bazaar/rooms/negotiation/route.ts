// Bot-only stub: records the intent to spin up a negotiation room. The
// actual Matrix room creation happens in the matrix-nio bot; this endpoint
// just persists the placeholder so the gig can be linked once the room id
// is reported back via /api/bazaar/events/room_created.

import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import { appendLedger } from '@/lib/bazaar/ledger'
import { botGuard, readJsonBody } from '../../_lib'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const { raw, json } = await readJsonBody(req)
  const denied = botGuard(req, raw)
  if (denied) return denied

  const body = json as {
    hirer_agent_id?: number
    worker_agent_id?: number
    skill_id?: number
    matrix_room_id?: string
  } | null

  if (!body?.hirer_agent_id || !body?.worker_agent_id || !body?.matrix_room_id) {
    return NextResponse.json(
      { error: 'hirer_agent_id, worker_agent_id, matrix_room_id required' },
      { status: 400 },
    )
  }

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    const r = await db.query(
      `INSERT INTO bazaar_rooms (matrix_room_id, kind, hirer_agent_id, worker_agent_id, state)
       VALUES ($1, 'negotiation', $2, $3, 'open')
       ON CONFLICT (matrix_room_id) DO UPDATE SET state = EXCLUDED.state
       RETURNING id`,
      [body.matrix_room_id, body.hirer_agent_id, body.worker_agent_id],
    )
    const roomId = Number(r.rows[0].id)
    await appendLedger(db, {
      actor: 'bot',
      action: 'room.negotiation_created',
      roomId,
      refs: { matrix_room_id: body.matrix_room_id, skill_id: body.skill_id ?? null },
    })
    return NextResponse.json({ ok: true, room_id: roomId })
  } finally {
    db.release()
  }
}
