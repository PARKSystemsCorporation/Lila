import OpenAI from 'openai'
import type { PoolClient } from 'pg'
import { BountyEngine } from './bounty-engine'
import { fetchAllBounties, type UnifiedBounty } from './bounties-fetch'
import * as Alpaca from './platforms/alpaca'

// ── Tasker autonomy loop ──────────────────────────────────────────────────────
//
// The worker. Executes the plan Lila sets. Does NOT speak for the team —
// Management Lila owns operator replies. Tasker posts its own status updates
// to chat as sender='tasker' so Lila can read progress and the operator can
// watch raw execution.
//
// Bounty cycle (every step, 30s-gated):
//   BT0 — parse recent chat for operator-assigned tasks, queue them
//   BH0 — work the assigned/top-scored bounty (security-focused filter)
//   BZ0 — post an execution status update to the team chat
//
// Every 11 completed bounty cycles, run a trade check instead:
//   TT0 — review open positions, flag drawdowns
//   TT1 — read Analyst output, Tasker files a plan with tight stops, queues picks
//   TH0 — execute portfolio management (cut/hold) against Alpaca
//   TJ0 — post the trade update to chat

const STEP_INTERVAL_SEC = 30
const TRADE_CYCLE_EVERY = 11

export type TaskerStep = 'BT0' | 'BH0' | 'BZ0' | 'TT0' | 'TT1' | 'TH0' | 'TJ0'

type LogType = 'info' | 'success' | 'warn'

export interface TaskerStepResult {
  step: TaskerStep
  logMessage: string
  logType: LogType
}

const CHAT_PARSE_PROMPT = `You are Tasker, the executor on Lila's team. Read the recent chat transcript and extract any concrete tasks the operator or Lila (the manager) has assigned.

Respond with ONLY valid JSON — no preamble:
{ "tasks": ["task 1", "task 2"] }

Rules:
- Only include explicit assignments ("do X", "work on Y", "try Z"), not general commentary.
- Keep each task <= 70 chars, imperative form.
- Empty array if nothing actionable.`

const PLAN_PROMPT = `You are Tasker writing today's trade plan in 2 short sections:
1) "Stance" — 1-2 sentences on what changes vs last session.
2) "Trades" — JSON array of intended longs with TIGHT stops. Sizing is agnostic; stops must be close.

Respond with ONLY valid JSON:
{
  "stance": "one or two sentences",
  "trades": [{"symbol":"XYZ","entry":12.34,"target":13.20,"stop":12.10,"confidence":0.7,"reason":"one sentence"}]
}`

const PORTFOLIO_PROMPT = `You manage open positions. Decide HOLD, CLOSE, or TRIM for each. Be aggressive about cutting losers.

Respond with ONLY valid JSON:
{ "actions": [{"symbol":"X","action":"HOLD|CLOSE|TRIM","reason":"one sentence"}] }`

function today() { return new Date().toISOString().slice(0, 10) }

export class TaskerLoop {
  private db: PoolClient
  private ai: OpenAI | null

  constructor(db: PoolClient) {
    this.db = db
    this.ai = process.env.DEEPSEEK_API_KEY
      ? new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com/v1' })
      : null
  }

  async run(): Promise<TaskerStepResult | null> {
    if (!(await this.shouldRun())) return null

    const { rows: [s] } = await this.db.query(
      'SELECT step, turn_count FROM lila_loop_state WHERE id=1'
    )
    const step: TaskerStep = (s?.step as TaskerStep) ?? 'BT0'
    let turnCount: number = s?.turn_count ?? 0

    let result: { logMessage: string; logType: LogType }
    let next: TaskerStep

    try {
      switch (step) {
        case 'BT0': result = await this.bt0(); next = 'BH0'; break
        case 'BH0': result = await this.bh0(); next = 'BZ0'; break
        case 'BZ0': {
          result = await this.bz0()
          turnCount++
          if (turnCount >= TRADE_CYCLE_EVERY) { next = 'TT0'; turnCount = 0 }
          else next = 'BT0'
          break
        }
        case 'TT0': result = await this.tt0(); next = 'TT1'; break
        case 'TT1': result = await this.tt1(); next = 'TH0'; break
        case 'TH0': result = await this.th0(); next = 'TJ0'; break
        case 'TJ0': result = await this.tj0(); next = 'BT0'; break
      }
    } catch (e) {
      await this.advance(step, turnCount)
      return { step, logMessage: `Tasker ${step} error: ${String(e)}`, logType: 'warn' }
    }

    await this.advance(next, turnCount)
    return { step, logMessage: `Tasker ${step}: ${result.logMessage}`, logType: result.logType }
  }

