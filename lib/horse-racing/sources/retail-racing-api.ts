// Retail-feed adapter wrapping The Racing API. The yield engine treats
// this as the baseline market price (Lila's existing Ceelo + Vega
// conventions: book odds = retail consensus, fair value is what we
// compute against it).

import * as racing from '../racing-api'
import type { HorseRacingSource, SourceQuotes } from './types'

export const racingApiRetail: HorseRacingSource = {
  name: 'theracingapi',
  kind: 'retail',
  isConfigured(): boolean {
    return racing.isConfigured()
  },
  async fetchQuotes(raceId: string): Promise<SourceQuotes | null> {
    if (!this.isConfigured()) return null
    const race = await racing.getRacecard(raceId)
    if (!race) return null
    const quotes: SourceQuotes['quotes'] = {}
    for (const r of race.runners) {
      quotes[r.horse_id] = { odds_decimal: r.odds_decimal }
    }
    return { source: this.name, quotes }
  },
}
