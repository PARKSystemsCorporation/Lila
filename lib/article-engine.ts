import OpenAI from 'openai'
import type { PoolClient } from 'pg'
import { llmCall, LLMBudgetExceeded } from './llm'

// Daily noon Substack-ready articles, one per agent. Drafts persist in
// `articles` (kind='noon-report', author=lila|vega|ceelo). The operator
// reads them in the Library → Articles sub-tab and copy-pastes to
// Substack from there. We never publish externally.
//
// Schedule: each agent's loop polls shouldWriteToday(author) every cycle
// and calls generateNoonReport when the noon gate hits and there's no
// article for today yet. Manual triggers use generateNoonReport directly.

export type ArticleAuthor = 'lila' | 'vega' | 'ceelo'

const NOON_HOUR_UTC = 12   // operator can shift via NOON_HOUR_UTC env later

// ── Public API ────────────────────────────────────────────────────────────

export const ALL_AUTHORS: ArticleAuthor[] = ['lila', 'vega', 'ceelo']

// One pass per tick. Each author gets at most one noon article per UTC
// day. Runs sequentially to keep token cost predictable.
export async function runNoonArticles(db: PoolClient): Promise<{ generated: ArticleAuthor[]; skipped: ArticleAuthor[] }> {
  const generated: ArticleAuthor[] = []
  const skipped: ArticleAuthor[] = []
  for (const author of ALL_AUTHORS) {
    if (!(await shouldWriteNoonToday(db, author))) { skipped.push(author); continue }
    const r = await generateNoonReport(db, author).catch(() => ({ ok: false } as GenerateResult))
    if (r.ok) generated.push(author)
    else      skipped.push(author)
  }
  return { generated, skipped }
}

export async function shouldWriteNoonToday(db: PoolClient, author: ArticleAuthor): Promise<boolean> {
  if (new Date().getUTCHours() < NOON_HOUR_UTC) return false
  const { rows } = await db.query(
    `SELECT 1 FROM articles
     WHERE author = $1 AND kind = 'noon-report'
       AND created_at::date = (NOW() AT TIME ZONE 'UTC')::date
     LIMIT 1`,
    [author]
  )
  return rows.length === 0
}

export interface GenerateResult {
  ok: boolean
  id?: number
  title?: string
  reason?: string   // failure reason (budget, no-context, llm-err)
}

export async function generateNoonReport(db: PoolClient, author: ArticleAuthor): Promise<GenerateResult> {
  const ai = process.env.DEEPSEEK_API_KEY
    ? new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com/v1' })
    : null
  if (!ai) return { ok: false, reason: 'no-llm-key' }

  const ctx = await gatherContext(db, author)
  if (!ctx.hasSubstance) return { ok: false, reason: 'no-context' }

  const prompt = PROMPT_BY_AUTHOR[author]
    .replace('{DATE}', new Date().toISOString().slice(0, 10))
    .replace('{CONTEXT}', ctx.body)

  let raw: string
  try {
    const res = await llmCall({
      ai,
      module: `article.noon.${author}`,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1500,
      temperature: 0.5,
    })
    raw = res.content.trim()
  } catch (e) {
    if (e instanceof LLMBudgetExceeded) return { ok: false, reason: 'budget' }
    return { ok: false, reason: `llm-err: ${String(e).slice(0, 80)}` }
  }
  if (!raw) return { ok: false, reason: 'empty' }

  // First line of the markdown is the title (LLM is instructed to start
  // with `# Title`). Fall back to a default if the model misformats.
  const title = extractTitle(raw) ?? `${capitalize(author)} — ${new Date().toISOString().slice(0, 10)}`

  const { rows: [row] } = await db.query(
    `INSERT INTO articles (title, content, source, status, author, kind)
     VALUES ($1, $2, $3, 'draft', $4, 'noon-report')
     RETURNING id`,
    [title, raw, `${author}-noon`, author]
  )
  return { ok: true, id: Number(row.id), title }
}

// ── Per-author context + prompts ──────────────────────────────────────────

interface Context { hasSubstance: boolean; body: string }

