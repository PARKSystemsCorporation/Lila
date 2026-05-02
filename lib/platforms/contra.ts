// Contra opportunities scraper. Contra serves their public opportunities
// listings via Next.js SSR; we extract the embedded data island. This is
// best-effort — if the markup or anti-bot rules change, we return [] and
// Scout falls back to Wellfound.
//
// We cannot use auth (Contra's API isn't public) and we cannot autosubmit
// on Contra. Scout drafts a proposal pitch for the operator to send.

const LISTING_URL = 'https://contra.com/opportunities'

const KEYWORD_RE = /python|automat|scrap|api|webhook|integrat/i

export interface ContraGig {
  external_id: string
  url: string
  title: string
  summary: string | null
  budget_usd: number | null
  posted_at: string | null
}

interface NextDataIsland {
  props?: { pageProps?: Record<string, unknown> }
}

export async function fetchOpenGigs(opts?: { minUsd?: number; maxUsd?: number }): Promise<ContraGig[]> {
  const minUsd = opts?.minUsd ?? 50
  const maxUsd = opts?.maxUsd ?? 300

  let html: string
  try {
    const res = await fetch(LISTING_URL, {
      headers: {
        'user-agent': 'Mozilla/5.0 (Lila/Scout opportunity scout)',
        'accept': 'text/html,application/xhtml+xml',
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return []
    html = await res.text()
  } catch {
    return []
  }

  // Pull the __NEXT_DATA__ JSON island. If the site isn't shipping it any
  // longer, give up cleanly.
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
  if (!m) return []

  let parsed: NextDataIsland
  try { parsed = JSON.parse(m[1]) as NextDataIsland } catch { return [] }

  const candidates = collectGigCandidates(parsed)

  const out: ContraGig[] = []
  for (const c of candidates) {
    if (!c.title || !c.url) continue
    if (c.compensationType && !/fixed|flat/i.test(c.compensationType)) continue
    const usd = bestUsd(c.budget)
    if (usd != null && (usd < minUsd || usd > maxUsd)) continue

    const blob = `${c.title} ${c.summary ?? ''} ${(c.skills ?? []).join(' ')}`
    if (!KEYWORD_RE.test(blob)) continue

    out.push({
      external_id: String(c.id ?? c.url),
      url: c.url.startsWith('http') ? c.url : `https://contra.com${c.url}`,
      title: c.title.slice(0, 280),
      summary: snippet(c.summary, 280),
      budget_usd: usd,
      posted_at: c.postedAt ?? null,
    })
  }

  const seen = new Set<string>()
  return out.filter(g => (seen.has(g.url) ? false : (seen.add(g.url), true)))
}

interface RawCandidate {
  id?: unknown
  url?: string
  title?: string
  summary?: string | null
  budget?: unknown
  compensationType?: string
  skills?: string[]
  postedAt?: string
}

// Walk the next-data tree and gather objects that look like gig listings.
// Schema isn't documented; we match on the presence of (title|name) +
// (compensationType|budget|rate|payment) which is the typical opportunity
// card shape on Contra.
function collectGigCandidates(node: unknown, out: RawCandidate[] = []): RawCandidate[] {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const v of node) collectGigCandidates(v, out)
    return out
  }
  const obj = node as Record<string, unknown>
  const title = pickString(obj, ['title', 'name', 'projectTitle'])
  const url   = pickString(obj, ['url', 'href', 'permalink', 'path', 'slug'])
  if (title && url) {
    const hasComp = (
      'compensationType' in obj ||
      'budget' in obj ||
      'rate' in obj ||
      'payment' in obj ||
      'fixedPrice' in obj
    )
    if (hasComp) {
      out.push({
        id: obj.id ?? obj.uid ?? obj.opportunityId,
        url,
        title,
        summary: pickString(obj, ['summary', 'description', 'shortDescription']) ?? null,
        budget: obj.budget ?? obj.fixedPrice ?? obj.payment ?? obj.rate,
        compensationType: pickString(obj, ['compensationType', 'paymentType']) ?? undefined,
        skills: Array.isArray(obj.skills) ? (obj.skills as string[]).filter(s => typeof s === 'string') : undefined,
        postedAt: pickString(obj, ['postedAt', 'publishedAt', 'createdAt']) ?? undefined,
      })
    }
  }
  for (const k of Object.keys(obj)) collectGigCandidates(obj[k], out)
  return out
}

function pickString(o: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'string' && v.trim()) return v
  }
  return null
}

function bestUsd(b: unknown): number | null {
  if (b == null) return null
  if (typeof b === 'number' && Number.isFinite(b)) return b
  if (typeof b === 'string') {
    const m = b.match(/\$?\s*([\d,]+(?:\.\d+)?)/)
    if (m) return parseFloat(m[1].replace(/,/g, ''))
  }
  if (typeof b === 'object') {
    const o = b as Record<string, unknown>
    const candidates = [o.amount, o.value, o.usd, o.min, o.max]
    for (const c of candidates) {
      const n = bestUsd(c)
      if (n != null) return n
    }
  }
  return null
}

function snippet(s: string | undefined | null, max: number): string | null {
  if (!s) return null
  return s.replace(/\s+/g, ' ').trim().slice(0, max)
}
