import type { PoolClient } from 'pg'
import { getPool } from '../db'
import {
  upsertEntity,
  writeEpisode,
  writeMessage,
  type EpisodeSource,
} from './store'
import { processMsg } from './correlations'

// Single ingestion entry point. Every site that creates new conversational /
// observational data calls this. It's fire-and-forget at the call sites
// (`.catch(()=>{})`) so a memory hiccup never breaks the existing path.
//
// What digest does:
//   1. Resolve an entity (hint or best-effort regex).
//   2. Write a memory_episodes row.
//   3. Feed the text through KIRA's `processMsg` so word-pair correlations
//      build up across all conversational sources (gated to user-style text).
//   4. Append to memory_messages — the durable, never-pruned chat archive.
//
// No fact-extraction LLM call in v1, matching 2dkira's design — durable claims
// emerge from high-scoring memory_long pairs.

export interface EntityHint {
  kind: string
  slug: string
  display_name: string
  aliases?: string[]
  target_id?: number | null
}

export interface DigestSignal {
  source: EpisodeSource
  source_id?: string | null
  actor?: string | null              // e.g. 'lila' | 'cipher' | 'vega' | 'user' | 'web'
  text: string                       // primary content; tokens come from here
  detail?: string | null             // optional longer body kept on the episode row
  target_id?: number | null
  entity_hint?: EntityHint
}

export interface DigestResult {
  episode_id: number | null
  message_id: string | null
  entity_id:  number | null
}

// Treat agent self-reports + chat as user-style language for the correlation
// graph. System sources (web HTML dumps, structured notes) only feed
// episodes/messages — they'd swamp the graph with junk grams.
const CORRELATION_SOURCES: ReadonlySet<EpisodeSource> = new Set<EpisodeSource>([
  'chat', 'desk', 'research_note', 'analyst_note', 'broadcast',
])

export async function digest(db: PoolClient, signal: DigestSignal): Promise<DigestResult> {
  const text = (signal.text ?? '').trim()
  if (!text) return { episode_id: null, message_id: null, entity_id: null }

  // 1. Entity resolution -----------------------------------------------------
  let entity_id: number | null = null
  let entity_target_id: number | null = null
  if (signal.entity_hint) {
    entity_id = await upsertEntity(db, {
      kind:         signal.entity_hint.kind,
      slug:         signal.entity_hint.slug,
      display_name: signal.entity_hint.display_name,
      aliases:      signal.entity_hint.aliases,
      target_id:    signal.entity_hint.target_id ?? signal.target_id ?? null,
    })
    entity_target_id = signal.entity_hint.target_id ?? null
  } else {
    const guess = await guessEntity(db, text)
    if (guess) {
      entity_id = guess.id
      entity_target_id = guess.target_id
    }
  }

  // 2. Episode --------------------------------------------------------------
  const episode_id = await writeEpisode(db, {
    source:    signal.source,
    source_id: signal.source_id ?? null,
    actor:     signal.actor ?? null,
    entity_id,
    target_id: signal.target_id ?? entity_target_id ?? null,
    content:   text.slice(0, 2000),
    detail:    signal.detail ?? null,
  })

  // 3. Correlation graph ----------------------------------------------------
  if (CORRELATION_SOURCES.has(signal.source)) {
    await processMsg(db, text, 'user').catch(() => { /* swallow */ })
  }

  // 4. Durable archive ------------------------------------------------------
  const message_id = await writeMessage(db, {
    role: signal.actor ?? signal.source,
    content: text.slice(0, 4000),
    metadata: {
      source: signal.source,
      source_id: signal.source_id ?? null,
      target_id: signal.target_id ?? entity_target_id ?? null,
      entity_id,
    },
  }).catch(() => null)

  return { episode_id, message_id, entity_id }
}

// Best-effort entity resolution. Two indexed lookups against memory_entities
// (slug, then GIN-indexed aliases), then a small slug derivation against
// research_targets as the auto-promotion fallback. Replaces the previous
// 200-row scan + JS substring loop — same behavior, indexed.
async function guessEntity(db: PoolClient, text: string): Promise<{ id: number; target_id: number | null } | null> {
  const tokens = text.toLowerCase().match(/[a-z0-9][a-z0-9-]+/g) ?? []
  if (!tokens.length) return null

  // 1. Direct slug match — idx_memory_entities_slug.
  const { rows: bySlug } = await db.query(
    `SELECT id, target_id FROM memory_entities WHERE slug = ANY($1::text[]) LIMIT 1`,
    [tokens]
  )
  if (bySlug[0]) {
    return { id: Number(bySlug[0].id), target_id: bySlug[0].target_id != null ? Number(bySlug[0].target_id) : null }
  }

  // 2. Alias overlap — idx_memory_entities_aliases (GIN).
  const { rows: byAlias } = await db.query(
    `SELECT id, target_id FROM memory_entities WHERE aliases && $1::text[] LIMIT 1`,
    [tokens]
  )
  if (byAlias[0]) {
    return { id: Number(byAlias[0].id), target_id: byAlias[0].target_id != null ? Number(byAlias[0].target_id) : null }
  }

  // 3. research_targets fallback — auto-promote first match into memory_entities.
  //    Kept narrow (active + recent) so this stays a single indexed read.
  const { rows: targets } = await db.query(
    `SELECT id, title FROM research_targets WHERE status='active' ORDER BY last_worked_at DESC NULLS LAST LIMIT 50`
  )
  const lower = text.toLowerCase()
  for (const t of targets as Array<{ id: number; title: string }>) {
    const slug = String(t.title ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 3).join('-')
    if (slug && lower.includes(slug)) {
      const id = await upsertEntity(db, {
        kind: 'bounty',
        slug,
        display_name: String(t.title),
        target_id: Number(t.id),
      })
      return { id, target_id: Number(t.id) }
    }
  }
  return null
}

// Single-concurrency queue for callers that don't already hold a pooled
// client (chiefly the web fetcher). Without this, a research cycle hitting
// many URLs could grab several pool connections in parallel just for the
// memory ingest and starve other queries (pool max is 5 in lib/db.ts).
let digestQueue: Promise<unknown> = Promise.resolve()
export function enqueueDigest(signal: DigestSignal): void {
  digestQueue = digestQueue.then(async () => {
    if (!process.env.DATABASE_URL) return
    let conn
    try {
      conn = await getPool().connect()
      await digest(conn, signal)
    } catch { /* swallow — memory ingest is fire-and-forget */ }
    finally {
      if (conn) conn.release()
    }
  }).catch(() => { /* keep the chain alive */ })
}
