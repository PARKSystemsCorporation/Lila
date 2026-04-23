import OpenAI from 'openai'
import type { PoolClient } from 'pg'
import type { UnifiedBounty } from './bounties-fetch'

// ── Research engine ───────────────────────────────────────────────────────────
//
// Gemini's insight: big-money bugs come from *persistence*. One-shot LLM passes
// don't beat Slither. The edge is weeks on one codebase — mapping architecture,
// enumerating surfaces, deriving invariants, then hunting for violations.
//
// Each cycle on a target reads ALL prior notes and extends them. After N cycles
// Tasker has a mental model of that one protocol that a cold pass cannot match.
//
// Phase machine:
//   map          — actors, contracts, money flow, privileged roles (cycle 1)
//   surfaces     — public entry points, oracle reads, external calls (cycle 2)
//   invariants   — properties that MUST hold (solvency, access) (cycle 3)
//   hypothesize  — specific attack ideas targeting invariants (cycle 4)
//   investigate  — take one open hypothesis per cycle; confirm or discard
//                  (cycles 5+ — this is where findings emerge)
//   found        — a confirmed finding was filed as a security_report
//   exhausted    — all hypotheses discarded, no new ones; rotate to next target

export type ResearchPhase =
  | 'map' | 'surfaces' | 'invariants' | 'hypothesize' | 'investigate'
  | 'found' | 'exhausted'

const MAX_FRUITLESS_CYCLES = 3
const MAX_NOTE_BLOB = 12_000  // chars of prior notes sent per cycle; rest summarized

export interface ResearchTarget {
  id: number
  bounty_id: string
  platform: string
  platform_label: string
  title: string
  reward: number
  chain?: string
  url?: string
  scope: string
  phase: ResearchPhase
  cycles: number
  fruitless_cycles: number
  status: 'active' | 'exhausted' | 'found' | 'abandoned'
}

export interface CycleResult {
  action: 'advanced' | 'finding' | 'exhausted' | 'error'
  phase: ResearchPhase
  logMessage: string
  logType: 'info' | 'success' | 'warn'
  reportContent?: string  // populated when action === 'finding'
  confidence?: number
}

const MAP_PROMPT = `You are Tasker, beginning deep research on a bounty target. Read the brief and write an ARCHITECTURE map.

Target: {TITLE}
Platform: {PLATFORM}
Scope:
{SCOPE}

Output markdown with these exact headings:
## Actors
Who participates: users, admins, keepers, oracles, counterparties.
## Core Contracts
Name each contract and its role in one line. If the brief doesn't list them, infer from the description.
## Money Flow
Where value enters, where it exits, what moves between contracts.
## Privileges
Admin roles, upgradeability, pausability, fee-takers.
## External Dependencies
Oracles, price feeds, other protocols, bridges.

Be specific to THIS target. Stub "unknown from brief" if the scope doesn't say. This is foundation for later cycles — be accurate, not speculative.`

const SURFACES_PROMPT = `You are Tasker. You've mapped the architecture of {TITLE}. Now enumerate ATTACK SURFACES.

Prior architecture notes:
{NOTES}

Output markdown headings:
## Public Entry Points
Functions an anonymous attacker can call. For each: name, inputs, state it touches, who-can-call.
## Privileged Entry Points
Admin/keeper functions. Per each: required role, what it changes, upgrade/pause path.
## Oracle & External Reads
Any external price/data the contracts trust. Name the source and freshness mechanism.
## External Calls
Calls OUT to other contracts (token transfers, swaps, callbacks). Reentrancy prep.
## Upgrade Surfaces
Proxies, delegatecalls, selfdestruct paths.

Be specific. This is where attacks live.`

const INVARIANTS_PROMPT = `You are Tasker. You have the architecture and surfaces of {TITLE}. Now derive INVARIANTS — properties that MUST always hold for this protocol to be correct and solvent.

Prior notes:
{NOTES}

Frame each as a NEGATION ("X must NEVER be possible"). Number them. Think about:
- Value conservation (sum of balances = vault total)
- Access control (only authorized role can change state)
- State monotonicity (nonces, timestamps only advance)
- Solvency (withdraw ≤ deposit per user, total)
- Oracle freshness (reads never use stale data)
- Reentrancy (external calls after state changes)

Output: numbered markdown list of invariants. 5-15 items. No hedging.`

