// Phantom wallet link flow.
//   GET  → returns a fresh challenge (signed with VIEWER_COOKIE_SECRET)
//   POST → { pubkey, signature, challenge } → verify Ed25519, then upsert
//          the agent row for this viewer and store the wallet.

import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import { buildChallenge, parseChallenge, verifyEd25519 } from '@/lib/solana/wallet-verify'
import { createAgent, getAgentByViewer, linkPhantomWallet } from '@/lib/bazaar/agents'
import { viewerGuard } from '../../_lib'

export const dynamic = 'force-dynamic'

export async function GET() {
  const secret = process.env.VIEWER_COOKIE_SECRET
  if (!secret) return NextResponse.json({ error: 'auth not configured' }, { status: 503 })
  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    const vg = await viewerGuard(db)
    if (vg instanceof NextResponse) return vg
    const challenge = buildChallenge(vg.viewerId, secret)
    return NextResponse.json({ challenge })
  } finally {
    db.release()
  }
}

export async function POST(req: Request) {
  const secret = process.env.VIEWER_COOKIE_SECRET
  if (!secret) return NextResponse.json({ error: 'auth not configured' }, { status: 503 })

  const body = await req.json().catch(() => null) as {
    pubkey?: string; signature?: string; challenge?: string
  } | null
  if (!body?.pubkey || !body.signature || !body.challenge) {
    return NextResponse.json({ error: 'pubkey, signature, challenge required' }, { status: 400 })
  }

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    const vg = await viewerGuard(db)
    if (vg instanceof NextResponse) return vg

    const parsed = parseChallenge(body.challenge, vg.viewerId, secret)
    if (!parsed) return NextResponse.json({ error: 'invalid_or_expired_challenge' }, { status: 400 })

    const ok = await verifyEd25519(body.challenge, body.signature, body.pubkey).catch(() => false)
    if (!ok) return NextResponse.json({ error: 'bad_signature' }, { status: 400 })

    let agent = await getAgentByViewer(db, vg.viewerId)
    if (!agent) {
      // Provisional agent — operator approves later through the admin path.
      const matrixUserId = `@viewer-${vg.viewerId}:${process.env.SYNAPSE_SERVER_NAME ?? 'bazaar.local'}`
      const created = await createAgent(db, {
        viewerId: vg.viewerId,
        matrixUserId,
        displayName: `viewer-${vg.viewerId}`,
      })
      agent = created.agent
    }
    await linkPhantomWallet(db, agent.id, body.pubkey)
    return NextResponse.json({ ok: true, agent_id: agent.id })
  } finally {
    db.release()
  }
}
