import type { PoolClient } from 'pg'
import { cfg } from '../../config'

// Cross-loop seeding. Lila writes a NEXT-LOOP-PRIMARY blob onto each
// teammate's per-loop state row. The teammate reads + nulls it at the
// top of its run() so the seed influences exactly one iteration.
//
//   target           state table        consumer
//   -------          -----------        --------
//   vega             analyst_state      AnalystLoop  (T0 prompt)
//   cipher           lila_loop_state    TaskerLoop   (BT0 active_tasks)
//   ceelo            ceelo_state        CeeloLoop    (focus override)
//
// A visible artifact is also posted to chat_messages with mentions=[target]
// so the operator can scan the pings.

export type TeamTarget = 'vega' | 'cipher' | 'ceelo'

const TARGET_TABLE: Record<TeamTarget, string> = {
  vega:   'analyst_state',
  cipher: 'lila_loop_state',
  ceelo:  'ceelo_state',
}

export interface PrimaryPayload {
  goal: string
  hint?: string
  deadline_at?: string
}

function isTarget(s: string): s is TeamTarget {
  return s === 'vega' || s === 'cipher' || s === 'ceelo'
}

export async function update(db: PoolClient, args: { target: string; goal: string; hint?: string; deadline_at?: string; note?: string }): Promise<{ logMessage: string }> {
  const target = String(args.target ?? '').toLowerCase()
  if (!isTarget(target)) return { logMessage: `team.update: invalid target "${args.target}"` }
  const goal = String(args.goal ?? '').trim().slice(0, 400)
  if (!goal) return { logMessage: 'team.update: missing goal' }
  const payload: PrimaryPayload = {
    goal,
    ...(args.hint ? { hint: String(args.hint).slice(0, 400) } : {}),
    ...(args.deadline_at ? { deadline_at: String(args.deadline_at).slice(0, 32) } : {}),
  }
  if (cfg.LILA_DRY_RUN) {
    return { logMessage: `[dry-run] team.update @${target} goal="${goal.slice(0, 60)}"` }
  }
  const table = TARGET_TABLE[target]
  await db.query(
    `UPDATE ${table} SET next_primary=$1, updated_at=NOW() WHERE id=1`,
    [JSON.stringify(payload)]
  )
  const visible = (args.note ?? `→ next-loop primary: ${goal}`).slice(0, 400)
  await db.query(
    `INSERT INTO chat_messages (sender, content, thread, kind, mentions)
     VALUES ('lila', $1, 'main', 'status', ARRAY[$2])`,
    [`@${target} ${visible}`, target]
  )
  return { logMessage: `team.update @${target}: "${goal.slice(0, 60)}"` }
}

// Set next_primary on every teammate at once. Same payload, three updates.
export async function announce(db: PoolClient, args: { goal: string; hint?: string; deadline_at?: string; note?: string }): Promise<{ logMessage: string }> {
  const goal = String(args.goal ?? '').trim().slice(0, 400)
  if (!goal) return { logMessage: 'team.announce: missing goal' }
  const payload: PrimaryPayload = {
    goal,
    ...(args.hint ? { hint: String(args.hint).slice(0, 400) } : {}),
    ...(args.deadline_at ? { deadline_at: String(args.deadline_at).slice(0, 32) } : {}),
  }
  if (cfg.LILA_DRY_RUN) {
    return { logMessage: `[dry-run] team.announce @all goal="${goal.slice(0, 60)}"` }
  }
  const blob = JSON.stringify(payload)
  await db.query(`UPDATE analyst_state    SET next_primary=$1, updated_at=NOW() WHERE id=1`, [blob])
  await db.query(`UPDATE lila_loop_state  SET next_primary=$1, updated_at=NOW() WHERE id=1`, [blob])
  await db.query(`UPDATE ceelo_state      SET next_primary=$1, updated_at=NOW() WHERE id=1`, [blob])
  const visible = (args.note ?? `→ team-wide primary: ${goal}`).slice(0, 400)
  await db.query(
    `INSERT INTO chat_messages (sender, content, thread, kind, mentions)
     VALUES ('lila', $1, 'main', 'status', ARRAY['*'])`,
    [`@all ${visible}`]
  )
  return { logMessage: `team.announce @all: "${goal.slice(0, 60)}"` }
}
