import OpenAI from 'openai'
import type { PoolClient } from 'pg'
import * as Alpaca from './platforms/alpaca'
import { llmCall, LLMBudgetExceeded } from './llm'
import { cfg } from './config'

// ── Management Lila ──────────────────────────────────────────────────────────
//
// Lila handles the high-stakes work on top of Tasker's bounty grind:
//   1. Operator replies    — direct-line responses in chat
//   2. Report review       — vets Tasker's pending_review reports before the
//                            operator sees anything (approve / reject with notes)
//   3. Trade cycle         — her own trading decisions, every ~15 min:
//                            review Analyst notes, file plan with tight stops,
//                            close/trim open positions, post update
//   4. Proactive check-in  — morale / flags / wins, every ~5 min
//
// Each run returns after the first priority that fires, keeping token cost
// bounded. She never ticks unprompted — work must be there.

const BIG_WIN_THRESHOLD = 50
const ERROR_THRESHOLD   = 3

type LogType = 'info' | 'success' | 'warn'

export interface ManagementResult {
  logMessage: string
  logType: LogType
  posted: boolean
}

const REPLY_PROMPT = `You are Lila, the manager of a small autonomous team: Tasker (bounty executor) and Analyst (market intel). You report to the operator.

Voice: direct, dry, warm-but-not-soft. CEO briefing an investor. Numbers first. No filler, no hedging, no apologies.

Team state right now:
{CONTEXT}

Recent chat (latest last):
{TRANSCRIPT}

The most recent operator message is unanswered. Write a single reply (1-3 sentences) addressing it directly. Use the numbers above. If they're pushing for action, commit to it. Don't repeat the context back at them.`

const PROACTIVE_PROMPT = `You are Lila, managing Tasker and Analyst. Report to the operator.

State:
{CONTEXT}

Notable event: {EVENT}

Write ONE short message (1-2 sentences) — morale note to the team or heads-up to the operator, whichever fits. Direct, dry.`

const REVIEW_PROMPT = `You are Lila reviewing a security-bug report Tasker just drafted. Before it reaches the operator it passes through you. Your job is to catch fabrication, overreach, and unjustified severity.

Bounty: {TITLE} · ${'${REWARD}'} on {PLATFORM}

Tasker's report:
---
{REPORT}
---

Evaluate:
1. Is the finding concrete — does it reference a real component/function and a real failure mode?
2. Is severity justified? Critical/High needs a direct asset-loss path.
3. Is the PoC plausible? Obvious hand-waving or "this could potentially allow" language is a red flag.
4. Any obvious fabrication (invented function names, invented code)?

Respond with ONLY valid JSON:
{
  "decision": "approve" | "reject",
  "confidence": 0.0-1.0,
  "notes": "one sentence for the operator"
}

Approve only if you'd be comfortable submitting this yourself. Reject with the actual reason. No "looks good to me" — give a reason either way.`

const TRADE_PLAN_PROMPT = `You are Lila, running the trading desk. Write today's plan based on Analyst output and current positions.

Analyst notes (recent):
{NOTES}

Analyst pending picks:
{PICKS}

Open positions:
{POSITIONS}

Rules:
- Long only.
- Sizing is agnostic; small-account trades are fine.
- Every trade MUST have a TIGHT stop (close to entry, tight enough that a single bad candle takes you out, not a 7% stop).
- Be aggressive cutting losers. Let winners run only if thesis holds.

Respond with ONLY valid JSON:
{
  "stance": "1-2 sentence read on the market and your posture today",
  "trades": [{"symbol":"XYZ","entry":12.34,"target":13.20,"stop":12.10,"confidence":0.7,"reason":"one sentence"}],
  "positionActions": [{"symbol":"XYZ","action":"HOLD|CLOSE","reason":"one sentence"}]
}`

function today() { return new Date().toISOString().slice(0, 10) }

export class ManagementLoop {
  private db: PoolClient
  private ai: OpenAI | null

  constructor(db: PoolClient) {
    this.db = db
    this.ai = process.env.DEEPSEEK_API_KEY
      ? new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com/v1' })
      : null
  }

