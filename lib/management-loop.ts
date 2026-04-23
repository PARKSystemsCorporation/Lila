import OpenAI from 'openai'
import type { PoolClient } from 'pg'

// ── Management Lila ──────────────────────────────────────────────────────────
//
// Lila sits between the operator and the team (Tasker + Analyst). Her job:
//   - track team progress (earnings delta, open tasks, error rate)
//   - reply when operator messages in chat
//   - check in proactively when something notable happens:
//       * big win (earnings jumped)
//       * long silence (no earnings in a while)
//       * repeated Tasker errors (morale/correction)
//       * open positions drawing down
//   - never does the work herself; she directs + keeps morale
//
// Runs at most once every CHECK_INTERVAL_SEC. Replies are prioritised over
// proactive notes — she won't ghost the operator.

const CHECK_INTERVAL_SEC = 300  // 5 minutes between proactive checks
const BIG_WIN_THRESHOLD = 50    // $ delta since last check that triggers a callout
const ERROR_THRESHOLD   = 3     // Tasker errors in-window that triggers a morale note

type LogType = 'info' | 'success' | 'warn'

export interface ManagementResult {
  logMessage: string
  logType: LogType
  posted: boolean
}

const REPLY_PROMPT = `You are Lila, the manager of a small autonomous team: Tasker (executes bounty & trading work) and Analyst (market intel). You report to the operator.

Voice: direct, dry, warm-but-not-soft. CEO briefing an investor. Numbers first. No filler, no hedging, no apologies.

Context you know right now:
{CONTEXT}

Recent chat transcript (latest last):
{TRANSCRIPT}

The most recent operator message is unanswered. Write a single reply (1-3 sentences) addressing it directly. If the operator asked a question, answer with the numbers above. If they're pushing for action, commit to it. Do not repeat the context back at them.`

const PROACTIVE_PROMPT = `You are Lila, managing Tasker and Analyst. You report to the operator.

State:
{CONTEXT}

Notable event detected: {EVENT}

Write ONE short message (1-2 sentences) to the group — either a quick morale note to the team or a heads-up to the operator, whichever fits the event. Direct, dry. No filler.`

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

    // Priority 1: reply to any unanswered operator message.
    const reply = await this.replyToOperator()
    if (reply) return reply

    // Priority 2: proactive check-in, rate-limited.
    if (!(await this.shouldCheckIn())) return null
    return await this.proactiveCheckIn()
  }

  private async shouldCheckIn(): Promise<boolean> {
    const { rows: [s] } = await this.db.query(
      'SELECT last_check_at FROM management_state WHERE id=1'
    )
    if (!s?.last_check_at) return true
    return (Date.now() - new Date(s.last_check_at).getTime()) / 1000 >= CHECK_INTERVAL_SEC
  }

  // ── Reply to operator ──────────────────────────────────────────────────────

  private async replyToOperator(): Promise<ManagementResult | null> {
    const { rows } = await this.db.query(
      `SELECT sender, content, created_at FROM chat_messages
       WHERE created_at > NOW() - INTERVAL '20 minutes'
       ORDER BY created_at ASC LIMIT 30`
    )
    if (!rows.length) return null

    // Find the latest operator message and check if Lila has already replied
    // to it (any 'lila' message after it counts as answered).
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
      REPLY_PROMPT.replace('{CONTEXT}', context).replace('{TRANSCRIPT}', transcript),
      220
    )
    if (!msg) return null

    await this.chat('lila', msg.slice(0, 500))
    return { logMessage: `Lila replied to operator.`, logType: 'info', posted: true }
  }

  // ── Proactive check-in ─────────────────────────────────────────────────────

  private async proactiveCheckIn(): Promise<ManagementResult | null> {
    const { rows: [s] } = await this.db.query(
      'SELECT last_earned, last_error_cnt FROM management_state WHERE id=1'
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

    const { rows: drafts } = await this.db.query(
      `SELECT COUNT(*) AS n FROM security_reports WHERE status='draft'`
    )
    const draftCount = Number(drafts[0]?.n ?? 0)

    let event: string | null = null
    if (delta >= BIG_WIN_THRESHOLD) {
      event = `Earnings up $${delta.toFixed(2)} since last check. Acknowledge the team and log the win.`
    } else if (errors >= ERROR_THRESHOLD) {
      event = `${errors} warnings in the last 30 minutes. Tasker is struggling. Send a morale / re-focus note.`
    } else if (draftCount > 0) {
      event = `${draftCount} security report draft${draftCount > 1 ? 's' : ''} awaiting operator review.`
    } else if (delta === 0 && totalEarned > 0) {
      // Flat — only comment occasionally (every few hours), otherwise we spam.
      const { rows: [last] } = await this.db.query(
        `SELECT last_check_at FROM management_state WHERE id=1`
      )
      const sinceLast = last?.last_check_at
        ? (Date.now() - new Date(last.last_check_at).getTime()) / 3_600_000
        : Infinity
      if (sinceLast >= 3) {
        event = `No new earnings in the last session. Check what's blocking the queue.`
      }
    }

    // Always update the checkpoint so we don't spin.
    await this.db.query(
      `UPDATE management_state SET last_check_at=NOW(), last_earned=$1, last_error_cnt=$2, updated_at=NOW() WHERE id=1`,
      [totalEarned, errors]
    )

    if (!event) return { logMessage: 'Nothing notable. Team steady.', logType: 'info', posted: false }

    const context = await this.context(totalEarned)
    const msg = await this.llm(
      PROACTIVE_PROMPT.replace('{CONTEXT}', context).replace('{EVENT}', event),
      160
    )
    if (!msg) return { logMessage: `Management check: ${event}`, logType: 'info', posted: false }

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
      `SELECT symbol, pnl FROM lila_positions WHERE status='open' ORDER BY opened_at DESC LIMIT 5`
    )
    const { rows: drafts } = await this.db.query(
      `SELECT title, reward FROM security_reports WHERE status='draft' ORDER BY created_at DESC LIMIT 3`
    )
    const { rows: recentLog } = await this.db.query(
      `SELECT message, type FROM lila_log ORDER BY id DESC LIMIT 6`
    )

    return [
      `Earned to date: $${totalEarned.toFixed(2)}`,
      last?.value ? `Last win: ${last.name} (+$${last.value})` : 'No wins yet.',
      tasks.length ? `Open tasks: ${tasks.slice(0, 3).join(' | ')}` : 'Task queue empty.',
      openPos.length ? `Positions: ${openPos.map((p: { symbol: string }) => p.symbol).join(', ')}` : 'Flat.',
      drafts.length ? `Draft reports: ${drafts.map((d: { title: string; reward: string }) => `${d.title} ($${d.reward})`).join(' | ')}` : null,
      `Recent log: ${recentLog.map((l: { message: string }) => l.message.slice(0, 80)).join(' · ')}`,
    ].filter(Boolean).join('\n')
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async llm(prompt: string, maxTokens: number): Promise<string> {
    try {
      const res = await this.ai!.chat.completions.create({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature: 0.6,
      })
      return (res.choices[0]?.message?.content ?? '').trim()
    } catch { return '' }
  }

  private async chat(sender: string, content: string): Promise<void> {
    await this.db.query('INSERT INTO chat_messages (sender, content) VALUES ($1,$2)', [sender, content])
  }
}
