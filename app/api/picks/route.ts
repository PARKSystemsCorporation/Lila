import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import { netProfit } from '@/lib/ceelo-loop'
import * as Odds from '@/lib/ceelo/odds'

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
  model_spread: number | null
  book_spread: number | null
  book_name: string | null
  edge_points: number | null
  source: 'llm' | 'model'
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
      bySport: [],
      status: null,
    })
  }

  const pool = getPool()
  const db = await pool.connect()
  try {
    await ensureSchema(db)

    const picksRes = await db.query(
      `SELECT id, game_label, market, side,
              model_prob, fair_line, min_odds, edge_pct,
              model_spread, book_spread, book_name, edge_points, source,
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
    const stateRes = await db.query(
      `SELECT (EXTRACT(EPOCH FROM last_run_at)      * 1000)::bigint AS last_run_ts,
              (EXTRACT(EPOCH FROM last_schedule_at) * 1000)::bigint AS last_sched_ts,
              (EXTRACT(EPOCH FROM last_grade_at)    * 1000)::bigint AS last_grade_ts,
              (EXTRACT(EPOCH FROM last_lines_at)    * 1000)::bigint AS last_lines_ts,
              cycle
       FROM ceelo_state WHERE id=1`
    )
    const ratingsRes = await db.query(
      `SELECT COUNT(*) AS n FROM ceelo_team_ratings WHERE games_played > 0`,
    )
    const scheduleRes = await db.query(
      `SELECT COUNT(*) AS n FROM ceelo_games
       WHERE status='scheduled' AND kickoff_at > NOW()`
    )
    const modelRes = await db.query(`SELECT COUNT(*) AS n FROM ceelo_model_lines`)
    // Per-sport breakdown — computed in SQL so it covers ALL picks, not
    // just the 200-row UI list. Two streams:
    //   op_*    — operator-marked W/L on bets they actually took
    //   model_* — auto-graded outcomes for every flagged green pick
    const perSportRes = await db.query(
      `SELECT s.sport,
              COUNT(*)                                        FILTER (WHERE p.status='open')                                    AS op_open,
              COUNT(*)                                        FILTER (WHERE p.status='taken')                                   AS op_active,
              COUNT(*)                                        FILTER (WHERE p.status='won')                                     AS op_wins,
              COUNT(*)                                        FILTER (WHERE p.status='lost')                                    AS op_losses,
              COUNT(*)                                        FILTER (WHERE p.status IN ('push','void'))                        AS op_pushes,
              COALESCE(SUM(p.stake)                           FILTER (WHERE p.status IN ('taken','won','lost','push','void')), 0) AS op_staked,
              COALESCE(SUM(p.stake + COALESCE(p.payout, 0))   FILTER (WHERE p.status='won'), 0)                                 AS op_won_returned,
              COALESCE(SUM(p.stake)                           FILTER (WHERE p.status IN ('push','void')), 0)                    AS op_push_returned,
              COUNT(*)                                        FILTER (WHERE p.source='model' AND p.model_outcome='win')         AS model_wins,
              COUNT(*)                                        FILTER (WHERE p.source='model' AND p.model_outcome='loss')        AS model_losses,
              COUNT(*)                                        FILTER (WHERE p.source='model' AND p.model_outcome='push')        AS model_pushes,
              COUNT(*)                                        FILTER (WHERE p.source='model' AND p.model_outcome IS NOT NULL)   AS model_settled,
              COUNT(*)                                        FILTER (WHERE p.source='model' AND p.model_outcome IS NULL)       AS model_pending
       FROM (VALUES ('NFL'),('NBA'),('MLB')) AS s(sport)
       LEFT JOIN ceelo_picks p ON p.sport = s.sport
       GROUP BY s.sport
       ORDER BY s.sport`
    )

    const rows = picksRes.rows
    const s = stateRes.rows[0] ?? {}
    const ratedTeams      = Number(ratingsRes.rows[0]?.n ?? 0)
    const upcomingGames   = Number(scheduleRes.rows[0]?.n ?? 0)
    const modelLineCount  = Number(modelRes.rows[0]?.n ?? 0)

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
      model_spread: r.model_spread != null ? Number(r.model_spread) : null,
      book_spread:  r.book_spread  != null ? Number(r.book_spread)  : null,
      book_name:    r.book_name ?? null,
      edge_points:  r.edge_points  != null ? Number(r.edge_points)  : null,
      source: (r.source ?? 'llm') as 'llm' | 'model',
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

    // Per-sport rollup — operator (real bet) record + model (auto-graded)
    // accuracy. Both come from the same picks table; the operator path
    // counts where status moved through 'taken' → 'won'/'lost', the
    // model path counts where source='model' AND model_outcome got
    // stamped by C5's auto-grader.
    const bySport = perSportRes.rows.map((r: {
      sport: string
      op_open: number; op_active: number; op_wins: number; op_losses: number; op_pushes: number
      op_staked: string; op_won_returned: string; op_push_returned: string
      model_wins: number; model_losses: number; model_pushes: number; model_settled: number; model_pending: number
    }) => {
      const opStaked   = parseFloat(r.op_staked   ?? '0')
      const opReturned = parseFloat(r.op_won_returned ?? '0') + parseFloat(r.op_push_returned ?? '0')
      const opPnl      = +(opReturned - opStaked).toFixed(2)
      const opRoi      = opStaked > 0 ? +((opPnl / opStaked) * 100).toFixed(2) : 0
      const opSettled  = Number(r.op_wins) + Number(r.op_losses)
      const opWinPct   = opSettled > 0 ? +((Number(r.op_wins) / opSettled) * 100).toFixed(1) : null
      const modelSettled = Number(r.model_settled)
      const modelDecided = Number(r.model_wins) + Number(r.model_losses)
      const modelAcc = modelDecided > 0 ? +((Number(r.model_wins) / modelDecided) * 100).toFixed(1) : null
      return {
        sport: r.sport,
        operator: {
          open: Number(r.op_open),
          active: Number(r.op_active),
          wins: Number(r.op_wins),
          losses: Number(r.op_losses),
          pushes: Number(r.op_pushes),
          staked: +opStaked.toFixed(2),
          pnl: opPnl,
          roi: opRoi,
          win_pct: opWinPct,
        },
        model: {
          wins: Number(r.model_wins),
          losses: Number(r.model_losses),
          pushes: Number(r.model_pushes),
          settled: modelSettled,
          pending: Number(r.model_pending),
          accuracy: modelAcc,
        },
      }
    })

    return NextResponse.json({
      picks,
      summary: {
        open,
        active,
        record: { wins, losses, pushes },
        bankroll: { staked: +staked.toFixed(2), returned: +returned.toFixed(2), pnl, roi },
      },
      bySport,
      status: {
        odds_key:        Odds.isConfigured(),
        rated_teams:     ratedTeams,
        upcoming_games:  upcomingGames,
        model_lines:     modelLineCount,
        last_run_ts:      s.last_run_ts      != null ? Number(s.last_run_ts)      : null,
        last_schedule_ts: s.last_sched_ts    != null ? Number(s.last_sched_ts)    : null,
        last_grade_ts:    s.last_grade_ts    != null ? Number(s.last_grade_ts)    : null,
        last_lines_ts:    s.last_lines_ts    != null ? Number(s.last_lines_ts)    : null,
        cycle:            s.cycle            != null ? Number(s.cycle)            : 0,
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
