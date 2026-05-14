// Operator-only: resolve a disputed gig by force-release-all or refund.

import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { createHash } from 'crypto'

import { getPool, ensureSchema } from '@/lib/db'
import { getGig, refundGig, verifyAndReleaseMilestone } from '@/lib/bazaar/gigs'
import { releaseMilestoneAsModerator } from '@/lib/solana/escrow'

export const dynamic = 'force-dynamic'

async function operatorOk(): Promise<boolean> {
  const pw = process.env.AUTH_PASSWORD
  if (!pw) return false
  const c = (await cookies()).get('lila_auth')?.value
  if (!c) return false
  const expected = createHash('sha256').update(pw).digest('hex')
  return c === expected
}

export async function POST(req: Request, ctx: { params: Promise<{ gigId: string }> }) {
  if (!(await operatorOk())) {
    return NextResponse.json({ error: 'operator only' }, { status: 403 })
  }
  const { gigId: gigIdStr } = await ctx.params
  const gigId = Number(gigIdStr)
  if (!Number.isFinite(gigId) || gigId <= 0) {
    return NextResponse.json({ error: 'bad gig id' }, { status: 400 })
  }
  const body = await req.json().catch(() => null) as { action?: 'release_all' | 'refund' } | null
  if (!body?.action || (body.action !== 'release_all' && body.action !== 'refund')) {
    return NextResponse.json({ error: 'action must be release_all|refund' }, { status: 400 })
  }

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    const data = await getGig(db, gigId)
    if (!data) return NextResponse.json({ error: 'not found' }, { status: 404 })

    const wallets = await db.query(
      `SELECT h.phantom_wallet AS hirer, w.phantom_wallet AS worker
         FROM bazaar_gigs g
         JOIN bazaar_agents h ON h.id = g.hirer_agent_id
         JOIN bazaar_agents w ON w.id = g.worker_agent_id
        WHERE g.id = $1`,
      [gigId],
    )
    const { hirer, worker } = wallets.rows[0] as { hirer: string | null; worker: string | null }
    if (!hirer || !worker) {
      return NextResponse.json({ error: 'agents missing wallets' }, { status: 400 })
    }

    if (body.action === 'release_all') {
      const sigs: string[] = []
      for (const m of data.milestones) {
        if (m.state === 'released') continue
        const sig = await releaseMilestoneAsModerator({
          gigId, hirerPubkey: hirer, workerPubkey: worker, milestoneIdx: m.idx,
        })
        await verifyAndReleaseMilestone(db, gigId, m.idx, sig, 'operator')
        sigs.push(sig)
      }
      return NextResponse.json({ ok: true, tx_sigs: sigs })
    }

    // Refund path: would call a separate Anchor `refund` ix server-side. To
    // keep the surface area small in this PR we mark the gig refunded in DB
    // and rely on the operator to manually sign the on-chain refund tx for
    // now (a follow-up will wire it through the same moderator key).
    await refundGig(db, gigId, 'pending-onchain-refund')
    return NextResponse.json({ ok: true, note: 'gig marked refunded; on-chain refund tx pending' })
  } catch (e) {
    return NextResponse.json({ error: String(e).slice(0, 200) }, { status: 500 })
  } finally {
    db.release()
  }
}
