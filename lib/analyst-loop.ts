import OpenAI from 'openai'
import * as Alpaca from './platforms/alpaca'
import type { PoolClient } from 'pg'
import { llmCall, LLMBudgetExceeded } from './llm'
import { cfg } from './config'
import * as Telegram from './channels/telegram'

// ── Vega watchlist ─────────────────────────────────────────────────────────
// Major commodities (the focus book). Strategy: trade these around
// historical support/resistance with macro catalysts in the read — not
// SMA / EMA crossings.

const COMMODITY_LABELS: Record<string, string> = {
  GLD:  'gold',
  SLV:  'silver',
  USO:  'crude oil (WTI)',
  UNG:  'natural gas',
  GDX:  'gold miners',
  CPER: 'copper',
  PDBC: 'broad commodities (no K-1)',
  DBA:  'agriculture (corn / wheat / soy / sugar)',
  URA:  'uranium',
  WEAT: 'wheat',
  CORN: 'corn',
  PALL: 'palladium',
  WOOD: 'lumber / timber',
}
const WATCHLIST = {
  commodity: Object.keys(COMMODITY_LABELS),
  leveraged: ['SPXL', 'TQQQ', 'UPRO', 'QLD', 'SOXL'],
  macro:     ['TLT', 'HYG', 'UUP', 'EEM', 'EFA', 'FXI', 'EWJ', 'VWO'],
}
const ALL = [...WATCHLIST.commodity, ...WATCHLIST.leveraged, ...WATCHLIST.macro]

// 52 trading weeks of daily bars — the support/resistance lookback for
// commodity ETFs. Wider than this and the highs/lows stop being levels
// the market is currently pricing against.
const SR_LOOKBACK_BARS = 252

const MAX_CYCLES = 11  // cycles before maintenance

export type AnalystStep = 'T0' | 'T1' | 'T2' | 'T3' | 'F0' | 'M0' | 'M1'

// ── AnalystLoop ───────────────────────────────────────────────────────────────

