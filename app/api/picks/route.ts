import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import { netProfit } from '@/lib/ceelo-loop'
import * as Racing from '@/lib/horse-racing/racing-api'

export const dynamic = 'force-dynamic'

// GET /api/picks
//   → { picks: PickRow[], summary: { open, active, record, bankroll }, status }
//
// PickRow groups: status='open' (Ceelo posted, awaiting decision),
// 'taken' (operator placed, awaiting settle), and settled (won/lost/push/void).
// 'skipped' is hidden from the main list but counted.
//
// After the racing swap, Ceelo emits one 'win'-market pick per race. We keep
// the legacy field names (game_label, model_spread, etc.) populated from
// racing columns so the existing operator UI keeps rendering — see field
// map below.

type Status = 'open' | 'skipped' | 'taken' | 'won' | 'lost' | 'push' | 'void'

interface PickRow {
  id: number
  game_label: string             // ← race_label
  kickoff_at: number | null      // ← off_dt
  market: string                 // 'win'
  side: string                   // horse_name
  model_prob: number | null
  fair_line: string | null       // formatted fair_decimal
  min_odds: number | null
  edge_pct: number | null
  model_spread: number | null    // always null (no spread market in racing)
  book_spread: number | null     // always null
  book_name: string | null       // always null
  edge_points: number | null     // always null
  source: 'llm' | 'model'
  reasoning: string
  confidence: string
  status: Status
  stake: number | null
  taken_odds: number | null      // decimal odds
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

    const [picksRes, stateRes, racesRes, runnerOddsRes, modelRollupRes] = await Promise.all([
      db.query(
        `SELECT id, race_label, market, horse_name,
                model_prob, fair_decimal, book_decimal, edge_pct,
                intensity, velocity, source,
                reasoning, confidence, status, stake, taken_odds, payout,
                (EXTRACT(EPOCH FROM off_dt)     * 1000)::bigint AS off_ts,
                (EXTRACT(EPOCH FROM taken_at)   * 1000)::bigint AS taken_ts,
                (EXTRACT(EPOCH FROM settled_at) * 1000)::bigint AS settled_ts,
                (EXTRACT(EPOCH FROM created_at) * 1000)::bigint AS created_ts
         FROM ceelo_picks
         ORDER BY
           CASE status
             WHEN 'open'    THEN 0
             WHEN 'taken'   THEN 1
             WHEN 'won'     THEN 2
             WHEN 'lost'    THEN 2
             WHEN 'push'    THEN 2
             WHEN 'void'    THEN 2
             WHEN 'skipped' THEN 3
           END,
           created_at DESC
         LIMIT 200`
      ),
      db.query(
        `SELECT (EXTRACT(EPOCH FROM last_run_at)      * 1000)::bigint AS last_run_ts,
                (EXTRACT(EPOCH FROM last_schedule_at) * 1000)::bigint AS last_sched_ts,
                (EXTRACT(EPOCH FROM last_grade_at)    * 1000)::bigint AS last_grade_ts,
                (EXTRACT(EPOCH FROM last_odds_at)     * 1000)::bigint AS last_odds_ts,
                cycle
         FROM ceelo_state WHERE id=1`
      ),
      db.query(`SELECT COUNT(*) AS n FROM ceelo_races WHERE status='scheduled' AND off_dt > NOW()`),
      db.query(`SELECT COUNT(*) AS n FROM ceelo_runner_odds WHERE fetched_at > NOW() - INTERVAL '30 minutes'`),
      // Model auto-grade rollup. One row of operator + model stats.
      db.query(
        `SELECT
            COUNT(*)                              FILTER (WHERE status='open')                                    AS op_open,
            COUNT(*)                              FILTER (WHERE status='taken')                                   AS op_active,
            COUNT(*)                              FILTER (WHERE status='won')                                     AS op_wins,
            COUNT(*)                              FILTER (WHERE status='lost')                                    AS op_losses,
            COUNT(*)                              FILTER (WHERE status IN ('push','void'))                        AS op_pushes,
            COALESCE(SUM(stake)                   FILTER (WHERE status IN ('taken','won','lost','push','void')), 0) AS op_staked,
            COALESCE(SUM(stake + COALESCE(payout, 0)) FILTER (WHERE status='won'), 0)                             AS op_won_returned,
            COALESCE(SUM(stake)                   FILTER (WHERE status IN ('push','void')), 0)                    AS op_push_returned,
            COUNT(*)                              FILTER (WHERE source='model' AND model_outcome='win')           AS model_wins,
            COUNT(*)                              FILTER (WHERE source='model' AND model_outcome='loss')          AS model_losses,
            COUNT(*)                              FILTER (WHERE source='model' AND model_outcome='push')          AS model_pushes,
            COUNT(*)                              FILTER (WHERE source='model' AND model_outcome IS NOT NULL)     AS model_settled,
            COUNT(*)                              FILTER (WHERE source='model' AND model_outcome IS NULL)         AS model_pending
         FROM ceelo_picks`
      ),
    ])

