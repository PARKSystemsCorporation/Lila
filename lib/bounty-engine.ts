import OpenAI from 'openai'
import type { PoolClient } from 'pg'
import * as ClawTasks from './platforms/clawtasks'
import * as Superteam from './platforms/superteam'
import type { UnifiedBounty } from './bounties-fetch'
import { llmCall, LLMBudgetExceeded } from './llm'

export type { UnifiedBounty }

export interface EngineResult {
  action: 'claimed' | 'submitted' | 'drafted' | 'researching' | 'idle' | 'error'
  bountyId?: string
  title?: string
  reward?: number
  platform?: string
  logMessage: string
  logType: 'info' | 'success' | 'warn'
}

// Security bounties are surfaced separately so Cipher can route them into the
// target-pinned ResearchEngine loop instead of a one-shot LLM pass.
export function pickSecurityCandidates(bounties: UnifiedBounty[]): UnifiedBounty[] {
  return bounties
    .filter(b => b.reward >= 50)
    .filter(b => {
      const blob = `${b.title} ${b.description}`.toLowerCase()
      return SECURITY_KEYWORDS.some(k => blob.includes(k))
        && !OFF_TOPIC_KEYWORDS.some(k => blob.includes(k))
    })
    .sort((a, b) => b.reward - a.reward)
}

// Documentation / technical-writing candidates. Low-friction payouts while
// Cipher alternates away from deep security cycles.
export function pickDocsCandidates(bounties: UnifiedBounty[]): UnifiedBounty[] {
  return bounties
    .filter(b => b.reward >= 50)
    .filter(b => {
      const blob = `${b.title} ${b.description}`.toLowerCase()
      return DOCS_KEYWORDS.some(k => blob.includes(k))
        && !OFF_TOPIC_KEYWORDS.some(k => blob.includes(k))
    })
    .sort((a, b) => b.reward - a.reward)
}

const WALLET = process.env.WALLET_ADDRESS ?? ''

// Security focus: anything matching these tags gets top priority. Content /
// marketing / design bounties are skipped — Cipher's edge is code, not copy.
const SECURITY_KEYWORDS = [
  'audit', 'security', 'vuln', 'vulnerab', 'exploit', 'bug bounty',
  'smart contract', 'contract review', 'code review', 'pentest',
  'penetration test', 'sast', 'dast', 'reentrancy', 'cve', 'ctf',
  'fuzz', 'static analysis', 'formal verif', 'invariant',
]

const DOCS_KEYWORDS = [
  'documentation', 'docs', 'readme', 'api docs', 'api reference',
  'technical writing', 'technical writer', 'tech writing',
  'tutorial', 'integration guide', 'quickstart', 'quick start',
  'developer docs', 'dev docs', 'getting started', 'onboarding guide',
  'whitepaper', 'explainer', 'write up', 'write-up', 'changelog',
]

// Explicit drop list — Cipher will not even score these.
const OFF_TOPIC_KEYWORDS = [
  'video', 'logo', 'design', 'meme', 'twitter thread', 'marketing',
  'social media', 'community manager', 'illustration', 'graphic',
]

function classify(b: UnifiedBounty): 'security' | 'docs' | 'code' | 'offtopic' | 'other' {
  const blob = `${b.title} ${b.description}`.toLowerCase()
  if (OFF_TOPIC_KEYWORDS.some(k => blob.includes(k))) return 'offtopic'
  if (SECURITY_KEYWORDS.some(k => blob.includes(k))) return 'security'
  if (DOCS_KEYWORDS.some(k => blob.includes(k))) return 'docs'
  if (/\b(code|script|smart[- ]?contract|backend|api|sdk|integration|refactor|bug)\b/.test(blob)) return 'code'
  return 'other'
}

const SCORE_PROMPT = `You are Cipher's triage module. Decide if this bounty is a task Cipher can complete autonomously.

Respond with ONLY valid JSON:
{
  "canComplete": true/false,
  "confidence": 0.0–1.0,
  "reason": "one sentence",
  "mode": "security_report" | "docs_work" | "code_work" | "skip"
}

Modes:
- security_report — smart-contract audits, vulnerability writeups, code-review security reports, invariant documentation.
- docs_work       — README rewrites, API reference, integration guides, quickstarts, technical writing.
- code_work       — non-security code tasks, SDK integrations, scripts, technical problem solving.

Tasks you CANNOT: running live exploits, KYC/identity verification, video / audio / image generation, marketing posts, visual design, community moderation.`

const SECURITY_REPORT_PROMPT = `You are Cipher, filing a security vulnerability report on a bug bounty program. Target the ACTUAL published bounty brief below and write a report in the standard format reviewers expect.

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

const CODE_WORK_PROMPT = `You are Cipher completing a paid code / audit bounty. Deliver the real work, not an outline.

