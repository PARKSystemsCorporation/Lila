import OpenAI from 'openai'
import type { PoolClient } from 'pg'
import { llmCall, LLMBudgetExceeded } from './llm'
import { cfg } from './config'
import * as Bluesky from './channels/bluesky'
import * as Telegram from './channels/telegram'

// ── Broadcast loop ───────────────────────────────────────────────────────────
//
// Two-stage pipeline:
//   1. Compose: once per BROADCAST_INTERVAL_MIN, gather context, ask the LLM
//      for a post, insert one row per channel with status='pending_publish'
//      and scheduled_publish_at = NOW + BROADCAST_PREVIEW_WINDOW_MIN.
//   2. Publish due: on every tick, find pending_publish rows whose scheduled
//      time has passed and actually post them via the channel. Updates row
//      to 'posted' or 'failed' and logs a chat alert on failure.
//
// The preview window lets the operator Cancel or Publish Now from the Dash
// PendingBroadcastCard before the post actually goes out. Setting
// BROADCAST_PREVIEW_WINDOW_MIN=0 publishes immediately (legacy behavior).

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

    // 1. Publish anything whose preview window has elapsed. This runs every
    //    tick regardless of compose cadence — so if the window was 5 min ago,
    //    we don't wait until the next hourly cycle to push the queued post.
    const publishResult = await this.publishDue()

    // 2. If enough time has passed since last compose, queue a new one.
    if (await this.shouldCompose()) {
      const queueResult = await this.composeAndQueue()
      if (queueResult) {
        // Compose wins the log line when it fires. Publish result only
        // logs when it actually did something.
        return queueResult
      }
    }

    return publishResult
  }

  async runManual(override?: string, publishImmediately = true): Promise<BroadcastResult> {
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

    // Manual post from the "Post now" button → bypass the preview window.
    if (publishImmediately) {
      const results = await this.publishAll(channels, text)
      for (const r of results) {
        await this.db.query(
          `INSERT INTO broadcasts (channel, content, status, external_id, error)
           VALUES ($1,$2,$3,$4,$5)`,
          [r.channel, text, r.ok ? 'posted' : 'failed', r.id ?? null, r.error ?? null]
        )
      }
      await this.mark()

      await this.maybeAlertOnFailures(results)

      const successes = results.filter(r => r.ok).map(r => r.channel)
      return successes.length
        ? { logMessage: `Manual broadcast on ${successes.join(', ')}.`, logType: 'success', posted: true }
        : { logMessage: 'Manual broadcast failed.', logType: 'warn', posted: false }
    }

    // Otherwise queue as pending
    await this.queue(channels, text)
    await this.mark()
    return {
      logMessage: `Broadcast queued for preview (${cfg.BROADCAST_PREVIEW_WINDOW_MIN} min window).`,
      logType: 'info',
      posted: false,
    }
  }

  // ── stage 1: compose and queue ────────────────────────────────────────────

  private async shouldCompose(): Promise<boolean> {
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

  private async composeAndQueue(): Promise<BroadcastResult | null> {
    const channels = BroadcastLoop.enabledChannels()
    if (channels.length === 0) {
      await this.mark()
      return null
    }

    const context = await this.gatherContext()
    const recent  = await this.recentPosts()

    const text = await this.compose(context, recent)
    if (!text) {
      await this.mark()
      return { logMessage: 'Broadcast: LLM returned empty, skipped.', logType: 'warn', posted: false }
    }

    // No preview window → publish immediately (legacy path).
    if (cfg.BROADCAST_PREVIEW_WINDOW_MIN <= 0) {
      const results = await this.publishAll(channels, text)
      for (const r of results) {
        await this.db.query(
          `INSERT INTO broadcasts (channel, content, status, external_id, error)
           VALUES ($1,$2,$3,$4,$5)`,
          [r.channel, text, r.ok ? 'posted' : 'failed', r.id ?? null, r.error ?? null]
        )
      }
      await this.mark()
      await this.maybeAlertOnFailures(results)

      const successes = results.filter(r => r.ok).map(r => r.channel)
      const failures  = results.filter(r => !r.ok).map(r => r.channel)
      if (successes.length) {
        return {
          logMessage: `Broadcast posted on ${successes.join(', ')}${failures.length ? ` (failed: ${failures.join(', ')})` : ''}.`,
          logType: 'success',
          posted: true,
        }
      }
      return { logMessage: `Broadcast failed: ${failures.join(', ')}.`, logType: 'warn', posted: false }
    }

    // Preview window enabled → queue as pending_publish.
    await this.queue(channels, text)
    await this.mark()
    return {
      logMessage: `Broadcast queued: "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}" · preview ${cfg.BROADCAST_PREVIEW_WINDOW_MIN}m · ${channels.join(', ')}`,
      logType: 'info',
      posted: false,
    }
  }

  private async queue(channels: string[], text: string): Promise<void> {
    for (const ch of channels) {
      await this.db.query(
        `INSERT INTO broadcasts (channel, content, status, scheduled_publish_at)
         VALUES ($1, $2, 'pending_publish', NOW() + ($3 || ' minutes')::interval)`,
        [ch, text, String(cfg.BROADCAST_PREVIEW_WINDOW_MIN)]
      )
    }
  }

  // ── stage 2: publish anything whose preview elapsed ───────────────────────

  private async publishDue(): Promise<BroadcastResult | null> {
    const { rows } = await this.db.query(
      `SELECT id, channel, content
       FROM broadcasts
       WHERE status = 'pending_publish'
         AND scheduled_publish_at IS NOT NULL
         AND scheduled_publish_at <= NOW()
       ORDER BY scheduled_publish_at ASC
       LIMIT 20`
    )
    if (rows.length === 0) return null

    const publishedBy: Record<string, string[]> = {} // text → [channel]
    const results: Array<{ id: number; channel: string; ok: boolean; error?: string }> = []

    for (const row of rows) {
      const channel = String(row.channel)
      const text    = String(row.content)
      const r = await this.publishOne(channel, text)
      results.push({ id: Number(row.id), channel, ok: r.ok, error: r.error })
      await this.db.query(
        `UPDATE broadcasts
           SET status = $1, external_id = $2, error = $3
         WHERE id = $4`,
        [r.ok ? 'posted' : 'failed', r.id ?? null, r.error ?? null, Number(row.id)]
      )
      if (r.ok) {
        publishedBy[text] ??= []
        publishedBy[text].push(channel)
      }
    }

    await this.maybeAlertOnFailures(results.map(r => ({ channel: r.channel, ok: r.ok, error: r.error })))

    const ok = results.filter(r => r.ok).length
    const fail = results.filter(r => !r.ok).length
    if (ok === 0 && fail === 0) return null
    return {
      logMessage: `Broadcast publish: ${ok} posted, ${fail} failed.`,
      logType: fail > 0 ? 'warn' : 'success',
      posted: ok > 0,
    }
  }

  // Called by the /api/broadcasts route when the operator taps "Publish now"
  // or "Cancel" inside the preview window.
  async publishPending(id: number): Promise<{ ok: boolean; error?: string }> {
    const { rows: [row] } = await this.db.query(
      `SELECT id, channel, content, status FROM broadcasts WHERE id = $1`, [id]
    )
    if (!row) return { ok: false, error: 'not found' }
    if (row.status !== 'pending_publish') return { ok: false, error: `already ${row.status}` }

    const r = await this.publishOne(String(row.channel), String(row.content))
    await this.db.query(
      `UPDATE broadcasts SET status = $1, external_id = $2, error = $3 WHERE id = $4`,
      [r.ok ? 'posted' : 'failed', r.id ?? null, r.error ?? null, id]
    )
    if (!r.ok) {
      await this.maybeAlertOnFailures([{ channel: String(row.channel), ok: false, error: r.error }])
    }
    return { ok: r.ok, error: r.error }
  }

  async cancelPending(id: number): Promise<{ ok: boolean }> {
    const res = await this.db.query(
      `UPDATE broadcasts SET status = 'cancelled' WHERE id = $1 AND status = 'pending_publish'`,
      [id]
    )
    return { ok: (res.rowCount ?? 0) > 0 }
  }

  // Cancel ALL pending broadcasts sharing a given content string (one compose
  // fans out to multiple channels; operator probably wants to cancel all).
  async cancelPendingByText(text: string): Promise<number> {
    const res = await this.db.query(
      `UPDATE broadcasts SET status = 'cancelled'
       WHERE status = 'pending_publish' AND content = $1`,
      [text]
    )
    return res.rowCount ?? 0
  }

  // ── failure chat alert with dedup ─────────────────────────────────────────
  //
  // When a channel fails, post a chat message as 'lila' with the exact
  // error so the operator sees it in the direct line. Dedup window is
  // 60 min per (channel + error-prefix) so a persistent failure doesn't
  // spam chat every tick.

  private async maybeAlertOnFailures(
    results: Array<{ channel: string; ok: boolean; error?: string }>,
  ): Promise<void> {
    const failures = results.filter(r => !r.ok)
    if (failures.length === 0) return

    for (const f of failures) {
      const key = `broadcast:${f.channel}:${(f.error ?? 'unknown').slice(0, 80)}`
      // Look for a matching lila message in the last 60 minutes.
      const { rows } = await this.db.query(
        `SELECT 1 FROM chat_messages
         WHERE sender = 'lila'
           AND content LIKE $1
           AND created_at > NOW() - INTERVAL '60 minutes'
         LIMIT 1`,
        [`%${key}%`]
      )
      if (rows.length > 0) continue  // already alerted

      const msg = `⚠ Broadcast failed — ${f.channel}: ${(f.error ?? 'unknown error').slice(0, 280)}\n[${key}]`
      await this.db.query(
        `INSERT INTO chat_messages (sender, content) VALUES ('lila', $1)`,
        [msg]
      )
      await this.db.query(
        `INSERT INTO lila_log (message, type) VALUES ($1, 'warn')`,
        [`Broadcast alert posted to chat: ${f.channel} — ${(f.error ?? '').slice(0, 80)}`]
      )
    }
  }

  // ── context gathering (unchanged from prior loop) ────────────────────────

  private async gatherContext(): Promise<string> {
    const { rows: [state] } = await this.db.query(
      'SELECT last_broadcast_at FROM broadcast_state WHERE id=1'
    )
    const since: string = state?.last_broadcast_at ?? new Date(Date.now() - 86_400_000).toISOString()

    const [paid, approved, closedTrades, earnings, target, drafts, positions, watch] = await Promise.all([
      this.db.query(
        `SELECT title, payout, platform_label FROM security_reports
         WHERE paid_at IS NOT NULL AND paid_at > $1
         ORDER BY paid_at DESC LIMIT 3`, [since]
      ),
      this.db.query(
        `SELECT title, reward, platform_label FROM security_reports
         WHERE status='approved' AND updated_at > $1
         ORDER BY updated_at DESC LIMIT 3`, [since]
      ),
      this.db.query(
        `SELECT symbol, pnl FROM lila_positions
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
      this.db.query(`SELECT symbol FROM lila_positions WHERE status='open' LIMIT 5`),
      this.db.query(
        `SELECT
           COUNT(*) FILTER (WHERE status='watching' AND first_seen_at > $1) AS new_watches,
           COUNT(*) FILTER (WHERE status='watching')                        AS watching
         FROM watch_targets`, [since]
      ),
    ])

    const lines: string[] = []
    lines.push(`Total earned (paid + closed P&L): $${parseFloat(earnings.rows[0]?.total_earned ?? '0').toFixed(2)}`)
    for (const p of paid.rows)         lines.push(`PAID: "${p.title}" on ${p.platform_label} → $${parseFloat(p.payout).toFixed(2)} received`)
    for (const a of approved.rows)     lines.push(`APPROVED: "${a.title}" on ${a.platform_label} (max $${a.reward})`)
    for (const t of closedTrades.rows) {
      const v = parseFloat(t.pnl ?? '0')
      lines.push(`TRADE CLOSED: ${t.symbol} ${v >= 0 ? '+' : ''}$${v.toFixed(2)}`)
    }
    if (target.rows[0]) lines.push(`Research target pinned: "${target.rows[0].title}" — cycle ${target.rows[0].cycles}, phase ${target.rows[0].phase}`)

    const d = drafts.rows[0]
    const pipelineParts: string[] = []
    if (Number(d?.reviewing) > 0) pipelineParts.push(`${d.reviewing} awaiting Lila review`)
    if (Number(d?.approved) > 0)  pipelineParts.push(`${d.approved} approved, awaiting submit`)
    if (Number(d?.submitted) > 0) pipelineParts.push(`${d.submitted} submitted, awaiting payout`)
    if (pipelineParts.length) lines.push(`Reports pipeline: ${pipelineParts.join(' · ')}`)
    if (positions.rows.length > 0) lines.push(`Open positions: ${positions.rows.map((p: { symbol: string }) => p.symbol).join(', ')}`)

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

  private async publishOne(
    channel: string,
    text: string,
  ): Promise<{ ok: boolean; id?: string; error?: string }> {
    if (channel === 'bluesky') {
      const r = await Bluesky.postSkeet(text)
      return { ok: r.ok, id: r.uri, error: r.error }
    }
    if (channel === 'telegram') {
      // No parse_mode — plain text so stray * or _ can't trip Telegram.
      const r = await Telegram.sendMessage(`🤖 Lila update\n\n${text}`)
      return { ok: r.ok, error: r.error }
    }
    return { ok: false, error: 'unknown channel' }
  }

  private async publishAll(
    channels: string[],
    text: string,
  ): Promise<Array<{ channel: string; ok: boolean; id?: string; error?: string }>> {
    return Promise.all(channels.map(async ch => {
      const r = await this.publishOne(ch, text)
      return { channel: ch, ...r }
    }))
  }
}
