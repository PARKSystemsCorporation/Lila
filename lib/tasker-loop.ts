import OpenAI from 'openai'
import type { PoolClient } from 'pg'
import { BountyEngine, pickSecurityCandidates, pickDocsCandidates } from './bounty-engine'
import { fetchAllBounties, type UnifiedBounty } from './bounties-fetch'
import { ResearchEngine } from './research-engine'
import { llmCall, LLMBudgetExceeded } from './llm'
import { cfg } from './config'
import { buildCipherBrief, renderBrief } from './agent-brief'

// ── Cipher autonomy loop ──────────────────────────────────────────────────────
//
// Cipher is the executor. Bounty cycle only, every step 30s-gated:
//   BT0 — parse recent chat for operator/Lila-assigned tasks, queue them
//   BH0 — on security bounties, run ONE research cycle on a pinned target
//         (target persists across many ticks; findings file as security_reports
//         → Lila reviews before the operator sees them). On code bounties,
//         one-shot execute via BountyEngine.
//   BZ0 — post an execution status update to the team chat
//
// Trading, report review, operator replies all belong to Lila (autonomy tree).

export type TaskerStep = 'BT0' | 'BH0' | 'BZ0'

type LogType = 'info' | 'success' | 'warn'

export interface TaskerStepResult {
  step: TaskerStep
  logMessage: string
  logType: LogType
}

const CHAT_PARSE_PROMPT = `You are Cipher, the executor on Lila's team. Read the recent chat transcript and extract any concrete tasks the operator or Lila has assigned.

Respond with ONLY valid JSON — no preamble:
{ "tasks": ["task 1", "task 2"] }

Rules:
- Only include explicit assignments ("do X", "work on Y", "try Z"), not general commentary.
- Keep each task <= 70 chars, imperative form.
- Empty array if nothing actionable.`

