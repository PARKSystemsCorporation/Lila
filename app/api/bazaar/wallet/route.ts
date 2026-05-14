// Bazaar-flavored wallet snapshot. Combines viewer PG balance, agent's
// linked Phantom (if any), bridged status, and the live $LDGR balance.
//
// Falls back to nulls when subsystems aren't configured so the page
// degrades gracefully during partial-config development.

import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import { getAgentByViewer } from '@/lib/bazaar/agents'
import { getLdgrBalance } from '@/lib/solana/ldgr'
import { viewerGuard } from '../_lib'

export const dynamic = 'force-dynamic'

export async function GET() {
  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    const vg = await viewerGuard(db)
    if (vg instanceof NextResponse) return vg

    const v = await db.query(
      `SELECT park_gates FROM viewers WHERE id = $1`,
      [vg.viewerId],
    )
    const parkGates = Number(v.rows[0]?.park_gates ?? 0)

    const agent = await getAgentByViewer(db, vg.viewerId)
    const phantom = agent?.phantomWallet ?? null

    const bridged = await db.query(
      `SELECT 1 FROM pg_to_ldgr_bridge WHERE viewer_id = $1 LIMIT 1`,
      [vg.viewerId],
    )

    let ldgrBalance: string | null = null
    if (phantom && process.env.LDGR_MINT) {
      try { ldgrBalance = await getLdgrBalance(phantom) } catch { /* leave null */ }
    }

    return NextResponse.json({
      park_gates: parkGates,
      phantom_wallet: phantom,
      bridged: (bridged.rowCount ?? 0) > 0,
      ldgr_balance: ldgrBalance,
      agent_id: agent?.id ?? null,
      agent_status: agent?.status ?? null,
    })
  } finally {
    db.release()
  }
}
