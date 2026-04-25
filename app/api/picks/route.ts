import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import { netProfit } from '@/lib/ceelo-loop'

export const dynamic = 'force-dynamic'

// GET /api/picks
//   → { picks: PickRow[], summary: { open, active, record, bankroll } }
//
// PickRow groups: status='open' (Ceelo posted, awaiting decision),
// 'taken' (operator placed, awaiting settle), and settled (won/lost/push/void).
// 'skipped' is hidden from the main list but counted.

type Status = 'open' | 'skipped' | 'taken' | 'won' | 'lost' | 'push' | 'void'

interface PickRow {
  id: number
  game_label: string
  kickoff_at: number | null
  market: string
  side: string
  model_prob: number | null
  fair_line: string | null
  min_odds: number | null
  edge_pct: number | null
  reasoning: string
  confidence: string
  status: Status
  stake: number | null
  taken_odds: number | null
  payout: number | null
  taken_at: number | null
  settled_at: number | null
  created_ts: number
}

export async function GET() {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({
      picks: [],
      summary: { open: 0, active: 0, record: { wins: 0, losses: 0, pushes: 0 }, bankroll: { staked: 0, returned: 0, pnl: 0, roi: 0 } },
    })
  }

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)

    const { rows } = await db.query(
      `SELECT id, game_label, market, side,
              model_prob, fair_line, min_odds, edge_pct,
              reasoning, confidence, status, stake, taken_odds, payout,
              (EXTRACT(EPOCH FROM kickoff_at) * 1000)::bigint AS kickoff_ts,
              (EXTRACT(EPOCH FROM taken_at)   * 1000)::bigint AS taken_ts,
              (EXTRACT(EPOCH FROM settled_at) * 1000)::bigint AS settled_ts,
              (EXTRACT(EPOCH FROM created_at) * 1000)::bigint AS created_ts
       FROM ceelo_picks
       ORDER BY
         CASE status
           WHEN 'open'   THEN 0
           WHEN 'taken'  THEN 1
           WHEN 'won'    THEN 2
           WHEN 'lost'   THEN 2
           WHEN 'push'   THEN 2
           WHEN 'void'   THEN 2
           WHEN 'skipped' THEN 3
         END,
         created_at DESC
       LIMIT 200`
    )

    const picks: PickRow[] = rows.map(r => ({
      id: Number(r.id),
      game_label: r.game_label,
      kickoff_at: r.kickoff_ts != null ? Number(r.kickoff_ts) : null,
      market: r.market,
      side: r.side,
      model_prob: r.model_prob != null ? Number(r.model_prob) : null,
      fair_line: r.fair_line ?? null,
      min_odds: r.min_odds != null ? Number(r.min_odds) : null,
      edge_pct: r.edge_pct != null ? Number(r.edge_pct) : null,
      reasoning: r.reasoning,
      confidence: r.confidence,
      status: r.status as Status,
      stake: r.stake != null ? Number(r.stake) : null,
      taken_odds: r.taken_odds != null ? Number(r.taken_odds) : null,
      payout: r.payout != null ? Number(r.payout) : null,
      taken_at: r.taken_ts != null ? Number(r.taken_ts) : null,
      settled_at: r.settled_ts != null ? Number(r.settled_ts) : null,
      created_ts: Number(r.created_ts),
    }))

    let open = 0, active = 0, wins = 0, losses = 0, pushes = 0
    let staked = 0, returned = 0
    for (const p of picks) {
      if (p.status === 'open') open++
      else if (p.status === 'taken') {
        active++
        staked += p.stake ?? 0
      }
      else if (p.status === 'won') {
        wins++
        staked += p.stake ?? 0
        // returned = stake + net profit (= stake + payout)
        returned += (p.stake ?? 0) + (p.payout ?? 0)
      } else if (p.status === 'lost') {
        losses++
        staked += p.stake ?? 0
        // returned 0 of the stake
      } else if (p.status === 'push' || p.status === 'void') {
        pushes++
        staked += p.stake ?? 0
        returned += p.stake ?? 0
      }
    }
    const pnl = +(returned - staked).toFixed(2)
    const roi = staked > 0 ? +((pnl / staked) * 100).toFixed(2) : 0

    return NextResponse.json({
      picks,
      summary: {
        open,
        active,
        record: { wins, losses, pushes },
        bankroll: { staked: +staked.toFixed(2), returned: +returned.toFixed(2), pnl, roi },
      },
    })
  } finally { db.release() }
}

// POST /api/picks
//   { action: 'take',   id, stake, taken_odds }
//   { action: 'skip',   id }
//   { action: 'settle', id, result: 'won'|'lost'|'push'|'void' }
//   { action: 'reopen', id }   ← undo accidental skip/settle
//   { action: 'delete', id }
export async function POST(req: Request) {
  if (!process.env.DATABASE_URL) return NextResponse.json({ error: 'no db' }, { status: 503 })
  const body = await req.json().catch(() => ({}))
  const action = String(body.action ?? '')
  const id = Number(body.id)
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)

    if (action === 'take') {
      const stake = Number(body.stake)
      const odds = Math.trunc(Number(body.taken_odds))
      if (!Number.isFinite(stake) || stake <= 0) {
        return NextResponse.json({ error: 'stake must be > 0' }, { status: 400 })
      }
      if (!Number.isFinite(odds) || odds === 0) {
        return NextResponse.json({ error: 'taken_odds required' }, { status: 400 })
      }
      await db.query(
        `UPDATE ceelo_picks
         SET status='taken', stake=$1, taken_odds=$2, taken_at=NOW(), updated_at=NOW()
         WHERE id=$3 AND status IN ('open','skipped')`,
        [stake, odds, id]
      )
      return NextResponse.json({ ok: true })
    }

    if (action === 'skip') {
      await db.query(
        `UPDATE ceelo_picks SET status='skipped', updated_at=NOW()
         WHERE id=$1 AND status='open'`,
        [id]
      )
      return NextResponse.json({ ok: true })
    }

    if (action === 'settle') {
      const result = String(body.result ?? '')
      if (!['won', 'lost', 'push', 'void'].includes(result)) {
        return NextResponse.json({ error: 'bad result' }, { status: 400 })
      }
      const { rows: [row] } = await db.query(
        `SELECT stake, taken_odds FROM ceelo_picks WHERE id=$1 AND status='taken'`,
        [id]
      )
      if (!row) return NextResponse.json({ error: 'not a taken pick' }, { status: 400 })

      let payout = 0
      if (result === 'won') {
        payout = netProfit(Number(row.stake), Number(row.taken_odds))
      } else if (result === 'lost') {
        payout = -Number(row.stake)
      }
      // push / void: payout = 0 (stake refunded; bankroll unchanged)

      await db.query(
        `UPDATE ceelo_picks
         SET status=$1, payout=$2, settled_at=NOW(), updated_at=NOW()
         WHERE id=$3`,
        [result, payout, id]
      )
      return NextResponse.json({ ok: true })
    }

    if (action === 'reopen') {
      await db.query(
        `UPDATE ceelo_picks
         SET status='open', stake=NULL, taken_odds=NULL, payout=NULL,
             taken_at=NULL, settled_at=NULL, updated_at=NOW()
         WHERE id=$1`,
        [id]
      )
      return NextResponse.json({ ok: true })
    }

    if (action === 'delete') {
      await db.query(`DELETE FROM ceelo_picks WHERE id=$1`, [id])
      return NextResponse.json({ ok: true })
    }

    return NextResponse.json({ error: 'bad action' }, { status: 400 })
  } finally { db.release() }
}
