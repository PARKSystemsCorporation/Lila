// Wellfound (formerly AngelList Talent) jobs scraper. Best-effort fallback
// for when Contra returns nothing. Wellfound's public job board is also
// Next.js SSR; we extract __NEXT_DATA__ and harvest fixed-price /
// short-term roles whose copy mentions Python automation, scraping, or
// API work.
//
// Wellfound is primarily for full-time / contract roles, not gig-style
// fixed-price work, so the yield here is intentionally low — this is a
// safety net, not a primary feed.

const LISTING_URL = 'https://wellfound.com/jobs?keywords=python+automation'

const KEYWORD_RE = /python|automat|scrap|api|webhook|integrat/i

export interface WellfoundGig {
  external_id: string
  url: string
  title: string
  summary: string | null
  budget_usd: number | null
  posted_at: string | null
}

export async function fetchOpenGigs(opts?: { minUsd?: number; maxUsd?: number }): Promise<WellfoundGig[]> {
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

  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)
  if (!m) return []
  let parsed: unknown
  try { parsed = JSON.parse(m[1]) } catch { return [] }

  const cards = collectJobCandidates(parsed)
  const out: WellfoundGig[] = []
  for (const c of cards) {
    if (!c.title || !c.url) continue
    const blob = `${c.title} ${c.summary ?? ''}`
    if (!KEYWORD_RE.test(blob)) continue
    const usd = parseSalary(c.salary ?? c.compensation ?? c.budget)
    // Wellfound salaries are mostly annual ranges; we only keep listings whose
    // expressed compensation falls in our gig band, OR that have no $ at all
    // (likely gig-style postings).
    if (usd != null && (usd < minUsd || usd > maxUsd)) continue

    out.push({
      external_id: String(c.id ?? c.url),
      url: c.url.startsWith('http') ? c.url : `https://wellfound.com${c.url}`,
      title: c.title.slice(0, 280),
      summary: snippet(c.summary, 280),
      budget_usd: usd,
      posted_at: c.postedAt ?? null,
    })
  }

  const seen = new Set<string>()
  return out.filter(g => (seen.has(g.url) ? false : (seen.add(g.url), true)))
}

interface RawCard {
  id?: unknown
  url?: string
  title?: string
  summary?: string | null
  salary?: unknown
  compensation?: unknown
  budget?: unknown
  postedAt?: string
}

function collectJobCandidates(node: unknown, out: RawCard[] = []): RawCard[] {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const v of node) collectJobCandidates(v, out)
    return out
  }
  const obj = node as Record<string, unknown>
  const title = pickString(obj, ['title', 'jobTitle', 'roleTitle', 'name'])
  const url   = pickString(obj, ['url', 'jobUrl', 'permalink', 'path', 'slug'])
  if (title && url) {
    out.push({
      id: obj.id ?? obj.jobId ?? obj.uid,
      url,
      title,
      summary: pickString(obj, ['description', 'summary', 'jobDescription']) ?? null,
      salary: obj.salary ?? obj.salaryRange,
      compensation: obj.compensation,
      budget: obj.budget,
      postedAt: pickString(obj, ['postedAt', 'publishedAt', 'createdAt']) ?? undefined,
    })
  }
  for (const k of Object.keys(obj)) collectJobCandidates(obj[k], out)
  return out
}

function pickString(o: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'string' && v.trim()) return v
  }
  return null
}

function parseSalary(b: unknown): number | null {
  if (b == null) return null
  if (typeof b === 'number' && Number.isFinite(b)) return b
  if (typeof b === 'string') {
    const m = b.match(/\$?\s*([\d,]+(?:\.\d+)?)/)
    if (m) return parseFloat(m[1].replace(/,/g, ''))
  }
  if (typeof b === 'object') {
    const o = b as Record<string, unknown>
    for (const c of [o.min, o.amount, o.value, o.usd]) {
      const n = parseSalary(c)
      if (n != null) return n
    }
  }
  return null
}

function snippet(s: string | undefined | null, max: number): string | null {
  if (!s) return null
  return s.replace(/\s+/g, ' ').trim().slice(0, max)
}
