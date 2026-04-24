import { NextResponse } from 'next/server'
import OpenAI from 'openai'
import { getPool, ensureSchema } from '@/lib/db'
import { llmCall, LLMBudgetExceeded } from '@/lib/llm'
import { affiliatePromptBlock } from '@/lib/affiliates'

export const dynamic = 'force-dynamic'

const ai = process.env.DEEPSEEK_API_KEY
  ? new OpenAI({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com/v1' })
  : null

const ARTICLE_PROMPT = `You are Lila writing a technical deep-dive for a Substack / mirror.xyz audience.

Audience: web3 developers and security-curious engineers. Not laypeople.

Voice: dry, observational, opinionated. Senior engineer narrating what they
noticed during real research. Numbers and concrete examples > theory. No fluff,
no "in this article", no marketer copy.

Source notes from our actual research on this codebase (everything we
observed — architecture, surfaces, invariants, hypotheses, evidence, finding):
---
{NOTES}
---

Tools we may mention. ONLY hyperlink ones with an affiliate URL given;
the OSS-no-program ones get plain-text mentions. Do not invent links.
{AFFILIATES}

Output a complete markdown article (~700-1100 words) using these sections:

# Title
A real title — what we learned, not a generic "Auditing X". Avoid clickbait.

## TL;DR
3 bullets. Concrete.

## Background
The protocol/codebase in one short paragraph. Just enough to orient.

## What we mapped
Architecture observations. Actors, contracts, money flow, privileges.

## Invariants worth defending
3-5 of the most interesting properties that must hold. Numbered or bulleted.

## Where things could bend
Hypotheses we generated and why. Brief reasoning per item.

## What we found
The actual finding if any, OR honest "exhausted without a hit, here's what
that suggests". Don't invent a finding to look good.

## Tools and methodology
Natural mentions of tools we'd actually use for this kind of work. Hyperlink
ONLY the ones with an affiliate URL above. Don't oversell — these are
mentions, not endorsements.

## Takeaway
One paragraph. What a reader takes from this beyond the specifics.

Hard rules:
- No fabrication beyond the source notes.
- No "USE TOOL X!" — natural mentions only.
- Don't moralize. Don't hedge. Show the work.`

export async function GET() {
  if (!process.env.DATABASE_URL) return NextResponse.json({ articles: [], counts: { draft: 0, published: 0, dismissed: 0 } })
  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)

    const { rows } = await db.query(
      `SELECT id, title, content, source, status, external_url,
              (EXTRACT(EPOCH FROM created_at) * 1000)::bigint AS created_ts,
              (EXTRACT(EPOCH FROM updated_at) * 1000)::bigint AS updated_ts
       FROM articles
       ORDER BY
         CASE status WHEN 'draft' THEN 1 WHEN 'published' THEN 2 ELSE 3 END,
         created_at DESC
       LIMIT 50`
    )
    const { rows: [counts] } = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status='draft')     AS draft,
         COUNT(*) FILTER (WHERE status='published') AS published,
         COUNT(*) FILTER (WHERE status='dismissed') AS dismissed
       FROM articles`
    )
    return NextResponse.json({
      articles: rows.map(r => ({
        id: Number(r.id),
        title: r.title,
        content: r.content,
        source: r.source,
        status: r.status,
        external_url: r.external_url,
        created_ts: Number(r.created_ts),
        updated_ts: Number(r.updated_ts),
      })),
      counts: {
        draft: Number(counts.draft ?? 0),
        published: Number(counts.published ?? 0),
        dismissed: Number(counts.dismissed ?? 0),
      },
    })
  } finally { db.release() }
}

// POST actions:
//   { action: 'generate' }                       → write a fresh article from
//                                                  the most recent terminal
//                                                  research target (found or
//                                                  exhausted). Operator can
//                                                  pass {targetId: N} to pin
//                                                  a specific one.
//   { action: 'mark_published', id, external_url? }
//   { action: 'dismiss',  id }
export async function POST(req: Request) {
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: 'no db' }, { status: 503 })
  const body = await req.json().catch(() => ({}))
  const action = String(body.action ?? 'generate')

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)

    if (action === 'mark_published') {
      const id = Number(body.id)
      if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
      await db.query(
        `UPDATE articles SET status='published', external_url=$1, updated_at=NOW() WHERE id=$2`,
        [body.external_url ?? null, id]
      )
      return NextResponse.json({ ok: true })
    }

    if (action === 'dismiss') {
      const id = Number(body.id)
      if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
      await db.query(`UPDATE articles SET status='dismissed', updated_at=NOW() WHERE id=$1`, [id])
      return NextResponse.json({ ok: true })
    }

    if (action !== 'generate') {
      return NextResponse.json({ error: 'bad action' }, { status: 400 })
    }

    if (!ai) return NextResponse.json({ error: 'DEEPSEEK_API_KEY not set' }, { status: 503 })

    // Pick a research target — operator-specified or the most recent terminal one.
    let targetId: number | null = body.targetId ? Number(body.targetId) : null
    if (!targetId) {
      const { rows } = await db.query(
        `SELECT id FROM research_targets
         WHERE status IN ('found','exhausted')
         ORDER BY last_worked_at DESC NULLS LAST, id DESC LIMIT 1`
      )
      targetId = rows[0]?.id ?? null
    }
    if (!targetId) {
      return NextResponse.json(
        { error: 'No completed research targets yet. Wait for Cipher to finish a target, or pass {targetId}.' },
        { status: 404 }
      )
    }

    const { rows: [target] } = await db.query(
      `SELECT id, title, platform_label, scope, phase, cycles, status FROM research_targets WHERE id=$1`,
      [targetId]
    )
    if (!target) return NextResponse.json({ error: 'target not found' }, { status: 404 })

    const { rows: notes } = await db.query(
      `SELECT kind, content FROM research_notes
       WHERE target_id=$1
       ORDER BY
         CASE kind
           WHEN 'arch' THEN 1 WHEN 'surfaces' THEN 2 WHEN 'invariants' THEN 3
           WHEN 'hypothesis:open' THEN 4 WHEN 'hypothesis:closed' THEN 5
           WHEN 'evidence' THEN 6 WHEN 'finding' THEN 7 ELSE 8 END,
         id ASC`,
      [targetId]
    )

    const notesBlob = notes
      .map((n: { kind: string; content: string }) => `=== ${n.kind} ===\n${n.content}`)
      .join('\n\n')
      .slice(0, 14_000)

    let content: string
    try {
      const res = await llmCall({
        ai,
        module: 'article.generate',
        messages: [{
          role: 'user',
          content: ARTICLE_PROMPT
            .replace('{NOTES}', notesBlob || `(target "${target.title}" — ${target.status} after ${target.cycles} cycles, scope:\n${target.scope})`)
            .replace('{AFFILIATES}', affiliatePromptBlock()),
        }],
        max_tokens: 2200,
        temperature: 0.5,
      })
      content = res.content.trim()
    } catch (e) {
      if (e instanceof LLMBudgetExceeded) {
        return NextResponse.json({ error: e.message }, { status: 429 })
      }
      throw e
    }

    // Pull a title from the first markdown H1; fall back to research title.
    const titleMatch = content.match(/^#\s+(.+)$/m)
    const title = (titleMatch?.[1] ?? `Notes on ${target.title}`).slice(0, 200)

    const { rows: [inserted] } = await db.query(
      `INSERT INTO articles (title, content, source, status)
       VALUES ($1, $2, $3, 'draft')
       RETURNING id`,
      [title, content, `research:${targetId}`]
    )

    return NextResponse.json({
      id: Number(inserted.id),
      title,
      content,
      source: `research:${targetId}`,
      status: 'draft',
    })
  } finally { db.release() }
}
