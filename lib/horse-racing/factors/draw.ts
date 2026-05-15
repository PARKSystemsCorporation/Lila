// Gate / post-position draw heuristic. Without a track-bias table we
// keep this deliberately blunt: inside draws score better, more so in
// large fields where the rail saves ground. Null when the runner has
// no draw assigned (typical for jumps cards).

import type { Race, Runner } from '../types'

export function drawScore(runner: Runner, race: Race): number | null {
  if (runner.draw == null) return null

  if (race.field_size <= 8) {
    return runner.draw <= 4 ? 7 : 4
  }
  if (runner.draw <= 3) return 8
  if (runner.draw <= 8) return 6
  return 4
}
