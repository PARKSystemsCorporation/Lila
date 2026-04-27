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

const SHALLOW_TRIAGE_PROMPT = `You are Scout, a high-volume security triage agent on Lila's team. Cipher does deep audits; you do FAST shallow scans for $1-5k bounties. Speed > thoroughness. Higher false-positive rate is acceptable — Lila reviews every draft before it goes out.

Triage this target. You have ~60 seconds of model time, not 60 minutes.

TARGET:
  Name:   {NAME}
  Source: {SOURCE}
  URL:    {URL}
  Chain:  {CHAIN}
  Scope:  {SCOPE}

CHECKLIST (run through quickly, flag anything obvious):
1. Access control — missing onlyOwner, public functions that mutate state, unprotected admin entries.
2. Reentrancy — external calls before state writes, missing nonReentrant on payable / withdraw paths.
3. Oracle / price manipulation — single-source price feeds, no TWAP, spot-price reads in liquidations.
4. Integer issues — unchecked math in token amounts, rounding in shares/asset conversions.
5. Token approvals — infinite approvals on aggregator paths, missing safeTransfer.
6. Init / upgrade — uninitialized proxies, public initializers, missing storage gaps.
7. Forked code drift — minor mods to a known protocol that break invariants the original relied on.

Output strict JSON:
{
  "severity": "critical" | "high" | "medium" | "low" | "none",
  "summary":  "one-sentence finding (or 'no obvious issues')",
  "details":  "2-4 sentences: what + why + suggested fix. Empty if severity=none.",
  "confidence": 0.0..1.0
}

If you can't tell from the surface info alone, return severity="none" with summary="needs deeper scan — punt to Cipher". Don't fabricate findings.`

interface RawTriage {
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

    const severity = normalizeSeverity(triage.severity)
    const summary = String(triage.summary ?? '').slice(0, 280).trim()
    const details = String(triage.details ?? '').slice(0, 4000).trim()
    const confidence = clamp01(triage.confidence) ?? 0.4

    // S2: log + (maybe) file report.
    const shouldReport = ['critical', 'high', 'medium'].includes(severity) && summary && details
    let reportId: number | null = null

    if (shouldReport) {
      const { rows: [row] } = await this.db.query(
        `INSERT INTO security_reports
           (bounty_id, platform, platform_label, title, reward, chain, url,
            content, confidence, status, source)
         VALUES ($1, 'scout', 'Scout (volume)', $2, $3, $4, $5, $6, $7, 'pending_review', 'scout')
         ON CONFLICT (bounty_id) DO UPDATE
           SET content=$6, confidence=$7, status='pending_review', updated_at=NOW()
         RETURNING id`,
        [
          `scout:${target.id}:${severity}`,
          `[Scout/${severity}] ${target.name}: ${summary.slice(0, 120)}`,
          guessReward(severity),
          target.chain ?? null,
          target.url ?? null,
          renderReportBody(target, severity, summary, details, confidence),
          confidence,
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

function clamp01(n: unknown): number | null {
  if (n == null || !Number.isFinite(n as number)) return null
  const v = Number(n)
  if (v < 0) return 0
  if (v > 1) return 1
  return +v.toFixed(2)
}

// Heuristic max-bounty by severity for the security_reports.reward column.
// Scout's targets are smaller protocols, so the brackets are tighter than
// Cipher's deep-audit drafts.
function guessReward(severity: string): number {
  switch (severity) {
    case 'critical': return 5000
    case 'high':     return 2500
    case 'medium':   return 1000
    case 'low':      return 250
    default:         return 0
  }
}

function renderReportBody(
  target: TargetRow,
  severity: string,
  summary: string,
  details: string,
  confidence: number,
): string {
  return [
    `# ${target.name}`,
    '',
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