export class TaskerLoop {
  private db: PoolClient
  private ai: OpenAI | null
  // Per-tick rendered brief. Built lazily on first llm() call, cleared
  // at the end of run(). Cap is applied at injection time in llm(), not
  // here — keeps renderBrief honest as a pure formatter.
  private briefPrefix: string | null = null

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
      this.briefPrefix = null
      return { step, logMessage: `Cipher ${step} error: ${String(e)}`, logType: 'warn' }
    }

    await this.advance(next)
    this.briefPrefix = null
    return { step, logMessage: `Cipher ${step}: ${result.logMessage}`, logType: result.logType }
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
       WHERE thread = 'main'
         AND created_at > NOW() - INTERVAL '15 minutes'
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

    // ── Alternation: docs (even turn) ⇄ security (odd turn) ─────────────────
    // Per operator plan: cycle A docs, cycle B security, cycle C docs, …
    // The turn only advances when a cycle "completes" — a docs draft is
    // filed or a security target hits found/exhausted. Security work that
    // spans many Cipher ticks stays on the same turn until terminal.
    const { rows: [ls] } = await this.db.query(
      'SELECT assigned_bounty, bounty_turn FROM lila_state WHERE id=1'
    )
    const assigned: UnifiedBounty | null = ls?.assigned_bounty ?? null
    const turn: number = ls?.bounty_turn ?? 0
    const docsTurn = turn % 2 === 0   // even turns = docs

    const securityCandidates = pickSecurityCandidates(liveBounties)
    const docsCandidates     = pickDocsCandidates(liveBounties)

    const assignedIsSecurity = assigned && securityCandidates.some(b => b.id === assigned.id)
    const assignedIsDocs     = assigned && docsCandidates.some(b => b.id === assigned.id)

    // Operator assignment always wins — run whichever mode fits the assigned
    // bounty regardless of the turn counter.
    if (assignedIsDocs) {
      return this.runDocsCycle(liveBounties, assigned)
    }
    if (assignedIsSecurity) {
      return this.runSecurityCycle(liveBounties, assigned, securityCandidates)
    }

    // ── Docs turn ────────────────────────────────────────────────────────────
    if (docsTurn) {
      if (docsCandidates.length > 0) {
        return this.runDocsCycle(liveBounties, null)
      }
      // No docs bounty visible — fall through to security rather than idle.
      // We still count this as "docs consumed" so next turn goes security
      // naturally. But don't advance the turn on empty fallthrough, or we'd
      // skip docs two-in-a-row.
    }

    // ── Security turn (or docs fallthrough) ─────────────────────────────────
    return this.runSecurityCycle(liveBounties, assigned, securityCandidates)
  }

  // Full docs cycle: pick highest-scoring docs bounty, generate draft, hand
  // to Lila for review. Advances bounty_turn on success so the next tick
  // flips to security.
  private async runDocsCycle(
    liveBounties: UnifiedBounty[],
    assigned: UnifiedBounty | null,
  ): Promise<{ logMessage: string; logType: LogType }> {
    const engine = new BountyEngine()
    // Filter to docs-only so the scorer doesn't pick a security/code bounty
    // for this turn.
    const docsIds = new Set(pickDocsCandidates(liveBounties).map(b => b.id))
    const docsOnly = liveBounties.filter(b => docsIds.has(b.id))
    const result = await engine.tick(
      assigned && docsIds.has(assigned.id) ? assigned : null,
      docsOnly,
      this.db,
      'docs',
    )

    if (result.action === 'drafted') {
      await this.mergeTasks([`Review docs draft: ${result.title}`])
      await this.advanceTurn()
      return {
        logMessage: `Docs cycle complete: ${result.logMessage} Next turn → security.`,
        logType: result.logType,
      }
    }

    // Docs scored but nothing above threshold, or no docs to work. Stay on
    // the docs turn and let security fallthrough handle this tick.
    if (result.action === 'idle') {
      return {
        logMessage: `Docs turn: ${result.logMessage}`,
        logType: 'info',
      }
    }

    return { logMessage: result.logMessage, logType: result.logType }
  }

  private async runSecurityCycle(
    liveBounties: UnifiedBounty[],
    assigned: UnifiedBounty | null,
    securityCandidates: UnifiedBounty[],
  ): Promise<{ logMessage: string; logType: LogType }> {
    const research = new ResearchEngine(this.db)
    const candidates = assigned && securityCandidates.some(b => b.id === assigned.id)
      ? [assigned, ...securityCandidates]
      : securityCandidates

    const target = await research.pinOrGetCurrent(candidates)

    // Research cycle gate: cheap code-work bounties get worked while the
    // pinned target is cooling down between research cycles.
    if (target) {
      const last = await this.lastResearchAt(target.id)
      const tooRecent = last && (Date.now() - last.getTime()) / 1000 < cfg.RESEARCH_CYCLE_SEC
      if (tooRecent) {
        const securityIds = new Set(securityCandidates.map(b => b.id))
        const codeOnly = liveBounties.filter(b => !securityIds.has(b.id))
        const engine = new BountyEngine()
        const result = await engine.tick(
          assigned && !securityIds.has(assigned.id) ? assigned : null,
          codeOnly,
          this.db,
          'code',
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
        await this.advanceTurn()
        return {
          logMessage: `Finding on "${target.title}" after ${target.cycles + 1} cycle${target.cycles ? 's' : ''}. Report filed. Next turn → docs.`,
          logType: 'success',
        }
      }

      if (cycle.action === 'exhausted') {
        await this.advanceTurn()
        return {
          logMessage: `"${target.title}" exhausted after ${target.cycles + 1} cycles. Rotating. Next turn → docs.`,
          logType: 'warn',
        }
      }

      return {
        logMessage: `"${target.title}" — cycle ${target.cycles + 1}, ${cycle.phase}.`,
        logType: cycle.logType,
      }
    }

    // No pinned target and no security candidates. Run the one-shot code
    // bounty path.
    const engine = new BountyEngine()
    const result = await engine.tick(assigned, liveBounties, this.db, 'code')

    if (result.action === 'submitted' && result.title) {
      // DO NOT credit total_earned here. Acceptance by the platform API is
      // not payment. BountyEngine.saveSubmission already recorded the row;
      // operator confirms via /api/reports mark_paid and total_earned is
      // updated there (see lib/llm.ts? actually in api/reports/route.ts).
      await this.db.query(
        `UPDATE lila_state
           SET active_tasks = (
                 SELECT COALESCE(jsonb_agg(t), '[]'::jsonb)
                 FROM jsonb_array_elements_text(active_tasks) t
                 WHERE t <> $1
               )
         WHERE id = 1`,
        [result.title]
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
      'SELECT total_earned, active_tasks, current_target_id FROM lila_state WHERE id=1'
    )
    const earned = parseFloat(s?.total_earned ?? '0').toFixed(2)
    const tasks: string[] = s?.active_tasks ?? []

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

    const { rows: [lastPaid] } = await this.db.query(
      `SELECT title, payout FROM security_reports
       WHERE status='paid' ORDER BY paid_at DESC LIMIT 1`
    )

    const msg = tasks.length
      ? `Earned $${earned}. ${tasks.length} task${tasks.length > 1 ? 's' : ''} active.${targetLine}`
      : lastPaid
        ? `Earned $${earned}. Last paid: ${lastPaid.title} (+$${parseFloat(lastPaid.payout ?? '0').toFixed(2)}).${targetLine}`
        : `Earned $${earned}.${targetLine || ' Scanning.'}`

    await this.chat('tasker', msg.slice(0, 500), 'status')
    return { logMessage: 'Status posted.', logType: 'info' }
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async llm(module: string, prompt: string, maxTokens: number): Promise<string> {
    // Build the brief prefix once per tick. Capped at 800 chars at
    // injection so a verbose brief can't crowd out the actual prompt.
    if (this.briefPrefix === null) {
      try {
        this.briefPrefix = renderBrief(await buildCipherBrief(this.db)).slice(0, 800)
      } catch {
        this.briefPrefix = ''
      }
    }
    const finalPrompt = this.briefPrefix
      ? `${this.briefPrefix}\n---\n${prompt}`
      : prompt
    try {
      const { content } = await llmCall({
        ai: this.ai!,
        module,
        messages: [{ role: 'user', content: finalPrompt }],
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

  // kind: 'message' (chat-visible) | 'status' (work update, hidden from Chat)
  private async chat(sender: string, content: string, kind: 'message' | 'status' = 'message'): Promise<void> {
    await this.db.query(
      `INSERT INTO chat_messages (sender, content, kind) VALUES ($1,$2,$3)`,
      [sender, content, kind]
    )
  }

  private async mergeTasks(incoming: string[]): Promise<void> {
    const { rows: [s] } = await this.db.query('SELECT active_tasks FROM lila_state WHERE id=1')
    const current: string[] = s?.active_tasks ?? []
    const merged = Array.from(new Set([...current, ...incoming])).slice(-8)
    await this.db.query('UPDATE lila_state SET active_tasks=$1 WHERE id=1', [JSON.stringify(merged)])
  }

  private async advanceTurn(): Promise<void> {
    await this.db.query(
      'UPDATE lila_state SET bounty_turn = bounty_turn + 1 WHERE id=1'
    )
  }
}
