import OpenAI from 'openai'
import type { PoolClient } from 'pg'
import * as ClawTasks from './platforms/clawtasks'
import * as Superteam from './platforms/superteam'
import type { UnifiedBounty } from './bounties-fetch'

export type { UnifiedBounty }

export interface EngineResult {
  action: 'claimed' | 'submitted' | 'drafted' | 'idle' | 'error'
  bountyId?: string
  title?: string
  reward?: number
  platform?: string
  logMessage: string
  logType: 'info' | 'success' | 'warn'
}

const WALLET = process.env.WALLET_ADDRESS ?? ''

// Security focus: anything matching these tags gets top priority. Content /
// marketing / design bounties are skipped — Tasker's edge is code, not copy.
const SECURITY_KEYWORDS = [
  'audit', 'security', 'vuln', 'vulnerab', 'exploit', 'bug bounty',
  'smart contract', 'contract review', 'code review', 'pentest',
  'penetration test', 'sast', 'dast', 'reentrancy', 'cve', 'ctf',
  'fuzz', 'static analysis', 'formal verif', 'invariant',
]

// Explicit drop list — Tasker will not even score these.
const OFF_TOPIC_KEYWORDS = [
  'video', 'logo', 'design', 'meme', 'twitter thread', 'marketing',
  'social media', 'community manager', 'illustration', 'graphic',
]

function classify(b: UnifiedBounty): 'security' | 'code' | 'offtopic' | 'other' {
  const blob = `${b.title} ${b.description}`.toLowerCase()
  if (OFF_TOPIC_KEYWORDS.some(k => blob.includes(k))) return 'offtopic'
  if (SECURITY_KEYWORDS.some(k => blob.includes(k))) return 'security'
  if (/\b(code|script|smart[- ]?contract|backend|api|sdk|integration|refactor|bug)\b/.test(blob)) return 'code'
  return 'other'
}

const SCORE_PROMPT = `You are Tasker's triage module. Decide if this bounty is a security/audit/code-review task Tasker can complete autonomously using static analysis, reading source code, and writing a report or code output.

Respond with ONLY valid JSON:
{
  "canComplete": true/false,
  "confidence": 0.0–1.0,
  "reason": "one sentence",
  "mode": "security_report" | "code_work" | "skip"
}

Tasks you CAN do: smart-contract audits, code review, vulnerability writeups, static analysis reports, bug writeups with PoC pseudocode, security checklists, invariant documentation.
Tasks you CANNOT: tasks requiring running exploits on live chains, KYC, video/audio creation, social posts, design.`

const SECURITY_REPORT_PROMPT = `You are Tasker, filing a security vulnerability report on a bug bounty program. Target the ACTUAL published bounty brief below and write a report in the standard format reviewers expect.

Bounty: {TITLE}
Scope: {DESCRIPTION}

Output a single markdown report with these sections:
# Title
## Severity
One of: Critical, High, Medium, Low. Justify briefly.
## Summary
One paragraph of what the issue is.
## Vulnerable Component
File / contract / function references where possible.
## Impact
What an attacker gains. Concrete dollar/asset impact if estimable.
## Steps to Reproduce
Numbered, deterministic.
## Proof of Concept
Pseudocode or minimal code sketch of the attack.
## Recommended Fix
Specific, code-level.
## References
Any CVE / SWC / Hacken class references that apply.

Rules:
- NEVER fabricate a finding. If you can't identify a concrete issue from the scope, emit ONLY:
  "NO_FINDING: <one-sentence reason>"
- Do NOT include preamble, greetings, or meta commentary.
- Severity must be justified. "High" or above needs a direct asset-loss path.`

const CODE_WORK_PROMPT = `You are Tasker completing a paid code / audit bounty. Deliver the real work, not an outline.

Bounty: {TITLE}
Requirements: {DESCRIPTION}

Output the full deliverable now. Markdown if it's a report, raw code if it's code. No preamble.`

export class BountyEngine {
  private ai: OpenAI

  constructor() {
    this.ai = new OpenAI({
      apiKey: process.env.DEEPSEEK_API_KEY!,
      baseURL: 'https://api.deepseek.com/v1',
    })
  }

