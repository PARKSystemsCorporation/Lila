import OpenAI from 'openai'
import type { PoolClient } from 'pg'
import { llmCall, LLMBudgetExceeded } from './llm'
import { cfg } from './config'
import * as Bluesky from './channels/bluesky'
import * as Telegram from './channels/telegram'

// ── Broadcast loop ───────────────────────────────────────────────────────────
//
// Once per BROADCAST_INTERVAL_MIN (default 60), compose and publish ONE
// short public update. The loop no longer skips silent hours — operator
// wants a steady cadence on Bluesky (and Telegram mirror). Lila picks
// whichever angle fits the current state: paid event, closed trade,
// approved report, research progress, discovery queue, or a state-of-
// operations line.
//
// Anti-repetition: the composer sees the last few posts so it doesn't
// say the same thing back-to-back.

type LogType = 'info' | 'success' | 'warn'

export interface BroadcastResult {
  logMessage: string
  logType: LogType
  posted: boolean
}

const POST_PROMPT = `You are Lila posting a public operational update on Bluesky. One post per hour, rain or shine.

Voice: dry, numbers-first, quiet operator. No hashtags, no emojis, no exclamation points. Not a marketer. 2-3 short sentences max. Under 260 characters total.

FINANCIAL INTEGRITY:
- "Paid" / "received" only when {PAID_HINT_CONTEXT}. Anything submitted or approved is PENDING — say pending, not earned.
- If nothing new happened, don't fabricate — post a quiet state line (current target, queue depth, etc.).

Your recent posts (do NOT repeat these angles):
{RECENT_POSTS}

Current state + any notable events since last post:
{CONTEXT}

Pick ONE angle for THIS post. Prefer newer info. Menu:
  1. A paid event (if one just landed — lead with the $ and platform).
  2. A closed trade (symbol + P&L).
  3. A newly approved report (what + max).
  4. Research progress (target + cycle + phase).
  5. Discovery / watchlist delta (e.g. "+3 protocols from DefiLlama today").
  6. Pipeline state (e.g. "2 reports in Lila's queue, 1 awaiting submit").
  7. Quiet state (e.g. "Cycle 4 on <target>, phase investigate. No payouts today.").

Output the post text only. No surrounding quotes, no "update:" preamble.`

export class BroadcastLoop {
  private db: PoolClient
  private ai: OpenAI | null

  constructor(db: PoolClient) {
    this.db = db
    this.ai = process.env.DEEPSEEK_API_KEY
      ? new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com/v1' })
      : null
  }

  // Channels that have credentials configured right now.
  static enabledChannels(): string[] {
    const out: string[] = []
    if (Bluesky.isConfigured())  out.push('bluesky')
    if (Telegram.isConfigured()) out.push('telegram')
    return out
  }

  async run(): Promise<BroadcastResult | null> {
    if (!cfg.ENABLE_BROADCAST) return null
    if (!(await this.shouldRun())) return null

    const channels = BroadcastLoop.enabledChannels()
    if (channels.length === 0) {
      // No channels configured — still mark the window so we don't thrash.
      await this.mark()
      return null
    }

    const context = await this.gatherContext()
    const recent = await this.recentPosts()

    const text = await this.compose(context, recent)
    if (!text) {
      await this.mark()
      return { logMessage: 'Broadcast: LLM returned empty, skipped.', logType: 'warn', posted: false }
    }

    const results = await this.publishAll(channels, text)

    for (const r of results) {
      await this.db.query(
        `INSERT INTO broadcasts (channel, content, status, external_id, error)
         VALUES ($1,$2,$3,$4,$5)`,
        [r.channel, text, r.ok ? 'posted' : 'failed', r.id ?? null, r.error ?? null]
      )
    }

    await this.mark()

    const successes = results.filter(r => r.ok).map(r => r.channel)
    const failures  = results.filter(r => !r.ok).map(r => r.channel)
    if (successes.length > 0) {
      return {
        logMessage: `Broadcast posted on ${successes.join(', ')}${failures.length ? ` (failed: ${failures.join(', ')})` : ''}.`,
        logType: 'success',
        posted: true,
      }
    }
    return {
      logMessage: `Broadcast failed: ${failures.join(', ')}.`,
      logType: 'warn',
      posted: false,
    }
  }

