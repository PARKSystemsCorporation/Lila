import type { PoolClient } from 'pg'
import { randomUUID } from 'crypto'

// Entity, episode, summary, and message-archive writes. These are Lila's
// extensions on top of KIRA — KIRA itself only stores word-pair correlations
// (see correlations.ts). Episodes give us a real timeline; entities give us
// canonical topics for cross-target linking; summaries roll older episodes
// into compressed long-term context.

export type EntityKind =
  | 'bounty' | 'codebase' | 'person' | 'token' | 'agent' | 'topic'
export type EpisodeSource =
  | 'chat' | 'desk' | 'research_note' | 'analyst_note' | 'web' | 'telegram' | 'broadcast'
  | 'priority_set' | 'thesis_set' | 'lesson'
export type SummaryLevel = 'hour' | 'day' | 'week' | 'month'

export interface UpsertEntity {
  kind: EntityKind | string
  slug: string
  display_name: string
  aliases?: string[]
  target_id?: number | null
}

export interface WriteEpisode {
  source: EpisodeSource
  source_id?: string | null
  actor?: string | null
  entity_id?: number | null
  target_id?: number | null
  content: string
  detail?: string | null
  occurred_at?: Date | null
}

export interface WriteSummary {
  level: SummaryLevel
  window_start: Date
  window_end: Date
  entity_id?: number | null
  target_id?: number | null
  content: string
  episode_count?: number
}

export async function upsertEntity(db: PoolClient, e: UpsertEntity): Promise<number> {
  const slug = e.slug.toLowerCase().trim()
  const { rows } = await db.query(
    `INSERT INTO memory_entities (kind, slug, display_name, aliases, target_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (kind, slug) DO UPDATE SET
       display_name = COALESCE(NULLIF(EXCLUDED.display_name, ''), memory_entities.display_name),
       aliases      = (SELECT ARRAY(SELECT DISTINCT unnest(memory_entities.aliases || EXCLUDED.aliases))),
       target_id    = COALESCE(EXCLUDED.target_id, memory_entities.target_id),
       updated_at   = NOW()
     RETURNING id`,
    [e.kind, slug, e.display_name, e.aliases ?? [], e.target_id ?? null]
  )
  return Number(rows[0].id)
}

export async function findEntityBySlug(
  db: PoolClient,
  slug: string,
  kind?: string,
): Promise<{ id: number; kind: string; display_name: string; target_id: number | null } | null> {
  const params: unknown[] = [slug.toLowerCase().trim()]
  let where = `slug = $1`
  if (kind) { params.push(kind); where += ` AND kind = $${params.length}` }
  const { rows } = await db.query(
    `SELECT id, kind, display_name, target_id FROM memory_entities WHERE ${where} LIMIT 1`,
    params
  )
  if (!rows[0]) return null
  return {
    id: Number(rows[0].id),
    kind: String(rows[0].kind),
    display_name: String(rows[0].display_name),
    target_id: rows[0].target_id != null ? Number(rows[0].target_id) : null,
  }
}

export async function writeEpisode(db: PoolClient, ep: WriteEpisode): Promise<number> {
  const { rows } = await db.query(
    `INSERT INTO memory_episodes
       (source, source_id, actor, entity_id, target_id, content, detail, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8, NOW()))
     RETURNING id`,
    [
      ep.source,
      ep.source_id ?? null,
      ep.actor ?? null,
      ep.entity_id ?? null,
      ep.target_id ?? null,
      ep.content,
      ep.detail ?? null,
      ep.occurred_at ?? null,
    ]
  )
  return Number(rows[0].id)
}

export async function writeSummary(db: PoolClient, s: WriteSummary): Promise<number> {
  // Idempotent via UNIQUE(level, window_start, COALESCE(entity_id,0), COALESCE(target_id,0)).
  // On collision we update content + episode_count so re-running with more data refines.
  const { rows } = await db.query(
    `INSERT INTO memory_summaries
       (level, window_start, window_end, entity_id, target_id, content, episode_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (level, window_start, (COALESCE(entity_id,0)), (COALESCE(target_id,0)))
     DO UPDATE SET content = EXCLUDED.content,
                   episode_count = EXCLUDED.episode_count,
                   window_end = EXCLUDED.window_end
     RETURNING id`,
    [
      s.level,
      s.window_start,
      s.window_end,
      s.entity_id ?? null,
      s.target_id ?? null,
      s.content,
      s.episode_count ?? 0,
    ]
  )
  return Number(rows[0].id)
}

// Mark episodes as rolled up so they're eligible for hard-delete by retention.
export async function markRolledUp(
  db: PoolClient,
  episodeIds: number[],
  summaryId: number,
): Promise<void> {
  if (!episodeIds.length) return
  await db.query(
    `UPDATE memory_episodes SET rolled_up_into = $1 WHERE id = ANY($2)`,
    [summaryId, episodeIds]
  )
}

// KIRA-style chat archive. Distinct from chat_messages — never auto-pruned,
// holds the durable conversational record used by recall.
export interface WriteMessage {
  role: string
  content: string
  metadata?: Record<string, unknown>
}
export async function writeMessage(db: PoolClient, m: WriteMessage): Promise<string> {
  const id = randomUUID()
  await db.query(
    `INSERT INTO memory_messages (id, role, content, created_at, metadata)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, m.role, m.content, Date.now(), m.metadata ? JSON.stringify(m.metadata) : null]
  )
  return id
}