  // ── Score a list of bounties with DeepSeek ─────────────────────────────

  async scoreBounties(
    bounties: UnifiedBounty[]
  ): Promise<(UnifiedBounty & { confidence: number; rawScore: number; mode: 'security_report' | 'code_work' })[]> {
    // Pre-filter: drop explicit off-topic, prefer security/code.
    const candidates = bounties
      .filter(b => b.reward >= 50)
      .map(b => ({ b, cat: classify(b) }))
      .filter(({ cat }) => cat !== 'offtopic')
      .sort((a, b) => {
        const prio = (c: string) => (c === 'security' ? 0 : c === 'code' ? 1 : 2)
        return prio(a.cat) - prio(b.cat)
      })
      .slice(0, 6)
      .map(({ b }) => b)

    const scored = await Promise.all(candidates.map(async b => {
      try {
        const res = await this.ai.chat.completions.create({
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: SCORE_PROMPT },
            { role: 'user', content: `Title: ${b.title}\n\nDescription: ${b.description.slice(0, 1200)}` },
          ],
          max_tokens: 160,
          temperature: 0.2,
        })
        const raw = (res.choices[0]?.message?.content ?? '{}')
          .replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '')
        const score = JSON.parse(raw)
        if (score.mode === 'skip' || !score.canComplete) {
          return { ...b, confidence: 0, rawScore: 0, mode: 'code_work' as const }
        }
        const confidence = Number(score.confidence) || 0
        const mode: 'security_report' | 'code_work' =
          score.mode === 'security_report' ? 'security_report' : 'code_work'
        // Prefer security mode with a 20% score bonus — that's the grinding ground.
        const weight = mode === 'security_report' ? 1.2 : 1.0
        return { ...b, confidence, rawScore: b.reward * confidence * weight, mode }
      } catch {
        return { ...b, confidence: 0, rawScore: 0, mode: 'code_work' as const }
      }
    }))

    return scored.sort((a, b) => b.rawScore - a.rawScore)
  }

  // ── Generate output ────────────────────────────────────────────────────

  async executeWork(
    bounty: UnifiedBounty,
    mode: 'security_report' | 'code_work'
  ): Promise<{ content: string; hasFinding: boolean }> {
    const prompt = mode === 'security_report' ? SECURITY_REPORT_PROMPT : CODE_WORK_PROMPT
    const res = await this.ai.chat.completions.create({
      model: 'deepseek-chat',
      messages: [{
        role: 'user',
        content: prompt
          .replace('{TITLE}', bounty.title)
          .replace('{DESCRIPTION}', bounty.description.slice(0, 3000)),
      }],
      max_tokens: 2200,
      temperature: 0.4,
    })
    const content = res.choices[0]?.message?.content?.trim() ?? ''
    const hasFinding = mode === 'security_report'
      ? !content.startsWith('NO_FINDING')
      : content.length > 100
    return { content, hasFinding }
  }

  // ── Claim + submit on writable platforms ───────────────────────────────

  async claimAndSubmit(bounty: UnifiedBounty, work: string): Promise<boolean> {
    const rawId = bounty.id.replace(/^(st|bc|ct|imf)_/, '')

    if (bounty.platform === 'clawtasks' && process.env.CLAWTASKS_API_KEY) {
      const claimed = await ClawTasks.claimBounty(process.env.CLAWTASKS_API_KEY, rawId)
      if (!claimed) return false
      return ClawTasks.submitWork(process.env.CLAWTASKS_API_KEY, { bountyId: rawId, content: work })
    }

    if (bounty.platform === 'superteam' && process.env.SUPERTEAM_API_KEY) {
      return Superteam.submitWork(process.env.SUPERTEAM_API_KEY, { listingId: rawId, content: work })
    }

    if (bounty.platform === 'bountycaster') {
      return true  // work ready; operator submits via Warpcast
    }

    return false
  }

  // ── Save a draft report (Immunefi + any security finding) ─────────────

  async saveDraftReport(
    db: PoolClient,
    bounty: UnifiedBounty,
    content: string,
    confidence: number
  ): Promise<number | null> {
    try {
      const { rows } = await db.query(
        `INSERT INTO security_reports
           (bounty_id, platform, platform_label, title, reward, chain, url, content, confidence, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft')
         ON CONFLICT (bounty_id) DO UPDATE SET content=$8, confidence=$9, updated_at=NOW()
         RETURNING id`,
        [
          bounty.id, bounty.platform, bounty.platformLabel, bounty.title,
          bounty.reward, bounty.chain, bounty.url ?? null, content, confidence,
        ]
      )
      return rows[0]?.id ?? null
    } catch { return null }
  }

  // ── Main tick ──────────────────────────────────────────────────────────

  async tick(
    assignedBounty: UnifiedBounty | null,
    liveBounties: UnifiedBounty[],
    db?: PoolClient
  ): Promise<EngineResult> {
    const workQueue = assignedBounty
      ? [assignedBounty, ...liveBounties.filter(b => b.id !== assignedBounty.id)]
      : liveBounties

    if (workQueue.length === 0) {
      return { action: 'idle', logMessage: 'No bounties on the board right now.', logType: 'info' }
    }

    const scored = await this.scoreBounties(workQueue)
    const best = (assignedBounty && scored.find(b => b.id === assignedBounty.id && b.confidence > 0.4))
      ?? scored.find(b => b.confidence > 0.6)

    if (!best) {
      return {
        action: 'idle',
        logMessage: `Scored ${scored.length} bounties. None above threshold. Standing by.`,
        logType: 'info',
      }
    }

    // Produce the output
    let output: { content: string; hasFinding: boolean }
    try {
      output = await this.executeWork(best, best.mode)
    } catch {
      return { action: 'error', logMessage: `Work generation failed for "${best.title}".`, logType: 'warn' }
    }

    // No real finding on a security pass → don't submit, don't draft, just log.
    if (!output.hasFinding) {
      return {
        action: 'idle',
        logMessage: `Reviewed "${best.title}" — no finding. ${output.content.replace('NO_FINDING:', '').trim().slice(0, 120)}`,
        logType: 'info',
      }
    }

    // Security report mode:
    // 1. Always save a draft report for operator review.
    // 2. Auto-submit only on non-read-only platforms where a draft goes to triage,
    //    not directly to payout (keeps noise down).
    if (best.mode === 'security_report') {
      if (db) {
        await this.saveDraftReport(db, best, output.content, best.confidence)
      }
      // Immunefi is read-only; we always stop at draft and notify the operator.
      if (best.readOnly) {
        return {
          action: 'drafted',
          bountyId: best.id,
          title: best.title,
          reward: best.reward,
          platform: best.platformLabel,
          logMessage: `Draft report ready: "${best.title}" — $${best.reward} on ${best.platformLabel}. Operator review required.`,
          logType: 'success',
        }
      }
      // Writable platforms: still draft, and auto-submit only if assigned or very confident.
      const shouldAutoSubmit = assignedBounty?.id === best.id || best.confidence >= 0.85
      if (!shouldAutoSubmit) {
        return {
          action: 'drafted',
          bountyId: best.id,
          title: best.title,
          reward: best.reward,
          platform: best.platformLabel,
          logMessage: `Draft report filed: "${best.title}" on ${best.platformLabel}. Awaiting operator approval.`,
          logType: 'success',
        }
      }
    }

    // Writable + approved path: submit.
    const submitted = await this.claimAndSubmit(best, output.content).catch(() => false)
    const chain = best.chain === 'Solana' ? '(you cash out)' : `→ ${WALLET.slice(0, 10)}...`

    if (submitted) {
      const manualNote = best.platform === 'bountycaster' ? ' Submit via Warpcast.' : ''
      return {
        action: 'submitted',
        bountyId: best.id,
        title: best.title,
        reward: best.reward,
        platform: best.platformLabel,
        logMessage: `Submitted: "${best.title}" on ${best.platformLabel}. $${best.reward} pending ${chain}.${manualNote}`,
        logType: 'success',
      }
    }

    return { action: 'error', logMessage: `Submission failed on ${best.platformLabel}. Will retry.`, logType: 'warn' }
  }
}
