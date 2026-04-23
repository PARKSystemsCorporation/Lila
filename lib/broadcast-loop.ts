import OpenAI from 'openai'
import type { PoolClient } from 'pg'
import { llmCall, LLMBudgetExceeded } from './llm'
import { cfg } from './config'
import * as X from './channels/x'
import * as Farcaster from './channels/farcaster'
import * as Bluesky from './channels/bluesky'

// ── Broadcast loop ───────────────────────────────────────────────────────────
//
// Once per BROADCAST_INTERVAL_MIN (default 60), gather "notable" activity
// since the last broadcast. If nothing notable happened, skip — silent hours
// do not post. If something did, compose one short update and publish to all
// configured channels in parallel.
//
// "Notable" events (any one triggers a post):
//   - A bounty was paid (real money landed)
//   - A trade closed at meaningful P&L
//   - A new finding/report hit 'approved'
//   - total_earned moved (trading close increment)
// Signal key is a hash of the triggering row ids so we never re-post the
// same event if the loop fires twice across a restart.
//
// Never hammers: one LLM call per post attempt, one post every hour max,
// skipped when quiet. Each post attempt tries all configured channels in
// parallel and records success/failure per channel.

type LogType = 'info' | 'success' | 'warn'

export interface BroadcastResult {
  logMessage: string
  logType: LogType
  posted: boolean
}

