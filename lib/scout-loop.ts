import OpenAI from 'openai'
import type { PoolClient } from 'pg'
import { llmCall, LLMBudgetExceeded } from './llm'
import { cfg } from './config'
import * as Contra from './platforms/contra'
import * as Wellfound from './platforms/wellfound'
import { extractTitle } from './article-engine'

// ── Scout: gig hunter + tutorial fallback ───────────────────────────────
//
// Scout pulls small fixed-price contracts (Python automation / scraping /
// API fixes) from Contra (primary) and Wellfound (fallback). For each
// discovered gig, Scout drafts a short proposal pitch — the operator
// submits manually on the platform.
//
// When both gig sources have been dry for SCOUT_DRY_HOURS (default 24h),
// Scout switches modes and drafts a technical tutorial instead. Drafts
// land in `articles` with kind='tutorial'; once Lila approves, the
// devto-publish.ts step posts them to dev.to.
//
// One step per cycle, time-gated by SCOUT_RUN_SEC (default 5min):
//   S0 — Fetch new gigs (Contra → Wellfound fallback) when queue empty
//        OR last fetch is >1h old.
//   S1 — Draft a proposal for the oldest 'discovered' row.
//   S2 — Tutorial fallback when the queue has been dry for too long.

const FETCH_INTERVAL_MS = 60 * 60 * 1000
const PITCH_MAX_TOKENS  = 600
const TUTORIAL_MAX_TOKENS = 2400

const DEFAULT_TUTORIAL_TOPICS = [
  'Robust rate-limited Python scraping with retry and backoff',
  'Building a small REST API in FastAPI with auth and rate limiting',
  'Practical webhooks: receiving, verifying, and replaying events in Python',
  'Scheduling background jobs with APScheduler vs cron + Docker',
  'Handling pagination, throttling, and partial failures in API integrations',
  'Resilient CSV/Excel ingestion pipelines with pandas + pydantic',
]

const PITCH_PROMPT = `You are Scout, the gig-prospecting agent on Lila's autonomous team. You are drafting a short fixed-price proposal pitch (120-180 words, no fluff) for the operator to submit manually on Contra/Wellfound.

GIG:
  Source:  {SOURCE}
  Title:   {TITLE}
  Budget:  {BUDGET}
  URL:     {URL}

DESCRIPTION:
---
{SUMMARY}
---

Write a proposal pitch in plain prose, not markdown. Include:
- One-line hook tied to the operator's actual pain point
- Why we're a fit (Python automation / scraping / API integration experience — be concrete, no vague claims)
- Specific deliverable + concrete timeline (days, not weeks)
- Price proposal anchored to the listed budget
- A single sharp question that surfaces missing scope

Voice: senior engineer pitching, not a marketer. No exclamations, no "I'm passionate about". 120-180 words. Output the pitch text only, no preamble.`

const TUTORIAL_PROMPT = `You are Scout, ghost-writing a technical tutorial for dev.to. The topic:

TOPIC: {TOPIC}

Audience: working developers who already know Python basics. Voice: senior engineer, dry, specific. 1200-1800 words. Markdown.

Constraints:
- Start with a clear "what you'll build" / "what you'll learn" lede.
- Concrete code blocks with imports, not abbreviated snippets.
- Every code block must be runnable as written (or note explicitly what's missing).
- Include at least one "common mistake" callout.
- End with a "where this falls down" section that names real edge cases.
- No "in this tutorial we will…" filler. No emoji. No padding.

Output a complete markdown article starting with a single H1 title line. No surrounding commentary.`

interface ScoutResult {
  logMessage: string
  logType: 'info' | 'success' | 'warn'
}

interface PitchTarget {
  id: number
  source: string
  external_id: string
  url: string
  title: string
  summary: string | null
  budget_usd: string | null
}

export class ScoutLoop {
  private db: PoolClient
  private ai: OpenAI | null

  constructor(db: PoolClient) {
    this.db = db
    this.ai = process.env.DEEPSEEK_API_KEY
      ? new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com/v1' })
      : null
  }

  async shouldRun(): Promise<boolean> {
    const { rows: [s] } = await this.db.query('SELECT last_step_at FROM scout_state WHERE id=1')
    if (!s?.last_step_at) return true
    return (Date.now() - new Date(s.last_step_at).getTime()) / 1000 >= cfg.SCOUT_RUN_SEC
  }