const HYPOTHESIZE_PROMPT = `You are Tasker. Given the invariants of {TITLE}, generate HYPOTHESES — specific, testable attack ideas that would violate each invariant.

Prior notes:
{NOTES}

Each hypothesis is one row. Prefer ones that drain funds or grant unauthorized access.

Respond with ONLY valid JSON:
{ "hypotheses": [
  {
    "invariant": "which numbered invariant it violates",
    "path": "code path or function that's suspect",
    "preconditions": "what the attacker needs",
    "outcome": "what happens when it works",
    "priority": "high | medium | low"
  }
] }

Generate 3-8 hypotheses. No invented contracts or functions — ground them in prior notes.`

const INVESTIGATE_PROMPT = `You are Tasker. Take hypothesis #{HID} and rigorously evaluate it.

Target: {TITLE}
Hypothesis:
{HYPOTHESIS}

Prior notes (architecture, surfaces, invariants, other hypotheses, prior evidence):
{NOTES}

Evaluate:
1. Can you construct a concrete exploit sketch (ordered steps, precise preconditions)?
2. Is there existing mitigation in the scope that refutes this (a lock, a check, a modifier)?
3. Severity if confirmed: Critical / High / Medium / Low — justify with asset impact.

Respond with ONLY valid JSON, one of two shapes:

If CONFIRMED (you'd submit this):
{
  "verdict": "confirmed",
  "severity": "Critical|High|Medium|Low",
  "confidence": 0.0-1.0,
  "report": "full markdown report with # Title / ## Severity / ## Summary / ## Vulnerable Component / ## Impact / ## Steps to Reproduce / ## Proof of Concept / ## Recommended Fix / ## References"
}

If DISCARDED:
{
  "verdict": "discarded",
  "reason": "one sentence: why it doesn't work"
}

No middle ground. No "might" or "could potentially". Confirm or discard.`

export class ResearchEngine {
  private ai: OpenAI
  private db: PoolClient

