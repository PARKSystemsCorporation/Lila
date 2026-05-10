import type { PoolClient } from 'pg'
import {
  upsertEntity,
  findEntityBySlug,
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
  'chat', 'desk', 'research_note', 'analyst_note', 'telegram', 'broadcast',
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

// Best-effort entity resolution by regex against research_targets (slug or
// title). Cheap — one indexed query, optional. Returns null if nothing matches.
async function guessEntity(db: PoolClient, text: string): Promise<{ id: number; target_id: number | null } | null> {
  const lower = text.toLowerCase()
  // First: any existing memory_entities whose slug or alias appears in the text.
  const { rows: ents } = await db.query(
    `SELECT id, slug, aliases, target_id FROM memory_entities ORDER BY updated_at DESC LIMIT 200`
  )
  for (const e of ents as Array<{ id: number; slug: string; aliases: string[]; target_id: number | null }>) {
    if (e.slug && lower.includes(e.slug.toLowerCase())) {
      return { id: Number(e.id), target_id: e.target_id != null ? Number(e.target_id) : null }
    }
    for (const a of e.aliases ?? []) {
      if (a && lower.includes(a.toLowerCase())) {
        return { id: Number(e.id), target_id: e.target_id != null ? Number(e.target_id) : null }
      }
    }
  }
  // Second: research_targets — auto-promote the matching one into memory_entities.
  const { rows: targets } = await db.query(
    `SELECT id, title FROM research_targets WHERE status='active' ORDER BY last_worked_at DESC NULLS LAST LIMIT 50`
  )
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
