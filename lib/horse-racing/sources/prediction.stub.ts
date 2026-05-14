// Prediction-market adapter stub (Polymarket / ProphetX). Returns null
// until a real adapter ships.

import type { HorseRacingSource } from './types'

export const predictionStub: HorseRacingSource = {
  name: 'prediction.stub',
  kind: 'prediction',
  isConfigured(): boolean { return false },
  async fetchQuotes(): Promise<null> { return null },
}