  async runManual(override?: string): Promise<BroadcastResult> {
    const channels = BroadcastLoop.enabledChannels()
    if (channels.length === 0) {
      return { logMessage: 'No broadcast channels configured.', logType: 'warn', posted: false }
    }

    let text: string
    if (override && override.trim()) {
      text = override.slice(0, 260)
    } else {
      const context = await this.gatherContext()
      const recent = await this.recentPosts()
      const composed = await this.compose(context, recent)
      if (!composed) return { logMessage: 'Compose failed.', logType: 'warn', posted: false }
      text = composed
    }

    const results = await this.publishAll(channels, text)
    for (const r of results) {
      await this.db.query(
        `INSERT INTO broadcasts (channel, content, status, external_id, error)
         VALUES ($1,$2,$3,$4,$5)`,
        [r.channel, text, r.ok ? 'posted' : 'failed', r.id ?? null, r.error ?? null]
      )
    }
    await this.mark()

    const successes = results.filter(r => r.ok).map(r => r.channel)
    return successes.length
      ? { logMessage: `Manual broadcast on ${successes.join(', ')}.`, logType: 'success', posted: true }
      : { logMessage: 'Manual broadcast failed.', logType: 'warn', posted: false }
  }

  // ── cadence ────────────────────────────────────────────────────────────────

  private async shouldRun(): Promise<boolean> {
    const { rows: [s] } = await this.db.query(
      'SELECT last_broadcast_at FROM broadcast_state WHERE id=1'
    )
    if (!s?.last_broadcast_at) return true
    return (Date.now() - new Date(s.last_broadcast_at).getTime()) / 60_000 >= cfg.BROADCAST_INTERVAL_MIN
  }

  private async mark(): Promise<void> {
    await this.db.query(
      'UPDATE broadcast_state SET last_broadcast_at=NOW(), updated_at=NOW() WHERE id=1'
    )
  }

  // ── context gathering ─────────────────────────────────────────────────────

  private async gatherContext(): Promise<string> {
    const { rows: [state] } = await this.db.query(
      'SELECT last_broadcast_at FROM broadcast_state WHERE id=1'
    )
    const since: string = state?.last_broadcast_at ?? new Date(Date.now() - 86_400_000).toISOString()

    // Notable-since-last-post events (dated fresh)
    const [paid, approved, closedTrades, earnings, target, drafts, positions, watch] = await Promise.all([
      this.db.query(
        `SELECT title, payout, platform_label
         FROM security_reports
         WHERE paid_at IS NOT NULL AND paid_at > $1
         ORDER BY paid_at DESC LIMIT 3`, [since]
      ),
      this.db.query(
        `SELECT title, reward, platform_label
         FROM security_reports
         WHERE status='approved' AND updated_at > $1
         ORDER BY updated_at DESC LIMIT 3`, [since]
      ),
      this.db.query(
        `SELECT symbol, pnl
         FROM lila_positions
         WHERE status='closed' AND closed_at IS NOT NULL AND closed_at > $1
           AND COALESCE(ABS(pnl), 0) >= 1
         ORDER BY closed_at DESC LIMIT 3`, [since]
      ),
      this.db.query('SELECT total_earned FROM lila_state WHERE id=1'),
      this.db.query(
        `SELECT title, phase, cycles FROM research_targets
         WHERE status='active' ORDER BY last_worked_at DESC NULLS LAST LIMIT 1`
      ),
      this.db.query(
        `SELECT
           COUNT(*) FILTER (WHERE status='pending_review') AS reviewing,
           COUNT(*) FILTER (WHERE status='approved')       AS approved,
           COUNT(*) FILTER (WHERE status='submitted')      AS submitted
         FROM security_reports`
      ),
      this.db.query(
        `SELECT symbol FROM lila_positions WHERE status='open' LIMIT 5`
      ),
      this.db.query(
        `SELECT
           COUNT(*) FILTER (WHERE status='watching' AND first_seen_at > $1) AS new_watches,
           COUNT(*) FILTER (WHERE status='watching')                        AS watching
         FROM watch_targets`, [since]
      ),
    ])

    const lines: string[] = []
    lines.push(`Total earned (paid + closed P&L): $${parseFloat(earnings.rows[0]?.total_earned ?? '0').toFixed(2)}`)

    if (paid.rows.length > 0) {
      for (const p of paid.rows) {
        lines.push(`PAID: "${p.title}" on ${p.platform_label} → $${parseFloat(p.payout).toFixed(2)} received`)
      }
    }
    if (approved.rows.length > 0) {
      for (const a of approved.rows) {
        lines.push(`APPROVED: "${a.title}" on ${a.platform_label} (max $${a.reward})`)
      }
    }
    if (closedTrades.rows.length > 0) {
      for (const t of closedTrades.rows) {
        const v = parseFloat(t.pnl ?? '0')
        lines.push(`TRADE CLOSED: ${t.symbol} ${v >= 0 ? '+' : ''}$${v.toFixed(2)}`)
      }
    }

    // Steady-state lines
    if (target.rows[0]) {
      lines.push(`Research target pinned: "${target.rows[0].title}" — cycle ${target.rows[0].cycles}, phase ${target.rows[0].phase}`)
    }

    const d = drafts.rows[0]
    const pipelineParts: string[] = []
    if (Number(d?.reviewing) > 0) pipelineParts.push(`${d.reviewing} awaiting Lila review`)
    if (Number(d?.approved) > 0)  pipelineParts.push(`${d.approved} approved, awaiting submit`)
    if (Number(d?.submitted) > 0) pipelineParts.push(`${d.submitted} submitted, awaiting payout`)
    if (pipelineParts.length) lines.push(`Reports pipeline: ${pipelineParts.join(' · ')}`)

    if (positions.rows.length > 0) {
      lines.push(`Open positions: ${positions.rows.map((p: { symbol: string }) => p.symbol).join(', ')}`)
    }

    const newWatches = Number(watch.rows[0]?.new_watches ?? 0)
    const watching   = Number(watch.rows[0]?.watching ?? 0)
    if (newWatches > 0 || watching > 0) {
      lines.push(`Watchlist: ${watching} total${newWatches > 0 ? ` (+${newWatches} new since last post)` : ''}`)
    }

    return lines.join('\n')
  }

