// Marketplace DM loop. One queued viewer_dms row gets answered per
// autonomy tick: pull per-agent context (recent picks, trades, articles),
// hand it to DeepSeek with a persona-specific system prompt, persist the
// reply. Budget-respecting (uses llmCall non-critical) — if the daily cap
// is hit, the row stays queued and gets picked up tomorrow.

import OpenAI from 'openai'
import type { PoolClient } from 'pg'
import { llmCall, LLMBudgetExceeded } from './llm'

type AgentKey = 'lila' | 'ceelo' | 'vega'

interface Pending {
  id:        number
  viewer_id: number
  agent:     AgentKey
  prompt:    string
}

const SYSTEM: Record<AgentKey, string> = {
  lila:
    'You are Lila — desk manager at Park Systems. You run the team: Cipher ' +
    '(security bounties), Scout (volume bounties), Vega (equities analyst), ' +
    'Ceelo (NFL handicapper). Voice: direct, confident, lowercase-first with ' +
    'brutalist punctuation, no hedging. Reference real recent activity from ' +
    'the context block when it actually applies — never invent numbers. ' +
    'Three to six sentences. No headers, no bullet lists, no greetings.',
  ceelo:
    'You are Ceelo — the NFL handicapper. You maintain an internal Elo ratings ' +
    'graph from nflverse data and diff your model spreads against live book ' +
    'lines. Voice: math-first, terse, no fluff. Give the read with specific ' +
    'numbers when the context supports them; admit uncertainty when it does ' +
    "not. Don't write 'I think'. Three to six sentences.",
  vega:
    'You are Vega — the equities analyst. Focus: commodity ETFs, leveraged ' +
    'index, global macro. Tight stops. Voice: technical, decisive, real ' +
    "tickers only when they're in the context block — never invent positions. " +
    'Three to six sentences.',
}

export class DmLoop {
  private ai: OpenAI | null
  private db: PoolClient

  constructor(db: PoolClient) {
    this.db = db
    this.ai = process.env.DEEPSEEK_API_KEY
      ? new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com/v1' })
      : null
  }

  async run(): Promise<{ logMessage: string; logType: 'info' | 'success' | 'warn' } | null> {
    if (!this.ai) return null

    // Take the oldest queued DM — let the FIFO be visible to the viewer.
    const { rows } = await this.db.query<Pending>(
      `SELECT id, viewer_id, agent, prompt
         FROM viewer_dms
        WHERE status = 'queued'
        ORDER BY created_at ASC
        LIMIT 1`,
    )
    const dm = rows[0]
    if (!dm) return null
    if (dm.agent !== 'lila' && dm.agent !== 'ceelo' && dm.agent !== 'vega') {
      // Defensive: skip unknown agent rows so a typo can't pin the queue.
      await this.db.query(
        `UPDATE viewer_dms SET status='answered', reply=$2, answered_at=NOW() WHERE id=$1`,
        [dm.id, '[skipped — unknown agent]'],
      )
      return { logMessage: `DM ${dm.id}: skipped (unknown agent ${dm.agent}).`, logType: 'warn' }
    }

    const context = await this.contextFor(dm.agent)

    let reply: string
    try {
      const r = await llmCall({
        ai: this.ai,
        module: `dm.${dm.agent}`,
        max_tokens: 360,
        temperature: 0.55,
        messages: [
          { role: 'system', content: SYSTEM[dm.agent] },
          { role: 'system', content: `Recent context (real, do not embellish):\n${context}` },
          { role: 'user',   content: dm.prompt },
        ],
      })
      reply = (r.content || '').trim()
      if (!reply) reply = '[empty reply — try asking again]'
    } catch (e) {
      if (e instanceof LLMBudgetExceeded) {
        // Stay queued — answer tomorrow when the cap resets.
        return { logMessage: `DM queue: budget exceeded, ${dm.agent} reply deferred.`, logType: 'info' }
      }
      // Network/API failure: leave queued; if it persists, the row is still
      // visible in the operator UI and can be hand-answered.
      return {
        logMessage: `DM ${dm.id} ${dm.agent}: LLM error ${String(e).slice(0, 80)}`,
        logType: 'warn',
      }
    }

    await this.db.query(
      `UPDATE viewer_dms
          SET reply       = $2,
              status      = 'answered',
              answered_at = NOW()
        WHERE id = $1`,
      [dm.id, reply.slice(0, 4000)],
    )

    return {
      logMessage: `DM ${dm.id}: ${dm.agent} replied (${reply.length} chars).`,
      logType: 'success',
    }
  }

