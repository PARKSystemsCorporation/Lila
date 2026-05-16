// Server-side milestone release. Called by:
//   1) Lila bot (HMAC) after it verifies a submitted milestone in the room
//   2) Operator (cookie) via the disputes panel when force-releasing
//
// Lila bot's Solana key (LILA_BOT_SOLANA_SECRET) is the moderator signer.

import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createHash, timingSafeEqual } from 'crypto'

import { getPool, ensureSchema } from '@/lib/db'
import { getGig, verifyAndReleaseMilestone } from '@/lib/bazaar/gigs'
import { getAgentByMatrixId } from '@/lib/bazaar/agents'
import { releaseMilestoneAsModerator } from '@/lib/solana/escrow'
import { botGuard, readJsonBody } from '../../_lib'

export const dynamic = 'force-dynamic'

// Constant-time string compare. timingSafeEqual throws on length mismatch,
// so gate on length first — the expected value's length (64 hex chars) is
// not secret; the password-derived bytes are.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

async function operatorCookieValid(): Promise<boolean> {
  const password = process.env.AUTH_PASSWORD
  if (!password) return false
  const c = (await cookies()).get('lila_auth')?.value
  if (!c) return false
  const expected = createHash('sha256').update(password).digest('hex')
  return safeEqual(c, expected)
}

export async function POST(req: Request) {
  const { raw, json } = await readJsonBody(req)
  const operatorOk = await operatorCookieValid()
  if (!operatorOk) {
    const denied = botGuard(req, raw)
    if (denied) return denied
  }

  const body = json as {
    gig_id?: number; idx?: number; sender_matrix_id?: string
  } | null
  if (!body?.gig_id || body.idx == null) {
    return NextResponse.json({ error: 'missing fields' }, { status: 400 })
  }
  // Bot path must always carry the sender_matrix_id so we can authorize
  // against the gig hirer. Operator path bypasses this — the cookie check
  // above already established trust.
  if (!operatorOk && !body.sender_matrix_id) {
    return NextResponse.json({ error: 'sender_matrix_id required' }, { status: 400 })
  }

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    const data = await getGig(db, body.gig_id)
    if (!data) return NextResponse.json({ error: 'gig not found' }, { status: 404 })

    // Sender-auth (bot path only): the !verify command must come from the
    // gig's hirer. Worker, third-party, or unknown senders are rejected
    // before any Solana ix is constructed.
    if (!operatorOk) {
      const sender = await getAgentByMatrixId(db, body.sender_matrix_id!)
      if (!sender) return NextResponse.json({ error: 'unknown sender' }, { status: 403 })
      if (sender.id !== data.gig.hirerAgentId) {
        return NextResponse.json({ error: 'only the hirer can release' }, { status: 403 })
      }
    }

    // Look up hirer/worker wallets so we can build the on-chain accounts.
    const wallets = await db.query(
      `SELECT
         h.phantom_wallet AS hirer_wallet,
         w.phantom_wallet AS worker_wallet
       FROM bazaar_gigs g
       JOIN bazaar_agents h ON h.id = g.hirer_agent_id
       JOIN bazaar_agents w ON w.id = g.worker_agent_id
       WHERE g.id = $1`,
      [body.gig_id],
    )
    if (wallets.rowCount === 0) {
      return NextResponse.json({ error: 'gig agents missing' }, { status: 500 })
    }
    const { hirer_wallet, worker_wallet } = wallets.rows[0] as { hirer_wallet: string | null; worker_wallet: string | null }
    if (!hirer_wallet || !worker_wallet) {
      return NextResponse.json({ error: 'agents missing wallets' }, { status: 400 })
    }

    let txSig: string
    try {
      txSig = await releaseMilestoneAsModerator({
        gigId: body.gig_id,
        hirerPubkey: hirer_wallet,
        workerPubkey: worker_wallet,
        milestoneIdx: body.idx,
      })
    } catch (e) {
      return NextResponse.json({ error: 'on_chain_release_failed', detail: String(e).slice(0, 200) }, { status: 502 })
    }

    await verifyAndReleaseMilestone(
      db, body.gig_id, body.idx, txSig,
      operatorOk ? 'operator' : 'lila',
    )
    return NextResponse.json({ ok: true, tx_sig: txSig })
  } finally {
    db.release()
  }
}
