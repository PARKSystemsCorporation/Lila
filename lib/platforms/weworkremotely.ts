// We Work Remotely jobs source. Free public RSS feed, no auth required.
//   https://weworkremotely.com/categories/remote-programming-jobs.rss
//
// RSS format. Each <item> has: title, description (CDATA-wrapped HTML),
// link, pubDate, guid. We parse with a small regex pass — the schema is
// stable enough that a full XML dependency isn't worth it.
//
// Used as a fallback to RemoteOK; same shape so scout-loop can swap.

const ENDPOINT = 'https://weworkremotely.com/categories/remote-programming-jobs.rss'

const KEYWORD_RE = /python|automat|scrap|api|webhook|integrat/i

export interface RemoteGig {
  external_id: string
  url: string
  title: string
  summary: string | null
  budget_usd: number | null
  posted_at: string | null
}

export async function fetchOpenGigs(): Promise<RemoteGig[]> {
  let xml: string
  try {
    const res = await fetch(ENDPOINT, {
      headers: {
        'user-agent': 'Lila/Scout (https://thepark.world)',
        'accept': 'application/rss+xml,application/xml',
      },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return []
    xml = await res.text()
  } catch {
    return []
  }

  const items = extractItems(xml)
  const out: RemoteGig[] = []
  for (const item of items) {
    const title = item.title?.trim()
    const link  = item.link?.trim()
    if (!title || !link) continue
    const summaryRaw = stripHtml(item.description)
    const blob = `${title} ${summaryRaw ?? ''}`
    if (!KEYWORD_RE.test(blob)) continue

    out.push({
      external_id: item.guid?.trim() || link,
      url: link,
      title: title.slice(0, 280),
      summary: snippet(summaryRaw, 280),
      budget_usd: null, // WWR doesn't publish salary in the feed
      posted_at: item.pubDate?.trim() ?? null,
    })
  }
  return out
}

interface RawItem {
  title?: string
  link?: string
  description?: string
  pubDate?: string
  guid?: string
}

function extractItems(xml: string): RawItem[] {
  const out: RawItem[] = []
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/g
  let m: RegExpExecArray | null
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1]
    out.push({
      title:       readField(block, 'title'),
      link:        readField(block, 'link'),
      description: readField(block, 'description'),
      pubDate:     readField(block, 'pubDate'),
      guid:        readField(block, 'guid'),
    })
  }
  return out
}

function readField(block: string, name: string): string | undefined {
  const re = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i')
  const m = block.match(re)
  if (!m) return undefined
  // Strip CDATA wrapper if present.
  return m[1].replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '')
}

function stripHtml(s: string | undefined | null): string | null {
  if (!s) return null
  return s.replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ')
}

function snippet(s: string | null, max: number): string | null {
  if (!s) return null
  return s.replace(/\s+/g, ' ').trim().slice(0, max)
}
