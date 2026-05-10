import type { PoolClient } from 'pg'
import type OpenAI from 'openai'
import { llmCall, LLMBudgetExceeded } from '../llm'
import { writeSummary, markRolledUp, type SummaryLevel } from './store'

// Progressive LLM rollups for the long arc. Hour → Day → Week. Each level
// collapses items below it within a closed window, grouped by entity_id and
// target_id (NULL group bucketed together). Idempotent on (level,
// window_start, COALESCE(entity_id,0), COALESCE(target_id,0)) so re-runs
// after late-arriving episodes refine the rollup in place.
//
// Scheduled from outside the autonomy loop — analyst maintenance phase
// (lib/analyst-loop.ts m0) and a daily backstop in lib/retention.ts.

const HOUR_MS = 60 * 60 * 1000
const DAY_MS  = 24 * HOUR_MS
const WEEK_MS = 7  * DAY_MS

// Don't bother summarizing tiny windows — < this many episodes is just noise.
const MIN_EPISODES_HOUR = 3
const MIN_EPISODES_DAY  = 5
const MIN_EPISODES_WEEK = 7

export async function maybeRunSummaries(
  db: PoolClient,
  ai: OpenAI,
): Promise<{ ran: SummaryLevel[] }> {
  const { rows: [s] } = await db.query(
    `SELECT last_rollup_hour_at, last_rollup_day_at, last_rollup_week_at
       FROM memory_state WHERE id = 1`
  )
  const now = Date.now()
  const ran: SummaryLevel[] = []

  // Each level only fires if its own cadence has elapsed.
  if (!s?.last_rollup_hour_at || (now - new Date(s.last_rollup_hour_at).getTime()) > HOUR_MS) {
    try { if (await rollupHour(db, ai) > 0) ran.push('hour') } catch { /* swallow */ }
    await db.query(`UPDATE memory_state SET last_rollup_hour_at = NOW(), updated_at = NOW() WHERE id = 1`)
  }
  if (!s?.last_rollup_day_at || (now - new Date(s.last_rollup_day_at).getTime()) > DAY_MS) {
    try { if (await rollupDay(db, ai) > 0) ran.push('day') } catch { /* swallow */ }
    await db.query(`UPDATE memory_state SET last_rollup_day_at = NOW(), updated_at = NOW() WHERE id = 1`)
  }
  if (!s?.last_rollup_week_at || (now - new Date(s.last_rollup_week_at).getTime()) > WEEK_MS) {
    try { if (await rollupWeek(db, ai) > 0) ran.push('week') } catch { /* swallow */ }
    await db.query(`UPDATE memory_state SET last_rollup_week_at = NOW(), updated_at = NOW() WHERE id = 1`)
  }
  return { ran }
}

interface EpisodeRow {
  id: number
  occurred_at: Date
  actor: string | null
  source: string
  content: string
  entity_id: number | null
  target_id: number | null
}

async function fetchEpisodesInWindow(
  db: PoolClient,
  start: Date,
  end: Date,
  onlyUnrolled = true,
): Promise<EpisodeRow[]> {
  const where = [`occurred_at >= $1`, `occurred_at < $2`]
  if (onlyUnrolled) where.push(`rolled_up_into IS NULL`)
  const { rows } = await db.query(
    `SELECT id, occurred_at, actor, source, content, entity_id, target_id
       FROM memory_episodes
      WHERE ${where.join(' AND ')}
      ORDER BY occurred_at ASC`,
    [start, end]
  )
  return rows.map((r: Record<string, unknown>) => ({
    id: Number(r.id),
    occurred_at: r.occurred_at as Date,
    actor: r.actor != null ? String(r.actor) : null,
    source: String(r.source),
    content: String(r.content),
    entity_id: r.entity_id != null ? Number(r.entity_id) : null,
    target_id: r.target_id != null ? Number(r.target_id) : null,
  }))
}

