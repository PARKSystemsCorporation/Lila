import { NextResponse } from 'next/server'
import OpenAI from 'openai'
import { getPool, ensureSchema } from '@/lib/db'
import { llmCall, LLMBudgetExceeded } from '@/lib/llm'

export const dynamic = 'force-dynamic'

const ai = process.env.DEEPSEEK_API_KEY
  ? new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com/v1' })
  : null

const PITCH_PROMPT = `You are writing a one-page retainer sales pitch for PARKSystems Corporation — operators of the Lila autonomous security research agent.

Target buyer: DeFi / web3 protocol teams who want continuous security monitoring but can't afford a full-time auditor.

Performance facts you MAY cite — use them only if the number is non-zero and meaningful. Do not fabricate.

{FACTS}

Output a single markdown document with these sections exactly:

# Retainer · Continuous Security Research

## Why
Two sentences. The problem (protocols ship fast, audits don't scale, bounty platforms react not prevent) and the answer (Lila grinds one codebase at a time with persistent memory — each week of attention compounds).

## What you get
- **Monthly deep audit** of one codebase: target-pinned phase machine (map → surfaces → invariants → hypothesize → investigate), 10+ cycles of research, full memory across cycles.
- **Weekly surface scans** on any other contract in scope.
- **Direct Telegram channel** to your security lead for any finding that matters.
- **Draft → review → your team** workflow. Nothing hits public disclosure without your sign-off.

## Pricing

| Tier  | Monthly | Includes |
|-------|---------|----------|
| Watch | $2,000  | 1 monthly deep audit + weekly surface scans |
| Scan  | $3,000  | 2 deep audits + ad-hoc scans + priority Telegram |
| Deep  | $5,000  | 3+ deep audits + custom research directions + weekly call |

Annual prepay: 10% off.

## How we work
- Pin your first target within 24h of signing.
- Monthly sync call, unlimited Telegram + email in between.
- Every finding is drafted by Tasker, reviewed by Lila (manager-tier), then delivered to your team. You decide disclosure.
- You keep the findings either way — nothing gets sold to bounty platforms without your approval.

## Why this vs. a one-off audit
Audits are point-in-time. Your code keeps shipping. Retainer means the research memory keeps growing too — month two on the same codebase is structurally deeper than month one. Bounty platforms are reactive; we work before the exploit.

## Track record
{TRACK_RECORD}

## Next step
Reply to this email (or DM on Bluesky / Telegram) with your repo URL. We'll return a scoping note within 24h.

---
*PARKSystems Corporation · autonomous security research*

Rules:
- Keep total under 500 words.
- No "we leverage cutting-edge AI". No hashtags. No emojis.
- If the track-record numbers are all zero, write a short honest line like "Newly launched service — ask us for current-cycle research examples on request." instead of fabricating stats.`

async function gatherFacts(db: import('pg').PoolClient): Promise<{ facts: string; trackRecord: string }> {
  const [earnings, reports, targets, positions] = await Promise.all([
    db.query('SELECT total_earned FROM lila_state WHERE id=1'),
    db.query(`
      SELECT
        COUNT(*)                                           AS total,
        COUNT(*) FILTER (WHERE status='paid')              AS paid_count,
        COALESCE(SUM(payout) FILTER (WHERE status='paid'), 0) AS paid_sum,
        COUNT(*) FILTER (WHERE status='submitted')         AS submitted
      FROM security_reports
    `),
    db.query(`
      SELECT
        COUNT(*)                                            AS total,
        COUNT(*) FILTER (WHERE status='found')              AS found_count,
        COUNT(*) FILTER (WHERE status='exhausted')          AS exhausted_count,
        COALESCE(AVG(cycles), 0)::int                       AS avg_cycles
      FROM research_targets
    `),
    db.query(`
      SELECT COUNT(*) AS closed_count, COALESCE(SUM(pnl) FILTER (WHERE pnl > 0), 0) AS wins
      FROM lila_positions WHERE status='closed'
    `),
  ])

  const te = parseFloat(earnings.rows[0]?.total_earned ?? '0')
  const r = reports.rows[0] ?? {}
  const t = targets.rows[0] ?? {}
  const p = positions.rows[0] ?? {}

  const facts = [
    `Lifetime confirmed earnings (paid bounties + closed-trade P&L): $${te.toFixed(2)}`,
    `Security reports filed (all time): ${r.total ?? 0}`,
    `Reports paid out: ${r.paid_count ?? 0} for a total of $${parseFloat(r.paid_sum ?? '0').toFixed(2)}`,
    `Reports in submitted / awaiting payout: ${r.submitted ?? 0}`,
    `Research targets investigated: ${t.total ?? 0}`,
    `Targets that produced a finding: ${t.found_count ?? 0}`,
    `Avg research depth per target: ${t.avg_cycles ?? 0} cycles`,
    `Closed trades: ${p.closed_count ?? 0}, winning pnl total: $${parseFloat(p.wins ?? '0').toFixed(2)}`,
  ].join('\n')

  // A tighter track-record string to inject into the section directly.
  const items: string[] = []
  if (Number(r.paid_count) > 0) items.push(`- ${r.paid_count} paid reports, $${parseFloat(r.paid_sum).toFixed(2)} received`)
  if (Number(t.found_count) > 0) items.push(`- ${t.found_count} research targets closed with findings`)
  if (Number(t.total) > 0) items.push(`- ${t.total} codebases researched, average ${t.avg_cycles} research cycles each`)
  if (Number(p.closed_count) > 0) items.push(`- ${p.closed_count} trades closed, tight-stop discipline`)

  const trackRecord = items.length > 0
    ? items.join('\n')
    : 'Newly launched service — ask us for current-cycle research examples on request.'

  return { facts, trackRecord }
}

// GET → latest stored pitch (if any)
export async function GET() {
  if (!process.env.DATABASE_URL) return NextResponse.json({ content: null, created_at: null })

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)
    const { rows: [row] } = await db.query(
      `SELECT content, (EXTRACT(EPOCH FROM updated_at) * 1000)::bigint AS ts
       FROM analyst_notes
       WHERE path LIKE 'lila/pitches/retainer-%'
       ORDER BY updated_at DESC LIMIT 1`
    )
    return NextResponse.json({
      content: row?.content ?? null,
      created_at: row?.ts ? Number(row.ts) : null,
    })
  } finally { db.release() }
}

// POST → (re)generate the pitch using live facts
export async function POST() {
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: 'no db' }, { status: 503 })
  if (!ai) return NextResponse.json({ error: 'DEEPSEEK_API_KEY not set' }, { status: 503 })

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)

    const { facts, trackRecord } = await gatherFacts(db)

    let content: string
    try {
      const res = await llmCall({
        ai,
        module: 'pitch.retainer',
        messages: [{
          role: 'user',
          content: PITCH_PROMPT
            .replace('{FACTS}', facts)
            .replace('{TRACK_RECORD}', trackRecord),
        }],
        max_tokens: 900,
        temperature: 0.5,
      })
      content = res.content
    } catch (e) {
      if (e instanceof LLMBudgetExceeded) {
        return NextResponse.json({ error: e.message }, { status: 429 })
      }
      throw e
    }

    const today = new Date().toISOString().slice(0, 10)
    const path = `lila/pitches/retainer-${today}`
    await db.query(
      `INSERT INTO analyst_notes (path, content, updated_at) VALUES ($1,$2,NOW())
       ON CONFLICT (path) DO UPDATE SET content=$2, updated_at=NOW()`,
      [path, content]
    )

    return NextResponse.json({ content, path, created_at: Date.now() })
  } finally { db.release() }
}
