import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import * as Superteam from '@/lib/platforms/superteam'
import * as Bountycaster from '@/lib/platforms/bountycaster'
import * as Immunefi from '@/lib/platforms/immunefi'
import * as ClawTasks from '@/lib/platforms/clawtasks'

export type BountySource = 'superteam' | 'bountycaster' | 'immunefi' | 'clawtasks'

export interface UnifiedBounty {
  id: string
  platform: BountySource
  platformLabel: string
  title: string
  description: string
  reward: number
  token: string
  url?: string
  deadline?: string
  readOnly: boolean     // true = Lila can view but not submit (e.g. Immunefi)
  chain: string
}

// ── Fetch from all configured platforms in parallel ────────────────────────

async function fetchAll(): Promise<UnifiedBounty[]> {
  const results: UnifiedBounty[] = []

  const tasks: Promise<void>[] = []

  if (process.env.SUPERTEAM_API_KEY) {
    tasks.push(
      Superteam.listOpenBounties(process.env.SUPERTEAM_API_KEY)
        .then(items => items.forEach(b => results.push({
          id: `st_${b.id}`,
          platform: 'superteam',
          platformLabel: 'Superteam',
          title: b.title,
          description: b.description,
          reward: b.rewardAmount,
          token: b.token || 'USDC',
          url: `https://earn.superteam.fun/listings/${b.slug}`,
          deadline: b.deadline,
          readOnly: false,
          chain: 'Solana',
        })))
        .catch(() => {})
    )
  }

  if (process.env.NEYNAR_API_KEY) {
    tasks.push(
      Bountycaster.listOpenBounties(process.env.NEYNAR_API_KEY)
        .then(items => items.forEach(b => results.push({
          id: `bc_${b.id}`,
          platform: 'bountycaster',
          platformLabel: 'Bountycaster',
          title: b.title,
          description: b.description,
          reward: b.reward,
          token: b.token,
          url: b.castUrl,
          deadline: undefined,
          readOnly: false,
          chain: 'Base',
        })))
        .catch(() => {})
    )
  }

  if (process.env.CLAWTASKS_API_KEY) {
    tasks.push(
      ClawTasks.listOpenBounties(process.env.CLAWTASKS_API_KEY)
        .then(items => items.forEach(b => results.push({
          id: `ct_${b.id}`,
          platform: 'clawtasks',
          platformLabel: 'ClawTasks',
          title: b.title,
          description: b.description,
          reward: b.reward ?? 0,
          token: 'USDC',
          deadline: b.deadline,
          readOnly: false,
          chain: 'Base',
        })))
        .catch(() => {})
    )
  }

  // Immunefi — always fetch (no key needed), always read-only
  tasks.push(
    Immunefi.listPrograms()
      .then(items => items.forEach(p => results.push({
        id: `imf_${p.id}`,
        platform: 'immunefi',
        platformLabel: 'Immunefi',
        title: p.title,
        description: `Max bounty: $${p.maxBounty.toLocaleString()} ${p.rewardsToken}. KYC: ${p.kyc ? 'required' : 'not required'}.`,
        reward: p.maxBounty,
        token: p.rewardsToken,
        url: p.url,
        readOnly: true,
        chain: 'Various',
      })))
      .catch(() => {})
  )

  await Promise.all(tasks)

  // Sort by reward descending, paid tasks first
  return results.sort((a, b) => {
    if (a.readOnly !== b.readOnly) return a.readOnly ? 1 : -1
    return b.reward - a.reward
  })
}

// ── GET /api/bounties — return full sorted bounty board ────────────────────

export async function GET() {
  const bounties = await fetchAll()

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

// ── POST /api/bounties — assign a bounty to Lila ──────────────────────────

export async function POST(req: Request) {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'No database' }, { status: 503 })
  }

  const body = await req.json().catch(() => ({}))

  // Pass null to clear assignment
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
