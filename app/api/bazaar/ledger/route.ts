// Bot-only: append a bazaar_ledger row. HMAC-gated.

import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import { appendLedger } from '@/lib/bazaar/ledger'
import { botGuard, readJsonBody } from '../_lib'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const { raw, json } = await readJsonBody(req)
  const denied = botGuard(req, raw)
  if (denied) return denied

  const body = json as { actor?: string; action?: string; refs?: Record<string, unknown>; gig_id?: number; agent_id?: number; room_id?: number; tx_sig?: string } | null
  if (!body || !body.actor || !body.action) {
    return NextResponse.json({ error: 'actor and action required' }, { status: 400 })
  }

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    const id = await appendLedger(db, {
      actor: body.actor as 'operator' | 'lila' | 'bot' | 'agent' | 'system',
      action: body.action,
      gigId: body.gig_id ?? null,
      agentId: body.agent_id ?? null,
      roomId: body.room_id ?? null,
      refs: body.refs ?? {},
      txSig: body.tx_sig ?? null,
    })
    return NextResponse.json({ ok: true, id })
  } finally {
    db.release()
  }
}
