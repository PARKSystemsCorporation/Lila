// Thin facade over racing-api.ts so consumers (API route, HorseLoop)
// don't import the upstream adapter directly. Keeps the swap-out path
// clean if we ever introduce additional retail feeds.

import * as racing from './racing-api'
import type { Race, RaceResult } from './types'

let lastRefreshTs = 0

export class HorseDataService {
  isConfigured(): boolean {
    return racing.isConfigured()
  }

  async getTodayRacecards(): Promise<Race[]> {
    const races = await racing.getTodayRacecards()
    if (races.length > 0) lastRefreshTs = Date.now()
    return races
  }

  async getRacecard(raceId: string): Promise<Race | null> {
    return racing.getRacecard(raceId)
  }

  async getResult(raceId: string): Promise<RaceResult | null> {
    return racing.getResult(raceId)
  }

  status() {
    return {
      creds_ok: racing.isConfigured(),
      cache_size: racing.cacheSize(),
      last_refresh_ts: lastRefreshTs || null,
    }
  }
}

let svc: HorseDataService | null = null

export function getHorseDataService(): HorseDataService {
  if (!svc) svc = new HorseDataService()
  return svc
}
