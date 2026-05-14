// One-shot PG → $LDGR bridge.
//
// Transaction order (single connection, all-or-nothing):
//   1) lock viewers row
//   2) INSERT pg_to_ldgr_bridge (UNIQUE constraint on viewer_id → blocks
//      doubled bridges)
//   3) zero viewers.park_gates
//   4) write park_gates_ledger refund-style row marking the transfer
//   5) write bazaar_ledger entry
//   6) mint $LDGR to the agent's Phantom wallet on Solana
//
// If step 6 fails we ROLLBACK so the row vanishes and the PG balance comes
// back. Rate: 1 PG : 1 $LDGR (devnet only).

import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import { getAgentByViewer } from '@/lib/bazaar/agents'
import { appendLedger } from '@/lib/bazaar/ledger'
import { mintLdgrTo } from '@/lib/solana/ldgr'
import { viewerGuard } from '../_lib'

export const dynamic = 'force-dynamic'

export async function POST() {
  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    const vg = await viewerGuard(db)
    if (vg instanceof NextResponse) return vg

    const agent = await getAgentByViewer(db, vg.viewerId)
    if (!agent?.phantomWallet) {
      return NextResponse.json({ error: 'link a phantom wallet first' }, { status: 400 })
    }

    await db.query('BEGIN')
    try {
      const lock = await db.query(
        `SELECT park_gates FROM viewers WHERE id = $1 FOR UPDATE`,
        [vg.viewerId],
      )
      if (lock.rowCount === 0) throw new Error('viewer missing')
      const pg = Number(lock.rows[0].park_gates ?? 0)
      if (pg <= 0) throw new Error('no_pg_to_bridge')

      const ldgr = pg.toFixed(9) // 1:1
      const ins = await db.query(
        `INSERT INTO pg_to_ldgr_bridge (viewer_id, pg_burned, ldgr_minted, phantom_wallet)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [vg.viewerId, pg, ldgr, agent.phantomWallet],
      )
      await db.query(
        `UPDATE viewers SET park_gates = 0 WHERE id = $1`,
        [vg.viewerId],
      )
      await db.query(
        `INSERT INTO park_gates_ledger (viewer_id, delta, reason, ref)
         VALUES ($1, $2, 'bridge_to_ldgr', $3)`,
        [vg.viewerId, -pg, `bridge:${ins.rows[0].id}`],
      )

      let txSig: string
      try {
        txSig = await mintLdgrTo(agent.phantomWallet, ldgr)
      } catch (e) {
        throw new Error(`mint_failed: ${String(e).slice(0, 140)}`)
      }
      await db.query(
        `UPDATE pg_to_ldgr_bridge SET tx_sig = $2 WHERE id = $1`,
        [ins.rows[0].id, txSig],
      )
      await appendLedger(db, {
        actor: 'system',
        action: 'bridge.pg_to_ldgr',
        agentId: agent.id,
        refs: { pg_burned: pg, ldgr_minted: ldgr },
        txSig,
      })
      await db.query('COMMIT')
      return NextResponse.json({ ok: true, pg_burned: pg, ldgr_minted: ldgr, tx_sig: txSig })
    } catch (e) {
      await db.query('ROLLBACK')
      const msg = String(e)
      if (msg.includes('no_pg_to_bridge')) {
        return NextResponse.json({ error: 'no_pg_to_bridge' }, { status: 400 })
      }
      if (msg.includes('duplicate key')) {
        return NextResponse.json({ error: 'already_bridged' }, { status: 409 })
      }
      return NextResponse.json({ error: msg.slice(0, 200) }, { status: 500 })
    }
  } finally {
    db.release()
  }
}
