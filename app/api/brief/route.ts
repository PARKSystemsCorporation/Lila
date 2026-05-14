import { NextResponse } from 'next/server'
import { getPool, ensureSchema } from '@/lib/db'
import * as Alpaca from '@/lib/platforms/alpaca'

export const dynamic = 'force-dynamic'

// Operator brief — the four numbers Lila and the operator both want
// glanced in one shot:
//   1. Wallet (confirmed bounty earnings + last-paid breadcrumb)
//   2. Open positions (Alpaca, paper or live)
//   3. Pending bounty submissions (Lila queue + ready-to-submit + submitted)
//   4. Team task queue (per-agent state, what each is working on right now)
//
// One endpoint, one fetch on the operator's side. No fluff.

interface BriefResponse {
  wallet: {
    confirmed_earned: number
    paid_mtd: number
    last_paid: { title: string; payout: number; on: string } | null
    // Reconciliation: total_earned ought to equal sum_of_paid. If it doesn't,
    // the difference is leak residue from the old paper-P&L credit code.
    reconciliation: {
      total_earned: number      // raw lila_state.total_earned
      sum_of_paid: number       // SUM(security_reports.payout WHERE status='paid')
      paid_count: number
      delta: number             // total_earned - sum_of_paid (should be 0)
      reconciled: boolean       // migration v2 has run
    }
  }
  positions: {
    paper: boolean
    open: Array<{ symbol: string; qty: number; entry: number; pnl_pct: number }>
    paper_realized: number
  }
  bounties: {
    pending_review: number
    approved: number
    submitted: number
    awaiting_payout_max: number
  }
  team: {
    cipher: { step: string; cycles: number; target: string | null; last_ts: number | null } | null
    scout:  { cycle: number; scanned: number; reported: number; last_ts: number | null } | null
    vega:   { step: string; cycle: number; last_ts: number | null } | null
    ceelo:  { cycle: number; rated: number; upcoming: number; last_ts: number | null } | null
    lila:   { active_tasks: string[]; last_chat_ts: number | null }
  }
}

