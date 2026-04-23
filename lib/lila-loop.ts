import OpenAI from 'openai'
import type { PoolClient } from 'pg'
import { BountyEngine } from './bounty-engine'
import { fetchAllBounties, type UnifiedBounty } from './bounties-fetch'
import * as Alpaca from './platforms/alpaca'

// ── Lila autonomy loop ────────────────────────────────────────────────────────
//
// Bounty cycle (every step):
//   BT0 — Lila checks group chat, makes tasks if needed
//   BH0 — Lila works the currently assigned bounty (real submission)
//   BZ0 — Lila updates the group chat with status
//
// Every 11 completed bounty cycles, Lila runs a trade check instead:
//   TT0 — review open positions, queue portfolio tasks
//   TT1 — read Analyst notes, write her own plan with tight stops
//   TH0 — execute portfolio management (cut/hold/modify)
//   TJ0 — update the group chat with the trade plan and outcome
//
// Steps are time-gated so a UI polling every 5s can't advance Lila faster than
// STEP_INTERVAL_SEC.

const STEP_INTERVAL_SEC = 30
const TRADE_CYCLE_EVERY = 11

export type LilaStep = 'BT0' | 'BH0' | 'BZ0' | 'TT0' | 'TT1' | 'TH0' | 'TJ0'

type LogType = 'info' | 'success' | 'warn'

export interface LilaStepResult {
  step: LilaStep
  logMessage: string
  logType: LogType
}

const CHAT_CHECK_PROMPT = `You are Lila (COO). The group chat has Lila, the Analyst, and the operator.

Review the recent chat transcript. Decide if anything the operator or Analyst said needs a task on your list or a short reply.

Respond with ONLY valid JSON:
{ "tasks": ["task 1", "task 2"], "reply": "one sentence or empty string" }

Tasks should be concrete and short (<= 70 chars). Empty arrays are fine. Keep the reply terse and in Lila's voice — dry, direct, no filler.`

const PLAN_PROMPT = `You are Lila, the COO. The Analyst has filed notes and picks. Write YOUR plan in your own words.

Two short sections:
1) "Stance" — 1–2 sentences: what you're keeping, what you're changing, why.
2) "Trades" — JSON array of trade intents you'd take today. Sizing is agnostic (small account, small trades are fine) but every trade needs a TIGHT stop. Include: symbol, entry (current price), target, stop, confidence 0-1, reason. Long only.

Respond with ONLY valid JSON:
{
  "stance": "one or two sentences",
  "trades": [{"symbol":"XYZ","entry":12.34,"target":13.20,"stop":12.10,"confidence":0.7,"reason":"one sentence"}]
}`

const PORTFOLIO_PROMPT = `You are Lila managing open positions. Decide for each: HOLD, CLOSE, or TRIM.

Be aggressive about cutting losers. Let winners run only if the thesis is intact. If a position is down more than its stop already, CLOSE now.

Respond with ONLY valid JSON:
{ "actions": [{"symbol":"X","action":"HOLD|CLOSE|TRIM","reason":"one sentence"}] }`

function today() { return new Date().toISOString().slice(0, 10) }

export class LilaLoop {
  private db: PoolClient
  private ai: OpenAI | null

  constructor(db: PoolClient) {
    this.db = db
    this.ai = process.env.DEEPSEEK_API_KEY
      ? new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com/v1' })
      : null
  }

  async run(): Promise<LilaStepResult | null> {
    if (!(await this.shouldRun())) return null

    const { rows: [s] } = await this.db.query(
      'SELECT step, turn_count FROM lila_loop_state WHERE id=1'
    )
    const step: LilaStep = (s?.step as LilaStep) ?? 'BT0'
    let turnCount: number = s?.turn_count ?? 0

    let result: { logMessage: string; logType: LogType }
    let next: LilaStep

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
      return { step, logMessage: `Lila ${step} error: ${String(e)}`, logType: 'warn' }
    }