  private async shouldRun(): Promise<boolean> {
    const { rows: [s] } = await this.db.query('SELECT last_step_at FROM lila_loop_state WHERE id=1')
    if (!s?.last_step_at) return true
    return (Date.now() - new Date(s.last_step_at).getTime()) / 1000 >= STEP_INTERVAL_SEC
  }

  private async advance(step: TaskerStep, turnCount: number): Promise<void> {
    await this.db.query(
      'UPDATE lila_loop_state SET step=$1, turn_count=$2, last_step_at=NOW(), updated_at=NOW() WHERE id=1',
      [step, turnCount]
    )
  }

  // ── BT0 — parse chat for assigned tasks ────────────────────────────────────

  private async bt0(): Promise<{ logMessage: string; logType: LogType }> {
    if (!this.ai) return { logMessage: 'Skipped — no LLM key.', logType: 'info' }

    const { rows } = await this.db.query(
      `SELECT sender, content FROM chat_messages
       WHERE created_at > NOW() - INTERVAL '15 minutes'
       ORDER BY created_at ASC LIMIT 25`
    )
    if (!rows.length) return { logMessage: 'Chat clear.', logType: 'info' }

    const transcript = rows
      .map((m: { sender: string; content: string }) => `[${m.sender.toUpperCase()}]: ${m.content}`)
      .join('\n')

    const raw = await this.llm(`${CHAT_PARSE_PROMPT}\n\nTranscript:\n${transcript}`, 200)
    const parsed = this.parse(raw, { tasks: [] as string[] })

    if (Array.isArray(parsed.tasks) && parsed.tasks.length) {
      await this.mergeTasks(parsed.tasks.slice(0, 5))
    }

    const taskCount = parsed.tasks?.length ?? 0
    return {
      logMessage: taskCount
        ? `Chat parsed. ${taskCount} new task${taskCount > 1 ? 's' : ''} queued.`
        : 'Chat parsed. Nothing to queue.',
      logType: 'info',
    }
  }

  // ── BH0 — work the current bounty (security-focused) ──────────────────────

  private async bh0(): Promise<{ logMessage: string; logType: LogType }> {
    let liveBounties: UnifiedBounty[] = []
    try { liveBounties = await fetchAllBounties() } catch { /* platforms slow */ }

    const { rows: [s] } = await this.db.query('SELECT assigned_bounty FROM lila_state WHERE id=1')
    const assigned: UnifiedBounty | null = s?.assigned_bounty ?? null

    if (!this.ai) return { logMessage: 'Bounty tick skipped — no LLM key.', logType: 'info' }

    const engine = new BountyEngine()
    const result = await engine.tick(assigned, liveBounties, this.db)

    if (result.action === 'submitted' && result.title && result.reward) {
      await this.db.query(
        `UPDATE lila_state
           SET total_earned = total_earned + $1,
               last_bounty  = $2,
               active_tasks = (
                 SELECT COALESCE(jsonb_agg(t), '[]'::jsonb)
                 FROM jsonb_array_elements_text(active_tasks) t
                 WHERE t <> $3
               )
         WHERE id = 1`,
        [result.reward, JSON.stringify({ name: result.title, value: result.reward, time: Date.now() }), result.title]
      )
      if (assigned?.title === result.title) {
        await this.db.query('UPDATE lila_state SET assigned_bounty = NULL WHERE id=1')
      }
    } else if (result.action === 'claimed' && result.title) {
      await this.mergeTasks([result.title])
    } else if (result.action === 'drafted' && result.title) {
      await this.mergeTasks([`Review draft report: ${result.title}`])
    }

    return { logMessage: result.logMessage, logType: result.logType }
  }

  // ── BZ0 — post execution status to chat (as tasker) ───────────────────────