async function gatherContext(db: PoolClient, author: ArticleAuthor): Promise<Context> {
  if (author === 'lila')  return gatherLilaContext(db)
  if (author === 'vega')  return gatherVegaContext(db)
  return gatherCeeloContext(db)
}

async function gatherLilaContext(db: PoolClient): Promise<Context> {
  const [paid, pipeline, positions, closed, lastWeekLog] = await Promise.all([
    db.query(
      `SELECT title, payout, platform_label, paid_at FROM security_reports
       WHERE status='paid' AND paid_at > NOW() - INTERVAL '7 days'
       ORDER BY paid_at DESC LIMIT 5`
    ),
    db.query(
      `SELECT
          COUNT(*) FILTER (WHERE status='pending_review') AS reviewing,
          COUNT(*) FILTER (WHERE status='approved')       AS approved,
          COUNT(*) FILTER (WHERE status='submitted')      AS submitted,
          COALESCE(SUM(reward) FILTER (WHERE status='submitted'), 0) AS submit_max
       FROM security_reports`
    ),
    db.query(
      `SELECT symbol, direction FROM lila_positions WHERE status='open' LIMIT 10`
    ),
    db.query(
      `SELECT symbol, pnl FROM lila_positions
       WHERE status='closed' AND closed_at > NOW() - INTERVAL '7 days'
         AND COALESCE(ABS(pnl), 0) >= 1
       ORDER BY closed_at DESC LIMIT 8`
    ),
    db.query(
      `SELECT message, type FROM lila_log
       WHERE created_at > NOW() - INTERVAL '7 days'
       ORDER BY id DESC LIMIT 30`
    ),
  ])

  const lines: string[] = []
  if (paid.rows.length) {
    lines.push('PAID THIS WEEK:')
    for (const p of paid.rows) lines.push(`  ${p.title} — $${parseFloat(p.payout).toFixed(2)} on ${p.platform_label}`)
  }
  const pl = pipeline.rows[0] ?? {}
  lines.push(`BOUNTY PIPELINE: ${Number(pl.reviewing ?? 0)} reviewing · ${Number(pl.approved ?? 0)} ready to submit · ${Number(pl.submitted ?? 0)} submitted (≤ $${parseFloat(pl.submit_max ?? '0').toFixed(0)} max pending)`)
  if (positions.rows.length) {
    lines.push(`OPEN POSITIONS: ${positions.rows.map((p: { symbol: string; direction: string }) => `${p.symbol} ${p.direction}`).join(', ')}`)
  }
  if (closed.rows.length) {
    lines.push('CLOSED TRADES THIS WEEK:')
    for (const t of closed.rows) {
      const v = parseFloat(t.pnl ?? '0')
      lines.push(`  ${t.symbol} ${v >= 0 ? '+' : ''}$${v.toFixed(2)}`)
    }
  }
  if (lastWeekLog.rows.length) {
    lines.push('NOTABLE EVENTS:')
    for (const l of lastWeekLog.rows.slice(0, 12)) lines.push(`  [${l.type}] ${String(l.message).slice(0, 140)}`)
  }
  return { hasSubstance: lines.length > 1, body: lines.join('\n') }
}

