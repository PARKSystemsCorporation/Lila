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

const POST_PROMPT = `You are Lila posting market commentary on Bluesky. One post per hour.

Voice: dry, numbers-first, quant-trained. No hashtags, no emojis, no exclamation points. Not a marketer, not a finfluencer. 2-3 short sentences max. Under 260 characters total.

SCOPE — market content only:
- Market thesis (what's setting up, what's breaking, what's reverting).
- Commodity triggers (oil, gas, metals, ags) and the macro catalyst driving them.
- Global news effects (central bank, geopolitics, data prints) read through a positioning lens.
- Quant / technical reads (levels, flows, vol regime, cross-asset signals).
- A closed trade result only if it illustrates a thesis. Lead with the setup, not the P&L.

DO NOT post:
- Life updates, internal ops chatter, bounty/research pipeline status, cycle/phase counters, queue depth, payouts.
- Vague platitudes ("stay sharp", "risk on today"). Every post needs a specific signal or read.

FINANCIAL INTEGRITY:
- State views as views, not certainty. No guarantees, no price targets stated as fact.
- If you reference a trade, "closed" / "P&L" is OK for realized results. Anything open is a view, not a win.

Your recent posts (do NOT repeat these angles or tickers):
{RECENT_POSTS}

Vega's latest market intel + current positioning:
{CONTEXT}

Pick ONE angle for THIS post. Prefer the freshest catalyst or cleanest setup. Menu:
  1. Commodity trigger — which commodity, what's moving it right now.
  2. Macro / news read — data print or policy event, and the positioning implication.
  3. Quant / technical — level, flow, vol, correlation break.
  4. Cross-asset thesis — what one market is telling you about another.
  5. Closed trade as thesis illustration — setup → trigger → result.
  6. Watchlist delta only if it's a real signal (e.g. "crude curve flipped to backwardation").

If Vega has nothing fresh, post a tight quant read of whatever's in the current state. Do not fabricate catalysts.

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
  // Dedup on channel alone. Error text often varies run-to-run (timestamps,
  // request IDs), which would defeat dedup and spam chat every tick.

  private async maybeAlertOnFailures(
    results: Array<{ channel: string; ok: boolean; error?: string }>,
  ): Promise<void> {
    const failures = results.filter(r => !r.ok)
    if (failures.length === 0) return

    for (const f of failures) {
      const key = `broadcast:${f.channel}`
      const { rows } = await this.db.query(
        `SELECT 1 FROM chat_messages
         WHERE sender = 'lila'
           AND thread = 'main'
           AND content LIKE $1
           AND created_at > NOW() - INTERVAL '60 minutes'
         LIMIT 1`,
        [`%[${key}]%`]
      )
      if (rows.length > 0) continue

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

    const [notes, picks, openPositions, closedTrades] = await Promise.all([
      this.db.query(
        `SELECT path, content FROM analyst_notes
         ORDER BY updated_at DESC LIMIT 4`
      ),
      this.db.query(
        `SELECT symbol, direction, entry_price, target_price, stop_loss, confidence, risk_level, reason, asset_class
         FROM analyst_picks
         WHERE status='pending' OR (status='executed' AND created_at > $1)
         ORDER BY created_at DESC LIMIT 5`, [since]
      ),
      this.db.query(
        `SELECT symbol, direction, entry_price, target_price, stop_loss
         FROM lila_positions
         WHERE status='open' ORDER BY opened_at DESC LIMIT 5`
      ),
      this.db.query(
        `SELECT symbol, direction, pnl, entry_price FROM lila_positions
         WHERE status='closed' AND closed_at IS NOT NULL AND closed_at > $1
           AND COALESCE(ABS(pnl), 0) >= 1
         ORDER BY closed_at DESC LIMIT 3`, [since]
      ),
    ])

    const lines: string[] = []

    if (notes.rows.length > 0) {
      lines.push('VEGA NOTES (most recent first, treat as the freshest market reads):')
      for (const n of notes.rows) {
        const body = String(n.content ?? '').slice(0, 600).replace(/\s+/g, ' ').trim()
        lines.push(`  [${n.path}] ${body}`)
      }
    } else {
      lines.push('VEGA NOTES: none fresh. Lean on positioning + a technical/quant read.')
    }

    if (picks.rows.length > 0) {
      lines.push('VEGA PICKS (current thesis set):')
      for (const p of picks.rows) {
        const conf = p.confidence != null ? ` conf=${Number(p.confidence).toFixed(2)}` : ''
        const entry = p.entry_price != null ? ` entry=${p.entry_price}` : ''
        const tgt = p.target_price != null ? ` tgt=${p.target_price}` : ''
        const stop = p.stop_loss != null ? ` stop=${p.stop_loss}` : ''
        const risk = p.risk_level ? ` risk=${p.risk_level}` : ''
        const why = p.reason ? ` — ${String(p.reason).slice(0, 200)}` : ''
        lines.push(`  ${p.symbol} ${p.direction} [${p.asset_class}]${entry}${tgt}${stop}${conf}${risk}${why}`)
      }
    }

    if (openPositions.rows.length > 0) {
      const parts = openPositions.rows.map((p: { symbol: string; direction: string }) => `${p.symbol} ${p.direction}`)
      lines.push(`OPEN POSITIONS: ${parts.join(', ')}`)
    }

    if (closedTrades.rows.length > 0) {
      for (const t of closedTrades.rows) {
        const v = parseFloat(t.pnl ?? '0')
        lines.push(`CLOSED: ${t.symbol} ${t.direction} ${v >= 0 ? '+' : ''}$${v.toFixed(2)}`)
      }
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