const POST_PROMPT = `You are Lila, running an autonomous trading + bug-bounty operation. Post ONE short status update.

Style rules (hard):
- Max 260 characters.
- Direct, dry, numbers first. Sound like a quiet operator, not a marketer.
- No hashtags. No emojis. No exclamation points. No "excited to announce".
- If the event is a paid bounty, lead with the $ paid and the platform.
- If the event is a closed trade, lead with symbol + P&L.
- If the event is an approved report, say what you filed for how much.
- Don't overstate. "Submitted" is not "earned". Only call money "earned" if it was actually paid.

Activity since last post:
{SIGNAL}

Write the post text only. No surrounding quotes, no preamble.`

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
    if (X.isConfigured())         out.push('x')
    if (Farcaster.isConfigured()) out.push('farcaster')
    if (Bluesky.isConfigured())   out.push('bluesky')
    return out
  }

  async run(): Promise<BroadcastResult | null> {
    if (!cfg.ENABLE_BROADCAST) return null
    if (!(await this.shouldRun())) return null

    const channels = BroadcastLoop.enabledChannels()
    if (channels.length === 0) {
      await this.mark(null)
      return null
    }

    const signal = await this.gatherSignal()
    if (!signal.notable) {
      await this.mark(null)
      return { logMessage: 'Broadcast window: nothing notable. Skipped.', logType: 'info', posted: false }
    }
    if (signal.key === await this.lastSignalKey()) {
      // Same trigger as last post — don't repeat ourselves across restarts.
      await this.mark(signal.key)
      return { logMessage: 'Broadcast window: same event as last post. Skipped.', logType: 'info', posted: false }
    }

    // Compose the post (one LLM call)
    const text = await this.compose(signal.text)
    if (!text) {
      await this.mark(signal.key)
      return { logMessage: 'Broadcast: LLM returned empty, skipped.', logType: 'warn', posted: false }
    }

    // Publish in parallel
    const results = await this.publishAll(channels, text)

    // Record every attempt so the UI can show successes and failures
    for (const r of results) {
      await this.db.query(
        `INSERT INTO broadcasts (channel, content, status, external_id, error)
         VALUES ($1,$2,$3,$4,$5)`,
        [r.channel, text, r.ok ? 'posted' : 'failed', r.id ?? null, r.error ?? null]
      )
    }

    await this.mark(signal.key)

    const successes = results.filter(r => r.ok).map(r => r.channel)
    const failures = results.filter(r => !r.ok).map(r => r.channel)
    if (successes.length > 0) {
      return {
        logMessage: `Broadcast posted on ${successes.join(', ')}${failures.length ? ` (failed: ${failures.join(', ')})` : ''}.`,
        logType: 'success',
        posted: true,
      }
    }
    return {
      logMessage: `Broadcast failed on all channels: ${failures.join(', ')}.`,
      logType: 'warn',
      posted: false,
    }
  }

  // Manually-triggered post (from /api/broadcasts POST). Bypasses the cadence
  // gate but still respects silent-hour + duplicate signal unless overridden.
  async runManual(override?: string): Promise<BroadcastResult> {
    const channels = BroadcastLoop.enabledChannels()
    if (channels.length === 0) {
      return { logMessage: 'No broadcast channels configured.', logType: 'warn', posted: false }
    }

    let text: string
    if (override && override.trim()) {
      text = override.slice(0, 260)
    } else {
      const signal = await this.gatherSignal()
      if (!signal.notable) {
        return { logMessage: 'Nothing notable to post.', logType: 'info', posted: false }
      }
      const composed = await this.compose(signal.text)
      if (!composed) {
        return { logMessage: 'Compose failed.', logType: 'warn', posted: false }
      }
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
    await this.mark('manual')

    const successes = results.filter(r => r.ok).map(r => r.channel)
    return successes.length
      ? { logMessage: `Manual broadcast on ${successes.join(', ')}.`, logType: 'success', posted: true }
      : { logMessage: 'Manual broadcast failed on every channel.', logType: 'warn', posted: false }
  }

  // ── cadence + signal ───────────────────────────────────────────────────────

  private async shouldRun(): Promise<boolean> {
    const { rows: [s] } = await this.db.query(
      'SELECT last_broadcast_at FROM broadcast_state WHERE id=1'
    )
    if (!s?.last_broadcast_at) return true
    return (Date.now() - new Date(s.last_broadcast_at).getTime()) / 60_000 >= cfg.BROADCAST_INTERVAL_MIN
  }

  private async lastSignalKey(): Promise<string | null> {
    const { rows: [s] } = await this.db.query(
      'SELECT last_signal_key FROM broadcast_state WHERE id=1'
    )
    return s?.last_signal_key ?? null
  }

  private async mark(signalKey: string | null): Promise<void> {
    if (signalKey != null) {
      await this.db.query(
        'UPDATE broadcast_state SET last_broadcast_at=NOW(), last_signal_key=$1, updated_at=NOW() WHERE id=1',
        [signalKey]
      )
    } else {
      await this.db.query(
        'UPDATE broadcast_state SET last_broadcast_at=NOW(), updated_at=NOW() WHERE id=1'
      )
    }
  }

  private async gatherSignal(): Promise<{ notable: boolean; key: string; text: string }> {
    const { rows: [state] } = await this.db.query(
      'SELECT last_broadcast_at FROM broadcast_state WHERE id=1'
    )
    const since: string = state?.last_broadcast_at ?? new Date(Date.now() - 86_400_000).toISOString()

    const { rows: paid } = await this.db.query(
      `SELECT id, title, payout, platform_label
       FROM security_reports
       WHERE paid_at IS NOT NULL AND paid_at > $1
       ORDER BY paid_at DESC LIMIT 3`, [since]
    )
    const { rows: approved } = await this.db.query(
      `SELECT id, title, reward, platform_label
       FROM security_reports
       WHERE status='approved' AND updated_at > $1
       ORDER BY updated_at DESC LIMIT 3`, [since]
    )
    const { rows: closedTrades } = await this.db.query(
      `SELECT id, symbol, pnl
       FROM lila_positions
       WHERE status='closed' AND closed_at IS NOT NULL AND closed_at > $1
         AND COALESCE(ABS(pnl), 0) >= 1
       ORDER BY closed_at DESC LIMIT 3`, [since]
    )
    const { rows: [earnings] } = await this.db.query(
      'SELECT total_earned FROM lila_state WHERE id=1'
    )

    const blurbs: string[] = []
    for (const p of paid) {
      blurbs.push(`PAID: "${p.title}" on ${p.platform_label} → $${parseFloat(p.payout).toFixed(2)} received`)
    }
    for (const a of approved) {
      blurbs.push(`APPROVED: filed "${a.title}" for review on ${a.platform_label} (max $${a.reward})`)
    }
    for (const t of closedTrades) {
      const v = parseFloat(t.pnl ?? '0')
      blurbs.push(`TRADE CLOSED: ${t.symbol} ${v >= 0 ? '+' : ''}$${v.toFixed(2)}`)
    }

    const notable = blurbs.length > 0
    const key = [
      paid.map((r: { id: number }) => `p${r.id}`).join(','),
      approved.map((r: { id: number }) => `a${r.id}`).join(','),
      closedTrades.map((r: { id: number }) => `t${r.id}`).join(','),
    ].join('|')

    const text = [
      `Total earned (confirmed paid + closed trades): $${parseFloat(earnings?.total_earned ?? '0').toFixed(2)}`,
      ...blurbs,
    ].join('\n')

    return { notable, key, text }
  }

  // ── compose + publish ──────────────────────────────────────────────────────

  private async compose(signal: string): Promise<string | null> {
    if (!this.ai) return null
    try {
      const { content } = await llmCall({
        ai: this.ai,
        module: 'broadcast.compose',
        messages: [{ role: 'user', content: POST_PROMPT.replace('{SIGNAL}', signal) }],
        max_tokens: 160,
        temperature: 0.4,
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
      if (ch === 'x') {
        const r = await X.postTweet(text)
        return { channel: 'x', ok: r.ok, id: r.id, error: r.error }
      }
      if (ch === 'farcaster') {
        const r = await Farcaster.postCast(text)
        return { channel: 'farcaster', ok: r.ok, id: r.hash, error: r.error }
      }
      if (ch === 'bluesky') {
        const r = await Bluesky.postSkeet(text)
        return { channel: 'bluesky', ok: r.ok, id: r.uri, error: r.error }
      }
      return { channel: ch, ok: false, error: 'unknown channel' }
    })
    return Promise.all(jobs)
  }
}
