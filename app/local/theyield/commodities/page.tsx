// Thin shim — keeps the existing /local/commodities board as the source of
// truth while the new yield route hierarchy beds in. Server-side redirect.

import { redirect } from 'next/navigation'

export default function TheYieldCommoditiesRedirect() {
  redirect('/local/commodities')
}
