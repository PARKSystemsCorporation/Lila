import OpenAI from 'openai'
import type { PoolClient } from 'pg'
import { llmCall, LLMBudgetExceeded } from './llm'
import { cfg } from './config'

// ── Ceelo: NFL handicapper ─────────────────────────────────────────────────
//
// Strictly informational. Posts handicapping picks (spread / moneyline /
// total) for upcoming NFL games. Operator decides what to take and marks
// W/L. No auto-execution, no shared bankroll with Vega/Cipher.
//
// v1: LLM-only handicapping. Ceelo reasons from the model's training-data
// view of teams + matchups + general public information. Output includes a
// modeled probability and a fair-line estimate; operator compares to the
// real line at their book before taking.
//
// Future: wire in The Odds API for live line shopping. Schema already
// supports per-pick taken_odds and edge_pct so that integration won't
// require a migration.

const PICK_PROMPT = `You are Ceelo, the NFL handicapper on Lila's team. Your sole job is finding handicapping edges on upcoming NFL games. You don't bet — you post picks; the operator chooses what to take.

TODAY (UTC): {DATE}

Voice: dry, numbers-first, quant-trained. No exclamation points, no hype. You're a sharp, not a tout.

METHODOLOGY:
- Estimate true win probability for each side using power ratings, recent form, injuries, situational spots (rest, travel, divisional, weather), and matchup dynamics.
- Translate that to a fair line (spread or total) and compare to typical market consensus you'd expect.
- Only flag a pick when your modeled probability gives a clear edge over the implied probability of a reasonable line. No "I like this game" — every pick states model_prob and the fair line.
- Prefer fewer high-confidence picks over many low-confidence ones. Empty list is acceptable.

OUTPUT — strict JSON:
{
  "picks": [
    {
      "game_label": "AWAY @ HOME",            // e.g. "KC @ BUF"
      "kickoff_iso": "2026-04-26T17:00:00Z",   // best estimate, ISO 8601 UTC
      "market": "spread" | "moneyline" | "total",
      "side": "string",                         // e.g. "BUF -3", "Over 47.5", "KC ML"
      "model_prob": 0.0,                        // 0..1, your modeled probability the side wins
      "fair_line": "string",                    // e.g. "BUF -2", "Over 45.5", "-150"
      "min_odds": -110,                         // American odds; minimum you'd take this at
      "confidence": "low" | "medium" | "high",
      "reasoning": "one tight paragraph: thesis, key drivers, why the edge"
    }
  ]
}

Existing recent picks (do NOT re-pick the same game/market combo if already in this list):
{RECENT}

Return JSON only. If no edge worth flagging, return { "picks": [] }.`

interface RawPick {
  game_label?: string
  kickoff_iso?: string
  market?: string
  side?: string
  model_prob?: number
  fair_line?: string
  min_odds?: number
  confidence?: string
  reasoning?: string
}

export class CeeloLoop {
  private ai: OpenAI | null
  private db: PoolClient

  constructor(db: PoolClient) {
    this.db = db
    this.ai = process.env.DEEPSEEK_API_KEY
      ? new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com/v1' })
      : null
  }

  async shouldRun(): Promise<boolean> {
    const { rows: [s] } = await this.db.query('SELECT last_run_at FROM ceelo_state WHERE id=1')
    if (!s?.last_run_at) return true
    return (Date.now() - new Date(s.last_run_at).getTime()) / 3_600_000 >= cfg.CEELO_RUN_HOURS
  }

