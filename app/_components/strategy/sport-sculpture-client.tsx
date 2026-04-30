'use client'

// Client-side mount wrapper so the sculpture (three.js) can be embedded
// inside a server component without breaking force-static.

import nextDynamic from 'next/dynamic'
import type { Sport, Tone } from './copy'

const SportSculpture = nextDynamic(() => import('./sport-sculpture'), { ssr: false, loading: () => null })

export default function SportSculptureClient({ sport, tone }: { sport: Sport; tone: Tone }) {
  return <SportSculpture sport={sport} tone={tone} />
}
