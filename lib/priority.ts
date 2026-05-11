import type { PoolClient } from 'pg'
import { writeEpisode } from './memory/store'

// Shared coordination primitives stored on the lila_state singleton.
// Reads are cheap (one row, two columns); writes also append a memory
// episode so provenance + history come for free via existing recall.

export interface PriorityState {
  priority:     string | null
  macro_thesis: string | null
}

export async function getPriority(db: PoolClient): Promise<PriorityState> {
  const { rows: [r] } = await db.query(
    `SELECT current_priority, macro_thesis FROM lila_state WHERE id=1`
  )
  return {
    priority:     r?.current_priority ?? null,
    macro_thesis: r?.macro_thesis     ?? null,
  }
}

export async function setPriority(
  db: PoolClient,
  text: string | null,
  by: string,
): Promise<void> {
  const value = text && text.trim() ? text.trim() : null
  await db.query(
    `UPDATE lila_state SET current_priority=$1, updated_at=NOW() WHERE id=1`,
    [value]
  )
  await writeEpisode(db, {
    source:  'priority_set',
    actor:   by,
    content: value ?? '(cleared)',
  }).catch(() => { /* best-effort audit */ })
}

export async function setMacroThesis(
  db: PoolClient,
  text: string | null,
  by: string,
): Promise<void> {
  const value = text && text.trim() ? text.trim() : null
  await db.query(
    `UPDATE lila_state SET macro_thesis=$1, updated_at=NOW() WHERE id=1`,
    [value]
  )
  await writeEpisode(db, {
    source:  'thesis_set',
    actor:   by,
    content: value ?? '(cleared)',
  }).catch(() => { /* best-effort audit */ })
}
