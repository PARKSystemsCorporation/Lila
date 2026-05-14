import type { PoolClient } from 'pg'
import { appendLedger } from './ledger'

export type GigState =
  | 'negotiating'
  | 'funded'
  | 'in_progress'
  | 'submitted'
  | 'completed'
  | 'disputed'
  | 'released'
  | 'refunded'

export type MilestoneState =
  | 'pending'
  | 'submitted'
  | 'verified'
  | 'released'
  | 'refunded'

export interface MilestoneInput {
  description: string
  amountLdgr: string // numeric, kept as string for precision
}

export interface Milestone {
  id: number
  gigId: number
  idx: number
  description: string
  amountLdgr: string
  state: MilestoneState
  proofEventId: string | null
  submittedAt: Date | null
  verifiedAt: Date | null
  releasedAt: Date | null
  releaseTxSig: string | null
}

export interface Gig {
  id: number
  hirerAgentId: number
  workerAgentId: number
  skillId: number | null
  roomId: number | null
  briefMd: string
  totalLdgr: string
  escrowPda: string | null
  state: GigState
  disputedReason: string | null
  createdAt: Date
  fundedAt: Date | null
  releasedAt: Date | null
  refundedAt: Date | null
}

export async function proposeGig(
  db: PoolClient,
  input: {
    hirerAgentId: number
    workerAgentId: number
    skillId?: number | null
    roomId?: number | null
    briefMd: string
    milestones: MilestoneInput[]
  },
): Promise<Gig> {
  if (input.milestones.length === 0) throw new Error('gig must have at least one milestone')
  if (input.milestones.length > 16) throw new Error('gig limited to 16 milestones')

  const total = input.milestones
    .reduce((s, m) => s + Number(m.amountLdgr), 0)
    .toFixed(9)

  const r = await db.query(
    `INSERT INTO bazaar_gigs
       (hirer_agent_id, worker_agent_id, skill_id, room_id, brief_md, milestones, total_ldgr, state)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'negotiating')
     RETURNING id, hirer_agent_id, worker_agent_id, skill_id, room_id, brief_md,
               total_ldgr, escrow_pda, state, disputed_reason,
               created_at, funded_at, released_at, refunded_at`,
    [
      input.hirerAgentId,
      input.workerAgentId,
      input.skillId ?? null,
      input.roomId ?? null,
      input.briefMd,
      JSON.stringify(input.milestones),
      total,
    ],
  )
  const gig = rowToGig(r.rows[0])

  for (let i = 0; i < input.milestones.length; i++) {
    const m = input.milestones[i]
    await db.query(
      `INSERT INTO bazaar_milestones (gig_id, idx, description, amount_ldgr, state)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [gig.id, i, m.description, m.amountLdgr],
    )
  }

  await appendLedger(db, {
    actor: 'agent',
    action: 'gig.proposed',
    gigId: gig.id,
    agentId: gig.hirerAgentId,
    roomId: gig.roomId,
    refs: { worker_agent_id: gig.workerAgentId, total_ldgr: total },
  })
  return gig
}

export async function setGigFunded(
  db: PoolClient,
  gigId: number,
  escrowPda: string,
  txSig: string,
): Promise<void> {
  await db.query(
    `UPDATE bazaar_gigs
        SET state = 'funded', escrow_pda = $2, funded_at = NOW()
      WHERE id = $1 AND state IN ('negotiating', 'in_progress')`,
    [gigId, escrowPda],
  )
  await appendLedger(db, {
    actor: 'agent',
    action: 'gig.funded',
    gigId,
    refs: { escrow_pda: escrowPda },
    txSig,
  })
}

export async function submitMilestone(
  db: PoolClient,
  gigId: number,
  idx: number,
  proofEventId: string,
): Promise<void> {
  const r = await db.query(
    `UPDATE bazaar_milestones
        SET state = 'submitted', proof_event_id = $3, submitted_at = NOW()
      WHERE gig_id = $1 AND idx = $2 AND state = 'pending'
      RETURNING id`,
    [gigId, idx, proofEventId],
  )
  if (r.rowCount === 0) throw new Error('milestone not pending or not found')
  await appendLedger(db, {
    actor: 'agent',
    action: 'milestone.submitted',
    gigId,
    refs: { idx, proof_event_id: proofEventId },
  })
}

export async function verifyAndReleaseMilestone(
  db: PoolClient,
  gigId: number,
  idx: number,
  txSig: string,
  verifierActor: 'lila' | 'operator' | 'agent',
): Promise<void> {
  const r = await db.query(
    `UPDATE bazaar_milestones
        SET state = 'released',
            verified_at = COALESCE(verified_at, NOW()),
            released_at = NOW(),
            release_tx_sig = $3
      WHERE gig_id = $1 AND idx = $2 AND state IN ('submitted', 'verified')
      RETURNING id`,
    [gigId, idx, txSig],
  )
  if (r.rowCount === 0) throw new Error('milestone not in releasable state')

  // If all milestones released, mark gig released.
  const counts = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE state = 'released') AS released_cnt,
       COUNT(*) AS total_cnt
     FROM bazaar_milestones WHERE gig_id = $1`,
    [gigId],
  )
  const released = Number(counts.rows[0].released_cnt)
  const total = Number(counts.rows[0].total_cnt)
  if (released === total) {
    await db.query(
      `UPDATE bazaar_gigs SET state = 'released', released_at = NOW() WHERE id = $1`,
      [gigId],
    )
  }

  await appendLedger(db, {
    actor: verifierActor,
    action: 'milestone.released',
    gigId,
    refs: { idx, final: released === total },
    txSig,
  })
}

export async function disputeGig(
  db: PoolClient,
  gigId: number,
  reason: string,
  actor: 'agent' | 'lila' | 'operator',
): Promise<void> {
  await db.query(
    `UPDATE bazaar_gigs
        SET state = 'disputed', disputed_reason = $2
      WHERE id = $1 AND state NOT IN ('released', 'refunded')`,
    [gigId, reason],
  )
  await appendLedger(db, {
    actor,
    action: 'gig.disputed',
    gigId,
    refs: { reason },
  })
}

export async function refundGig(
  db: PoolClient,
  gigId: number,
  txSig: string,
): Promise<void> {
  await db.query(
    `UPDATE bazaar_gigs
        SET state = 'refunded', refunded_at = NOW()
      WHERE id = $1`,
    [gigId],
  )
  await appendLedger(db, {
    actor: 'operator',
    action: 'gig.refunded',
    gigId,
    txSig,
  })
}

export async function getGig(
  db: PoolClient,
  gigId: number,
): Promise<{ gig: Gig; milestones: Milestone[] } | null> {
  const g = await db.query(
    `SELECT id, hirer_agent_id, worker_agent_id, skill_id, room_id, brief_md,
            total_ldgr, escrow_pda, state, disputed_reason,
            created_at, funded_at, released_at, refunded_at
       FROM bazaar_gigs WHERE id = $1`,
    [gigId],
  )
  if (g.rowCount === 0) return null
  const m = await db.query(
    `SELECT id, gig_id, idx, description, amount_ldgr, state,
            proof_event_id, submitted_at, verified_at, released_at, release_tx_sig
       FROM bazaar_milestones
      WHERE gig_id = $1
      ORDER BY idx ASC`,
    [gigId],
  )
  return {
    gig: rowToGig(g.rows[0]),
    milestones: m.rows.map(rowToMilestone),
  }
}

export async function listGigsForAgent(
  db: PoolClient,
  agentId: number,
): Promise<Gig[]> {
  const r = await db.query(
    `SELECT id, hirer_agent_id, worker_agent_id, skill_id, room_id, brief_md,
            total_ldgr, escrow_pda, state, disputed_reason,
            created_at, funded_at, released_at, refunded_at
       FROM bazaar_gigs
      WHERE hirer_agent_id = $1 OR worker_agent_id = $1
      ORDER BY created_at DESC`,
    [agentId],
  )
  return r.rows.map(rowToGig)
}

export async function listDisputedGigs(db: PoolClient): Promise<Gig[]> {
  const r = await db.query(
    `SELECT id, hirer_agent_id, worker_agent_id, skill_id, room_id, brief_md,
            total_ldgr, escrow_pda, state, disputed_reason,
            created_at, funded_at, released_at, refunded_at
       FROM bazaar_gigs
      WHERE state = 'disputed'
      ORDER BY created_at DESC`,
  )
  return r.rows.map(rowToGig)
}

function rowToGig(row: Record<string, unknown>): Gig {
  return {
    id: Number(row.id),
    hirerAgentId: Number(row.hirer_agent_id),
    workerAgentId: Number(row.worker_agent_id),
    skillId: row.skill_id == null ? null : Number(row.skill_id),
    roomId: row.room_id == null ? null : Number(row.room_id),
    briefMd: String(row.brief_md),
    totalLdgr: String(row.total_ldgr),
    escrowPda: row.escrow_pda == null ? null : String(row.escrow_pda),
    state: row.state as GigState,
    disputedReason: row.disputed_reason == null ? null : String(row.disputed_reason),
    createdAt: new Date(row.created_at as string),
    fundedAt: row.funded_at ? new Date(row.funded_at as string) : null,
    releasedAt: row.released_at ? new Date(row.released_at as string) : null,
    refundedAt: row.refunded_at ? new Date(row.refunded_at as string) : null,
  }
}

function rowToMilestone(row: Record<string, unknown>): Milestone {
  return {
    id: Number(row.id),
    gigId: Number(row.gig_id),
    idx: Number(row.idx),
    description: String(row.description),
    amountLdgr: String(row.amount_ldgr),
    state: row.state as MilestoneState,
    proofEventId: row.proof_event_id == null ? null : String(row.proof_event_id),
    submittedAt: row.submitted_at ? new Date(row.submitted_at as string) : null,
    verifiedAt: row.verified_at ? new Date(row.verified_at as string) : null,
    releasedAt: row.released_at ? new Date(row.released_at as string) : null,
    releaseTxSig: row.release_tx_sig == null ? null : String(row.release_tx_sig),
  }
}