  async run(): Promise<{ logMessage: string; logType: 'info' | 'success' | 'warn' } | null> {
    if (!(await this.shouldRun())) return null
    if (!this.ai) {
      await this.markRun()
      return { logMessage: 'Ceelo: no LLM key, skipping.', logType: 'warn' }
    }

    const recent = await this.recentPickSummary()

    let raw: string
    try {
      const res = await llmCall({
        ai: this.ai,
        module: 'ceelo.picks',
        messages: [{
          role: 'user',
          content: PICK_PROMPT
            .replace('{DATE}', new Date().toISOString())
            .replace('{RECENT}', recent),
        }],
        max_tokens: 1200,
        temperature: 0.3,
      })
      raw = res.content
    } catch (e) {
      if (e instanceof LLMBudgetExceeded) {
        return { logMessage: 'Ceelo: budget exceeded, skipping.', logType: 'warn' }
      }
      throw e
    }

    let picks: RawPick[] = []
    try {
      const parsed = JSON.parse(raw.replace(/```json|```/g, '').trim())
      picks = Array.isArray(parsed?.picks) ? parsed.picks : []
    } catch {
      await this.markRun()
      return { logMessage: 'Ceelo: malformed JSON from model.', logType: 'warn' }
    }

    let inserted = 0
    for (const p of picks) {
      if (!p.game_label || !p.market || !p.side || !p.reasoning) continue
      const market = ['spread', 'moneyline', 'total'].includes(p.market) ? p.market : null
      if (!market) continue
      const conf = ['low', 'medium', 'high'].includes(p.confidence ?? '') ? p.confidence! : 'medium'
      const modelProb = clampProb(p.model_prob)
      const minOdds = Number.isFinite(p.min_odds) ? Math.trunc(p.min_odds!) : null
      const edgePct = modelProb != null && minOdds != null
        ? +(100 * (modelProb - impliedProb(minOdds))).toFixed(2)
        : null
      const kickoff = parseIso(p.kickoff_iso)

      // Dedup: same game + market + side already open or settled in last 14 days.
      const dup = await this.db.query(
        `SELECT 1 FROM ceelo_picks
         WHERE game_label = $1 AND market = $2 AND side = $3
           AND created_at > NOW() - INTERVAL '14 days'
         LIMIT 1`,
        [p.game_label, market, p.side]
      )
      if (dup.rows.length > 0) continue

      await this.db.query(
        `INSERT INTO ceelo_picks
           (sport, game_label, kickoff_at, market, side, model_prob,
            fair_line, min_odds, edge_pct, reasoning, confidence, status)
         VALUES ('NFL',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'open')`,
        [
          p.game_label, kickoff, market, p.side, modelProb,
          p.fair_line ?? null, minOdds, edgePct, p.reasoning, conf,
        ]
      )
      inserted++
    }

    await this.markRun()

    const msg = inserted > 0
      ? `Ceelo posted ${inserted} pick${inserted > 1 ? 's' : ''}.`
      : 'Ceelo: no edges flagged this cycle.'
    return { logMessage: msg, logType: inserted > 0 ? 'success' : 'info' }
  }

  private async markRun(): Promise<void> {
    await this.db.query(
      `UPDATE ceelo_state SET last_run_at=NOW(), cycle=cycle+1, updated_at=NOW() WHERE id=1`
    )
  }

  private async recentPickSummary(): Promise<string> {
    const { rows } = await this.db.query(
      `SELECT game_label, market, side, status
       FROM ceelo_picks
       WHERE created_at > NOW() - INTERVAL '14 days'
       ORDER BY created_at DESC LIMIT 30`
    )
    if (!rows.length) return '(none)'
    return rows.map((r: { game_label: string; market: string; side: string; status: string }) =>
      `- ${r.game_label} | ${r.market} | ${r.side} | ${r.status}`
    ).join('\n')
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

// American odds → implied probability.
function impliedProb(odds: number): number {
  return odds < 0 ? -odds / (-odds + 100) : 100 / (odds + 100)
}

function clampProb(p: number | undefined): number | null {
  if (p == null || !Number.isFinite(p)) return null
  if (p < 0 || p > 1) return null
  return +p.toFixed(3)
}

function parseIso(s: string | undefined): string | null {
  if (!s) return null
  const d = new Date(s)
  return isNaN(d.getTime()) ? null : d.toISOString()
}

// American-odds payout calc — exposed so the API route can use the same math.
// Returns NET profit on a winning bet (does not include stake).
export function netProfit(stake: number, odds: number): number {
  if (odds < 0) return +(stake * (100 / Math.abs(odds))).toFixed(2)
  return +(stake * (odds / 100)).toFixed(2)
}
