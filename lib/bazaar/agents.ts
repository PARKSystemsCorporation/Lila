import type { PoolClient } from 'pg'
import { createHash, randomBytes } from 'crypto'
import { appendLedger } from './ledger'

export type AgentStatus = 'pending' | 'approved' | 'banned'

export interface BazaarAgent {
  id: number
  viewerId: number | null
  matrixUserId: string
  displayName: string
  bio: string | null
  phantomWallet: string | null
  status: AgentStatus
  deviceVerifiedAt: Date | null
  approvedAt: Date | null
  createdAt: Date
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

export interface CreatedAgent {
  agent: BazaarAgent
  apiToken: string
}

export async function createAgent(
  db: PoolClient,
  input: {
    matrixUserId: string
    displayName: string
    viewerId?: number | null
    bio?: string
  },
): Promise<CreatedAgent> {
  const apiToken = `ba_${randomBytes(24).toString('base64url')}`
  const r = await db.query(
    `INSERT INTO bazaar_agents (viewer_id, matrix_user_id, display_name, bio, api_token_hash, status)
     VALUES ($1, $2, $3, $4, $5, 'pending')
     RETURNING id, viewer_id, matrix_user_id, display_name, bio, phantom_wallet,
               status, device_verified_at, approved_at, created_at`,
    [
      input.viewerId ?? null,
      input.matrixUserId,
      input.displayName,
      input.bio ?? null,
      hashToken(apiToken),
    ],
  )
  const row = r.rows[0]
  const agent = rowToAgent(row)
  await appendLedger(db, {
    actor: 'operator',
    action: 'agent.created',
    agentId: agent.id,
    refs: { matrix_user_id: agent.matrixUserId },
  })
  return { agent, apiToken }
}

export async function approveAgent(
  db: PoolClient,
  agentId: number,
): Promise<void> {
  await db.query(
    `UPDATE bazaar_agents
        SET status = 'approved', approved_at = COALESCE(approved_at, NOW())
      WHERE id = $1`,
    [agentId],
  )
  await appendLedger(db, { actor: 'operator', action: 'agent.approved', agentId })
}

export async function banAgent(
  db: PoolClient,
  agentId: number,
  reason: string,
): Promise<void> {
  await db.query(
    `UPDATE bazaar_agents
        SET status = 'banned', banned_at = NOW()
      WHERE id = $1`,
    [agentId],
  )
  await appendLedger(db, {
    actor: 'operator',
    action: 'agent.banned',
    agentId,
    refs: { reason },
  })
}

export async function markDeviceVerified(
  db: PoolClient,
  agentId: number,
): Promise<void> {
  await db.query(
    `UPDATE bazaar_agents
        SET device_verified_at = NOW()
      WHERE id = $1 AND device_verified_at IS NULL`,
    [agentId],
  )
}

export async function linkPhantomWallet(
  db: PoolClient,
  agentId: number,
  walletPubkey: string,
): Promise<void> {
  await db.query(
    `UPDATE bazaar_agents SET phantom_wallet = $2 WHERE id = $1`,
    [agentId, walletPubkey],
  )
  await appendLedger(db, {
    actor: 'agent',
    action: 'wallet.linked',
    agentId,
    refs: { pubkey: walletPubkey },
  })
}

export async function getAgentByMatrixId(
  db: PoolClient,
  matrixUserId: string,
): Promise<BazaarAgent | null> {
  const r = await db.query(
    `SELECT id, viewer_id, matrix_user_id, display_name, bio, phantom_wallet,
            status, device_verified_at, approved_at, created_at
       FROM bazaar_agents
      WHERE matrix_user_id = $1`,
    [matrixUserId],
  )
  return r.rowCount === 0 ? null : rowToAgent(r.rows[0])
}

export async function getAgentByViewer(
  db: PoolClient,
  viewerId: number,
): Promise<BazaarAgent | null> {
  const r = await db.query(
    `SELECT id, viewer_id, matrix_user_id, display_name, bio, phantom_wallet,
            status, device_verified_at, approved_at, created_at
       FROM bazaar_agents
      WHERE viewer_id = $1
      ORDER BY id ASC LIMIT 1`,
    [viewerId],
  )
  return r.rowCount === 0 ? null : rowToAgent(r.rows[0])
}

export async function verifyApiToken(
  db: PoolClient,
  rawToken: string,
): Promise<BazaarAgent | null> {
  const r = await db.query(
    `SELECT id, viewer_id, matrix_user_id, display_name, bio, phantom_wallet,
            status, device_verified_at, approved_at, created_at
       FROM bazaar_agents
      WHERE api_token_hash = $1 AND status = 'approved'`,
    [hashToken(rawToken)],
  )
  return r.rowCount === 0 ? null : rowToAgent(r.rows[0])
}

function rowToAgent(row: Record<string, unknown>): BazaarAgent {
  return {
    id: Number(row.id),
    viewerId: row.viewer_id == null ? null : Number(row.viewer_id),
    matrixUserId: String(row.matrix_user_id),
    displayName: String(row.display_name),
    bio: row.bio == null ? null : String(row.bio),
    phantomWallet: row.phantom_wallet == null ? null : String(row.phantom_wallet),
    status: row.status as AgentStatus,
    deviceVerifiedAt: row.device_verified_at ? new Date(row.device_verified_at as string) : null,
    approvedAt: row.approved_at ? new Date(row.approved_at as string) : null,
    createdAt: new Date(row.created_at as string),
  }
}
