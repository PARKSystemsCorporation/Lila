import OpenAI from 'openai'
import type { PoolClient } from 'pg'
import { llmCall, LLMBudgetExceeded } from './llm'
import { cfg } from './config'

// ── Scout: volume bounty hunter ───────────────────────────────────────────
//
// Sibling to Cipher. Cipher goes deep on speculative audits and complex
// DeFi for $15k+ payouts. Scout goes shallow + fast on $1-5k targets:
// recently-listed protocols, forks of majors, post-seed scrappy projects.
// Higher miss rate is acceptable. Goal: 5-10 submissions per week.
//
// Reads from watch_targets (Discovery's pool). Writes drafts to
// security_reports tagged source='scout' so Lila reviews them in the
// same Library queue as Cipher's drafts. She knows scouts are at speed.
//
// Loop is one target per cycle, time-gated by SCOUT_RUN_SEC (default 5min).
//
//   S0 — Pick the freshest unscanned target from watch_targets.
//        Skip targets we've already scanned (in scout_findings).
//   S1 — Shallow LLM triage. Single low-token call. Output: severity,
//        one-line summary, fix sketch.
//   S2 — If severity ≥ medium, draft a security_reports row in
//        pending_review for Lila + log a scout_findings row.
//        Otherwise log scout_findings as 'dismissed' so we skip next time.

const SHALLOW_TRIAGE_PROMPT = `You are Scout, a high-volume bounty hunter on Lila's team. Cipher does deep audits; you grind small wins fast. Speed > thoroughness. Higher false-positive rate is acceptable — Lila reviews every draft before it goes out. Goal: stack $50-5k payouts.

Triage this target. You have ~60 seconds of model time, not 60 minutes.

TARGET:
  Name:   {NAME}
  Source: {SOURCE}
  URL:    {URL}
  Chain:  {CHAIN}
  Scope:  {SCOPE}

CATEGORIES YOU CAN FLAG (any one is fair game — small wins compound):

A) Security (the classic security_reports payload, $500-$5000):
   1. Access control — missing onlyOwner, public functions that mutate state, unprotected admin entries.
   2. Reentrancy — external calls before state writes, missing nonReentrant on payable / withdraw paths.
   3. Oracle / price manipulation — single-source feeds, no TWAP, spot reads in liquidations.
   4. Integer issues — unchecked math, rounding errors in shares/asset conversions.
   5. Token approvals — infinite approvals on aggregator paths, missing safeTransfer.
   6. Init / upgrade — uninitialized proxies, public initializers, missing storage gaps.
   7. Forked code drift — minor mods to a known protocol that break invariants.

B) Gas optimization ($50-$500 — Immunefi calls these "low-hanging fruit"):
   8. Storage slot packing — variables declared in wrong order, wasted slots.
   9. Redundant SLOAD — same storage var read multiple times in a function.
   10. unchecked{} blocks missing on safe arithmetic (post-0.8 Solidity).
   11. Public → external on functions never called internally.
   12. immutable / constant on values set once at deploy.
   13. Custom errors instead of revert strings.

C) Quick-fix code bounties ($50-$200 — Gitcoin / Code4rena micro-tickets):
   14. Off-by-one in loops or array indexing.
   15. Broken require / assert messages, swapped argument order.
   16. Stale documentation that disagrees with the implementation.
   17. Unsanitized inputs that produce confusing errors (not a vuln, just UX).

Output strict JSON:
{
  "category": "security" | "gas" | "code",
  "severity": "critical" | "high" | "medium" | "low" | "none",
  "summary":  "one-sentence finding (or 'no obvious issues')",
  "details":  "2-4 sentences: what + why + suggested fix. Empty if severity=none.",
  "confidence": 0.0..1.0
}

Severity mapping rough guide:
  - security:  critical = chain-of-funds risk, high = significant loss, medium = griefing/limited loss, low = best-practice
  - gas:       high = >5000 gas saved per call, medium = 500-5000, low = <500
  - code:      high = correctness bug operator-visible, medium = test-detectable defect, low = polish

If you can't tell from the surface info alone, return severity="none" + summary="needs deeper scan — punt to Cipher". Don't fabricate findings — Lila will reject and your hit rate drops.`

interface RawTriage {
  category?: string
  severity?: string
  summary?: string
  details?: string
  confidence?: number
}

