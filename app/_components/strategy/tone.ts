// Shared per-tone Tailwind classes so every strategy panel/card matches the
// existing landing motif (border-2 / hover-translate).

import type { Tone } from './copy'

export interface ToneClasses {
  accent:   string
  border:   string
  borderSoft: string
  glow:     string
  ring:     string
  fillRgba: string
  hex:      string
  bgSoft:   string
}

export const TONE: Record<Tone, ToneClasses> = {
  amber: {
    accent:     'text-amber-300',
    border:     'border-amber-500/40',
    borderSoft: 'border-amber-500/20',
    glow:       '',
    ring:       'hover:border-amber-300',
    fillRgba:   'rgba(245,158,11,0.18)',
    hex:        '#f59e0b',
    bgSoft:     'bg-amber-500/[0.04]',
  },
  orange: {
    accent:     'text-orange-300',
    border:     'border-orange-500/40',
    borderSoft: 'border-orange-500/20',
    glow:       '',
    ring:       'hover:border-orange-300',
    fillRgba:   'rgba(251,146,60,0.18)',
    hex:        '#fb923c',
    bgSoft:     'bg-orange-500/[0.04]',
  },
  red: {
    accent:     'text-red-300',
    border:     'border-red-500/40',
    borderSoft: 'border-red-500/20',
    glow:       '',
    ring:       'hover:border-red-300',
    fillRgba:   'rgba(239,68,68,0.18)',
    hex:        '#ef4444',
    bgSoft:     'bg-red-500/[0.04]',
  },
}