    await this.advance(next, turnCount)
    return { step, logMessage: `Lila ${step}: ${result.logMessage}`, logType: result.logType }
  }

  private async shouldRun(): Promise<boolean> {
    const { rows: [s] } = await this.db.query('SELECT last_step_at FROM lila_loop_state WHERE id=1')
    if (!s?.last_step_at) return true
    return (Date.now() - new Date(s.last_step_at).getTime()) / 1000 >= STEP_INTERVAL_SEC
  }

  private async advance(step: LilaStep, turnCount: number): Promise<void> {
    await this.db.query(
      'UPDATE lila_loop_state SET step=$1, turn_count=$2, last_step_at=NOW(), updated_at=NOW() WHERE id=1',
      [step, turnCount]
    )
  }

  // ── BT0 — check chat, make tasks ───────────────────────────────────────────

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

    const raw = await this.llm(`${CHAT_CHECK_PROMPT}\n\nTranscript:\n${transcript}`, 220)
    const parsed = this.parse(raw, { tasks: [] as string[], reply: '' })

    if (Array.isArray(parsed.tasks) && parsed.tasks.length) {
      await this.mergeTasks(parsed.tasks.slice(0, 5))
    }
    if (parsed.reply && typeof parsed.reply === 'string') {
      await this.chat('lila', parsed.reply.slice(0, 400))
    }

    const taskCount = parsed.tasks?.length ?? 0
    return {
      logMessage: taskCount
        ? `Chat reviewed. ${taskCount} new task${taskCount > 1 ? 's' : ''} queued.`
        : 'Chat reviewed. Nothing actionable.',
      logType: 'info',
    }
  }

  // ── BH0 — work the current bounty ──────────────────────────────────────────

  private async bh0(): Promise<{ logMessage: string; logType: LogType }> {
    let liveBounties: UnifiedBounty[] = []
    try { liveBounties = await fetchAllBounties() } catch { /* platforms slow */ }

    const { rows: [s] } = await this.db.query('SELECT assigned_bounty FROM lila_state WHERE id=1')
    const assigned: UnifiedBounty | null = s?.assigned_bounty ?? null

    if (!this.ai) return { logMessage: 'Bounty tick skipped — no LLM key.', logType: 'info' }

    const engine = new BountyEngine()
    const result = await engine.tick(assigned, liveBounties)

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
    }

    return { logMessage: result.logMessage, logType: result.logType }
  }

  // ── BZ0 — update chat ──────────────────────────────────────────────────────

  private async bz0(): Promise<{ logMessage: string; logType: LogType }> {
    const { rows: [s] } = await this.db.query(
      'SELECT total_earned, active_tasks, last_bounty FROM lila_state WHERE id=1'
    )
    const earned = parseFloat(s?.total_earned ?? '0').toFixed(2)
    const tasks: string[] = s?.active_tasks ?? []
    const last = s?.last_bounty

    const msg = tasks.length
      ? `Earned $${earned}. ${tasks.length} task${tasks.length > 1 ? 's' : ''} open: ${tasks[0]}${tasks.length > 1 ? ` (+${tasks.length - 1})` : ''}.`
      : last?.value
        ? `Earned $${earned}. Last: ${last.name} (+$${last.value}). Queue empty.`
        : `Earned $${earned}. Scanning.`

    await this.chat('lila', msg)
    return { logMessage: `Status posted. "${msg}"`, logType: 'info' }
  }

  // ── TT0 — check positions, queue portfolio tasks ───────────────────────────

  private async tt0(): Promise<{ logMessage: string; logType: LogType }> {
    const hasAlpaca = !!(process.env.ALPACA_API_KEY || process.env.APCA_API_KEY_ID)
    if (!hasAlpaca) return { logMessage: 'No Alpaca key — skipped.', logType: 'info' }

    const positions = await Alpaca.getPositions().catch(() => [] as Alpaca.AlpacaPosition[])
    if (!positions.length) return { logMessage: 'Position check: flat.', logType: 'info' }

    const urgent = positions.filter(p => parseFloat(p.unrealized_plpc) * 100 <= -2.5)
    const newTasks = urgent.map(p =>
      `Review ${p.symbol} (${(parseFloat(p.unrealized_plpc) * 100).toFixed(1)}%)`
    )
    if (newTasks.length) await this.mergeTasks(newTasks)

    const summary = positions
      .map(p => `${p.symbol} ${(parseFloat(p.unrealized_plpc) * 100).toFixed(1)}%`)
      .join(', ')
    return {
      logMessage: `Position check: ${positions.length} open. ${summary}.`,
      logType: urgent.length ? 'warn' : 'info',
    }
  }

  // ── TT1 — read Analyst notes, write Lila's plan ────────────────────────────

  private async tt1(): Promise<{ logMessage: string; logType: LogType }> {
    if (!this.ai) return { logMessage: 'Plan skipped — no LLM key.', logType: 'info' }

    const { rows: notes } = await this.db.query(
      `SELECT path, content FROM analyst_notes
       WHERE updated_at > NOW() - INTERVAL '24 hours'
       ORDER BY updated_at DESC LIMIT 12`
    )
    const { rows: picks } = await this.db.query(
      `SELECT symbol, confidence, reason, entry_price, target_price, stop_loss
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
      await this.chat('lila', 'Analyst notes empty. Holding cash, watching.')
      return { logMessage: 'No Analyst output. Plan: hold.', logType: 'info' }
    }

    const raw = await this.llm(`${PLAN_PROMPT}\n\nAnalyst output:\n${combined}`, 500)
    const plan = this.parse(raw, { stance: 'Holding.', trades: [] as LilaTrade[] })

    // File Lila's plan
    await this.note(
      `lila/plans/${today()}-${Date.now()}.md`,
      `# Lila Plan ${today()}\n\n## Stance\n${plan.stance}\n\n## Trades\n${JSON.stringify(plan.trades ?? [], null, 2)}`
    )

    // Queue her trades as picks so TradingEngine picks them up.
    let queued = 0
    for (const t of plan.trades ?? []) {
      if (!t.symbol || !t.entry || !t.stop || !t.target) continue
      if (t.stop >= t.entry) continue  // long only, stop must be below entry
      await this.db.query(
        `INSERT INTO analyst_picks
           (symbol, direction, entry_price, target_price, stop_loss, confidence, risk_level, reason, asset_class, status)
         VALUES ($1,'long',$2,$3,$4,$5,'tight',$6,'lila-plan','pending')`,
        [t.symbol.toUpperCase(), t.entry, t.target, t.stop, Math.min(Math.max(t.confidence ?? 0.6, 0), 1), t.reason ?? 'Lila plan']
      )
      queued++
    }

    return {
      logMessage: `Plan filed. ${queued} trade${queued === 1 ? '' : 's'} queued. ${plan.stance.slice(0, 120)}`,
      logType: queued > 0 ? 'success' : 'info',
    }
  }

  // ── TH0 — portfolio management (cut / hold) ────────────────────────────────

  private async th0(): Promise<{ logMessage: string; logType: LogType }> {
    const hasAlpaca = !!(process.env.ALPACA_API_KEY || process.env.APCA_API_KEY_ID)
    if (!hasAlpaca) return { logMessage: 'No Alpaca key — skipped.', logType: 'info' }
    if (!this.ai) return { logMessage: 'Portfolio mgmt skipped — no LLM key.', logType: 'info' }

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

  // ── TJ0 — update chat with trade plan + outcome ────────────────────────────

  private async tj0(): Promise<{ logMessage: string; logType: LogType }> {
    const { rows: [latest] } = await this.db.query(
      `SELECT content FROM analyst_notes
       WHERE path LIKE 'lila/plans/%' ORDER BY updated_at DESC LIMIT 1`
    )
    const { rows: openPicks } = await this.db.query(
      `SELECT symbol FROM analyst_picks WHERE status='pending' AND asset_class='lila-plan'
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

    await this.chat('lila', msg.slice(0, 500))
    return { logMessage: `Trade update posted.`, logType: 'success' }
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

interface LilaTrade {
  symbol: string
  entry: number
  target: number
  stop: number
  confidence?: number
  reason?: string
}