interface ScoutResult {
  logMessage: string
  logType: 'info' | 'success' | 'warn'
}

export class ScoutLoop {
  private db: PoolClient
  private ai: OpenAI | null

  constructor(db: PoolClient) {
    this.db = db
    this.ai = process.env.DEEPSEEK_API_KEY
      ? new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com/v1' })
      : null
  }

  async shouldRun(): Promise<boolean> {
    const { rows: [s] } = await this.db.query('SELECT last_step_at FROM scout_state WHERE id=1')
    if (!s?.last_step_at) return true
    return (Date.now() - new Date(s.last_step_at).getTime()) / 1000 >= cfg.SCOUT_RUN_SEC
  }

  async run(): Promise<ScoutResult | null> {
    if (!(await this.shouldRun())) return null
    if (!this.ai) {
      await this.markStep()
      return { logMessage: 'Scout: no LLM key, skipping.', logType: 'warn' }
    }

    // S0: pick a target.
    const target = await this.pickTarget()
    if (!target) {
      await this.markStep()
      return { logMessage: 'Scout: queue empty, idle.', logType: 'info' }
    }

    // S1: shallow triage.
    let triage: RawTriage
    try {
      triage = await this.triage(target)
    } catch (e) {
      if (e instanceof LLMBudgetExceeded) {
        await this.markStep()
        return { logMessage: 'Scout: budget hit, skipping.', logType: 'warn' }
      }
      await this.markStep()
      return { logMessage: `Scout triage error: ${String(e).slice(0, 120)}`, logType: 'warn' }
    }

    const category = normalizeCategory(triage.category)
    const severity = normalizeSeverity(triage.severity)
    const summary = String(triage.summary ?? '').slice(0, 280).trim()
    const details = String(triage.details ?? '').slice(0, 4000).trim()
    const confidence = clamp01(triage.confidence) ?? 0.4

    // S2: log + (maybe) file report. We file gas/code low-severity too —
    // Lila's whole point of Scout is grinding $50-$500 quick wins.
    const minSeverity = category === 'security' ? ['critical', 'high', 'medium'] : ['high', 'medium', 'low']
    const shouldReport = minSeverity.includes(severity) && summary && details
    let reportId: number | null = null

    if (shouldReport) {
      const reportKind = category === 'security' ? 'security' : 'code'
      const { rows: [row] } = await this.db.query(
        `INSERT INTO security_reports
           (bounty_id, platform, platform_label, title, reward, chain, url,
            content, confidence, status, source, kind)
         VALUES ($1, 'scout', 'Scout (volume)', $2, $3, $4, $5, $6, $7, 'pending_review', 'scout', $8)
         ON CONFLICT (bounty_id) DO UPDATE
           SET content=$6, confidence=$7, status='pending_review', updated_at=NOW()
         RETURNING id`,
        [
          `scout:${target.id}:${category}:${severity}`,
          `[Scout/${category}/${severity}] ${target.name}: ${summary.slice(0, 100)}`,
          guessReward(category, severity),
          target.chain ?? null,
          target.url ?? null,
          renderReportBody(target, category, severity, summary, details, confidence),
          confidence,
          reportKind,
        ]
      )
      reportId = Number(row.id)
    }

    await this.db.query(
      `INSERT INTO scout_findings
         (target_id, target_name, target_url, severity, summary, details, report_id, status, scanned_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
      [
        target.id, target.name, target.url ?? null,
        severity, summary || null, details || null,
        reportId,
        shouldReport ? 'reported' : 'dismissed',
      ]
    )

    await this.markStep()

    if (shouldReport) {
      return {
        logMessage: `Scout filed ${severity} on ${target.name}: ${summary.slice(0, 80)}`,
        logType: 'success',
      }
    }
    return {
      logMessage: `Scout scanned ${target.name} — no flag (${severity}).`,
      logType: 'info',
    }
  }

  // ── S0 ────────────────────────────────────────────────────────────────

  private async pickTarget(): Promise<TargetRow | null> {
    // Freshest watching target we haven't scanned yet. Prefer recent
    // listings (they're likeliest to have shipped fast / unaudited).
    const { rows } = await this.db.query(
      `SELECT id, source, external_id, name, url, chain, scope, listed_at, first_seen_at
       FROM watch_targets
       WHERE status = 'watching'
         AND id NOT IN (SELECT target_id FROM scout_findings WHERE target_id IS NOT NULL)
       ORDER BY COALESCE(listed_at, first_seen_at) DESC
       LIMIT 1`
    )
    return rows[0] ?? null
  }

  // ── S1 ────────────────────────────────────────────────────────────────

  private async triage(target: TargetRow): Promise<RawTriage> {
    const prompt = SHALLOW_TRIAGE_PROMPT
      .replace('{NAME}',   target.name)
      .replace('{SOURCE}', target.source)
      .replace('{URL}',    target.url ?? '(no url)')
      .replace('{CHAIN}',  target.chain ?? '(no chain)')
      .replace('{SCOPE}',  (target.scope ?? '(no scope blurb)').slice(0, 800))

    const { content } = await llmCall({
      ai: this.ai!,
      module: 'scout.triage',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 350,
      temperature: 0.2,
    })
    try {
      return JSON.parse(content.replace(/```json|```/g, '').trim())
    } catch {
      return { severity: 'none', summary: 'malformed triage output', details: '', confidence: 0 }
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────

  private async markStep(): Promise<void> {
    await this.db.query(
      `UPDATE scout_state SET last_step_at=NOW(), cycle=cycle+1, updated_at=NOW() WHERE id=1`
    )
  }
}

// ── types ────────────────────────────────────────────────────────────────

interface TargetRow {
  id: number
  source: string
  external_id: string
  name: string
  url: string | null
  chain: string | null
  scope: string | null
  listed_at: string | null
  first_seen_at: string
}

// ── pure helpers ─────────────────────────────────────────────────────────

function normalizeSeverity(s: string | undefined): string {
  const v = String(s ?? '').toLowerCase().trim()
  if (['critical', 'high', 'medium', 'low', 'none'].includes(v)) return v
  return 'none'
}

function normalizeCategory(c: string | undefined): 'security' | 'gas' | 'code' {
  const v = String(c ?? '').toLowerCase().trim()
  if (v === 'gas')  return 'gas'
  if (v === 'code') return 'code'
  return 'security'
}

function clamp01(n: unknown): number | null {
  if (n == null || !Number.isFinite(n as number)) return null
  const v = Number(n)
  if (v < 0) return 0
  if (v > 1) return 1
  return +v.toFixed(2)
}

// Heuristic max-bounty by category × severity. Scout's targets are smaller
// protocols and tighter brackets than Cipher's deep-audit drafts.
//   security: standard Immunefi-style brackets
//   gas:      Immunefi "low-hanging fruit" + Code4rena gas pools, ~$50-500
//   code:     Gitcoin / Code4rena micro-tickets, ~$50-200
function guessReward(category: 'security' | 'gas' | 'code', severity: string): number {
  if (category === 'security') {
    switch (severity) {
      case 'critical': return 5000
      case 'high':     return 2500
      case 'medium':   return 1000
      case 'low':      return 250
      default:         return 0
    }
  }
  if (category === 'gas') {
    switch (severity) {
      case 'high':   return 500
      case 'medium': return 200
      case 'low':    return 75
      default:       return 0
    }
  }
  // code
  switch (severity) {
    case 'high':   return 200
    case 'medium': return 100
    case 'low':    return 50
    default:       return 0
  }
}

function renderReportBody(
  target: TargetRow,
  category: 'security' | 'gas' | 'code',
  severity: string,
  summary: string,
  details: string,
  confidence: number,
): string {
  const kind = category === 'security' ? 'Security finding'
             : category === 'gas'      ? 'Gas optimization'
             : 'Quick-fix code bounty'
  return [
    `# ${target.name}`,
    '',
    `Type: ${kind}`,
    `Severity: ${severity}`,
    `Confidence: ${(confidence * 100).toFixed(0)}%`,
    `Source: ${target.source}`,
    target.chain ? `Chain: ${target.chain}` : null,
    target.url   ? `URL: ${target.url}`     : null,
    '',
    `## Finding`,
    summary,
    '',
    `## Details`,
    details,
    '',
    `_Filed by Scout (volume triage). Lila to review at speed before submission._`,
  ].filter(Boolean).join('\n')
}
