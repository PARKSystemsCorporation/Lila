// Registry of source adapters. The aggregator iterates this list, asks
// each adapter whether it's configured, and merges the live quotes. Add
// new sources by appending to the array — no aggregator changes needed.

import type { HorseRacingSource } from './types'
import { racingApiRetail } from './retail-racing-api'
import { sharpStub } from './sharp.stub'
import { predictionStub } from './prediction.stub'

export const sources: HorseRacingSource[] = [
  racingApiRetail,
  sharpStub,
  predictionStub,
]

export function liveSources(): HorseRacingSource[] {
  return sources.filter(s => s.isConfigured())
}
