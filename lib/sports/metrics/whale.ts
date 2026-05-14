// Whale — money% minus ticket%. Big positive delta means a handful of
// large bettors are pushing the side. Each 5-point gap = 1 tier.
import { clampScore } from '../scale'

export type WhaleInputs = {
  money_pct:   number        // 0..100
  ticket_pct:  number        // 0..100
}

export function whaleScore({ money_pct, ticket_pct }: WhaleInputs): number {
  if (!Number.isFinite(money_pct) || !Number.isFinite(ticket_pct)) return 1
  const delta = money_pct - ticket_pct
  if (delta <= 0) return 1
  return clampScore(1 + Math.floor(delta / 5))
}