export async function GET() {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'no db' }, { status: 503 })
  }

  const hasAlpaca = !!(process.env.ALPACA_API_KEY || process.env.APCA_API_KEY_ID)
  const paper = process.env.ALPACA_PAPER !== 'false'

  const pool = getPool()
  const db = await pool.connect()

  try {
    await ensureSchema(db)

    const walletRes = await db.query(`SELECT total_earned, active_tasks, reconciled_paper_pnl_v2 FROM lila_state WHERE id=1`)
    const paidMtdRes = await db.query(
      `SELECT COALESCE(SUM(payout), 0) AS paid_mtd
       FROM security_reports
       WHERE status='paid' AND paid_at >= date_trunc('month', NOW())`
    )
    const lastPaidRes = await db.query(
      `SELECT title, payout, to_char(paid_at, 'YYYY-MM-DD') AS d
       FROM security_reports
       WHERE status='paid' ORDER BY paid_at DESC LIMIT 1`
    )
    const paidSumRes = await db.query(
      `SELECT COALESCE(SUM(payout), 0) AS sum_of_paid,
              COUNT(*) AS paid_count
       FROM security_reports
       WHERE status='paid' AND payout IS NOT NULL`
    )
    const bountyCounts = await db.query(
      `SELECT
          COUNT(*) FILTER (WHERE status='pending_review') AS pending_review,
          COUNT(*) FILTER (WHERE status='approved')       AS approved,
          COUNT(*) FILTER (WHERE status='submitted')      AS submitted,
          COALESCE(SUM(reward) FILTER (WHERE status='submitted'), 0) AS awaiting_payout_max
       FROM security_reports`
    )
    const paperRealizedRes = await db.query(
      `SELECT COALESCE(SUM(pnl), 0) AS realized
       FROM lila_positions WHERE status='closed'`
    )
    const openLocalRes = await db.query(
      `SELECT symbol, direction, entry_price, target_price, stop_loss
       FROM lila_positions WHERE status='open'
       ORDER BY opened_at DESC LIMIT 10`
    )
    const cipherRes = await db.query(
      `SELECT step, turn_count,
              (EXTRACT(EPOCH FROM last_step_at) * 1000)::bigint AS last_ts
       FROM lila_loop_state WHERE id=1`
    )
    const scoutRes = await db.query(
      `SELECT cycle,
              (EXTRACT(EPOCH FROM last_step_at) * 1000)::bigint AS last_ts,
              (SELECT COUNT(*) FROM scout_findings) AS scanned,
              (SELECT COUNT(*) FROM scout_findings WHERE status='reported') AS reported
       FROM scout_state WHERE id=1`
    )
    const vegaRes = await db.query(
      `SELECT step, cycle,
              (EXTRACT(EPOCH FROM last_step_at) * 1000)::bigint AS last_ts
       FROM analyst_state WHERE id=1`
    )
    const targetRes = await db.query(
      `SELECT title, phase, cycles
       FROM research_targets
       WHERE status='active' ORDER BY last_worked_at DESC NULLS LAST LIMIT 1`
    )
    const lilaRes = await db.query(
      `SELECT (EXTRACT(EPOCH FROM MAX(created_at)) * 1000)::bigint AS last_chat_ts
       FROM chat_messages WHERE sender='lila' AND thread='main'`
    )
    const ceeloRes = await db.query(
      `SELECT cycle,
              (EXTRACT(EPOCH FROM last_run_at) * 1000)::bigint AS last_ts,
              (SELECT COUNT(*) FROM ceelo_team_ratings WHERE games_played > 0) AS rated,
              (SELECT COUNT(*) FROM ceelo_games WHERE status='scheduled' AND kickoff_at > NOW()) AS upcoming
       FROM ceelo_state WHERE id=1`
    )

    // Open positions: prefer Alpaca's live view (it has live PnL) but fall
    // back to our local mirror if Alpaca isn't configured.
    let open: BriefResponse['positions']['open'] = []
    if (hasAlpaca) {
      const livePositions = await Alpaca.getPositions().catch(() => [] as Alpaca.AlpacaPosition[])
      open = livePositions.slice(0, 10).map(p => ({
        symbol: p.symbol,
        qty: parseFloat(p.qty),
        entry: parseFloat(p.avg_entry_price),
        pnl_pct: parseFloat(p.unrealized_plpc) * 100,
      }))
    } else {
      open = openLocalRes.rows.map((p: { symbol: string; entry_price: string }) => ({
        symbol: p.symbol,
        qty: 0,
        entry: parseFloat(p.entry_price ?? '0'),
        pnl_pct: 0,
      }))
    }

    const wallet = walletRes.rows[0] ?? {}
    const paidMtd = paidMtdRes.rows[0]?.paid_mtd ?? 0
    const lastPaid = lastPaidRes.rows[0] ?? null
    const bc = bountyCounts.rows[0] ?? {}
    const cipher = cipherRes.rows[0]
    const scout = scoutRes.rows[0]
    const vega = vegaRes.rows[0]
    const tgt = targetRes.rows[0]
    const lila = lilaRes.rows[0]
    const ceelo = ceeloRes.rows[0]

    const totalEarned = parseFloat(wallet.total_earned ?? '0')
    const sumOfPaid   = parseFloat(paidSumRes.rows[0]?.sum_of_paid ?? '0')
    const paidCount   = Number(paidSumRes.rows[0]?.paid_count ?? 0)
    const reconciled  = Boolean(wallet.reconciled_paper_pnl_v2)

    const body: BriefResponse = {
      wallet: {
        confirmed_earned: totalEarned,
        paid_mtd: parseFloat(paidMtd),
        last_paid: lastPaid ? {
          title:  String(lastPaid.title),
          payout: parseFloat(lastPaid.payout ?? '0'),
          on:     String(lastPaid.d),
        } : null,
        reconciliation: {
          total_earned: totalEarned,
          sum_of_paid:  sumOfPaid,
          paid_count:   paidCount,
          delta:        +(totalEarned - sumOfPaid).toFixed(2),
          reconciled,
        },
      },
      positions: {
        paper,
        open,
        paper_realized: parseFloat(paperRealizedRes.rows[0]?.realized ?? '0'),
      },
      bounties: {
        pending_review:       Number(bc.pending_review ?? 0),
        approved:             Number(bc.approved ?? 0),
        submitted:            Number(bc.submitted ?? 0),
        awaiting_payout_max:  parseFloat(bc.awaiting_payout_max ?? '0'),
      },
      team: {
        cipher: cipher ? {
          step: String(cipher.step ?? 'BT0'),
          cycles: Number(tgt?.cycles ?? cipher.turn_count ?? 0),
          target: tgt?.title ? String(tgt.title) : null,
          last_ts: cipher.last_ts != null ? Number(cipher.last_ts) : null,
        } : null,
        scout: scout ? {
          cycle: Number(scout.cycle ?? 0),
          scanned: Number(scout.scanned ?? 0),
          reported: Number(scout.reported ?? 0),
          last_ts: scout.last_ts != null ? Number(scout.last_ts) : null,
        } : null,
        vega: vega ? {
          step: String(vega.step ?? 'T0'),
          cycle: Number(vega.cycle ?? 0),
          last_ts: vega.last_ts != null ? Number(vega.last_ts) : null,
        } : null,
        ceelo: ceelo ? {
          cycle: Number(ceelo.cycle ?? 0),
          rated: Number(ceelo.rated ?? 0),
          upcoming: Number(ceelo.upcoming ?? 0),
          last_ts: ceelo.last_ts != null ? Number(ceelo.last_ts) : null,
        } : null,
        lila: {
          active_tasks: (wallet.active_tasks as string[]) ?? [],
          last_chat_ts: lila?.last_chat_ts != null ? Number(lila.last_chat_ts) : null,
        },
      },
    }

    return NextResponse.json(body)
  } finally {
    db.release()
  }
}