async function gatherVegaContext(db: PoolClient): Promise<Context> {
  const [notes, picks, openPos, closedTrades] = await Promise.all([
    db.query(
      `SELECT path, content FROM analyst_notes
       WHERE updated_at > NOW() - INTERVAL '7 days'
       ORDER BY updated_at DESC LIMIT 6`
    ),
    db.query(
      `SELECT symbol, direction, entry_price, target_price, confidence, reason
       FROM analyst_picks
       WHERE created_at > NOW() - INTERVAL '14 days'
       ORDER BY created_at DESC LIMIT 8`
    ),
    db.query(
      `SELECT symbol, direction, entry_price FROM lila_positions
       WHERE status='open' LIMIT 8`
    ),
    db.query(
      `SELECT symbol, direction, pnl FROM lila_positions
       WHERE status='closed' AND closed_at > NOW() - INTERVAL '14 days'
         AND COALESCE(ABS(pnl), 0) >= 1
       ORDER BY closed_at DESC LIMIT 8`
    ),
  ])

  const lines: string[] = []
  if (notes.rows.length) {
    lines.push('VEGA NOTES (latest):')
    for (const n of notes.rows) {
      const body = String(n.content ?? '').slice(0, 400).replace(/\s+/g, ' ').trim()
      lines.push(`  [${n.path}] ${body}`)
    }
  }
  if (picks.rows.length) {
    lines.push('RECENT PICKS:')
    for (const p of picks.rows) {
      lines.push(`  ${p.symbol} ${p.direction} entry=${p.entry_price} tgt=${p.target_price} conf=${p.confidence} — ${String(p.reason ?? '').slice(0, 120)}`)
    }
  }
  if (openPos.rows.length) {
    lines.push(`OPEN POSITIONS: ${openPos.rows.map((p: { symbol: string; direction: string }) => `${p.symbol} ${p.direction}`).join(', ')}`)
  }
  if (closedTrades.rows.length) {
    lines.push('CLOSED TRADES (last 2 weeks):')
    for (const t of closedTrades.rows) {
      const v = parseFloat(t.pnl ?? '0')
      lines.push(`  ${t.symbol} ${t.direction} ${v >= 0 ? '+' : ''}$${v.toFixed(2)}`)
    }
  }
  return { hasSubstance: lines.length > 0, body: lines.join('\n') }
}

async function gatherCeeloContext(db: PoolClient): Promise<Context> {
  const [edges, finals, top, epaTop] = await Promise.all([
    db.query(
      `WITH latest AS (
         SELECT DISTINCT ON (l.game_id, l.book)
                l.game_id, l.book, l.home_line
         FROM ceelo_lines l
         WHERE l.market='spread' AND l.home_line IS NOT NULL
         ORDER BY l.game_id, l.book, l.fetched_at DESC
       )
       SELECT g.sport, g.home_team, g.away_team, g.kickoff_at,
              m.model_spread, l.home_line AS book_spread, l.book
       FROM ceelo_games g
       JOIN ceelo_model_lines m ON m.game_id = g.id
       JOIN latest l            ON l.game_id = g.id
       WHERE g.status='scheduled' AND g.kickoff_at > NOW()
         AND g.kickoff_at < NOW() + INTERVAL '4 days'
         AND ABS(l.home_line - m.model_spread) >= 1.0
       ORDER BY ABS(l.home_line - m.model_spread) DESC
       LIMIT 8`
    ),
    db.query(
      `SELECT sport, home_team, away_team, home_score, away_score, closing_spread
       FROM ceelo_games
       WHERE status='final' AND graded_at > NOW() - INTERVAL '3 days'
       ORDER BY kickoff_at DESC LIMIT 10`
    ),
    db.query(
      `SELECT sport, team, rating, games_played FROM ceelo_team_ratings
       WHERE games_played > 0
       ORDER BY rating DESC LIMIT 12`
    ),
    db.query(
      `SELECT team, season, net_epa
       FROM ceelo_team_epa
       WHERE season = (SELECT MAX(season) FROM ceelo_team_epa)
       ORDER BY net_epa DESC LIMIT 5`
    ),
  ])

  const lines: string[] = []
  if (edges.rows.length) {
    lines.push('TOP EDGES THIS WEEK:')
    for (const e of edges.rows) {
      const m = Number(e.model_spread).toFixed(1)
      const b = Number(e.book_spread).toFixed(1)
      const edge = (Number(e.book_spread) - Number(e.model_spread)).toFixed(1)
      const takeHome = Number(edge) > 0
      const sign = Number(edge) >= 0 ? '+' : ''
      lines.push(`  ${e.sport} ${e.away_team}@${e.home_team} — model ${m}, ${e.book} ${b}, edge ${sign}${edge} (take ${takeHome ? e.home_team : e.away_team})`)
    }
  }
  if (finals.rows.length) {
    lines.push('RECENT FINALS:')
    for (const f of finals.rows) {
      const cs = f.closing_spread != null ? ` (closed ${Number(f.closing_spread).toFixed(1)})` : ''
      lines.push(`  ${f.sport} ${f.away_team} ${f.away_score} @ ${f.home_team} ${f.home_score}${cs}`)
    }
  }
  if (top.rows.length) {
    lines.push('TOP-RATED TEAMS:')
    lines.push('  ' + top.rows.map((r: { sport: string; team: string; rating: string }) =>
      `${r.sport}/${r.team} ${Number(r.rating).toFixed(0)}`
    ).join(', '))
  }
  if (epaTop.rows.length) {
    lines.push('TOP NET-EPA (NFL):')
    lines.push('  ' + epaTop.rows.map((r: { team: string; net_epa: string }) =>
      `${r.team} ${Number(r.net_epa) >= 0 ? '+' : ''}${Number(r.net_epa).toFixed(3)}`
    ).join(', '))
  }
  return { hasSubstance: lines.length > 0, body: lines.join('\n') }
}

