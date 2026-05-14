// /marketplace sunset — Park Gates DMs have folded into The Bazaar. The
// schema (viewer_dms, park_gates_ledger) is kept read-only as history.
//
// Redirect at the page level rather than in middleware so the legacy DM
// API routes still work for one release cycle if any client still calls
// them. The next sweep deletes those routes too.

import { permanentRedirect } from 'next/navigation'

export default function MarketplaceSunset(): never {
  permanentRedirect('/bazaar')
}
