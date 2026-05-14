import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const revalidate = 0

interface TopEdge {
  id: number
  sport: string
  game_label: string
  market: string
  side: string
  edge_pct: number | null
  edge_points: number | null
  model_prob: number | null
  book_spread: number | null
  model_spread: number | null
  kickoff_ts: number | null
  confidence: string
}

interface Article {
  id: number
  title: string
  excerpt: string
  author: string
  kind: string
  created_ts: number
}

function excerptOf(content: string, max = 220): string {
  const stripped = content
    .replace(/^#.+$/gm, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[*_`>#-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (stripped.length <= max) return stripped
  return stripped.slice(0, max).replace(/\s+\S*$/, '') + '…'
}

export async function GET() {
  const empty = NextResponse.json({ top_edges: [], articles: [], refreshed_ts: Date.now() })
  if (!process.env.DATABASE_URL) return empty

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)

    const [edgesRes, articlesRes] = await Promise.all([
      // Racing top picks. We map the racing columns onto the legacy TopEdge
      // shape (game_label ← race_label, side ← horse_name, edge_points ← null)
      // so the public landing page keeps rendering.
      db.query(
        `SELECT id, race_label, market, horse_name, edge_pct, model_prob,
                fair_decimal, book_decimal, confidence,
                (EXTRACT(EPOCH FROM off_dt) * 1000)::bigint AS off_ts
         FROM ceelo_picks
         WHERE status='open'
         ORDER BY intensity DESC NULLS LAST, COALESCE(edge_pct, 0) DESC, created_at DESC
         LIMIT 3`
      ),
      db.query(
        `SELECT id, title, content, author, kind,
                (EXTRACT(EPOCH FROM created_at) * 1000)::bigint AS created_ts
         FROM articles
         WHERE status='published' AND author='ceelo'
         ORDER BY created_at DESC
         LIMIT 3`
      ),
    ])

    const top_edges: TopEdge[] = edgesRes.rows.map(r => ({
      id: Number(r.id),
      sport: 'RACING',
      game_label: r.race_label,
      market: r.market ?? 'win',
      side: r.horse_name,
      edge_pct: r.edge_pct != null ? Number(r.edge_pct) : null,
      edge_points: null,
      model_prob: r.model_prob != null ? Number(r.model_prob) : null,
      book_spread: null,
      model_spread: null,
      kickoff_ts: r.off_ts != null ? Number(r.off_ts) : null,
      confidence: r.confidence,
    }))

    const articles: Article[] = articlesRes.rows.map(r => ({
      id: Number(r.id),
      title: r.title,
      excerpt: excerptOf(r.content),
      author: r.author ?? 'ceelo',
      kind: r.kind ?? 'noon-report',
      created_ts: Number(r.created_ts),
    }))

    return NextResponse.json({ top_edges, articles, refreshed_ts: Date.now() })
  } catch {
    return empty
  } finally {
    db.release()
  }
}