  constructor(db: PoolClient) {
    this.db = db
    this.ai = new OpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY!,
      baseURL: 'https://api.deepseek.com/v1',
    })
  }

  // ── Target selection ───────────────────────────────────────────────────────

  async pinOrGetCurrent(candidates: UnifiedBounty[]): Promise<ResearchTarget | null> {
    // 1. Already pinned?
    const { rows: [state] } = await this.db.query(
      'SELECT current_target_id FROM lila_state WHERE id=1'
    )
    if (state?.current_target_id) {
      const t = await this.load(state.current_target_id)
      if (t && (t.status === 'active')) return t
    }

    // 2. Need to pick. Prefer high-reward security bounties we haven't worked.
    if (!candidates.length) return null
    const { rows: prior } = await this.db.query(
      `SELECT bounty_id FROM research_targets WHERE status IN ('exhausted','abandoned')`
    )
    const workedBefore = new Set(prior.map((r: { bounty_id: string }) => r.bounty_id))

    const sorted = [...candidates]
      .filter(c => !workedBefore.has(c.id))
      .sort((a, b) => b.reward - a.reward)
    if (!sorted.length) return null

    const pick = sorted[0]
    const scope = `Title: ${pick.title}\nPlatform: ${pick.platformLabel}\nReward: $${pick.reward} ${pick.token}\nChain: ${pick.chain}\n\nDescription:\n${pick.description}`

    const { rows } = await this.db.query(
      `INSERT INTO research_targets
         (bounty_id, platform, platform_label, title, reward, chain, url, scope)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (bounty_id) DO UPDATE SET
         scope=$8, updated_at=NOW(), status='active'
       RETURNING *`,
      [pick.id, pick.platform, pick.platformLabel, pick.title, pick.reward, pick.chain, pick.url ?? null, scope]
    )
    const target = this.rowToTarget(rows[0])
    await this.db.query('UPDATE lila_state SET current_target_id=$1 WHERE id=1', [target.id])
    return target
  }

  async load(id: number): Promise<ResearchTarget | null> {
    const { rows } = await this.db.query('SELECT * FROM research_targets WHERE id=$1', [id])
    return rows[0] ? this.rowToTarget(rows[0]) : null
  }

  // ── Run one cycle on the pinned target ─────────────────────────────────────

  async runCycle(target: ResearchTarget): Promise<CycleResult> {
    const notesBlob = await this.loadNotes(target.id)
    let nextPhase: ResearchPhase = target.phase
    let incrementFruitless = false
    let finding: { content: string; confidence: number } | null = null

    try {
      switch (target.phase) {
        case 'map': {
          const md = await this.llm(
            MAP_PROMPT.replace('{TITLE}', target.title)
                     .replace('{PLATFORM}', target.platform_label)
                     .replace('{SCOPE}', target.scope.slice(0, 6000)),
            900
          )
          await this.saveNote(target.id, 'arch', md)
          nextPhase = 'surfaces'
          break
        }
        case 'surfaces': {
          const md = await this.llm(
            SURFACES_PROMPT.replace('{TITLE}', target.title).replace('{NOTES}', notesBlob),
            900
          )
          await this.saveNote(target.id, 'surfaces', md)
          nextPhase = 'invariants'
          break
        }
        case 'invariants': {
          const md = await this.llm(
            INVARIANTS_PROMPT.replace('{TITLE}', target.title).replace('{NOTES}', notesBlob),
            700
          )
          await this.saveNote(target.id, 'invariants', md)
          nextPhase = 'hypothesize'
          break
        }
        case 'hypothesize': {
          const raw = await this.llm(
            HYPOTHESIZE_PROMPT.replace('{TITLE}', target.title).replace('{NOTES}', notesBlob),
            900
          )
          const parsed = this.parse(raw, { hypotheses: [] as Hypothesis[] })
          const list = (parsed.hypotheses ?? []).slice(0, 8)
          for (const h of list) {
            await this.saveNote(
              target.id,
              'hypothesis:open',
              JSON.stringify(h),
              `inv:${h.invariant}`
            )
          }
          nextPhase = list.length > 0 ? 'investigate' : 'exhausted'
          break
        }
        case 'investigate': {
          const hypothesis = await this.nextOpenHypothesis(target.id)
          if (!hypothesis) {
            nextPhase = 'exhausted'
            break
          }
          const raw = await this.llm(
            INVESTIGATE_PROMPT
              .replace('{HID}', String(hypothesis.id))
              .replace('{TITLE}', target.title)
              .replace('{HYPOTHESIS}', hypothesis.content)
              .replace('{NOTES}', notesBlob),
            1400
          )
          const verdict = this.parse<InvestigateVerdict>(raw, { verdict: 'discarded', reason: 'unparseable' })
          // Close out this hypothesis either way
          await this.db.query(
            `UPDATE research_notes SET kind='hypothesis:closed' WHERE id=$1`,
            [hypothesis.id]
          )
          if (verdict.verdict === 'confirmed' && verdict.report) {
            await this.saveNote(target.id, 'finding', verdict.report)
            finding = { content: verdict.report, confidence: verdict.confidence ?? 0.7 }
            nextPhase = 'found'
          } else {
            await this.saveNote(
              target.id,
              'evidence',
              `Hypothesis closed: ${hypothesis.content.slice(0, 200)}\n\nReason: ${verdict.reason ?? 'no reason given'}`
            )
            incrementFruitless = true
            // Stay in investigate; next cycle picks the next open hypothesis.
          }
          break
        }
        case 'found':
        case 'exhausted':
          // Terminal states; caller should rotate.
          return {
            action: target.phase === 'found' ? 'finding' : 'exhausted',
            phase: target.phase,
            logMessage: `Target "${target.title}" already ${target.phase}.`,
            logType: 'info',
          }
      }
    } catch (e) {
      return {
        action: 'error',
        phase: target.phase,
        logMessage: `Research ${target.phase} error on "${target.title}": ${String(e)}`,
        logType: 'warn',
      }
    }

    // Persist cycle advance + phase + fruitless counter
    const fruitless = target.fruitless_cycles + (incrementFruitless ? 1 : 0)
    let status: ResearchTarget['status'] = 'active'
    if ((nextPhase as ResearchPhase) === 'found') {
      status = 'found'
    } else if (nextPhase === 'exhausted' || fruitless >= MAX_FRUITLESS_CYCLES) {
      status = 'exhausted'
      nextPhase = 'exhausted'
    }

    await this.db.query(
      `UPDATE research_targets
         SET phase=$1, cycles=cycles+1, fruitless_cycles=$2, status=$3,
             last_worked_at=NOW(), updated_at=NOW()
       WHERE id=$4`,
      [nextPhase, fruitless, status, target.id]
    )

    // If terminal, unpin so next tick picks a new one.
    if (status !== 'active') {
      await this.db.query('UPDATE lila_state SET current_target_id=NULL WHERE id=1')
    }

    if (finding) {
      return {
        action: 'finding',
        phase: nextPhase,
        logMessage: `Finding on "${target.title}" — filing report.`,
        logType: 'success',
        reportContent: finding.content,
        confidence: finding.confidence,
      }
    }

    return {
      action: status === 'exhausted' ? 'exhausted' : 'advanced',
      phase: nextPhase,
      logMessage: `"${target.title}" → ${nextPhase}${incrementFruitless ? ` (fruitless ${fruitless}/${MAX_FRUITLESS_CYCLES})` : ''}.`,
      logType: status === 'exhausted' ? 'warn' : 'info',
    }
  }

  // ── Notes I/O ──────────────────────────────────────────────────────────────

  private async loadNotes(targetId: number): Promise<string> {
    const { rows } = await this.db.query(
      `SELECT kind, content, ref FROM research_notes
       WHERE target_id=$1
       ORDER BY
         CASE kind
           WHEN 'arch' THEN 1 WHEN 'surfaces' THEN 2 WHEN 'invariants' THEN 3
           WHEN 'hypothesis:open' THEN 4 WHEN 'hypothesis:closed' THEN 5
           WHEN 'evidence' THEN 6 WHEN 'finding' THEN 7
           ELSE 8 END ASC,
         id ASC`,
      [targetId]
    )
    const blob = rows
      .map((r: { kind: string; content: string; ref: string | null }) =>
        `=== ${r.kind}${r.ref ? ` [${r.ref}]` : ''} ===\n${r.content}`
      )
      .join('\n\n')
    // If it overflows, keep architecture + surfaces + invariants in full and truncate the rest.
    if (blob.length <= MAX_NOTE_BLOB) return blob
    const prefix = rows
      .filter((r: { kind: string }) => ['arch', 'surfaces', 'invariants'].includes(r.kind))
      .map((r: { kind: string; content: string }) => `=== ${r.kind} ===\n${r.content}`)
      .join('\n\n')
    const tail = blob.slice(-Math.max(MAX_NOTE_BLOB - prefix.length - 100, 1000))
    return `${prefix}\n\n...[older evidence truncated]...\n\n${tail}`
  }

  private async saveNote(targetId: number, kind: string, content: string, ref?: string): Promise<void> {
    await this.db.query(
      `INSERT INTO research_notes (target_id, kind, content, ref) VALUES ($1,$2,$3,$4)`,
      [targetId, kind, content, ref ?? null]
    )
  }

  private async nextOpenHypothesis(targetId: number): Promise<{ id: number; content: string } | null> {
    const { rows } = await this.db.query(
      `SELECT id, content FROM research_notes
       WHERE target_id=$1 AND kind='hypothesis:open'
       ORDER BY id ASC LIMIT 1`,
      [targetId]
    )
    return rows[0] ?? null
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async llm(prompt: string, maxTokens: number): Promise<string> {
    const res = await this.ai.chat.completions.create({
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

  private rowToTarget(r: Record<string, unknown>): ResearchTarget {
    return {
      id: Number(r.id),
      bounty_id: String(r.bounty_id),
      platform: String(r.platform),
      platform_label: String(r.platform_label),
      title: String(r.title),
      reward: parseFloat(String(r.reward)),
      chain: r.chain ? String(r.chain) : undefined,
      url: r.url ? String(r.url) : undefined,
      scope: String(r.scope),
      phase: String(r.phase) as ResearchPhase,
      cycles: Number(r.cycles),
      fruitless_cycles: Number(r.fruitless_cycles),
      status: String(r.status) as ResearchTarget['status'],
    }
  }
}

interface Hypothesis {
  invariant: string
  path: string
  preconditions: string
  outcome: string
  priority: 'high' | 'medium' | 'low'
}

interface InvestigateVerdict {
  verdict: 'confirmed' | 'discarded'
  severity?: string
  confidence?: number
  report?: string
  reason?: string
}
