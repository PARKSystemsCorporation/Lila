import type { PoolClient } from 'pg'
import { cfg } from '../config'
import { getHorseDataService } from './data-service'
import { attachSignals } from './yield'

// HorseLoop — keeps today's racecard cache warm and emits a digest log
// entry every HORSE_RUN_SEC. Mirrors the Ceelo / Scout / Forge time-gate
// pattern: state row holds last_run_at, run() short-circuits until the
// configured interval has elapsed.
//
// Self-gates on cfg.ENABLE_HORSE_RACING and on Racing API creds (matches
// runGumroadReverify: no creds → loop becomes a quiet no-op).
//
// NOTE: no LLM in this path. The digest message is built from the yield
// engine's deterministic output.

export class HorseLoop {
  private db: PoolClient

  constructor(db: PoolClient) {
    this.db = db
  }

  async run(): Promise<{ logMessage: string; logType: 'info' | 'success' | 'warn' } | null> {
    if (!cfg.ENABLE_HORSE_RACING) return null

    const svc = getHorseDataService()
    if (!svc.isConfigured()) return null

    if (!(await this.shouldRun())) return null

    try {
      const races = await svc.getTodayRacecards()
      await this.db.query(`UPDATE horse_state SET last_run_at=NOW(), cycle=cycle+1, updated_at=NOW() WHERE id=1`)

      if (races.length === 0) {
        return { logMessage: 'Horse — no racecards on the board.', logType: 'info' }
      }

      const decorated = attachSignals(races)
      const top = decorated.reduce(
        (best, r) => (r.signal.intensity > (best?.signal.intensity ?? -1) ? r : best),
        decorated[0],
      )

      const arrow = top.signal.velocity === 'up' ? '↑' : top.signal.velocity === 'down' ? '↓' : '→'
      const topLabel = top.signal.top_runner
        ? `${top.off_time} ${top.course} · ${top.signal.top_runner.horse} (int ${top.signal.intensity}, ${arrow})`
        : `${top.off_time} ${top.course} (no live prices yet)`

      return {
        logMessage: `Horse — refreshed ${races.length} race${races.length === 1 ? '' : 's'}, top yield: ${topLabel}.`,
        logType: 'info',
      }
    } catch (e) {
      return { logMessage: `Horse — refresh error: ${String(e).slice(0, 120)}`, logType: 'warn' }
    }
  }

  private async shouldRun(): Promise<boolean> {
    const { rows: [s] } = await this.db.query('SELECT last_run_at FROM horse_state WHERE id=1')
    if (!s?.last_run_at) return true
    return (Date.now() - new Date(s.last_run_at).getTime()) / 1_000 >= cfg.HORSE_RUN_SEC
  }
}
