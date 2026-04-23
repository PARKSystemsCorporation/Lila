import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import { fetchAllBounties, type UnifiedBounty, type BountySource } from '@/lib/bounties-fetch'

export const dynamic = 'force-dynamic'

export type { UnifiedBounty, BountySource }

export async function GET() {
  const bounties = await fetchAllBounties()

  let assignedBounty = null
  if (process.env.DATABASE_URL) {
    const pool = getPool()
    const db = await pool.connect()
    try {
      await ensureSchema(db)
      const { rows: [s] } = await db.query('SELECT assigned_bounty FROM lila_state WHERE id = 1')
      assignedBounty = s?.assigned_bounty ?? null
    } finally {
      db.release()
    }
  }

  return NextResponse.json({ bounties, assignedBounty })
}

export async function POST(req: Request) {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'No database' }, { status: 503 })
  }

  const body = await req.json().catch(() => ({}))
  const bounty: UnifiedBounty | null = body.bounty ?? null

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    await db.query(
      'UPDATE lila_state SET assigned_bounty = $1 WHERE id = 1',
      [bounty ? JSON.stringify(bounty) : null]
    )

    if (bounty) {
      await db.query(
        "INSERT INTO lila_log (message, type) VALUES ($1, 'info')",
        [`Operator assigned task: "${bounty.title}" — $${bounty.reward} on ${bounty.platformLabel}.`]
      )
    } else {
      await db.query(
        "INSERT INTO lila_log (message, type) VALUES ('Operator cleared assignment. Resuming autonomous selection.', 'info')"
      )
    }

    return NextResponse.json({ ok: true })
  } finally {
    db.release()
  }
}