    const rows = picksRes.rows
    const s = stateRes.rows[0] ?? {}
    const upcomingRaces      = Number(racesRes.rows[0]?.n ?? 0)
    const recentSnapshots    = Number(runnerOddsRes.rows[0]?.n ?? 0)

    const picks: PickRow[] = rows.map(r => ({
      id: Number(r.id),
      game_label: r.race_label,
      kickoff_at: r.off_ts != null ? Number(r.off_ts) : null,
      market: r.market ?? 'win',
      side: r.horse_name,
      model_prob: r.model_prob != null ? Number(r.model_prob) : null,
      fair_line: r.fair_decimal != null ? Number(r.fair_decimal).toFixed(2) : null,
      min_odds: null,
      edge_pct: r.edge_pct != null ? Number(r.edge_pct) : null,
      model_spread: null,
      book_spread:  null,
      book_name:    null,
      edge_points:  null,
      source: (r.source ?? 'model') as 'llm' | 'model',
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
        returned += (p.stake ?? 0) + (p.payout ?? 0)
      } else if (p.status === 'lost') {
        losses++
        staked += p.stake ?? 0
      } else if (p.status === 'push' || p.status === 'void') {
        pushes++
        staked += p.stake ?? 0
        returned += p.stake ?? 0
      }
    }
    const pnl = +(returned - staked).toFixed(2)
    const roi = staked > 0 ? +((pnl / staked) * 100).toFixed(2) : 0

    // Single-sport (RACING) rollup, returned in the same `bySport` shape so
    // the existing operator UI tab strip keeps rendering.
    const m = modelRollupRes.rows[0] ?? {}
    const opStaked   = parseFloat(m.op_staked   ?? '0')
    const opReturned = parseFloat(m.op_won_returned ?? '0') + parseFloat(m.op_push_returned ?? '0')
    const opPnl      = +(opReturned - opStaked).toFixed(2)
    const opRoi      = opStaked > 0 ? +((opPnl / opStaked) * 100).toFixed(2) : 0
    const opSettled  = Number(m.op_wins ?? 0) + Number(m.op_losses ?? 0)
    const opWinPct   = opSettled > 0 ? +((Number(m.op_wins) / opSettled) * 100).toFixed(1) : null
    const modelDecided = Number(m.model_wins ?? 0) + Number(m.model_losses ?? 0)
    const modelAcc   = modelDecided > 0 ? +((Number(m.model_wins) / modelDecided) * 100).toFixed(1) : null

    const bySport = [
      {
        sport: 'RACING',
        operator: {
          open:   Number(m.op_open    ?? 0),
          active: Number(m.op_active  ?? 0),
          wins:   Number(m.op_wins    ?? 0),
          losses: Number(m.op_losses  ?? 0),
          pushes: Number(m.op_pushes  ?? 0),
          staked: +opStaked.toFixed(2),
          pnl: opPnl,
          roi: opRoi,
          win_pct: opWinPct,
        },
        model: {
          wins:    Number(m.model_wins    ?? 0),
          losses:  Number(m.model_losses  ?? 0),
          pushes:  Number(m.model_pushes  ?? 0),
          settled: Number(m.model_settled ?? 0),
          pending: Number(m.model_pending ?? 0),
          accuracy: modelAcc,
        },
      },
    ]

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
        odds_key:        Racing.isConfigured(),
        rated_teams:     0,                 // no team ratings in racing
        upcoming_games:  upcomingRaces,
        model_lines:     recentSnapshots,
        last_run_ts:      s.last_run_ts      != null ? Number(s.last_run_ts)      : null,
        last_schedule_ts: s.last_sched_ts    != null ? Number(s.last_sched_ts)    : null,
        last_grade_ts:    s.last_grade_ts    != null ? Number(s.last_grade_ts)    : null,
        last_lines_ts:    s.last_odds_ts     != null ? Number(s.last_odds_ts)     : null,
        cycle:            s.cycle            != null ? Number(s.cycle)            : 0,
      },
    })
  } finally { db.release() }
}

// POST /api/picks
//   { action: 'take',   id, stake, taken_odds }   ← taken_odds is now decimal
//   { action: 'skip',   id }
//   { action: 'settle', id, result: 'won'|'lost'|'push'|'void' }
//   { action: 'reopen', id }
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
      const odds = Number(body.taken_odds)
      if (!Number.isFinite(stake) || stake <= 0) {
        return NextResponse.json({ error: 'stake must be > 0' }, { status: 400 })
      }
      if (!Number.isFinite(odds) || odds <= 1) {
        return NextResponse.json({ error: 'taken_odds (decimal) must be > 1' }, { status: 400 })
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
