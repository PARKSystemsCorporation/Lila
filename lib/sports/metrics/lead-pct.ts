// Milestone-Lead formula (operator-specified).
// L = clamp(log10(E_lead + P + 1) / log10(E_total + 2), 0.01, 0.99)
//   E_lead  — events where the team gained or successfully held the lead
//   E_total — total scoring / lead-changing events in the game
//   P       — 1 if leading during pull, else 0
import { clampScore } from '../scale'

export type LeadPctInputs = {
  e_lead:        number
  e_total:       number
  during_pull:   boolean
}

export function leadFraction({ e_lead, e_total, during_pull }: LeadPctInputs): number {
  const eLead  = Math.max(0, Math.floor(e_lead))
  const eTotal = Math.max(0, Math.floor(e_total))
  const p = during_pull ? 1 : 0
  const num = Math.log10(eLead + p + 1)
  const den = Math.log10(eTotal + 2)
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 0.01
  const raw = num / den
  if (raw < 0.01) return 0.01
  if (raw > 0.99) return 0.99
  return raw
}

export function leadPctScore(inputs: LeadPctInputs): number {
  const fraction = leadFraction(inputs)
  return clampScore(Math.ceil(fraction * 10))
}
