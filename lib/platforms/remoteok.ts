// RemoteOK jobs source. Free public JSON API, no auth required.
//   https://remoteok.com/api
//
// Response is an array. Element [0] is a legal-disclaimer object; the
// rest are job postings with: id, slug, position, company, tags[],
// location, salary_min, salary_max, description, url, apply_url, date.
//
// We filter for postings whose title/description/tags hint at Python
// automation, scraping, API, or webhook work.

const ENDPOINT = 'https://remoteok.com/api'

const KEYWORD_RE = /python|automat|scrap|api|webhook|integrat/i

export interface RemoteGig {
  external_id: string
  url: string
  title: string
  summary: string | null
  budget_usd: number | null
  posted_at: string | null
}

interface RemoteOKRaw {
  legal?: string
  id?: string | number
  slug?: string
  position?: string
  company?: string
  tags?: string[]
  description?: string
  url?: string
  apply_url?: string
  salary_min?: number | null
  salary_max?: number | null
  date?: string
}

export async function fetchOpenGigs(): Promise<RemoteGig[]> {
  let raw: RemoteOKRaw[]
  try {
    const res = await fetch(ENDPOINT, {
      headers: {
        'user-agent': 'Lila/Scout (https://thepark.world)',
        'accept': 'application/json',
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return []
    raw = await res.json() as RemoteOKRaw[]
  } catch {
    return []
  }
  if (!Array.isArray(raw)) return []

  const out: RemoteGig[] = []
  for (const r of raw) {
    if (r.legal) continue
    if (!r.id || !r.position) continue

    const tags = Array.isArray(r.tags) ? r.tags : []
    const blob = `${r.position ?? ''} ${r.description ?? ''} ${tags.join(' ')}`
    if (!KEYWORD_RE.test(blob)) continue

    const title = r.company
      ? `${r.position} @ ${r.company}`.slice(0, 280)
      : r.position.slice(0, 280)
    const url = r.url ?? r.apply_url ?? `https://remoteok.com/remote-jobs/${r.id}`

    out.push({
      external_id: String(r.id),
      url,
      title,
      summary: snippet(stripHtml(r.description), 280),
      budget_usd: r.salary_min ?? null,
      posted_at: r.date ?? null,
    })
  }
  return out
}

function stripHtml(s: string | undefined | null): string | null {
  if (!s) return null
  return s.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ')
}

function snippet(s: string | null, max: number): string | null {
  if (!s) return null
  return s.replace(/\s+/g, ' ').trim().slice(0, max)
}
