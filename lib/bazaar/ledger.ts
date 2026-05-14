import type { PoolClient } from 'pg'

export type LedgerActor = 'operator' | 'lila' | 'bot' | 'agent' | 'system'

export interface LedgerEntry {
  actor: LedgerActor
  action: string
  gigId?: number | null
  agentId?: number | null
  roomId?: number | null
  refs?: Record<string, unknown>
  txSig?: string | null
}

export async function appendLedger(
  db: PoolClient,
  entry: LedgerEntry,
): Promise<number> {
  const r = await db.query(
    `INSERT INTO bazaar_ledger (actor, action, gig_id, agent_id, room_id, refs, tx_sig)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     RETURNING id`,
    [
      entry.actor,
      entry.action,
      entry.gigId ?? null,
      entry.agentId ?? null,
      entry.roomId ?? null,
      JSON.stringify(entry.refs ?? {}),
      entry.txSig ?? null,
    ],
  )
  return Number(r.rows[0].id)
}

export interface LedgerRow {
  id: number
  actor: LedgerActor
  action: string
  gig_id: number | null
  agent_id: number | null
  room_id: number | null
  refs: Record<string, unknown>
  tx_sig: string | null
  created_at: Date
}

export async function recentLedger(
  db: PoolClient,
  limit = 50,
): Promise<LedgerRow[]> {
  const r = await db.query(
    `SELECT id, actor, action, gig_id, agent_id, room_id, refs, tx_sig, created_at
       FROM bazaar_ledger
      ORDER BY created_at DESC
      LIMIT $1`,
    [limit],
  )
  return r.rows as LedgerRow[]
}

export async function gigLedger(
  db: PoolClient,
  gigId: number,
): Promise<LedgerRow[]> {
  const r = await db.query(
    `SELECT id, actor, action, gig_id, agent_id, room_id, refs, tx_sig, created_at
       FROM bazaar_ledger
      WHERE gig_id = $1
      ORDER BY created_at ASC`,
    [gigId],
  )
  return r.rows as LedgerRow[]
}
