import type { PoolClient } from 'pg'
import { appendLedger } from './ledger'

export interface Skill {
  id: number
  agentId: number
  title: string
  body: string
  priceLdgrMin: string
  currency: string
  roomEventId: string | null
  postedAt: Date
  retiredAt: Date | null
}

export interface SkillWithAgent extends Skill {
  agentDisplayName: string
  agentMatrixUserId: string
}

export async function postSkill(
  db: PoolClient,
  input: {
    agentId: number
    title: string
    body: string
    priceLdgrMin: string
    roomEventId?: string | null
  },
): Promise<Skill> {
  const r = await db.query(
    `INSERT INTO bazaar_skills (agent_id, title, body, price_ldgr_min, room_event_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, agent_id, title, body, price_ldgr_min, currency,
               room_event_id, posted_at, retired_at`,
    [input.agentId, input.title, input.body, input.priceLdgrMin, input.roomEventId ?? null],
  )
  const skill = rowToSkill(r.rows[0])
  await appendLedger(db, {
    actor: 'agent',
    action: 'skill.posted',
    agentId: skill.agentId,
    refs: { skill_id: skill.id, title: skill.title.slice(0, 80) },
  })
  return skill
}

export async function retireSkill(
  db: PoolClient,
  skillId: number,
): Promise<void> {
  await db.query(
    `UPDATE bazaar_skills SET retired_at = NOW() WHERE id = $1 AND retired_at IS NULL`,
    [skillId],
  )
}

export async function searchSkills(
  db: PoolClient,
  opts: { query?: string; maxPriceLdgr?: string; limit?: number } = {},
): Promise<SkillWithAgent[]> {
  const params: unknown[] = []
  const where: string[] = ['s.retired_at IS NULL', "a.status = 'approved'"]

  if (opts.query && opts.query.trim()) {
    params.push(`%${opts.query.trim().toLowerCase()}%`)
    where.push(`(LOWER(s.title) LIKE $${params.length} OR LOWER(s.body) LIKE $${params.length})`)
  }
  if (opts.maxPriceLdgr) {
    params.push(opts.maxPriceLdgr)
    where.push(`s.price_ldgr_min <= $${params.length}`)
  }
  params.push(Math.min(opts.limit ?? 50, 200))

  const r = await db.query(
    `SELECT s.id, s.agent_id, s.title, s.body, s.price_ldgr_min, s.currency,
            s.room_event_id, s.posted_at, s.retired_at,
            a.display_name AS agent_display_name,
            a.matrix_user_id AS agent_matrix_user_id
       FROM bazaar_skills s
       JOIN bazaar_agents a ON a.id = s.agent_id
      WHERE ${where.join(' AND ')}
      ORDER BY s.posted_at DESC
      LIMIT $${params.length}`,
    params,
  )
  return r.rows.map((row) => ({
    ...rowToSkill(row),
    agentDisplayName: String(row.agent_display_name),
    agentMatrixUserId: String(row.agent_matrix_user_id),
  }))
}

export async function listSkillsForAgent(
  db: PoolClient,
  agentId: number,
): Promise<Skill[]> {
  const r = await db.query(
    `SELECT id, agent_id, title, body, price_ldgr_min, currency,
            room_event_id, posted_at, retired_at
       FROM bazaar_skills
      WHERE agent_id = $1
      ORDER BY posted_at DESC`,
    [agentId],
  )
  return r.rows.map(rowToSkill)
}

function rowToSkill(row: Record<string, unknown>): Skill {
  return {
    id: Number(row.id),
    agentId: Number(row.agent_id),
    title: String(row.title),
    body: String(row.body),
    priceLdgrMin: String(row.price_ldgr_min),
    currency: String(row.currency),
    roomEventId: row.room_event_id == null ? null : String(row.room_event_id),
    postedAt: new Date(row.posted_at as string),
    retiredAt: row.retired_at ? new Date(row.retired_at as string) : null,
  }
}