  async run(): Promise<ScoutResult | null> {
    if (!(await this.shouldRun())) return null

    await this.maybeIntroduce()

    const { rows: [counts] } = await this.db.query(
      `SELECT
         (SELECT COUNT(*) FROM gig_picks WHERE status='discovered')           AS discovered,
         (SELECT MAX(last_pick_at) FROM scout_state WHERE id=1)               AS last_fetch_at`
    )
    const discoveredCount = Number(counts?.discovered ?? 0)
    const lastFetchAt = counts?.last_fetch_at ? new Date(counts.last_fetch_at).getTime() : 0
    const fetchStale = Date.now() - lastFetchAt > FETCH_INTERVAL_MS

    if (discoveredCount === 0 || fetchStale) {
      const fetchResult = await this.fetchGigs().catch(e => ({
        inserted: 0, source: 'contra', _error: String(e).slice(0, 120),
      }))
      await this.markStep({ stampFetch: true })

      if (fetchResult.inserted > 0) {
        const errSuffix = (fetchResult as { _error?: string })._error
          ? ` (err: ${(fetchResult as { _error?: string })._error})` : ''
        await this.chat(`Pulled +${fetchResult.inserted} gigs from ${fetchResult.source}.`)
        return {
          logMessage: `Scout fetched gigs: +${fetchResult.inserted} discovered (${fetchResult.source})${errSuffix}`,
          logType: 'success',
        }
      }
      // Nothing new from either platform. Maybe time to draft a tutorial.
      const tutorial = await this.maybeDraftTutorial()
      if (tutorial) return tutorial

      return {
        logMessage: `Scout fetched gigs: +0 discovered (contra/wellfound dry)`,
        logType: 'info',
      }
    }

    if (!this.ai) {
      await this.markStep({})
      return { logMessage: 'Scout: no LLM key, skipping pitch.', logType: 'warn' }
    }

    const target = await this.pickToPitch()
    if (!target) {
      await this.markStep({})
      const tutorial = await this.maybeDraftTutorial()
      if (tutorial) return tutorial
      return { logMessage: 'Scout: gig queue empty, idle.', logType: 'info' }
    }

    let pitch: string
    try {
      pitch = await this.draftPitch(target)
    } catch (e) {
      if (e instanceof LLMBudgetExceeded) {
        await this.markStep({})
        return { logMessage: 'Scout: budget hit, skipping.', logType: 'warn' }
      }
      await this.db.query(
        `UPDATE gig_picks
           SET status='rejected', review_notes=$1, updated_at=NOW()
         WHERE id=$2`,
        [`Pitch error: ${String(e).slice(0, 200)}`, target.id]
      )
      await this.markStep({})
      return { logMessage: `Scout pitch error on "${target.title.slice(0, 60)}": ${String(e).slice(0, 80)}`, logType: 'warn' }
    }

    if (!pitch.trim() || pitch.length < 80) {
      await this.db.query(
        `UPDATE gig_picks
           SET status='rejected',
               review_notes='Pitch too thin (Scout self-rejected pre-Lila).',
               updated_at=NOW()
         WHERE id=$2`,
        [target.id]
      )
      await this.markStep({})
      return { logMessage: `Scout self-rejected gig "${target.title.slice(0, 60)}"`, logType: 'info' }
    }

    await this.db.query(
      `UPDATE gig_picks
         SET status='drafted',
             draft_pitch=$1,
             drafted_at=NOW(),
             updated_at=NOW()
       WHERE id=$2`,
      [pitch.slice(0, 4000), target.id]
    )

    await this.chat(`Drafted pitch for "${target.title.slice(0, 80)}" (${target.source}).`)
    await this.markStep({})
    return {
      logMessage: `Scout drafted ${target.source} pitch: "${target.title.slice(0, 70)}"`,
      logType: 'success',
    }
  }

  // ── S0: gig pull ──────────────────────────────────────────────────────

  private async fetchGigs(): Promise<{ inserted: number; source: 'contra' | 'wellfound' }> {
    const contra = await Contra.fetchOpenGigs().catch(() => [])
    if (contra.length > 0) {
      const inserted = await this.upsertGigs('contra', contra)
      return { inserted, source: 'contra' }
    }
    const wf = await Wellfound.fetchOpenGigs().catch(() => [])
    const inserted = await this.upsertGigs('wellfound', wf)
    return { inserted, source: 'wellfound' }
  }

  private async upsertGigs(
    source: 'contra' | 'wellfound',
    gigs: { external_id: string; url: string; title: string; summary: string | null; budget_usd: number | null; posted_at: string | null }[],
  ): Promise<number> {
    let inserted = 0
    for (const g of gigs) {
      const { rowCount } = await this.db.query(
        `INSERT INTO gig_picks
           (source, external_id, url, title, summary, budget_usd, posted_at, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'discovered')
         ON CONFLICT (source, external_id) DO NOTHING`,
        [source, g.external_id, g.url, g.title, g.summary, g.budget_usd, g.posted_at]
      )
      if (rowCount && rowCount > 0) inserted++
    }
    return inserted
  }

  // ── S1: pitch selection ──────────────────────────────────────────────

  private async pickToPitch(): Promise<PitchTarget | null> {
    const { rows } = await this.db.query(
      `SELECT id, source, external_id, url, title, summary, budget_usd
         FROM gig_picks
        WHERE status='discovered'
        ORDER BY budget_usd DESC NULLS LAST, created_at ASC
        LIMIT 1`
    )
    return rows[0] ?? null
  }

  // ── S1: draft a proposal pitch ───────────────────────────────────────

