// Viewer-callable: build an unsigned Solana tx the hirer signs in Phantom
// to fund a gig's escrow. The frontend forwards the signed tx to the RPC
// and POSTs the tx_sig back to /api/bazaar/escrow/funded for confirmation.

import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import { getGig } from '@/lib/bazaar/gigs'
import { buildInitializeTx } from '@/lib/solana/escrow'
import { viewerAgent, viewerGuard } from '../../_lib'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const body = await req.json().catch(() => null) as { gig_id?: number } | null
  if (!body?.gig_id) return NextResponse.json({ error: 'gig_id required' }, { status: 400 })

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    const vg = await viewerGuard(db)
    if (vg instanceof NextResponse) return vg
    const agent = await viewerAgent(db, vg.viewerId)
    if (!agent || !agent.phantomWallet) {
      return NextResponse.json({ error: 'link phantom wallet first' }, { status: 400 })
    }

    const data = await getGig(db, body.gig_id)
    if (!data) return NextResponse.json({ error: 'gig not found' }, { status: 404 })
    if (data.gig.hirerAgentId !== agent.id) {
      return NextResponse.json({ error: 'only the hirer can fund' }, { status: 403 })
    }
    if (data.gig.state !== 'negotiating') {
      return NextResponse.json({ error: `gig in state ${data.gig.state}` }, { status: 409 })
    }

    const workerWallet = await db.query(
      `SELECT phantom_wallet FROM bazaar_agents WHERE id = $1`,
      [data.gig.workerAgentId],
    )
    const workerPubkey = workerWallet.rows[0]?.phantom_wallet as string | null
    if (!workerPubkey) {
      return NextResponse.json({ error: 'worker has not linked a wallet' }, { status: 400 })
    }

    const moderatorPubkey = process.env.LILA_BOT_SOLANA_PUBKEY
    if (!moderatorPubkey) {
      return NextResponse.json({ error: 'moderator pubkey not configured' }, { status: 503 })
    }

    try {
      const { tx, accounts } = await buildInitializeTx({
        gigId: body.gig_id,
        hirerPubkey: agent.phantomWallet,
        workerPubkey,
        moderatorPubkey,
        milestoneAmountsLdgr: data.milestones.map((m) => m.amountLdgr),
      })
      return NextResponse.json({ ok: true, tx_base64: tx, accounts })
    } catch (e) {
      return NextResponse.json({ error: 'tx_build_failed', detail: String(e).slice(0, 200) }, { status: 500 })
    }
  } finally {
    db.release()
  }
}
