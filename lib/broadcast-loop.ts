import OpenAI from 'openai'
import type { PoolClient } from 'pg'
import { llmCall, LLMBudgetExceeded } from './llm'
import { cfg } from './config'
import * as Bluesky from './channels/bluesky'
import * as Telegram from './channels/telegram'
import * as Alpaca from './platforms/alpaca'

// Market quant context: tickers Vega tracks. Same list as analyst-loop's
// WATCHLIST so the broadcast pulls from the same universe Vega scans.
const QUANT_WATCHLIST = [
  // commodity ETFs
  'GLD', 'SLV', 'USO', 'GDX', 'UNG', 'CPER', 'PDBC',
  // leveraged index
  'SPXL', 'TQQQ', 'UPRO', 'QLD', 'SOXL',
  // global macro
  'TLT', 'HYG', 'UUP', 'EEM', 'EFA', 'FXI', 'EWJ', 'VWO',
]

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

const POST_PROMPT = `You are Lila posting market commentary on Bluesky. Market-only feed.

Voice: dry, numbers-first, quant-trained. No hashtags, no emojis, no exclamation points. Not a marketer, not a finfluencer. 2-3 short sentences max. Under 260 characters total.

REQUIRED — every post is one of these, anchored to specific tickers + numbers from the LIVE DATA below:
- Quant read on a ticker or pair (level vs SMA, momentum, vol regime, divergence).
- Commodity / macro / cross-asset thesis grounded in the data.
- Trade-idea sketch (ticker, side, why) — view, not advice.
- Post-mortem of a closed trade in the data.

ABSOLUTELY FORBIDDEN. Posts containing any of this will be rejected:
- Words like: protocols, watchlist (in the security sense), reports, queue, awaiting submit, payouts, bounties, research targets, cycles, phases, pipeline, "X reports in queue", "no payouts today". Internal ops state has zero place on the market feed.
- Generic platitudes ("stay sharp", "risk on", "interesting tape"). Every post must name a ticker or a specific level / move.
- Inventing data not present below.

If the live data is too thin to support a real take, output the single word \`SKIP\` and nothing else. Skipping is far better than fluff.

LIVE DATA (use only this — do not invent beyond it):
{CONTEXT}

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
      // Substance gate or model-side SKIP — silent skip, mark cycle done so
      // we don't retry until the next interval. Better than spamming slop.
      await this.mark()
      return { logMessage: 'Broadcast skipped — no substantive market data this hour.', logType: 'info', posted: false }
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
      // Cancel any queued post that matches the old ops-status pattern.
      // Defense in depth — the new compose path filters these, but legacy
      // queued rows from before the prompt change should die quietly.
      if (looksLikeOpsContent(text)) {
        await this.db.query(
          `UPDATE broadcasts
             SET status = 'cancelled',
                 error  = 'cancelled: ops-status content not allowed on market feed'
           WHERE id = $1`,
          [Number(row.id)]
        )
        continue
      }
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

    // Live quant data on the watchlist tickers. Free via Alpaca's bars API
    // and gives the LLM something concrete to riff on even when Vega has
    // written no notes (offseason / pre-market / quiet day).
    const bars = await Alpaca.getBars(QUANT_WATCHLIST, 25).catch(() => [] as Alpaca.BarData[])

    const lines: string[] = []

    if (bars.length > 0) {
      lines.push('LIVE QUANT (price · 20d SMA · 5d momentum · vol vs avg):')
      for (const b of bars) {
        const mom = `${b.momentum >= 0 ? '+' : ''}${b.momentum.toFixed(1)}%`
        const vol = `${b.volumeRatio.toFixed(2)}x`
        const vsSma = b.sma20 > 0 ? `${b.price >= b.sma20 ? '>' : '<'}sma` : ''
        lines.push(`  ${b.symbol}: $${b.price.toFixed(2)} sma20=$${b.sma20.toFixed(2)} mom=${mom} vol=${vol} ${vsSma}`)
      }
    }

    if (notes.rows.length > 0) {
      lines.push('VEGA NOTES (latest market reads):')
      for (const n of notes.rows) {
        const body = String(n.content ?? '').slice(0, 600).replace(/\s+/g, ' ').trim()
        lines.push(`  [${n.path}] ${body}`)
      }
    }

    if (picks.rows.length > 0) {
      lines.push('VEGA PICKS:')
      for (const p of picks.rows) {
        const conf = p.confidence != null ? ` conf=${Number(p.confidence).toFixed(2)}` : ''
        const entry = p.entry_price != null ? ` entry=${p.entry_price}` : ''
        const tgt = p.target_price != null ? ` tgt=${p.target_price}` : ''
        const stop = p.stop_loss != null ? ` stop=${p.stop_loss}` : ''
        const why = p.reason ? ` — ${String(p.reason).slice(0, 200)}` : ''
        lines.push(`  ${p.symbol} ${p.direction}${entry}${tgt}${stop}${conf}${why}`)
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

    // Empty context = no Alpaca data and no Vega/Lila state. Caller will
    // skip composing rather than letting the LLM invent ops content.
    return lines.join('\n')
  }

  // Substance gate: don't compose a post if there's nothing real to say.
  private hasSubstance(context: string): boolean {
    return context.includes('LIVE QUANT')
        || context.includes('VEGA NOTES')
        || context.includes('VEGA PICKS')
        || context.includes('OPEN POSITIONS')
        || context.includes('CLOSED:')
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

  private async compose(context: string, _recent: string): Promise<string | null> {
    if (!this.ai) return null
    // Substance gate: bail before spending tokens if there's nothing to say.
    // Prevents the model from filling the void with ops-status hallucinations
    // (the "X reports in queue" failure mode).
    if (!this.hasSubstance(context)) return null
    try {
      const { content } = await llmCall({
        ai: this.ai,
        module: 'broadcast.compose',
        messages: [{
          role: 'user',
          content: POST_PROMPT.replace('{CONTEXT}', context),
        }],
        max_tokens: 160,
        temperature: 0.4,
      })
      const out = content.trim().slice(0, 280)
      if (!out) return null
      // Honor the model's own SKIP signal (we tell it to do this when
      // the data is too thin — better than fluff).
      if (/^skip\b/i.test(out)) return null
      // Reject any ops-status leak (defense in depth — the prompt forbids
      // these but if the model slips, we catch it here rather than posting).
      if (looksLikeOpsContent(out)) return null
      return out
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

// Defense-in-depth filter: if the model slips and produces ops-status
// content despite the prompt forbidding it, drop the post on the floor.
// Pattern matches the failure mode we've actually seen on the feed
// ("X protocols on watchlist", "X reports in queue", "awaiting submit",
// "no payouts or closed trades today").
function looksLikeOpsContent(text: string): boolean {
  const lower = text.toLowerCase()
  const banned = [
    'protocols on watchlist',
    'reports in queue',
    'awaiting submit',
    'no payouts',
    'cycle ',
    'phase ',
    'pipeline',
    'bounty queue',
    'research target',
  ]
  return banned.some(b => lower.includes(b))
}
