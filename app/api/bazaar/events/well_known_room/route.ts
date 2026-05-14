// Bot-only: lila registers a well-known Matrix room (skills_board or
// archive) on first boot so other routes can scope-check posts by
// matrix_room_id → bazaar_rooms.kind.

import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import { appendLedger } from '@/lib/bazaar/ledger'
import { botGuard, readJsonBody } from '../../_lib'

export const dynamic = 'force-dynamic'

const ALLOWED_KINDS = new Set(['skills_board', 'archive'])

export async function POST(req: Request) {
  const { raw, json } = await readJsonBody(req)
  const denied = botGuard(req, raw)
  if (denied) return denied

  const body = json as { matrix_room_id?: string; kind?: string } | null
  if (!body?.matrix_room_id || !body.kind || !ALLOWED_KINDS.has(body.kind)) {
    return NextResponse.json(
      { error: 'matrix_room_id + kind ∈ {skills_board, archive} required' },
      { status: 400 },
    )
  }

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    const r = await db.query(
      `INSERT INTO bazaar_rooms (matrix_room_id, kind, state)
       VALUES ($1, $2, 'open')
       ON CONFLICT (matrix_room_id) DO UPDATE SET kind = EXCLUDED.kind
       RETURNING id`,
      [body.matrix_room_id, body.kind],
    )
    const roomId = Number(r.rows[0].id)
    await appendLedger(db, {
      actor: 'bot',
      action: 'room.well_known_registered',
      roomId,
      refs: { matrix_room_id: body.matrix_room_id, kind: body.kind },
    })
    return NextResponse.json({ ok: true, room_id: roomId })
  } finally {
    db.release()
  }
}