  private async bz0(): Promise<{ logMessage: string; logType: LogType }> {
    const { rows: [s] } = await this.db.query(
      'SELECT total_earned, active_tasks, last_bounty FROM lila_state WHERE id=1'
    )
    const earned = parseFloat(s?.total_earned ?? '0').toFixed(2)
    const tasks: string[] = s?.active_tasks ?? []
    const last = s?.last_bounty

    const msg = tasks.length
      ? `Earned $${earned}. ${tasks.length} task${tasks.length > 1 ? 's' : ''} active. Top: ${tasks[0]}.`
      : last?.value
        ? `Earned $${earned}. Last submission: ${last.name} (+$${last.value}). Queue empty.`
        : `Earned $${earned}. Scanning security bounties.`

    await this.chat('tasker', msg)
    return { logMessage: 'Status posted.', logType: 'info' }
  }

  // ── TT0 — position check ───────────────────────────────────────────────────

  private async tt0(): Promise<{ logMessage: string; logType: LogType }> {
    const hasAlpaca = !!(process.env.ALPACA_API_KEY || process.env.APCA_API_KEY_ID)
    if (!hasAlpaca) return { logMessage: 'No Alpaca key — skipped.', logType: 'info' }

    const positions = await Alpaca.getPositions().catch(() => [] as Alpaca.AlpacaPosition[])
    if (!positions.length) return { logMessage: 'Flat.', logType: 'info' }

    const urgent = positions.filter(p => parseFloat(p.unrealized_plpc) * 100 <= -2.5)
    const newTasks = urgent.map(p =>
      `Review ${p.symbol} (${(parseFloat(p.unrealized_plpc) * 100).toFixed(1)}%)`
    )
    if (newTasks.length) await this.mergeTasks(newTasks)

    const summary = positions
      .map(p => `${p.symbol} ${(parseFloat(p.unrealized_plpc) * 100).toFixed(1)}%`)
      .join(', ')
    return {
      logMessage: `${positions.length} open. ${summary}.`,
      logType: urgent.length ? 'warn' : 'info',
    }
  }

  // ── TT1 — Tasker's trade plan ──────────────────────────────────────────────

  private async tt1(): Promise<{ logMessage: string; logType: LogType }> {
    if (!this.ai) return { logMessage: 'Plan skipped — no LLM key.', logType: 'info' }

    const { rows: notes } = await this.db.query(
      `SELECT path, content FROM analyst_notes
       WHERE updated_at > NOW() - INTERVAL '24 hours'
       ORDER BY updated_at DESC LIMIT 12`
    )
    const { rows: picks } = await this.db.query(
      `SELECT symbol, confidence, reason
       FROM analyst_picks
       WHERE created_at > NOW() - INTERVAL '24 hours' AND status='pending'
       ORDER BY confidence DESC LIMIT 10`
    )

    const combined = [
      ...notes.map((n: { path: string; content: string }) => `=== ${n.path} ===\n${n.content.slice(0, 400)}`),
      picks.length ? `=== analyst/current-picks ===\n${picks.map((p: { symbol: string; confidence: string; reason: string }) =>
        `${p.symbol} conf=${p.confidence} — ${p.reason}`).join('\n')}` : '',
    ].filter(Boolean).join('\n\n')

    if (!combined) {
      await this.chat('tasker', 'Analyst notes empty. Holding cash.')
      return { logMessage: 'No Analyst output. Holding.', logType: 'info' }
    }

    const raw = await this.llm(`${PLAN_PROMPT}\n\nAnalyst output:\n${combined}`, 500)
    const plan = this.parse(raw, { stance: 'Holding.', trades: [] as TaskerTrade[] })

    await this.note(
      `tasker/plans/${today()}-${Date.now()}.md`,
      `# Tasker Plan ${today()}\n\n## Stance\n${plan.stance}\n\n## Trades\n${JSON.stringify(plan.trades ?? [], null, 2)}`
    )

    let queued = 0
    for (const t of plan.trades ?? []) {
      if (!t.symbol || !t.entry || !t.stop || !t.target) continue
      if (t.stop >= t.entry) continue
      await this.db.query(
        `INSERT INTO analyst_picks
           (symbol, direction, entry_price, target_price, stop_loss, confidence, risk_level, reason, asset_class, status)
         VALUES ($1,'long',$2,$3,$4,$5,'tight',$6,'tasker-plan','pending')`,
        [t.symbol.toUpperCase(), t.entry, t.target, t.stop, Math.min(Math.max(t.confidence ?? 0.6, 0), 1), t.reason ?? 'Tasker plan']
      )
      queued++
    }

    return {
      logMessage: `Plan filed. ${queued} trade${queued === 1 ? '' : 's'} queued. ${plan.stance.slice(0, 120)}`,
      logType: queued > 0 ? 'success' : 'info',
    }
  }

