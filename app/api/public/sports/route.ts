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
      db.query(
        `SELECT id, sport, game_label, market, side, edge_pct, edge_points,
                model_prob, book_spread, model_spread, confidence,
                (EXTRACT(EPOCH FROM kickoff_at) * 1000)::bigint AS kickoff_ts
         FROM ceelo_picks
         WHERE status='open'
         ORDER BY
           CASE WHEN edge_points IS NOT NULL THEN ABS(edge_points) ELSE 0 END DESC,
           COALESCE(edge_pct, 0) DESC,
           created_at DESC
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
      sport: String(r.sport ?? 'NFL'),
      game_label: r.game_label,
      market: r.market,
      side: r.side,
      edge_pct: r.edge_pct != null ? Number(r.edge_pct) : null,
      edge_points: r.edge_points != null ? Number(r.edge_points) : null,
      model_prob: r.model_prob != null ? Number(r.model_prob) : null,
      book_spread: r.book_spread != null ? Number(r.book_spread) : null,
      model_spread: r.model_spread != null ? Number(r.model_spread) : null,
      kickoff_ts: r.kickoff_ts != null ? Number(r.kickoff_ts) : null,
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