  // Per-agent context block. We keep these small + factual so the model
  // grounds its reply in real desk activity instead of confabulating.
  private async contextFor(agent: AgentKey): Promise<string> {
    try {
      if (agent === 'ceelo')  return await this.ceeloContext()
      if (agent === 'vega')   return await this.vegaContext()
      return await this.lilaContext()
    } catch {
      return '(no recent context available)'
    }
  }

  private async ceeloContext(): Promise<string> {
    const picks = await this.db.query(
      `SELECT sport, game_label, market, side, edge_points, model_prob, confidence, status,
              created_at
         FROM ceelo_picks
        ORDER BY created_at DESC
        LIMIT 5`,
    )
    const lines = picks.rows.map((p) => {
      const edge = p.edge_points != null ? `${Number(p.edge_points) >= 0 ? '+' : ''}${Number(p.edge_points).toFixed(1)}pt` : '—'
      const prob = p.model_prob != null ? `${(Number(p.model_prob) * 100).toFixed(0)}%` : '—'
      return `- ${p.sport} ${p.game_label} · ${p.market}/${p.side} · edge ${edge} · model ${prob} · ${p.confidence} · ${p.status}`
    })
    if (!lines.length) return '(no Ceelo picks logged yet)'
    return `Recent Ceelo picks:\n${lines.join('\n')}`
  }

  private async vegaContext(): Promise<string> {
    const picks = await this.db.query(
      `SELECT symbol, direction, entry_price, target_price, stop_loss, confidence, status, asset_class
         FROM analyst_picks
        ORDER BY created_at DESC
        LIMIT 5`,
    )
    const positions = await this.db.query(
      `SELECT symbol, direction, entry_price, status
         FROM lila_positions
        ORDER BY id DESC
        LIMIT 3`,
    )
    const pickLines = picks.rows.map((p) =>
      `- ${p.symbol} ${p.direction} · entry ${p.entry_price ?? '—'} · target ${p.target_price ?? '—'} · stop ${p.stop_loss ?? '—'} · ${p.status}`,
    )
    const posLines = positions.rows.map((p) =>
      `- ${p.symbol} ${p.direction} @ ${p.entry_price ?? '—'} · ${p.status}`,
    )
    const out: string[] = []
    if (pickLines.length)  out.push('Recent Vega picks:\n' + pickLines.join('\n'))
    if (posLines.length)   out.push('Open/recent positions:\n' + posLines.join('\n'))
    return out.length ? out.join('\n\n') : '(no Vega activity logged yet)'
  }

  private async lilaContext(): Promise<string> {
    const trades = await this.db.query(
      `SELECT symbol, direction, entry_price, status
         FROM lila_positions
        ORDER BY id DESC
        LIMIT 3`,
    )
    const reports = await this.db.query(
      `SELECT title, status, payout
         FROM security_reports
        ORDER BY updated_at DESC
        LIMIT 3`,
    )
    const articles = await this.db.query(
      `SELECT title, author, kind, created_at
         FROM articles
        WHERE status = 'published'
        ORDER BY created_at DESC
        LIMIT 3`,
    )
    const out: string[] = []
    if (trades.rows.length) {
      out.push(
        'Recent positions:\n' +
        trades.rows.map((t) => `- ${t.symbol} ${t.direction} @ ${t.entry_price ?? '—'} · ${t.status}`).join('\n'),
      )
    }
    if (reports.rows.length) {
      out.push(
        'Recent security reports:\n' +
        reports.rows.map((r) => `- ${r.title} · ${r.status}${r.payout != null ? ` · $${r.payout}` : ''}`).join('\n'),
      )
    }
    if (articles.rows.length) {
      out.push(
        'Recent articles:\n' +
        articles.rows.map((a) => `- ${a.author}/${a.kind}: ${a.title}`).join('\n'),
      )
    }
    return out.length ? out.join('\n\n') : '(no recent desk activity logged yet)'
  }
}