  // ── TH0 — portfolio management ─────────────────────────────────────────────

  private async th0(): Promise<{ logMessage: string; logType: LogType }> {
    const hasAlpaca = !!(process.env.ALPACA_API_KEY || process.env.APCA_API_KEY_ID)
    if (!hasAlpaca) return { logMessage: 'No Alpaca key — skipped.', logType: 'info' }
    if (!this.ai) return { logMessage: 'Mgmt skipped — no LLM key.', logType: 'info' }

    const positions = await Alpaca.getPositions().catch(() => [] as Alpaca.AlpacaPosition[])
    if (!positions.length) return { logMessage: 'Nothing to manage.', logType: 'info' }

    const summary = positions.map(p =>
      `${p.symbol} qty=${p.qty} entry=$${parseFloat(p.avg_entry_price).toFixed(2)} now=$${parseFloat(p.current_price).toFixed(2)} pl=${(parseFloat(p.unrealized_plpc) * 100).toFixed(1)}%`
    ).join('\n')

    const raw = await this.llm(`${PORTFOLIO_PROMPT}\n\nPositions:\n${summary}`, 300)
    const decision = this.parse(raw, { actions: [] as { symbol: string; action: string; reason: string }[] })

    let closed = 0
    for (const a of decision.actions ?? []) {
      if (a.action === 'CLOSE') {
        const ok = await Alpaca.closePosition(a.symbol).catch(() => false)
        if (ok) {
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
      }
    }

    return {
      logMessage: closed
        ? `Cut ${closed} position${closed > 1 ? 's' : ''}. ${decision.actions?.length ?? 0} reviewed.`
        : `Held ${positions.length}. No cuts.`,
      logType: closed ? 'success' : 'info',
    }
  }

  // ── TJ0 — post trade update to chat ────────────────────────────────────────

  private async tj0(): Promise<{ logMessage: string; logType: LogType }> {
    const { rows: [latest] } = await this.db.query(
      `SELECT content FROM analyst_notes
       WHERE path LIKE 'tasker/plans/%' ORDER BY updated_at DESC LIMIT 1`
    )
    const { rows: openPicks } = await this.db.query(
      `SELECT symbol FROM analyst_picks WHERE status='pending' AND asset_class='tasker-plan'
       ORDER BY created_at DESC LIMIT 5`
    )
    const { rows: open } = await this.db.query(
      `SELECT symbol FROM lila_positions WHERE status='open' ORDER BY opened_at DESC LIMIT 5`
    )

    const stance = latest?.content
      ? String(latest.content).match(/## Stance\n([^\n]+)/)?.[1]?.trim() ?? 'Plan filed.'
      : 'No plan this cycle.'

    const msg = [
      stance,
      openPicks.length ? `Queued: ${openPicks.map((p: { symbol: string }) => p.symbol).join(', ')}.` : null,
      open.length ? `Open: ${open.map((p: { symbol: string }) => p.symbol).join(', ')}.` : 'Flat.',
    ].filter(Boolean).join(' ')

    await this.chat('tasker', msg.slice(0, 500))
    return { logMessage: 'Trade update posted.', logType: 'success' }
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async llm(prompt: string, maxTokens: number): Promise<string> {
    const res = await this.ai!.chat.completions.create({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature: 0.5,
    })
    return (res.choices[0]?.message?.content ?? '')
      .replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
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

  private async mergeTasks(incoming: string[]): Promise<void> {
    const { rows: [s] } = await this.db.query('SELECT active_tasks FROM lila_state WHERE id=1')
    const current: string[] = s?.active_tasks ?? []
    const merged = Array.from(new Set([...current, ...incoming])).slice(-8)
    await this.db.query('UPDATE lila_state SET active_tasks=$1 WHERE id=1', [JSON.stringify(merged)])
  }
}

interface TaskerTrade {
  symbol: string
  entry: number
  target: number
  stop: number
  confidence?: number
  reason?: string
}