// Group key: "entity_id|target_id" with nulls as 0 (matches the unique index).
function groupKey(entity_id: number | null, target_id: number | null): string {
  return `${entity_id ?? 0}|${target_id ?? 0}`
}

async function summarizeGroup(
  ai: OpenAI,
  level: SummaryLevel,
  episodes: EpisodeRow[],
): Promise<string> {
  if (!episodes.length) return ''
  const lines = episodes.map(e => {
    const t = e.occurred_at.toISOString().slice(0, 16).replace('T', ' ')
    const who = e.actor ?? e.source
    return `${t} ${who}: ${e.content.slice(0, 200)}`
  }).join('\n')
  const horizon = level === 'hour' ? 'last hour' : level === 'day' ? 'last day' : 'last week'
  const prompt = `Roll up these ${episodes.length} events from the ${horizon} into a tight summary (4-7 bullets, no fluff). Preserve names, numbers, and decisions. Skip routine no-ops.\n\n${lines}`

  try {
    const { content } = await llmCall({
      ai,
      module: `memory.summarize.${level}`,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: level === 'week' ? 400 : 250,
      temperature: 0.3,
    })
    return content.trim()
  } catch (e) {
    if (e instanceof LLMBudgetExceeded) return ''
    throw e
  }
}

async function rollupAtLevel(
  db: PoolClient,
  ai: OpenAI,
  level: SummaryLevel,
  windowStart: Date,
  windowEnd: Date,
  minEpisodes: number,
): Promise<number> {
  const episodes = await fetchEpisodesInWindow(db, windowStart, windowEnd, true)
  if (episodes.length < minEpisodes) return 0

  // Group by (entity_id, target_id).
  const groups = new Map<string, EpisodeRow[]>()
  for (const e of episodes) {
    const k = groupKey(e.entity_id, e.target_id)
    const arr = groups.get(k) ?? []
    arr.push(e)
    groups.set(k, arr)
  }

  let written = 0
  const entries = Array.from(groups.values())
  for (const group of entries) {
    if (group.length < minEpisodes) continue
    const content = await summarizeGroup(ai, level, group)
    if (!content) continue
    const summaryId = await writeSummary(db, {
      level,
      window_start: windowStart,
      window_end: windowEnd,
      entity_id: group[0].entity_id,
      target_id: group[0].target_id,
      content,
      episode_count: group.length,
    })
    await markRolledUp(db, group.map((g: EpisodeRow) => g.id), summaryId)
    written++
  }
  return written
}

// Floor a Date to the start of its hour / day / week (UTC).
function floorHour(d: Date): Date {
  const x = new Date(d)
  x.setUTCMinutes(0, 0, 0)
  return x
}
function floorDay(d: Date): Date {
  const x = new Date(d)
  x.setUTCHours(0, 0, 0, 0)
  return x
}
function floorWeek(d: Date): Date {
  const x = floorDay(d)
  // ISO week: subtract days until Monday.
  const dow = (x.getUTCDay() + 6) % 7  // 0 = Mon
  x.setUTCDate(x.getUTCDate() - dow)
  return x
}

export async function rollupHour(db: PoolClient, ai: OpenAI): Promise<number> {
  // Last completed hour.
  const end   = floorHour(new Date())
  const start = new Date(end.getTime() - HOUR_MS)
  return rollupAtLevel(db, ai, 'hour', start, end, MIN_EPISODES_HOUR)
}

export async function rollupDay(db: PoolClient, ai: OpenAI): Promise<number> {
  const end   = floorDay(new Date())
  const start = new Date(end.getTime() - DAY_MS)
  return rollupAtLevel(db, ai, 'day', start, end, MIN_EPISODES_DAY)
}

export async function rollupWeek(db: PoolClient, ai: OpenAI): Promise<number> {
  const end   = floorWeek(new Date())
  const start = new Date(end.getTime() - WEEK_MS)
  return rollupAtLevel(db, ai, 'week', start, end, MIN_EPISODES_WEEK)
}
