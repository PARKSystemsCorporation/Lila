import OpenAI from 'openai'
import type { PoolClient } from 'pg'
import { BountyEngine, pickSecurityCandidates } from './bounty-engine'
import { fetchAllBounties, type UnifiedBounty } from './bounties-fetch'
import { ResearchEngine } from './research-engine'
import { llmCall, LLMBudgetExceeded } from './llm'
import { cfg } from './config'

// ── Tasker autonomy loop ──────────────────────────────────────────────────────
//
// Tasker is the executor. Bounty cycle only, every step 30s-gated:
//   BT0 — parse recent chat for operator/Lila-assigned tasks, queue them
//   BH0 — on security bounties, run ONE research cycle on a pinned target
//         (target persists across many ticks; findings file as security_reports
//         → Lila reviews before the operator sees them). On code bounties,
//         one-shot execute via BountyEngine.
//   BZ0 — post an execution status update to the team chat
//
// Trading, report review, operator replies all belong to Lila (ManagementLoop).

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
    return (Date.now() - new Date(s.last_step_at).getTime()) / 1000 >= cfg.TASKER_STEP_SEC
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

    const raw = await this.llm('tasker.bt0', `${CHAT_PARSE_PROMPT}\n\nTranscript:\n${transcript}`, 200)
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
    if (!this.ai) return { logMessage: 'Bounty tick skipped — no LLM key.', logType: 'info' }

    let liveBounties: UnifiedBounty[] = []
    try { liveBounties = await fetchAllBounties() } catch { /* platforms slow */ }

    // ── Security: target-pinned deep research (persistent memory) ────────────
    // This is where big-money findings come from — weeks on one codebase.

    const research = new ResearchEngine(this.db)
    const securityCandidates = pickSecurityCandidates(liveBounties)

    // Operator assignment trumps auto-selection: pin whatever they assigned.
    const { rows: [lilaState] } = await this.db.query(
      'SELECT assigned_bounty FROM lila_state WHERE id=1'
    )
    const assigned: UnifiedBounty | null = lilaState?.assigned_bounty ?? null

    // If operator assigned a security bounty, pin it.
    const assignedIsSecurity = assigned && securityCandidates.some(b => b.id === assigned.id)
    const candidates = assignedIsSecurity ? [assigned!, ...securityCandidates] : securityCandidates

    const target = await research.pinOrGetCurrent(candidates)

    // Tiered cadence: don't burn a research cycle on every Tasker tick. Cycles
    // on the same target are expensive (prompt includes accumulated notes); a
    // 3-minute default gate lets cheap code-work bounties run in between.
    if (target) {
      const last = await this.lastResearchAt(target.id)
      const tooRecent = last && (Date.now() - last.getTime()) / 1000 < cfg.RESEARCH_CYCLE_SEC
      if (tooRecent) {
        // Fall through to code-work path with security bounties filtered out —
        // the research target is already claimed, and we'll hit it next window.
        const securityIds = new Set(securityCandidates.map(b => b.id))
        const codeOnly = liveBounties.filter(b => !securityIds.has(b.id))
        const engine = new BountyEngine()
        const result = await engine.tick(
          assigned && !securityIds.has(assigned.id) ? assigned : null,
          codeOnly,
          this.db
        )
        return {
          logMessage: `Researching "${target.title}" (next cycle ${this.untilNext(last)}). Meanwhile: ${result.logMessage}`,
          logType: result.logType,
        }
      }
    }

    if (target) {
      const cycle = await research.runCycle(target)

      if (cycle.action === 'finding' && cycle.reportContent) {
        // File the finding as a security report; Lila reviews before operator.
        await this.db.query(
          `INSERT INTO security_reports
             (bounty_id, platform, platform_label, title, reward, chain, url,
              content, confidence, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending_review')
           ON CONFLICT (bounty_id) DO UPDATE SET
             content=$8, confidence=$9, status='pending_review', review_notes=NULL, updated_at=NOW()`,
          [
            target.bounty_id, target.platform, target.platform_label, target.title,
            target.reward, target.chain ?? null, target.url ?? null,
            cycle.reportContent, cycle.confidence ?? 0.7,
          ]
        )
        await this.mergeTasks([`Draft filed (Lila reviewing): ${target.title}`])
        return {
          logMessage: `Finding on "${target.title}" after ${target.cycles + 1} cycle${target.cycles ? 's' : ''}. Report filed for Lila's review.`,
          logType: 'success',
        }
      }

      if (cycle.action === 'exhausted') {
        return {
          logMessage: `"${target.title}" exhausted after ${target.cycles + 1} cycles. Rotating.`,
          logType: 'warn',
        }
      }

      return {
        logMessage: `"${target.title}" — cycle ${target.cycles + 1}, ${cycle.phase}.`,
        logType: cycle.logType,
      }
    }

    // ── Code work: one-shot (unchanged) ──────────────────────────────────────
    // Only runs if there are no security targets to work.
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
    }

    return { logMessage: result.logMessage, logType: result.logType }
  }

  // ── BZ0 — post execution status to chat ───────────────────────────────────

  private async bz0(): Promise<{ logMessage: string; logType: LogType }> {
    const { rows: [s] } = await this.db.query(
      'SELECT total_earned, active_tasks, last_bounty, current_target_id FROM lila_state WHERE id=1'
    )
    const earned = parseFloat(s?.total_earned ?? '0').toFixed(2)
    const tasks: string[] = s?.active_tasks ?? []
    const last = s?.last_bounty

    // Include current research target if any — gives operator a visible pulse
    // on the deep-research loop.
    let targetLine = ''
    if (s?.current_target_id) {
      const { rows } = await this.db.query(
        'SELECT title, phase, cycles FROM research_targets WHERE id=$1',
        [s.current_target_id]
      )
      const t = rows[0]
      if (t) targetLine = ` Researching: ${t.title} — cycle ${t.cycles}, phase ${t.phase}.`
    }

    const msg = tasks.length
      ? `Earned $${earned}. ${tasks.length} task${tasks.length > 1 ? 's' : ''} active.${targetLine}`
      : last?.value
        ? `Earned $${earned}. Last: ${last.name} (+$${last.value}).${targetLine}`
        : `Earned $${earned}.${targetLine || ' Scanning.'}`

    await this.chat('tasker', msg.slice(0, 500))
    return { logMessage: 'Status posted.', logType: 'info' }
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async llm(module: string, prompt: string, maxTokens: number): Promise<string> {
    try {
      const { content } = await llmCall({
        ai: this.ai!,
        module,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature: 0.4,
      })
      return content
    } catch (e) {
      if (e instanceof LLMBudgetExceeded) return ''
      throw e
    }
  }

  private async lastResearchAt(targetId: number): Promise<Date | null> {
    const { rows } = await this.db.query(
      'SELECT last_worked_at FROM research_targets WHERE id=$1',
      [targetId]
    )
    return rows[0]?.last_worked_at ? new Date(rows[0].last_worked_at) : null
  }

  private untilNext(last: Date | null): string {
    if (!last) return 'soon'
    const remainingSec = cfg.RESEARCH_CYCLE_SEC - (Date.now() - last.getTime()) / 1000
    if (remainingSec <= 0) return 'now'
    return remainingSec >= 60 ? `${Math.ceil(remainingSec / 60)}m` : `${Math.ceil(remainingSec)}s`
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