  async run(): Promise<ManagementResult | null> {
    if (!this.ai) return null

    // Priority 1: reply to unanswered operator message
    const reply = await this.replyToOperator()
    if (reply) return reply

    // Priority 2: review any pending_review report (one per run)
    const review = await this.reviewOne()
    if (review) return review

    // Priority 3: trade cycle, 15-min gated
    if (await this.shouldTrade()) {
      const trade = await this.runTradeCycle()
      if (trade) return trade
    }

    // Priority 4: proactive check-in, 5-min gated
    if (!(await this.shouldCheckIn())) return null
    return await this.proactiveCheckIn()
  }

  // ── Priority 1: operator reply ─────────────────────────────────────────────

  private async replyToOperator(): Promise<ManagementResult | null> {
    const { rows } = await this.db.query(
      `SELECT sender, content, created_at FROM chat_messages
       WHERE created_at > NOW() - INTERVAL '20 minutes'
       ORDER BY created_at ASC LIMIT 30`
    )
    if (!rows.length) return null

    let lastUserIdx = -1
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].sender === 'user') { lastUserIdx = i; break }
    }
    if (lastUserIdx === -1) return null

    const lilaRepliedAfter = rows.slice(lastUserIdx + 1).some(r => r.sender === 'lila')
    if (lilaRepliedAfter) return null

    const context = await this.context()
    const transcript = rows
      .map((m: { sender: string; content: string }) => `[${m.sender.toUpperCase()}]: ${m.content}`)
      .join('\n')

    const msg = await this.llm(
      'lila.reply',
      REPLY_PROMPT.replace('{CONTEXT}', context).replace('{TRANSCRIPT}', transcript),
      220
    )
    if (!msg) return null

    await this.chat('lila', msg.slice(0, 500))
    return { logMessage: 'Lila replied to operator.', logType: 'info', posted: true }
  }

  // ── Priority 2: report review ──────────────────────────────────────────────

  private async reviewOne(): Promise<ManagementResult | null> {
    const { rows } = await this.db.query(
      `SELECT id, title, reward, platform_label, content
       FROM security_reports
       WHERE status='pending_review'
       ORDER BY created_at ASC LIMIT 1`
    )
    if (!rows.length) return null

    const r = rows[0]
    const raw = await this.llm(
      'lila.review',
      REVIEW_PROMPT
        .replace('{TITLE}', r.title)
        .replace('{REWARD}', String(r.reward))
        .replace('{PLATFORM}', r.platform_label)
        .replace('{REPORT}', String(r.content).slice(0, 6000)),
      250
    )
    const parsed = this.parse<{ decision: 'approve' | 'reject'; confidence: number; notes: string }>(
      raw, { decision: 'reject', confidence: 0, notes: 'Review returned no parseable verdict.' }
    )

    const newStatus = parsed.decision === 'approve' ? 'approved' : 'rejected'
    const notes = String(parsed.notes ?? '').slice(0, 500)

    await this.db.query(
      `UPDATE security_reports
         SET status=$1, review_notes=$2, confidence=$3, updated_at=NOW()
       WHERE id=$4`,
      [newStatus, notes, Math.min(Math.max(parsed.confidence ?? 0, 0), 1), r.id]
    )

    if (newStatus === 'approved') {
      await this.chat(
        'lila',
        `Approved report: "${r.title}" — $${r.reward} on ${r.platform_label}. ${notes} Ready in the Reports tab.`
      )
    } else {
      await this.chat(
        'lila',
        `Rejected Tasker's draft on "${r.title}". ${notes}`
      )
    }

    return {
      logMessage: `Lila ${newStatus} "${r.title}" — ${notes.slice(0, 80)}`,
      logType: newStatus === 'approved' ? 'success' : 'warn',
      posted: true,
    }
  }

  // ── Priority 3: trade cycle ────────────────────────────────────────────────

  private async shouldTrade(): Promise<boolean> {
    const { rows: [s] } = await this.db.query(
      'SELECT last_trade_at FROM management_state WHERE id=1'
    )
    if (!s?.last_trade_at) return true
    return (Date.now() - new Date(s.last_trade_at).getTime()) / 1000 >= cfg.MANAGEMENT_TRADE_SEC
  }

  private async runTradeCycle(): Promise<ManagementResult | null> {
    const hasAlpaca = !!(process.env.ALPACA_API_KEY || process.env.APCA_API_KEY_ID)

    await this.db.query(
      'UPDATE management_state SET last_trade_at=NOW(), updated_at=NOW() WHERE id=1'
    )

    if (!hasAlpaca) {
      return { logMessage: 'Trade cycle skipped — no Alpaca key.', logType: 'info', posted: false }
    }

    // Gather context
    const { rows: notes } = await this.db.query(
      `SELECT path, content FROM analyst_notes
       WHERE updated_at > NOW() - INTERVAL '24 hours'
       ORDER BY updated_at DESC LIMIT 10`
    )
    const { rows: picks } = await this.db.query(
      `SELECT symbol, confidence, reason FROM analyst_picks
       WHERE status='pending' AND created_at > NOW() - INTERVAL '24 hours'
       ORDER BY confidence DESC LIMIT 10`
    )
    const positions = await Alpaca.getPositions().catch(() => [] as Alpaca.AlpacaPosition[])

    const notesBlob = notes.length
      ? notes.map((n: { path: string; content: string }) => `=== ${n.path} ===\n${n.content.slice(0, 300)}`).join('\n\n')
      : '(none)'
    const picksBlob = picks.length
      ? picks.map((p: { symbol: string; confidence: string; reason: string }) =>
          `${p.symbol} conf=${p.confidence} — ${p.reason}`).join('\n')
      : '(none)'
    const posBlob = positions.length
      ? positions.map(p =>
          `${p.symbol} qty=${p.qty} entry=$${parseFloat(p.avg_entry_price).toFixed(2)} now=$${parseFloat(p.current_price).toFixed(2)} pl=${(parseFloat(p.unrealized_plpc) * 100).toFixed(1)}%`
        ).join('\n')
      : '(flat)'

    const raw = await this.llm(
      'lila.trade',
      TRADE_PLAN_PROMPT
        .replace('{NOTES}', notesBlob)
        .replace('{PICKS}', picksBlob)
        .replace('{POSITIONS}', posBlob),
      700
    )
    const plan = this.parse(raw, {
      stance: 'No change.',
      trades: [] as LilaTrade[],
      positionActions: [] as { symbol: string; action: string; reason: string }[],
    })

    // File plan
    await this.note(
      `lila/plans/${today()}-${Date.now()}.md`,
      `# Lila Plan ${today()}\n\n## Stance\n${plan.stance}\n\n## Trades\n${JSON.stringify(plan.trades ?? [], null, 2)}\n\n## Position actions\n${JSON.stringify(plan.positionActions ?? [], null, 2)}`
    )

    // Queue new trades (TradingEngine will execute during market hours)
    let queued = 0
    for (const t of plan.trades ?? []) {
      if (!t.symbol || !t.entry || !t.stop || !t.target) continue
      if (t.stop >= t.entry) continue
      await this.db.query(
        `INSERT INTO analyst_picks
           (symbol, direction, entry_price, target_price, stop_loss, confidence, risk_level, reason, asset_class, status)
         VALUES ($1,'long',$2,$3,$4,$5,'tight',$6,'lila-plan','pending')`,
        [t.symbol.toUpperCase(), t.entry, t.target, t.stop, Math.min(Math.max(t.confidence ?? 0.6, 0), 1), t.reason ?? 'Lila plan']
      )
      queued++
    }

    // Close positions she wants out
    let closed = 0
    for (const a of plan.positionActions ?? []) {
      if (a.action !== 'CLOSE') continue
      const ok = await Alpaca.closePosition(a.symbol).catch(() => false)
      if (!ok) continue
      const pos = positions.find(p => p.symbol === a.symbol)
      const pnl = pos ? parseFloat(pos.unrealized_pl) : 0
      await this.db.query(
        `UPDATE lila_positions SET status='closed', pnl=$1, closed_at=NOW()
         WHERE symbol=$2 AND status='open'`,
        [pnl, a.symbol]
      )
      if (pnl > 0) {
        await this.db.query('UPDATE lila_state SET total_earned=total_earned+$1 WHERE id=1', [pnl])
      }
      closed++
    }

    const summary = [
      plan.stance.slice(0, 140),
      queued > 0 ? `${queued} new trade${queued === 1 ? '' : 's'} queued.` : null,
      closed > 0 ? `Cut ${closed} position${closed === 1 ? '' : 's'}.` : null,
    ].filter(Boolean).join(' ')

    await this.chat('lila', summary.slice(0, 500))
    return {
      logMessage: `Lila trade cycle: ${queued} queued, ${closed} closed.`,
      logType: queued + closed > 0 ? 'success' : 'info',
      posted: true,
    }
  }

  // ── Priority 4: proactive check-in ─────────────────────────────────────────

  private async shouldCheckIn(): Promise<boolean> {
    const { rows: [s] } = await this.db.query(
      'SELECT last_check_at FROM management_state WHERE id=1'
    )
    if (!s?.last_check_at) return true
    return (Date.now() - new Date(s.last_check_at).getTime()) / 1000 >= cfg.MANAGEMENT_CHECK_SEC
  }

  private async proactiveCheckIn(): Promise<ManagementResult | null> {
    const { rows: [s] } = await this.db.query(
      'SELECT last_earned FROM management_state WHERE id=1'
    )
    const { rows: [state] } = await this.db.query(
      'SELECT total_earned FROM lila_state WHERE id=1'
    )
    const totalEarned = parseFloat(state?.total_earned ?? '0')
    const lastEarned  = parseFloat(s?.last_earned ?? '0')
    const delta       = totalEarned - lastEarned

    const { rows: errCount } = await this.db.query(
      `SELECT COUNT(*) AS n FROM lila_log
       WHERE type='warn' AND created_at > NOW() - INTERVAL '30 minutes'`
    )
    const errors = Number(errCount[0]?.n ?? 0)

    const { rows: approved } = await this.db.query(
      `SELECT COUNT(*) AS n FROM security_reports WHERE status='approved'`
    )
    const approvedCount = Number(approved[0]?.n ?? 0)

    // Count reports newly paid this window — that's a REAL win.
    const { rows: paidWindow } = await this.db.query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(payout), 0) AS total
       FROM security_reports
       WHERE paid_at IS NOT NULL
         AND paid_at > COALESCE(
           (SELECT last_check_at FROM management_state WHERE id=1),
           NOW() - INTERVAL '1 hour'
         )`
    )
    const paidN = Number(paidWindow[0]?.n ?? 0)
    const paidTotal = parseFloat(paidWindow[0]?.total ?? '0')

    let event: string | null = null
    if (paidN > 0) {
      event = `${paidN} bounty payout${paidN > 1 ? 's' : ''} confirmed: +$${paidTotal.toFixed(2)}. Real money in. Acknowledge.`
    } else if (delta >= BIG_WIN_THRESHOLD) {
      // Trading P&L (position closed at profit) is the only other path that
      // increments total_earned. Report it as trading, not "earnings".
      event = `Trading P&L up $${delta.toFixed(2)} since last check (closed position).`
    } else if (errors >= ERROR_THRESHOLD) {
      event = `${errors} warnings in the last 30 minutes. Tasker may be stuck.`
    } else if (approvedCount > 0) {
      event = `${approvedCount} approved report${approvedCount > 1 ? 's' : ''} ready for operator to submit. Still unpaid — not earnings yet.`
    } else if (delta === 0 && totalEarned > 0) {
      const { rows: [last] } = await this.db.query(
        `SELECT last_check_at FROM management_state WHERE id=1`
      )
      const hrs = last?.last_check_at
        ? (Date.now() - new Date(last.last_check_at).getTime()) / 3_600_000
        : Infinity
      if (hrs >= 3) event = 'No new earnings in a while. Probe what is blocking the queue.'
    }

    await this.db.query(
      `UPDATE management_state SET last_check_at=NOW(), last_earned=$1, last_error_cnt=$2, updated_at=NOW() WHERE id=1`,
      [totalEarned, errors]
    )

    if (!event) return { logMessage: 'Nothing notable.', logType: 'info', posted: false }

    const context = await this.context(totalEarned)
    const msg = await this.llm(
      'lila.proactive',
      PROACTIVE_PROMPT.replace('{CONTEXT}', context).replace('{EVENT}', event),
      160
    )
    if (!msg) return { logMessage: `Check-in: ${event}`, logType: 'info', posted: false }

    await this.chat('lila', msg.slice(0, 500))
    return { logMessage: `Lila check-in: ${event.slice(0, 80)}`, logType: 'success', posted: true }
  }

  // ── Context builder ────────────────────────────────────────────────────────

  private async context(totalEarnedOverride?: number): Promise<string> {
    const { rows: [ls] } = await this.db.query(
      'SELECT total_earned, active_tasks, last_bounty FROM lila_state WHERE id=1'
    )
    const totalEarned = totalEarnedOverride ?? parseFloat(ls?.total_earned ?? '0')
    const tasks: string[] = ls?.active_tasks ?? []
    const last = ls?.last_bounty

    const { rows: openPos } = await this.db.query(
      `SELECT symbol FROM lila_positions WHERE status='open' LIMIT 5`
    )
    const { rows: approvedDrafts } = await this.db.query(
      `SELECT title, reward FROM security_reports WHERE status='approved' ORDER BY updated_at DESC LIMIT 3`
    )
    const { rows: reviewQueue } = await this.db.query(
      `SELECT COUNT(*) AS n FROM security_reports WHERE status='pending_review'`
    )
    const pendingCount = Number(reviewQueue[0]?.n ?? 0)
    const { rows: submittedRows } = await this.db.query(
      `SELECT COUNT(*) AS n, COALESCE(SUM(reward), 0) AS max_pending
       FROM security_reports WHERE status='submitted'`
    )
    const submittedCount = Number(submittedRows[0]?.n ?? 0)
    const submittedMax = parseFloat(submittedRows[0]?.max_pending ?? '0')
    const { rows: [lastPaid] } = await this.db.query(
      `SELECT title, payout FROM security_reports
       WHERE status='paid' ORDER BY paid_at DESC LIMIT 1`
    )
    const { rows: recentLog } = await this.db.query(
      `SELECT message FROM lila_log ORDER BY id DESC LIMIT 5`
    )

    return [
      `Earned (confirmed paid + closed-trade P&L): $${totalEarned.toFixed(2)}`,
      lastPaid ? `Last payout: ${lastPaid.title} +$${parseFloat(lastPaid.payout ?? '0').toFixed(2)}` : 'No confirmed payouts yet.',
      submittedCount ? `Pending payouts: ${submittedCount} up to $${submittedMax.toFixed(2)} max (NOT yet earned).` : null,
      tasks.length ? `Tasks: ${tasks.slice(0, 3).join(' | ')}` : 'No open tasks.',
      openPos.length ? `Positions: ${openPos.map((p: { symbol: string }) => p.symbol).join(', ')}` : 'Flat.',
      approvedDrafts.length
        ? `Approved reports waiting for operator submit: ${approvedDrafts.map((d: { title: string; reward: string }) => `${d.title} (max $${d.reward})`).join(' | ')}`
        : null,
      pendingCount ? `My review queue: ${pendingCount}` : null,
      `Recent: ${recentLog.map((l: { message: string }) => l.message.slice(0, 70)).join(' · ')}`,
    ].filter(Boolean).join('\n')
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async llm(module: string, prompt: string, maxTokens: number): Promise<string> {
    try {
      const { content } = await llmCall({
        ai: this.ai!,
        module,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature: 0.5,
      })
      return content
    } catch (e) {
      if (e instanceof LLMBudgetExceeded) return ''
      return ''
    }
  }

  private parse<T>(raw: string, fallback: T): T {
    try { return JSON.parse(raw) } catch { return fallback }
  }

  private async note(path: string, content: string): Promise<void> {
    await this.db.query(
      `INSERT INTO analyst_notes (path, content, updated_at) VALUES ($1,$2,NOW())
       ON CONFLICT (path) DO UPDATE SET content=$2, updated_at=NOW()`,
      [path, content]
    )
  }

  private async chat(sender: string, content: string): Promise<void> {
    await this.db.query('INSERT INTO chat_messages (sender, content) VALUES ($1,$2)', [sender, content])
  }
}

interface LilaTrade {
  symbol: string
  entry: number
  target: number
  stop: number
  confidence?: number
  reason?: string
}
