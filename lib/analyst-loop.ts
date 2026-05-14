import OpenAI from 'openai'
import * as Alpaca from './platforms/alpaca'
import type { PoolClient } from 'pg'
import { llmCall, LLMBudgetExceeded } from './llm'
import { cfg } from './config'
import { digest } from './memory/digest'
import { maybeRunSummaries } from './memory/summarize'
import { WATCHLIST_ALL as ALL } from './analyst-watchlist'
import { buildVegaBrief, renderBrief } from './agent-brief'

const MAX_CYCLES = 11  // cycles before maintenance

export type AnalystStep = 'T0' | 'T1' | 'T2' | 'T3' | 'F0' | 'M0' | 'M1'

// ── AnalystLoop ───────────────────────────────────────────────────────────────

export class AnalystLoop {
  private ai: OpenAI
  private db: PoolClient
  // Per-tick rendered brief. Built lazily on first llm() call, cleared
  // at the end of run(). Cap is applied at injection time in llm().
  private briefPrefix: string | null = null

  constructor(db: PoolClient) {
    this.db = db
    this.ai = new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY!, baseURL: 'https://api.deepseek.com/v1' })
  }

  async shouldRun(): Promise<boolean> {
    const { rows: [s] } = await this.db.query('SELECT last_step_at FROM analyst_state WHERE id=1')
    if (!s?.last_step_at) return true
    return (Date.now() - new Date(s.last_step_at).getTime()) / 60000 >= cfg.ANALYST_STEP_MIN
  }

  async run(): Promise<{ logMessage: string; logType: 'info' | 'success' | 'warn' } | null> {
    if (!(await this.shouldRun())) return null

    const { rows: [s] } = await this.db.query('SELECT step, cycle FROM analyst_state WHERE id=1')
    const step: AnalystStep = s?.step ?? 'T0'
    const cycle: number = s?.cycle ?? 0

    let result: string
    let next: AnalystStep
    let nextCycle = cycle

    try {
      switch (step) {
        case 'T0': result = await this.t0();            next = 'T1';                                     break
        case 'T1': { const r = await this.t1();         next = r.skip ? 'F0' : 'T2'; result = r.msg;    break }
        case 'T2': { const r = await this.t2();         next = r.trade ? 'F0' : 'T3'; result = r.msg;   break }
        case 'T3': result = await this.t3();            next = 'F0';                                     break
        case 'F0': { result = await this.f0(cycle);     nextCycle = cycle + 1; next = nextCycle >= MAX_CYCLES ? 'M0' : 'T0'; break }
        case 'M0': result = await this.m0();            next = 'M1';                                     break
        case 'M1': result = await this.m1();            next = 'T0'; nextCycle = 0;                      break
        default:   result = 'State reset.';             next = 'T0'
      }
    } catch (e) {
      this.briefPrefix = null
      return { logMessage: `Vega ${step} error: ${String(e)}`, logType: 'warn' }
    }

    await this.db.query(
      'UPDATE analyst_state SET step=$1, cycle=$2, last_step_at=NOW(), updated_at=NOW() WHERE id=1',
      [next, nextCycle]
    )
    this.briefPrefix = null
    return { logMessage: `Vega ${step}: ${result}`, logType: step === 'F0' || step === 'M1' ? 'success' : 'info' }
  }

  // ── T+0: Check group chat ──────────────────────────────────────────────────

  private async t0(): Promise<string> {
    const { rows } = await this.db.query(
      `SELECT sender, content FROM chat_messages
       WHERE thread = 'main'
         AND created_at > NOW() - INTERVAL '10 minutes'
       ORDER BY created_at ASC LIMIT 20`
    )
    if (!rows.length) return 'No new chat. Moving to feed.'

    const transcript = rows.map((m: { sender: string; content: string }) =>
      `[${m.sender.toUpperCase()}]: ${m.content}`
    ).join('\n')

    const res = await this.llm(
      'analyst.t0',
      `You are Vega, in a group chat with Lila (COO) and the operator. Review recent chat:\n\n${transcript}\n\nDo any messages require your response or a task? JSON only: { "action": true/false, "task": "one sentence or null", "response": "one sentence or null" }`,
      120
    )
    const d = this.parse(res, { action: false, task: null, response: null })

    if (d.action) {
      if (d.task) await this.note('tasks/current.md', `# Current Task\n${new Date().toISOString()}\n\n${d.task}`)
      if (d.response) await this.chat('analyst', d.response, 'status')
      return `Responded: ${d.task ?? d.response}`
    }
    return 'Chat clear.'
  }

  // ── T-1: News feed ─────────────────────────────────────────────────────────

  private async t1(): Promise<{ msg: string; skip: boolean }> {
    const news = await Alpaca.getNews(ALL.slice(0, 10), 15).catch(() => [] as Alpaca.NewsItem[])
    if (!news.length) return { msg: 'No news.', skip: false }

    const headlines = news.map(n => `- ${n.headline} (${n.symbols?.join(',') ?? ''})`).join('\n')
    const res = await this.llm(
      'analyst.t1',
      `Vega reviewing macro/commodity/ETF news. No biotech, no retail.\n\n${headlines}\n\nBreaking thesis? JSON: { "thesis": true/false, "summary": "one sentence" }`,
      100
    )
    const d = this.parse(res, { thesis: false, summary: 'No strong signal.' })

    const date = today()
    await this.note(`analyst/notes/feed-${date}.md`, `# Feed ${date}\n\n${headlines}\n\n## Take\n${d.summary}`)
    return { msg: d.summary, skip: d.thesis === true }
  }

  // ── T-2: Market scan ───────────────────────────────────────────────────────

  private async t2(): Promise<{ msg: string; trade: boolean }> {
    const bars = await Alpaca.getBars(ALL, 25).catch(() => [] as Alpaca.BarData[])
    if (bars.length < 3) return { msg: 'Insufficient data.', trade: false }

    const data = bars
      .map(b => `${b.symbol}: $${b.price.toFixed(2)} sma20=$${b.sma20.toFixed(2)} mom=${b.momentum.toFixed(1)}% vol=${b.volumeRatio.toFixed(2)}x`)
      .join('\n')

    const res = await this.llm(
      'analyst.t2',
      `Vega scanning commodity ETFs, leveraged S&P/NQ, global macro. Long only, no biotech, no retail.\n\n${data}\n\nAny thesis? JSON: { "thesis": true/false, "picks": [{"symbol":"X","confidence":0.7,"reason":"one sentence"}], "summary": "one sentence" }`,
      250
    )
    const d = this.parse(res, { thesis: false, picks: [], summary: 'No setup.' })

    const date = today()
    await this.note(`analyst/notes/scan-${date}.md`, `# Scan ${date}\n\n${data}\n\n## Verdict\n${d.summary}`)

    if (d.picks?.length) {
      await this.db.query(
        'UPDATE analyst_state SET notes_buffer=$1 WHERE id=1',
        [JSON.stringify({ picks: d.picks })]
      )
    }

    return { msg: d.summary, trade: d.thesis === true && d.picks?.length > 0 }
  }

  // ── T-3: Research ──────────────────────────────────────────────────────────

  private async t3(): Promise<string> {
    const res = await this.llm(
      'analyst.t3',
      'You are Vega. No trade setup today. Write 3-5 bullet research notes: what to watch next and why. Focus on commodity ETFs, leveraged indices, global macro.',
      180
    )
    const date = today()
    await this.note(`analyst/notes/research-${date}.md`, `# Research ${date}\n\n${res}`)
    return 'Research note filed.'
  }

  // ── F-0: Report ────────────────────────────────────────────────────────────

  private async f0(cycle: number): Promise<string> {
    const { rows: [s] } = await this.db.query('SELECT notes_buffer FROM analyst_state WHERE id=1')
    let queued = 0

    if (s?.notes_buffer) {
      try {
        const { picks } = JSON.parse(s.notes_buffer)
        for (const p of picks ?? []) {
          if ((p.confidence ?? 0) >= 0.6) {
            const bars = await Alpaca.getBars([p.symbol], 5).catch(() => [] as Alpaca.BarData[])
            const bar = bars[0]
            if (bar) {
              const entry = bar.price
              const target = +(entry * 1.05).toFixed(4)
              const stop = +(entry * 0.93).toFixed(4)
              await this.db.query(
                `INSERT INTO analyst_picks (symbol, direction, entry_price, target_price, stop_loss, confidence, risk_level, reason, asset_class)
                 VALUES ($1,'long',$2,$3,$4,$5,'medium',$6,'etf/macro') ON CONFLICT DO NOTHING`,
                [p.symbol, entry, target, stop, p.confidence, p.reason]
              )
              queued++
            }
          }
        }
        await this.db.query('UPDATE analyst_state SET notes_buffer=NULL WHERE id=1')
      } catch { /* empty buffer */ }
    }

    const msg = queued > 0
      ? `Cycle ${cycle + 1} complete — ${queued} pick${queued > 1 ? 's' : ''} queued for Lila.`
      : `Cycle ${cycle + 1} complete — no trades this cycle.`

    await this.chat('analyst', msg, 'status')

    return msg
  }

  // ── M-0: Summarize notes ───────────────────────────────────────────────────

  private async m0(): Promise<string> {
    const { rows } = await this.db.query(
      `SELECT path, content FROM analyst_notes
       WHERE path LIKE 'analyst/notes/%' AND updated_at > NOW() - INTERVAL '4 hours'
       ORDER BY updated_at DESC LIMIT 15`
    )
    if (!rows.length) return 'No notes to summarize.'

    const combined = rows.map((n: { path: string; content: string }) =>
      `=== ${n.path} ===\n${n.content.slice(0, 400)}`
    ).join('\n\n')

    const summary = await this.llm(
      'analyst.m0',
      `Summarize these analyst notes into a concise market brief (5-7 bullets):\n\n${combined}`, 250
    )
    await this.note(`analyst/summaries/${today()}-maintenance.md`, `# Maintenance Summary ${today()}\n\n${summary}`)
    // Maintenance phase (NOT the autonomy loop) — piggyback the memory
    // progressive-summarization pass. Internally gated by memory_state so
    // re-runs within the cadence are no-ops.
    await maybeRunSummaries(this.db, this.ai).catch(() => { /* best-effort */ })
    return 'Notes summarized.'
  }

  // ── M-1: P&L report to Lila ───────────────────────────────────────────────

  private async m1(): Promise<string> {
    const { rows: pos } = await this.db.query(
      `SELECT symbol, status, pnl FROM lila_positions ORDER BY opened_at DESC LIMIT 20`
    )
    const { rows: [earned] } = await this.db.query('SELECT total_earned FROM lila_state WHERE id=1')
    const totalPnl = pos.reduce((s: number, p: { pnl: string }) => s + parseFloat(p.pnl ?? '0'), 0)
    const posStr = pos.length
      ? pos.map((p: { symbol: string; status: string; pnl: string }) => `${p.symbol} [${p.status}] $${parseFloat(p.pnl ?? '0').toFixed(2)}`).join('\n')
      : 'No positions yet.'

    const analysis = await this.llm(
      'analyst.m1',
      `Vega P&L briefing for Lila (COO).\n\nPositions:\n${posStr}\n\nTrading P&L: $${totalPnl.toFixed(2)}\nBounty earnings: $${parseFloat(earned?.total_earned ?? '0').toFixed(2)}\n\nWrite 2-3 sentence analysis + recommendation.`,
      150
    )
    await this.note(`analyst/pnl/${today()}-analysis.md`, `# P&L ${today()}\n\n${analysis}\n\n## Positions\n${posStr}`)
    await this.chat('analyst', `Maintenance P&L: ${analysis}`, 'status')

    // Also drop a desk item — the operator should see Vega's read on
    // each maintenance cycle (and can deny with a "wrong direction"
    // comment that future briefings will absorb).
    const Desk = await import('./desk')
    await Desk.submit(this.db, {
      from: 'vega',
      kind: 'briefing',
      title: `Vega P&L briefing — ${today()}`,
      summary: analysis.slice(0, 140),
      body: `# P&L briefing — ${today()}\n\n${analysis}\n\n## Positions\n${posStr}\n\n## Snapshot\n- Trading P&L: $${totalPnl.toFixed(2)}\n- Bounty earnings: $${parseFloat(earned?.total_earned ?? '0').toFixed(2)}`,
    }).catch(() => { /* desk submit shouldn't break the loop */ })

    return `P&L sent to Lila. Trading total: $${totalPnl.toFixed(2)}.`
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async llm(module: string, prompt: string, maxTokens: number): Promise<string> {
    // Build the brief prefix once per tick. Capped at 800 chars so it
    // can't crowd out the prompt body. The `---` separator delimits
    // the brief from JSON-shape instructions further down.
    if (this.briefPrefix === null) {
      try {
        this.briefPrefix = renderBrief(await buildVegaBrief(this.db)).slice(0, 800)
      } catch {
        this.briefPrefix = ''
      }
    }
    const finalPrompt = this.briefPrefix
      ? `${this.briefPrefix}\n---\n${prompt}`
      : prompt
    try {
      const { content } = await llmCall({
        ai: this.ai,
        module,
        messages: [{ role: 'user', content: finalPrompt }],
        max_tokens: maxTokens,
        temperature: 0.3,
      })
      return content
    } catch (e) {
      if (e instanceof LLMBudgetExceeded) return ''
      throw e
    }
  }

  private parse<T>(raw: string, fallback: T): T {
    try { return JSON.parse(raw) } catch { return fallback }
  }

  async note(path: string, content: string): Promise<void> {
    await this.db.query(
      `INSERT INTO analyst_notes (path, content, updated_at) VALUES ($1,$2,NOW())
       ON CONFLICT (path) DO UPDATE SET content=$2, updated_at=NOW()`,
      [path, content]
    )
    digest(this.db, {
      source: 'analyst_note',
      source_id: path,
      actor: 'vega',
      text: content,
    }).catch(() => { /* best-effort */ })
  }

  // kind: 'message' (chat-visible) | 'status' (work update, hidden from Chat)
  async chat(sender: string, content: string, kind: 'message' | 'status' = 'message'): Promise<void> {
    await this.db.query(
      `INSERT INTO chat_messages (sender, content, kind) VALUES ($1,$2,$3)`,
      [sender, content, kind]
    )
    digest(this.db, {
      source: 'chat',
      actor: sender,
      text: content,
    }).catch(() => { /* best-effort */ })
  }
}

function today() { return new Date().toISOString().slice(0, 10) }