  private async recentPosts(limit = 4): Promise<string> {
    const { rows } = await this.db.query(
      `SELECT DISTINCT ON (content) content
       FROM broadcasts
       WHERE status='posted'
       ORDER BY content, created_at DESC
       LIMIT 20`
    )
    // Take first N distinct-content posts for anti-repetition. The cap here
    // is generous so the LLM sees a real sample of past angles.
    const picked = rows.slice(0, limit).map((r: { content: string }) => `- ${r.content}`)
    if (picked.length === 0) return '(none yet)'
    return picked.join('\n')
  }

  // ── compose + publish ──────────────────────────────────────────────────────

  private async compose(context: string, recent: string): Promise<string | null> {
    if (!this.ai) return null
    try {
      const { content } = await llmCall({
        ai: this.ai,
        module: 'broadcast.compose',
        messages: [{
          role: 'user',
          content: POST_PROMPT
            .replace('{PAID_HINT_CONTEXT}', "there's a 'PAID:' line below")
            .replace('{RECENT_POSTS}', recent)
            .replace('{CONTEXT}', context),
        }],
        max_tokens: 160,
        temperature: 0.5,
      })
      return content.trim().slice(0, 280) || null
    } catch (e) {
      if (e instanceof LLMBudgetExceeded) return null
      return null
    }
  }

  private async publishAll(
    channels: string[],
    text: string,
  ): Promise<Array<{ channel: string; ok: boolean; id?: string; error?: string }>> {
    const jobs = channels.map(async ch => {
      if (ch === 'bluesky') {
        const r = await Bluesky.postSkeet(text)
        return { channel: 'bluesky', ok: r.ok, id: r.uri, error: r.error }
      }
      if (ch === 'telegram') {
        // Broadcasts go out as plain text — no Markdown so stray * or _
        // in a generated post can't trip Telegram's strict parser.
        const r = await Telegram.sendMessage(`🤖 Lila update\n\n${text}`)
        return { channel: 'telegram', ok: r.ok, error: r.error }
      }
      return { channel: ch, ok: false, error: 'unknown channel' }
    })
    return Promise.all(jobs)
  }
}
