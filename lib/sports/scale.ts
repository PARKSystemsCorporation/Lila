export type ColorTier = 'red' | 'yellow' | 'green' | 'purple'
export type TierLabel = 'AVOID' | 'CAUTIOUS' | 'BET IT' | 'FULL SEND'

export function clampScore(n: number): number {
  if (!Number.isFinite(n)) return 1
  const rounded = Math.round(n)
  if (rounded < 1) return 1
  if (rounded > 10) return 10
  return rounded
}

export function toColorTier(score: number): ColorTier {
  const s = clampScore(score)
  if (s <= 2) return 'red'
  if (s <= 5) return 'yellow'
  if (s <= 7) return 'green'
  return 'purple'
}

export function toLabel(score: number): TierLabel {
  switch (toColorTier(score)) {
    case 'red':    return 'AVOID'
    case 'yellow': return 'CAUTIOUS'
    case 'green':  return 'BET IT'
    case 'purple': return 'FULL SEND'
  }
}

const TAILWIND_CLASS: Record<ColorTier, string> = {
  red:    'text-red-500',
  yellow: 'text-amber-500',
  green:  'text-emerald-500',
  purple: 'text-fuchsia-500',
}

export function tierTextClass(tier: ColorTier): string {
  return TAILWIND_CLASS[tier]
}
