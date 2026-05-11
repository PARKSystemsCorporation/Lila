import type { PoolClient } from 'pg'
import { WATCHLIST } from './analyst-watchlist'

// Per-agent briefs — narrow, lane-specific context cherry-picked from
// existing tables and prefixed onto every LLM call the agent makes.
//
// Briefs are computed per tick from current DB state — never persisted.
// State lives in the source tables (lila_state, security_reports,
// research_targets, analyst_picks, memory_entities, memory_episodes).
// renderBrief() returns uncapped text; the caller is expected to slice
// to fit its own token budget (mirrors lib/memory/retrieve.renderRecall).

export interface CipherBrief {
  priority:       string | null
  target:         { id: number; title: string; phase: string; cycles: number } | null
  current_status: { id: number; status: string; title: string } | null
  recent:         { title: string; status: string; payout: number | null }[]
  vuln_patterns:  { name: string }[]
}

export interface VegaBrief {
  priority:       string | null
  macro_thesis:   string | null
  watchlist:      typeof WATCHLIST
  recent_signals: { symbol: string; direction: string; status: string; acted: boolean }[]
  lessons:        { occurred_at: string; content: string }[]
}

export async function buildCipherBrief(db: PoolClient): Promise<CipherBrief> {
  const { rows: [s] } = await db.query(
    `SELECT current_priority, current_target_id FROM lila_state WHERE id=1`
  )
  const targetId: number | null = s?.current_target_id ?? null

  let target: CipherBrief['target'] = null
  let current_status: CipherBrief['current_status'] = null

  if (targetId) {
    const { rows: [t] } = await db.query(
      `SELECT id, title, phase, cycles FROM research_targets WHERE id=$1`,
      [targetId]
    )
    if (t) {
      target = { id: Number(t.id), title: String(t.title), phase: String(t.phase), cycles: Number(t.cycles) }
    }
    const { rows: [r] } = await db.query(
      `SELECT sr.id, sr.status, sr.title
         FROM security_reports sr
         JOIN research_targets rt ON rt.bounty_id = sr.bounty_id
        WHERE rt.id = $1
        ORDER BY sr.created_at DESC LIMIT 1`,
      [targetId]
    )
    if (r) {
      current_status = { id: Number(r.id), status: String(r.status), title: String(r.title) }
    }
  }

  const { rows: recentRows } = await db.query(
    `SELECT title, status, payout FROM security_reports
      ORDER BY created_at DESC LIMIT 3`
  )
  const recent = recentRows.map((r: { title: string; status: string; payout: string | null }) => ({
    title:  String(r.title),
    status: String(r.status),
    payout: r.payout != null ? parseFloat(r.payout) : null,
  }))

  const { rows: vulnRows } = await db.query(
    `SELECT display_name FROM memory_entities
      WHERE kind='vuln_pattern'
      ORDER BY updated_at DESC LIMIT 5`
  )
  const vuln_patterns = vulnRows.map((r: { display_name: string }) => ({
    name: String(r.display_name),
  }))

  return {
    priority: s?.current_priority ?? null,
    target,
    current_status,
    recent,
    vuln_patterns,
  }
}

export async function buildVegaBrief(db: PoolClient): Promise<VegaBrief> {
  const { rows: [s] } = await db.query(
    `SELECT current_priority, macro_thesis FROM lila_state WHERE id=1`
  )

  const { rows: signalRows } = await db.query(
    `SELECT symbol, direction, status FROM analyst_picks
      ORDER BY created_at DESC LIMIT 5`
  )
  const recent_signals = signalRows.map((r: { symbol: string; direction: string; status: string }) => ({
    symbol:    String(r.symbol),
    direction: String(r.direction),
    status:    String(r.status),
    acted:     String(r.status) !== 'pending',
  }))

  const { rows: lessonRows } = await db.query(
    `SELECT occurred_at, content FROM memory_episodes
      WHERE source='lesson' AND actor='vega'
      ORDER BY occurred_at DESC LIMIT 5`
  )
  const lessons = lessonRows.map((r: { occurred_at: Date; content: string }) => ({
    occurred_at: new Date(r.occurred_at).toISOString(),
    content:     String(r.content),
  }))

  return {
    priority:     s?.current_priority ?? null,
    macro_thesis: s?.macro_thesis     ?? null,
    watchlist:    WATCHLIST,
    recent_signals,
    lessons,
  }
}

// Compact rendering for prompt injection. Priority line is intentionally
// FIRST — LLMs anchor to the prompt prefix.
export function renderBrief(brief: CipherBrief | VegaBrief): string {
  const lines: string[] = []
  lines.push(`[priority] ${brief.priority ?? 'none'}`)

  if ('target' in brief) {
    // Cipher
    if (brief.target) {
      lines.push(`[target] #${brief.target.id} ${brief.target.title} — phase ${brief.target.phase}, cycle ${brief.target.cycles}`)
    } else {
      lines.push(`[target] none pinned`)
    }
    if (brief.current_status) {
      lines.push(`[submission] #${brief.current_status.id} ${brief.current_status.status} — ${brief.current_status.title}`)
    }
    if (brief.recent.length) {
      lines.push(`[recent submissions]`)
      for (const r of brief.recent) {
        const payout = r.payout != null ? ` $${r.payout.toFixed(2)}` : ''
        lines.push(`  ${r.status}${payout} — ${r.title}`)
      }
    }
    if (brief.vuln_patterns.length) {
      lines.push(`[known patterns] ${brief.vuln_patterns.map(p => p.name).join(', ')}`)
    }
  } else {
    // Vega
    lines.push(`[macro_thesis] ${brief.macro_thesis ?? 'none'}`)
    lines.push(`[watchlist] commodity=${brief.watchlist.commodity.join(',')} | leveraged=${brief.watchlist.leveraged.join(',')} | macro=${brief.watchlist.macro.join(',')}`)
    if (brief.recent_signals.length) {
      lines.push(`[recent signals]`)
      for (const s of brief.recent_signals) {
        lines.push(`  ${s.symbol} ${s.direction} [${s.status}]${s.acted ? '' : ' (unacted)'}`)
      }
    }
    if (brief.lessons.length) {
      lines.push(`[lessons learned]`)
      for (const l of brief.lessons) lines.push(`  ${l.content}`)
    }
  }

  return lines.join('\n')
}
