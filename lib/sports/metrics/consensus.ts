// Operator's consensus formula: score = overround_1to10 * binary / dataPoints.
// binary = 1 for the lead team, 0 for the underdog. The raw output is then
// re-mapped onto the 1–10 scale (clamped) so it can drive the color tier.
import { clampScore } from '../scale'

export type ConsensusInputs = {
  overround_1to10: number
  is_lead_team:    boolean
  data_points:     number
}

export function consensusScore({ overround_1to10, is_lead_team, data_points }: ConsensusInputs): number {
  if (!is_lead_team) return 1
  if (!Number.isFinite(data_points) || data_points <= 0) return 1
  const raw = (overround_1to10 * 1) / data_points
  return clampScore(raw)
}