  private async draftPitch(target: PitchTarget): Promise<string> {
    const budget = target.budget_usd
      ? `$${parseFloat(target.budget_usd).toFixed(2)}`
      : '(not specified)'
    const prompt = PITCH_PROMPT
      .replace(/\{SOURCE\}/g, target.source)
      .replace(/\{TITLE\}/g, target.title)
      .replace(/\{BUDGET\}/g, budget)
      .replace(/\{URL\}/g, target.url)
      .replace(/\{SUMMARY\}/g, target.summary ?? '(no description)')

    const { content } = await llmCall({
      ai: this.ai!,
      module: 'scout.pitch',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: PITCH_MAX_TOKENS,
      temperature: 0.4,
    })
    return content.trim()
  }

  // ── S2: tutorial fallback ────────────────────────────────────────────

  private async maybeDraftTutorial(): Promise<ScoutResult | null> {
    if (!this.ai) return null

    const dryHours = cfg.SCOUT_DRY_HOURS
    const { rows: [gate] } = await this.db.query(
      `SELECT
         (SELECT COUNT(*) FROM gig_picks
            WHERE created_at > NOW() - ($1 || ' hours')::interval
              AND status='discovered')                              AS recent_discovered,
         (SELECT COUNT(*) FROM articles
            WHERE author='scout' AND kind='tutorial'
              AND created_at > NOW() - INTERVAL '24 hours')         AS recent_tutorials,
         (SELECT MAX(last_pick_at) FROM scout_state WHERE id=1)     AS last_fetch_at`,
      [String(dryHours)]
    )
    const recentDiscovered = Number(gate?.recent_discovered ?? 0)
    const recentTutorials  = Number(gate?.recent_tutorials  ?? 0)
    const lastFetchAt = gate?.last_fetch_at ? new Date(gate.last_fetch_at).getTime() : 0
    // Don't draft tutorials before Scout has had a chance to find a gig.
    if (lastFetchAt === 0) return null
    if (recentDiscovered > 0) return null
    if (recentTutorials  > 0) return null

    const topic = pickTutorialTopic()
    let raw: string
    try {
      const { content } = await llmCall({
        ai: this.ai!,
        module: 'scout.tutorial',
        messages: [{ role: 'user', content: TUTORIAL_PROMPT.replace(/\{TOPIC\}/g, topic) }],
        max_tokens: TUTORIAL_MAX_TOKENS,
        temperature: 0.5,
      })
      raw = content.trim()
    } catch (e) {
      if (e instanceof LLMBudgetExceeded) {
        return { logMessage: 'Scout: budget hit, skipping tutorial.', logType: 'warn' }
      }
      return { logMessage: `Scout tutorial error: ${String(e).slice(0, 100)}`, logType: 'warn' }
    }
    if (!raw) return null

    const title = extractTitle(raw) ?? `Scout — ${topic}`.slice(0, 200)
    await this.db.query(
      `INSERT INTO articles (title, content, source, status, author, kind)
       VALUES ($1, $2, 'scout-tutorial', 'draft', 'scout', 'tutorial')`,
      [title, raw]
    )
    await this.chat(`Drafted tutorial: "${title.slice(0, 80)}". Awaiting review.`)
    return {
      logMessage: `Scout drafted tutorial: "${title.slice(0, 70)}"`,
      logType: 'success',
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────

  // One-shot self-introduction. Atomic claim via UPDATE … RETURNING so
  // the intro posts exactly once even if multiple ticks race.
  private async maybeIntroduce(): Promise<void> {
    const { rows } = await this.db.query(
      `UPDATE scout_state SET introduced_at=NOW()
        WHERE id=1 AND introduced_at IS NULL
        RETURNING id`
    )
    if (!rows.length) return
    await this.chat(
      "Scout reporting in. I hunt fixed-price Python automation / scraping / API gigs on Contra (primary) and Wellfound (fallback) and draft proposal pitches for the operator to send. When the gig queue is dry, I draft technical tutorials — once approved, dev.to publishes them.",
      'message',
    )
  }

  private async chat(content: string, kind: 'message' | 'status' = 'status'): Promise<void> {
    await this.db.query(
      `INSERT INTO chat_messages (sender, content, kind) VALUES ($1, $2, $3)`,
      ['scout', content.slice(0, 500), kind]
    )
  }

  private async markStep(opts: { stampFetch?: boolean }): Promise<void> {
    if (opts.stampFetch) {
      await this.db.query(
        `UPDATE scout_state
           SET last_step_at=NOW(), last_pick_at=NOW(), cycle=cycle+1, updated_at=NOW()
         WHERE id=1`
      )
    } else {
      await this.db.query(
        `UPDATE scout_state SET last_step_at=NOW(), cycle=cycle+1, updated_at=NOW() WHERE id=1`
      )
    }
  }
}

// ── pure helpers ──────────────────────────────────────────────────────────

function pickTutorialTopic(): string {
  const env = (process.env.SCOUT_TUTORIAL_TOPICS ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const pool = env.length ? env : DEFAULT_TUTORIAL_TOPICS
  return pool[Math.floor(Math.random() * pool.length)]
}
