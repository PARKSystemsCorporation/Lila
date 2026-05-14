// Sharp-market adapter stub. Real implementation will wrap a sharp book
// (Pinnacle / Betfair Exchange last-traded prices) once credentials land.
// Until then this returns null so the aggregator falls back to retail.

import type { HorseRacingSource } from './types'

export const sharpStub: HorseRacingSource = {
  name: 'sharp.stub',
  kind: 'sharp',
  isConfigured(): boolean { return false },
  async fetchQuotes(): Promise<null> { return null },
}
