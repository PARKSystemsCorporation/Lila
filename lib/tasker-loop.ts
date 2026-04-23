import OpenAI from 'openai'
import type { PoolClient } from 'pg'
import { BountyEngine } from './bounty-engine'
import { fetchAllBounties, type UnifiedBounty } from './bounties-fetch'

// ── Tasker autonomy loop ──────────────────────────────────────────────────────
//
// Tasker is the executor. It ONLY works bounties. Trading, report review,
// and operator replies all belong to Lila (ManagementLoop).
//
// Bounty cycle (every step, 30s-gated):
//   BT0 — parse recent chat for operator/Lila-assigned tasks, queue them
//   BH0 — run the bounty engine against the queue (security-focused filter).
//         Security reports land in security_reports with status=pending_review
//         for Lila to vet before the operator sees them.
//   BZ0 — post an execution status update to the team chat as sender='tasker'

const STEP_INTERVAL_SEC = 30

export type TaskerStep = 'BT0' | 'BH0' | 'BZ0'

type LogType = 'info' | 'success' | 'warn'

export interface TaskerStepResult {
  step: TaskerStep
  logMessage: string
  logType: LogType
}

const CHAT_PARSE_PROMPT = `You are Tasker, the executor on Lila's team. Read the recent chat transcript and extract any concrete tasks the operator or Lila has assigned.

Respond with ONLY valid JSON — no preamble:
{ "tasks": ["task 1", "task 2"] }

Rules:
- Only include explicit assignments ("do X", "work on Y", "try Z"), not general commentary.
- Keep each task <= 70 chars, imperative form.
- Empty array if nothing actionable.`

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
      'SELECT step FROM lila_loop_state WHERE id=1'
    )
    const step: TaskerStep =
      s?.step === 'BT0' || s?.step === 'BH0' || s?.step === 'BZ0' ? s.step : 'BT0'

    let result: { logMessage: string; logType: LogType }
    let next: TaskerStep

    try {
      switch (step) {
        case 'BT0': result = await this.bt0(); next = 'BH0'; break
        case 'BH0': result = await this.bh0(); next = 'BZ0'; break
        case 'BZ0': result = await this.bz0(); next = 'BT0'; break
      }
    } catch (e) {
      await this.advance(step)
      return { step, logMessage: `Tasker ${step} error: ${String(e)}`, logType: 'warn' }
    }

    await this.advance(next)
    return { step, logMessage: `Tasker ${step}: ${result.logMessage}`, logType: result.logType }
  }

  private async shouldRun(): Promise<boolean> {
    const { rows: [s] } = await this.db.query('SELECT last_step_at FROM lila_loop_state WHERE id=1')
    if (!s?.last_step_at) return true
    return (Date.now() - new Date(s.last_step_at).getTime()) / 1000 >= STEP_INTERVAL_SEC
  }

  private async advance(step: TaskerStep): Promise<void> {
    await this.db.query(
      'UPDATE lila_loop_state SET step=$1, last_step_at=NOW(), updated_at=NOW() WHERE id=1',
      [step]
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

  // ── BH0 — work the current bounty ──────────────────────────────────────────

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
      // Report is sitting in Lila's review queue — no operator task yet.
      await this.mergeTasks([`Draft filed (Lila reviewing): ${result.title}`])
    }

    return { logMessage: result.logMessage, logType: result.logType }
  }

  // ── BZ0 — post execution status to chat ───────────────────────────────────

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

  // ── helpers ────────────────────────────────────────────────────────────────

  private async llm(prompt: string, maxTokens: number): Promise<string> {
    const res = await this.ai!.chat.completions.create({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature: 0.4,
    })
    return (res.choices[0]?.message?.content ?? '')
      .replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
  }

  private parse<T>(raw: string, fallback: T): T {
    try { return JSON.parse(raw) } catch { return fallback }
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