Bounty: {TITLE}
Requirements: {DESCRIPTION}

Output the full deliverable now. Markdown if it's a report, raw code if it's code. No preamble.`

const DOCS_WORK_PROMPT = `You are Cipher completing a paid documentation bounty. Write publishable-quality technical documentation.

Bounty: {TITLE}
Scope: {DESCRIPTION}

Output a complete, polished markdown document. Rules:
- Write for developers, not marketers. No fluff.
- Lead with the most important thing (quick start, key function, primary use case).
- Code blocks must be syntactically valid and minimal.
- Section hierarchy: # top, ## subsections, ### sparingly.
- Tables for parameter / return / response references.
- Prefer concrete examples over prose.
- Stay inside the scope the brief requests. Don't bolt on sections that weren't asked for.
- No apologies, no meta commentary, no "I hope this helps".

If the brief lacks enough context to write useful docs, emit ONLY:
  INSUFFICIENT_SCOPE: <one-sentence why>`

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
    bounties: UnifiedBounty[],
    // When set, gives that category a score bonus so the alternation turn
    // preference sticks even if raw confidence is comparable.
    preferCategory?: 'security' | 'docs' | 'code',
  ): Promise<(UnifiedBounty & { confidence: number; rawScore: number; mode: 'security_report' | 'docs_work' | 'code_work' })[]> {
    // Pre-filter: drop explicit off-topic; keep security, docs, and code.
    const candidates = bounties
      .filter(b => b.reward >= 50)
      .map(b => ({ b, cat: classify(b) }))
      .filter(({ cat }) => cat !== 'offtopic')
      .sort((a, b) => {
        const prio = (c: string) => (
          c === 'security' ? 0 : c === 'docs' ? 1 : c === 'code' ? 2 : 3
        )
        return prio(a.cat) - prio(b.cat)
      })
      .slice(0, 8)
      .map(({ b }) => b)

    const scored = await Promise.all(candidates.map(async b => {
      try {
        const { content } = await llmCall({
          ai: this.ai,
          module: 'bounty.score',
          messages: [
            { role: 'system', content: SCORE_PROMPT },
            { role: 'user', content: `Title: ${b.title}\n\nDescription: ${b.description.slice(0, 1200)}` },
          ],
          max_tokens: 160,
          temperature: 0.2,
        })
        const score = JSON.parse(content || '{}')
        if (score.mode === 'skip' || !score.canComplete) {
          return { ...b, confidence: 0, rawScore: 0, mode: 'code_work' as const }
        }
        const confidence = Number(score.confidence) || 0
        const mode: 'security_report' | 'docs_work' | 'code_work' =
          score.mode === 'security_report' ? 'security_report' :
          score.mode === 'docs_work'       ? 'docs_work'       : 'code_work'
        // Base weights: security gets the biggest ceiling, docs are
        // low-friction so we score them close to security, code trails.
        const baseWeight = mode === 'security_report' ? 1.2 : mode === 'docs_work' ? 1.1 : 1.0
        // Alternation nudge: preferCategory gets +20% rawScore so the
        // current turn's mode actually wins ties.
        const prefBonus = preferCategory && (
          (preferCategory === 'security' && mode === 'security_report') ||
          (preferCategory === 'docs'     && mode === 'docs_work') ||
          (preferCategory === 'code'     && mode === 'code_work')
        ) ? 1.2 : 1.0
        const weight = baseWeight * prefBonus
        return { ...b, confidence, rawScore: b.reward * confidence * weight, mode }
      } catch (e) {
        if (e instanceof LLMBudgetExceeded) throw e
        return { ...b, confidence: 0, rawScore: 0, mode: 'code_work' as const }
      }
    }))

    return scored.sort((a, b) => b.rawScore - a.rawScore)
  }

  // ── Generate output ────────────────────────────────────────────────────

  async executeWork(
    bounty: UnifiedBounty,
    mode: 'security_report' | 'docs_work' | 'code_work'
  ): Promise<{ content: string; hasFinding: boolean }> {
    const prompt =
      mode === 'security_report' ? SECURITY_REPORT_PROMPT :
      mode === 'docs_work'       ? DOCS_WORK_PROMPT       : CODE_WORK_PROMPT
    const moduleName =
      mode === 'security_report' ? 'bounty.work.security' :
      mode === 'docs_work'       ? 'bounty.work.docs'     : 'bounty.work.code'
    const { content: resContent } = await llmCall({
      ai: this.ai,
      module: moduleName,
      messages: [{
        role: 'user',
        content: prompt
          .replace('{TITLE}', bounty.title)
          .replace('{DESCRIPTION}', bounty.description.slice(0, 3000)),
      }],
      max_tokens: 2200,
      temperature: 0.4,
    })
    const content = resContent.trim()
    // security: NO_FINDING = skip. docs: INSUFFICIENT_SCOPE = skip.
    // code: any non-trivial output counts.
    const hasFinding =
      mode === 'security_report' ? !content.startsWith('NO_FINDING') :
      mode === 'docs_work'       ? !content.startsWith('INSUFFICIENT_SCOPE') && content.length > 200 :
                                   content.length > 100
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

  // ── Record any submission (code or security). Acceptance by a platform
  // API is NOT payment — reviewers still decide. Everything lands here
  // with status='submitted' (code) or 'pending_review' (security drafts);
  // total_earned is only credited when the operator confirms payout.

  async saveSubmission(
    db: PoolClient,
    bounty: UnifiedBounty,
    content: string,
    confidence: number,
    kind: 'security' | 'code' | 'docs',
    status: 'pending_review' | 'submitted',
  ): Promise<number | null> {
    try {
      const { rows } = await db.query(
        `INSERT INTO security_reports
           (bounty_id, platform, platform_label, title, reward, chain, url,
            content, confidence, status, kind, submitted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
                 CASE WHEN $10='submitted' THEN NOW() ELSE NULL END)
         ON CONFLICT (bounty_id) DO UPDATE SET
           content=$8, confidence=$9, status=$10, kind=$11,
           submitted_at=CASE WHEN $10='submitted' THEN NOW() ELSE security_reports.submitted_at END,
           review_notes=NULL, updated_at=NOW()
         RETURNING id`,
        [
          bounty.id, bounty.platform, bounty.platformLabel, bounty.title,
          bounty.reward, bounty.chain, bounty.url ?? null,
          content, confidence, status, kind,
        ]
      )
      return rows[0]?.id ?? null
    } catch { return null }
  }

  async saveDraftReport(
    db: PoolClient,
    bounty: UnifiedBounty,
    content: string,
    confidence: number
  ): Promise<number | null> {
    return this.saveSubmission(db, bounty, content, confidence, 'security', 'pending_review')
  }

  // ── Main tick ──────────────────────────────────────────────────────────

  async tick(
    assignedBounty: UnifiedBounty | null,
    liveBounties: UnifiedBounty[],
    db?: PoolClient,
    preferCategory?: 'security' | 'docs' | 'code',
  ): Promise<EngineResult> {
    const workQueue = assignedBounty
      ? [assignedBounty, ...liveBounties.filter(b => b.id !== assignedBounty.id)]
      : liveBounties

    if (workQueue.length === 0) {
      return { action: 'idle', logMessage: 'No bounties on the board right now.', logType: 'info' }
    }

    const scored = await this.scoreBounties(workQueue, preferCategory)
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

    // Security report mode: always save a draft for Lila's review queue.
    // Immunefi is read-only, and on writable platforms we still vet before
    // auto-submit to keep noise down.
    if (best.mode === 'security_report') {
      if (db) {
        await this.saveDraftReport(db, best, output.content, best.confidence)
      }
      return {
        action: 'drafted',
        bountyId: best.id,
        title: best.title,
        reward: best.reward,
        platform: best.platformLabel,
        logMessage: `Draft report filed: "${best.title}" — $${best.reward} on ${best.platformLabel}. Lila reviewing.`,
        logType: 'success',
      }
    }

    // Docs mode: same review gate as security. Lila vets the writing quality
    // before the operator sees it, then the operator submits to the platform
    // (or opens the PR on GitHub if the bounty requires it).
    if (best.mode === 'docs_work') {
      if (db) {
        await this.saveSubmission(db, best, output.content, best.confidence, 'docs', 'pending_review')
      }
      return {
        action: 'drafted',
        bountyId: best.id,
        title: best.title,
        reward: best.reward,
        platform: best.platformLabel,
        logMessage: `Draft docs filed: "${best.title}" — $${best.reward} on ${best.platformLabel}. Lila reviewing.`,
        logType: 'success',
      }
    }

    // Writable + approved path: submit. Acceptance ≠ payment — we record
    // the submission and the operator marks paid when money arrives.
    const submitted = await this.claimAndSubmit(best, output.content).catch(() => false)
    const chain = best.chain === 'Solana' ? '(you cash out)' : `→ ${WALLET.slice(0, 10)}...`

    if (submitted) {
      if (db) {
        await this.saveSubmission(db, best, output.content, best.confidence, 'code', 'submitted')
      }
      const manualNote = best.platform === 'bountycaster' ? ' Submit via Warpcast.' : ''
      return {
        action: 'submitted',
        bountyId: best.id,
        title: best.title,
        reward: best.reward,
        platform: best.platformLabel,
        logMessage: `Submitted: "${best.title}" on ${best.platformLabel}. Max $${best.reward} pending payout ${chain}.${manualNote}`,
        logType: 'success',
      }
    }

    return { action: 'error', logMessage: `Submission failed on ${best.platformLabel}. Will retry.`, logType: 'warn' }
  }
}
