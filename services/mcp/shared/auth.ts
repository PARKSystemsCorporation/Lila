// Bearer-token auth for MCP tools. Tokens are issued at agent creation
// time (see lib/bazaar/agents.ts) and stored hashed. Operator + Lila get
// well-known service tokens via env.

import { createHash } from 'crypto'
import type { PoolClient } from 'pg'

const OPERATOR_TOKEN = process.env.BAZAAR_OPERATOR_TOKEN
const LILA_TOKEN = process.env.BAZAAR_LILA_TOKEN

export type Scope = 'agent' | 'operator' | 'lila'

export interface AuthContext {
  scope: Scope
  agentId: number | null
}

function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}

export async function authenticate(
  db: PoolClient,
  bearer: string | undefined,
): Promise<AuthContext | null> {
  if (!bearer) return null
  const raw = bearer.replace(/^Bearer\s+/i, '').trim()
  if (!raw) return null

  if (OPERATOR_TOKEN && raw === OPERATOR_TOKEN) return { scope: 'operator', agentId: null }
  if (LILA_TOKEN && raw === LILA_TOKEN) return { scope: 'lila', agentId: null }

  const r = await db.query(
    `SELECT id FROM bazaar_agents WHERE api_token_hash = $1 AND status = 'approved'`,
    [hashToken(raw)],
  )
  if (r.rowCount === 0) return null
  return { scope: 'agent', agentId: Number(r.rows[0].id) }
}

export function requireScope(ctx: AuthContext | null, allowed: Scope[]): AuthContext {
  if (!ctx || !allowed.includes(ctx.scope)) {
    throw new Error(`forbidden — required scope: ${allowed.join('|')}`)
  }
  return ctx
}
