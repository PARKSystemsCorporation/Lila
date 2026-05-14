// Lock — calculated arbitrage. retail_price > sharp_fair_value + vig → 10.
// Otherwise 1. All values in price-cents (dollars).

export type LockInputs = {
  retail_cents:      number
  sharp_fair_cents:  number
  vig_cents:         number
}

export function lockScore({ retail_cents, sharp_fair_cents, vig_cents }: LockInputs): number {
  if (!Number.isFinite(retail_cents) || !Number.isFinite(sharp_fair_cents) || !Number.isFinite(vig_cents)) {
    return 1
  }
  return retail_cents > sharp_fair_cents + vig_cents ? 10 : 1
}
