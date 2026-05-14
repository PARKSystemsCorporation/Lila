// Rolling 10-game simple moving average of a team's composite 1–10 score.
// Reads the last 10 'composite' rows for the team from sports_signals.
import { PoolClient } from 'pg'
import { clampScore } from '../scale'

export async function sma10Score(client: PoolClient, team_id: string): Promise<number | null> {
  const res = await client.query<{ score: number }>(
    `SELECT score FROM sports_signals
       WHERE team_id = $1 AND metric = 'composite'
       ORDER BY created_at DESC
       LIMIT 10`,
    [team_id],
  )
  if (res.rows.length === 0) return null
  const sum = res.rows.reduce((acc, r) => acc + Number(r.score), 0)
  return clampScore(sum / res.rows.length)
}
