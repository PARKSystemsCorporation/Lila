import type { PoolClient } from 'pg'
import { memoryContext, recallCorrelations, type Correlation } from './correlations'

// Lila-specific recall. Composes three channels:
//   1. KIRA correlation lookup — the word-pair association graph.
//   2. Recency — top-N most recent episodes (optionally scoped to a target).
//   3. Entity — if an entity_slug resolves, recent episodes + summaries for it.
//
// Cross-target rule: when scope.target_id is set, the cross-target episode
// slice EXCLUDES rows whose target_id == scope.target_id, because Lila's
// per-target paths (e.g. research-engine `collateNotes`) already cover them.

export interface RecallScope {
  target_id?:   number
  entity_slug?: string
  entity_kind?: string
}

export interface RecallQuery {
  text: string
  scope?: RecallScope
  k_correlations?: number   // default 8
  k_episodes?:     number   // default 5
  k_summaries?:    number   // default 2
}

export interface RecallEpisode {
  id: number
  occurred_at: string
  actor: string | null
  source: string
  content: string
  target_id: number | null
}

export interface RecallSummary {
  id: number
  level: string
  window_start: string
  content: string
}

export interface RecallHits {
  correlations: Correlation[]
  context_line: string                  // KIRA "Things you remember: …" sentence
  episodes:    RecallEpisode[]          // chronological, newest first
  summaries:   RecallSummary[]
  channels: {
    correlation: number
    recent:      number
    entity:      number
  }
}

export async function recall(db: PoolClient, q: RecallQuery): Promise<RecallHits> {
  const k_correlations = q.k_correlations ?? 8
  const k_episodes     = q.k_episodes     ?? 5
  const k_summaries    = q.k_summaries    ?? 2

  // 1. Correlation channel ----------------------------------------------------
  const correlations = await recallCorrelations(db, q.text, k_correlations)
  const context_line = await memoryContext(db, q.text, k_correlations)

  // 2. Recency channel — recent episodes, cross-target by default ------------
  const params: unknown[] = []
  const where: string[] = []
  if (q.scope?.target_id) {
    params.push(q.scope.target_id)
    where.push(`(target_id IS NULL OR target_id <> $${params.length})`)
  }
  params.push(k_episodes)
  const limitArg = `$${params.length}`
  const { rows: episRows } = await db.query(
    `SELECT id, occurred_at, actor, source, content, target_id
       FROM memory_episodes
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY occurred_at DESC
      LIMIT ${limitArg}`,
    params
  )
  const episodes: RecallEpisode[] = episRows.map((r: Record<string, unknown>) => ({
    id: Number(r.id),
    occurred_at: new Date(r.occurred_at as string | Date).toISOString(),
    actor: r.actor != null ? String(r.actor) : null,
    source: String(r.source),
    content: String(r.content),
    target_id: r.target_id != null ? Number(r.target_id) : null,
  }))

  // 3. Entity channel — pull summaries for the resolved entity (if any) ------
  let entity_id: number | null = null
  if (q.scope?.entity_slug) {
    const slug = q.scope.entity_slug.toLowerCase().trim()
    const entParams: unknown[] = [slug]
    let entWhere = `slug = $1`
    if (q.scope.entity_kind) { entParams.push(q.scope.entity_kind); entWhere += ` AND kind = $${entParams.length}` }
    const { rows: ent } = await db.query(
      `SELECT id FROM memory_entities WHERE ${entWhere} LIMIT 1`,
      entParams
    )
    if (ent[0]) entity_id = Number(ent[0].id)
  }

  let summaries: RecallSummary[] = []
  if (k_summaries > 0) {
    const summaryParams: unknown[] = [k_summaries]
    const summaryWhere: string[] = []
    if (entity_id != null) {
      summaryParams.push(entity_id)
      summaryWhere.push(`entity_id = $${summaryParams.length}`)
    }
    if (q.scope?.target_id) {
      summaryParams.push(q.scope.target_id)
      // For summaries we *include* the current target — they're rollups, useful regardless.
      summaryWhere.push(`(target_id IS NULL OR target_id = $${summaryParams.length})`)
    }
    const { rows: sumRows } = await db.query(
      `SELECT id, level, window_start, content
         FROM memory_summaries
        ${summaryWhere.length ? `WHERE ${summaryWhere.join(' AND ')}` : ''}
        ORDER BY window_end DESC
        LIMIT $1`,
      summaryParams
    )
    summaries = sumRows.map((r: Record<string, unknown>) => ({
      id: Number(r.id),
      level: String(r.level),
      window_start: new Date(r.window_start as string | Date).toISOString(),
      content: String(r.content),
    }))
  }

  return {
    correlations,
    context_line,
    episodes,
    summaries,
    channels: {
      correlation: correlations.length,
      recent:      episodes.length,
      entity:      entity_id != null ? 1 : 0,
    },
  }
}

// Compact text block for prompt injection. Shape mirrors the existing
// `recent chat:` block in lib/autonomy/context.ts → renderContext.
export function renderRecall(h: RecallHits, budget = 800): string {
  if (!h.correlations.length && !h.episodes.length && !h.summaries.length) return ''
  const lines: string[] = []
  if (h.context_line) {
    lines.push(`memory:`)
    lines.push(`  ${h.context_line}`)
  }
  if (h.episodes.length) {
    lines.push(`memory episodes (recent):`)
    for (const e of h.episodes) {
      const when = e.occurred_at.slice(0, 16).replace('T', ' ')
      const who  = e.actor ?? e.source
      const content = e.content.length > 110 ? e.content.slice(0, 107) + '…' : e.content
      lines.push(`  ${when} ${who}: ${content}`)
    }
  }
  if (h.summaries.length) {
    lines.push(`memory summaries:`)
    for (const s of h.summaries) {
      const when = s.window_start.slice(0, 10)
      const content = s.content.length > 160 ? s.content.slice(0, 157) + '…' : s.content
      lines.push(`  [${s.level} ${when}] ${content}`)
    }
  }
  return lines.join('\n').slice(0, budget)
}