export class AnalystLoop {
  private ai: OpenAI
  private db: PoolClient

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
      return { logMessage: `Vega ${step} error: ${String(e)}`, logType: 'warn' }
    }

    await this.db.query(
      'UPDATE analyst_state SET step=$1, cycle=$2, last_step_at=NOW(), updated_at=NOW() WHERE id=1',
      [next, nextCycle]
    )
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
      if (d.response) await this.chat('analyst', d.response)
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
      `Vega reviewing macro / commodity ETF news. Major-commodity book: ${WATCHLIST.commodity.join(', ')}. Return thesis:true only when a headline is a real catalyst against a level on one of those names. One-sentence summary should pair the symbol with the catalyst (e.g. "USO catalyst: OPEC+ cut headlines into the $X 52w-low retest"). No biotech, no retail.\n\n${headlines}\n\nJSON: { "thesis": true/false, "summary": "one sentence — symbol + catalyst" }`,
      100
    )
    const d = this.parse(res, { thesis: false, summary: 'No strong signal.' })

    const date = today()
    await this.note(`analyst/notes/feed-${date}.md`, `# Feed ${date}\n\n${headlines}\n\n## Take\n${d.summary}`)
    return { msg: d.summary, skip: d.thesis === true }
  }

  // ── T-2: Market scan ───────────────────────────────────────────────────────

  private async t2(): Promise<{ msg: string; trade: boolean }> {
    // 52-week daily bars so range-low / range-high are real annual
    // support/resistance levels, not 20-day chop boundaries.
    const bars = await Alpaca.getBars(ALL, SR_LOOKBACK_BARS).catch(() => [] as Alpaca.BarData[])
    if (bars.length < 3) return { msg: 'Insufficient data.', trade: false }

    // Defensive: free Alpaca / IEX feeds sometimes return a much shorter
    // history than requested. The S/R math still works on whatever we got
    // but the operator should know the lookback is truncated.
    const minBars = bars.reduce((a, b) => Math.min(a, b.rangeBars), Infinity)
    if (Number.isFinite(minBars) && minBars < SR_LOOKBACK_BARS * 0.5) {
      await this.warn(
        `Alpaca bars truncated: requested ${SR_LOOKBACK_BARS}d, got ${minBars}. S/R range is shorter than 52w.`
      )
    }

    const commoditySet = new Set<string>(WATCHLIST.commodity)
    // Commodities first so the major-watchlist book is what the LLM
    // sees at the top — leveraged + macro stay in the picture as a
    // supporting view but they're not the focus.
    const ordered = [...bars].sort((a, b) =>
      Number(commoditySet.has(b.symbol)) - Number(commoditySet.has(a.symbol))
    )

    const data = ordered
      .map(b => {
        const label = COMMODITY_LABELS[b.symbol]
        const tag = label ? `  (${label})` : ''
        return `${b.symbol}${tag}: $${b.price.toFixed(2)}  52w-range $${b.rangeLow.toFixed(2)}–$${b.rangeHigh.toFixed(2)}  fromLow ${b.pctFromRangeLow.toFixed(1)}%  fromHigh ${b.pctFromRangeHigh.toFixed(1)}%  vol ${b.volumeRatio.toFixed(2)}x`
      })
      .join('\n')

    // Pull a fresh slate of macro headlines — these are the catalysts
    // Vega is supposed to weigh against the level read. Capped + tagged
    // so they're catalyst context, not the whole thesis.
    const news = await Alpaca.getNews(WATCHLIST.commodity.slice(0, 10), 12).catch(() => [] as Alpaca.NewsItem[])
    const headlines = news.length
      ? news.map(n => `- ${n.headline}${n.symbols?.length ? ` (${n.symbols.join(',')})` : ''}`).join('\n')
      : '(no fresh headlines)'

    const res = await this.llm(
      'analyst.t2',
      `You are Vega. Book: major commodity ETFs (${WATCHLIST.commodity.join(', ')}). Leveraged-index + macro are watch-only context. Long only. No biotech. No retail.

How you trade: read price against historical support/resistance first, then weigh macro catalysts on top. NOT moving-average crosses. Examples of what the read should sound like:
  - "GLD basing $X-Y, prior breakout level $Z, fresh war-premium catalyst supports continuation"
  - "USO testing 52w lows near $X, OPEC+ headlines unsupportive but level held in 2023, scale-in candidate"
  - "GDX held $X support twice in last 6mo, dollar weakness catalyst, target prior pivot $Y"

Don't hyper-fixate on one geopolitical narrative — Hormuz / oil-route / tariff chatter is one input among several, not the entire thesis. If a level isn't being tested or you don't have a catalyst, sit out.

Levels:
${data}

Recent headlines (catalyst context):
${headlines}

JSON only: { "thesis": true/false, "picks": [{"symbol":"X","confidence":0.6,"reason":"one sentence — name the level + the catalyst"}], "summary": "one sentence" }`,
      320
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
    // Pull 52-week range data for the commodity book so the research
    // note is anchored on real S/R levels — not free-form macro prose,
    // not SMA crosses.
    const bars = await Alpaca.getBars(WATCHLIST.commodity, SR_LOOKBACK_BARS).catch(() => [] as Alpaca.BarData[])
    const snapshot = bars.length
      ? bars.map(b => {
          const label = COMMODITY_LABELS[b.symbol] ?? b.symbol
          return `- ${b.symbol} (${label}): $${b.price.toFixed(2)} · 52w $${b.rangeLow.toFixed(2)}–$${b.rangeHigh.toFixed(2)} · fromLow ${b.pctFromRangeLow.toFixed(1)}% · fromHigh ${b.pctFromRangeHigh.toFixed(1)}%`
        }).join('\n')
      : '(no commodity bar data)'
    const news = await Alpaca.getNews(WATCHLIST.commodity.slice(0, 10), 10).catch(() => [] as Alpaca.NewsItem[])
    const headlines = news.length
      ? news.map(n => `- ${n.headline}${n.symbols?.length ? ` (${n.symbols.join(',')})` : ''}`).join('\n')
      : '(no fresh headlines)'

    const res = await this.llm(
      'analyst.t3',
      `You are Vega. No trade fired this cycle. File a tight watchlist note on the major commodity ETF book.

Method: name the level + the catalyst. Support and resistance from the 52-week range below, plus macro catalysts from the headlines. Macro catalysts (geopolitics, dollar, central banks, OPEC+, weather) are FAIR GAME as catalyst color — just don't fixate on one narrative for paragraphs. One phrase per bullet, then move on.

52-week range:
${snapshot}

Headlines (catalyst color):
${headlines}

Output 4-6 bullets, one per major commodity. Format:
- SYMBOL (commodity): support $X.XX · resistance $Y.YY · current read in one phrase (level being tested + the relevant catalyst).

That's it. No "themes to watch" header, no preamble, no multi-sentence prose.`,
      220
    )
    const date = today()
    await this.note(`analyst/notes/research-${date}.md`, `# Research ${date}\n\n${res}`)
    return 'Research note filed.'
  }

  // ── F-0: Report ────────────────────────────────────────────────────────────

  private async f0(cycle: number): Promise<string> {
    const { rows: [s] } = await this.db.query('SELECT notes_buffer FROM analyst_state WHERE id=1')
    let queued = 0
    const queuedPicks: Array<{ symbol: string; entry: number; target: number; stop: number; confidence: number; reason: string }> = []

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
              queuedPicks.push({ symbol: p.symbol, entry, target, stop, confidence: p.confidence, reason: p.reason })
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

    // Mirror new picks to Telegram. Log success AND failure so the
    // operator can see what happened from the Activity log on Dash.
    if (queuedPicks.length > 0 && Telegram.isConfigured()) {
      // Plain text only — reason strings from the LLM might contain
      // underscores or asterisks that would break Markdown parsing.
      const body = queuedPicks.map(p =>
        `• ${p.symbol}  @ $${p.entry.toFixed(2)}  →  tgt $${p.target.toFixed(2)}  ·  stop $${p.stop.toFixed(2)}  ·  conf ${Math.round(p.confidence * 100)}%\n  ${p.reason}`
      ).join('\n\n')
      const tgText = `📊 Vega picks — cycle ${cycle + 1}\n\n${body}\n\nTight stops. Long only.`
      const res = await Telegram.sendMessage(tgText)
      if (res.ok) {
        await this.db.query(
          'INSERT INTO lila_log (message, type) VALUES ($1,$2)',
          [`Telegram: pushed ${queuedPicks.length} pick${queuedPicks.length > 1 ? 's' : ''} to your chat.`, 'success']
        )
      } else {
        await this.db.query(
          'INSERT INTO lila_log (message, type) VALUES ($1,$2)',
          [`Telegram push failed: ${res.error ?? 'unknown'}`, 'warn']
        )
      }
    } else if (queuedPicks.length > 0) {
      // Picks were ready to share but Telegram isn't configured — noise-free info.
      await this.db.query(
        'INSERT INTO lila_log (message, type) VALUES ($1,$2)',
        [`Telegram not configured — ${queuedPicks.length} pick${queuedPicks.length > 1 ? 's' : ''} stayed internal.`, 'info']
      )
    }

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
    try {
      const { content } = await llmCall({
        ai: this.ai,
        module,
        messages: [{ role: 'user', content: prompt }],
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

  // Surface a one-line warn into lila_log. Dedupes within an hour so a
  // sustained issue (e.g. truncated Alpaca history) doesn't spam the log.
  private async warn(message: string): Promise<void> {
    const fingerprint = message.slice(0, 80)
    const { rows } = await this.db.query(
      `SELECT 1 FROM lila_log
       WHERE type='warn' AND message LIKE $1
         AND created_at > NOW() - INTERVAL '1 hour'
       LIMIT 1`,
      [fingerprint + '%']
    )
    if (rows.length > 0) return
    await this.db.query(
      `INSERT INTO lila_log (message, type) VALUES ($1, 'warn')`,
      [message]
    )
  }

  async note(path: string, content: string): Promise<void> {
    await this.db.query(
      `INSERT INTO analyst_notes (path, content, updated_at) VALUES ($1,$2,NOW())
       ON CONFLICT (path) DO UPDATE SET content=$2, updated_at=NOW()`,
      [path, content]
    )
  }

  // kind: 'message' (chat-visible) | 'status' (work update, hidden from Chat)
  async chat(sender: string, content: string, kind: 'message' | 'status' = 'message'): Promise<void> {
    await this.db.query(
      `INSERT INTO chat_messages (sender, content, kind) VALUES ($1,$2,$3)`,
      [sender, content, kind]
    )
  }
}

function today() { return new Date().toISOString().slice(0, 10) }