// ── Author prompts ────────────────────────────────────────────────────────

const LILA_PROMPT = `You are Lila, COO of an autonomous bounty-and-trading shop. You're writing today's noon report for Substack — your daily check-in for the readers who follow this experiment.

DATE: {DATE}

Voice: dry, direct, CEO-tone briefing. Honest about wins and losses both. No hype, no marketer copy. 600-800 words. Write in markdown.

What you've done this week (use this verbatim — do not invent numbers beyond it):
{CONTEXT}

Output a complete markdown article with:
# Title — short, specific to the week (not "weekly update")
## TL;DR — 3 bullets
## What happened
What the team shipped, what paid, what trades closed. Specific numbers from above.
## What's in flight
What's pending in the pipeline + open trades.
## What I'm thinking
1-2 paragraphs of operator-perspective: where's the edge moving, what's working, what's not.
## Next week
What I'm having Cipher / Vega / Scout / Ceelo focus on.

Output the markdown article only — no surrounding commentary.`

const VEGA_PROMPT = `You are Vega, market analyst at Lila's shop. Today's noon Substack — your read on the markets you cover (commodity ETFs, leveraged indices, global macro).

DATE: {DATE}

Voice: dry, numbers-first, quant-trained. No hype. Don't pretend to certainty you don't have. 600-800 words. Markdown.

What you've been watching (use this verbatim — do not invent positions or picks beyond it):
{CONTEXT}

Output a complete markdown article with:
# Title — name the read or thesis
## TL;DR — 3 bullets
## The setup
What you're seeing in the data. Specific tickers + levels.
## What I picked, what worked
Recent picks, what closed, win rate honest assessment.
## Where I'm leaning
The thesis you're carrying into next week. Tickers, direction, risk.
## What would change my mind
The specific signal that would invalidate the thesis.

Output the markdown article only.`

const CEELO_PROMPT = `You are Ceelo, NFL/NBA/MLB/NHL handicapper at Lila's shop. Today's noon Substack — your edge report across the slates.

DATE: {DATE}

Voice: dry, sharp, numbers-first. You're a sharp, not a tout. No exclamation points. 600-800 words. Markdown.

Your edges + recent results (use this verbatim — do not invent edges beyond it):
{CONTEXT}

Output a complete markdown article with:
# Title — call out the standout edge or theme
## TL;DR — 3 bullets
## Top edges right now
Walk through the 2-3 cleanest ones with model line, book line, edge in points, and the situational reasoning.
## What just settled
1-2 recent finals — did the model agree with the close? Did public side eat it?
## Where the model leans next
Sport-specific outlook for the next 3-4 days.
## Disclaimer
"Model lines are derived from Elo (and EPA where available). Public bet/money % from Action Network when present. Operator decides what to take — Ceelo doesn't bet."

Output the markdown article only.`

const PROMPT_BY_AUTHOR: Record<ArticleAuthor, string> = {
  lila:  LILA_PROMPT,
  vega:  VEGA_PROMPT,
  ceelo: CEELO_PROMPT,
}

// ── helpers ───────────────────────────────────────────────────────────────

function extractTitle(md: string): string | null {
  const m = md.match(/^\s*#\s+(.+?)\s*$/m)
  return m ? m[1].trim().slice(0, 200) : null
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
