import type { PoolClient } from 'pg'

// dev.to publisher for Scout's tutorial fallback. Picks the oldest
// approved-but-unpublished tutorial article and posts it via dev.to's
// public API. Auth is a single header (`api-key`) issued from any dev.to
// account's Settings → Extensions page.
//
// Skips silently when DEVTO_API_KEY is unset (no logged event, so it
// doesn't spam the Log tab on installs that don't use dev.to).

const DEVTO_API = 'https://dev.to/api/articles'

interface PublishResult {
  ran: boolean
  published: number
  failed: number
  logMessage?: string
  logType?: 'info' | 'success' | 'warn'
}

interface DevtoResponse {
  id?: number
  url?: string
  canonical_url?: string
}

export async function runDevtoPublisher(db: PoolClient): Promise<PublishResult | null> {
  const key = process.env.DEVTO_API_KEY
  if (!key) return null

  const { rows } = await db.query(
    `SELECT id, title, content
       FROM articles
      WHERE author='scout'
        AND kind='tutorial'
        AND status='approved'
        AND published_to IS NULL
      ORDER BY id ASC
      LIMIT 1`
  )
  if (!rows.length) return { ran: true, published: 0, failed: 0 }

  const row = rows[0] as { id: number; title: string; content: string }
  const tags = inferTags(row.title, row.content)

  let res: Response
  try {
    res = await fetch(DEVTO_API, {
      method: 'POST',
      headers: {
        'api-key': key,
        'content-type': 'application/json',
        'accept': 'application/vnd.forem.api-v1+json',
      },
      body: JSON.stringify({
        article: {
          title: row.title.slice(0, 250),
          body_markdown: row.content,
          published: true,
          tags,
        },
      }),
      signal: AbortSignal.timeout(20_000),
    })
  } catch (e) {
    return {
      ran: true, published: 0, failed: 1,
      logMessage: `dev.to publish error: ${String(e).slice(0, 120)}`,
      logType: 'warn',
    }
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    return {
      ran: true, published: 0, failed: 1,
      logMessage: `dev.to publish failed (${res.status}): ${detail.slice(0, 120)}`,
      logType: 'warn',
    }
  }

  let body: DevtoResponse
  try { body = await res.json() as DevtoResponse } catch { body = {} }
  const url = body.url ?? body.canonical_url ?? null

  await db.query(
    `UPDATE articles
       SET published_to='devto',
           external_url=COALESCE($1, external_url),
           published_at=NOW(),
           updated_at=NOW()
     WHERE id=$2`,
    [url, row.id]
  )

  return {
    ran: true, published: 1, failed: 0,
    logMessage: `dev.to published "${row.title.slice(0, 60)}"${url ? ` → ${url}` : ''}`,
    logType: 'success',
  }
}

// Pull a few obvious dev.to tags from the article title + first 1k chars
// of the body. dev.to caps at 4 tags and rejects unknown ones loudly, so
// we stick to a small whitelist drawn from the most-popular tags on the
// platform — anything we can't confidently match is dropped.
const TAG_WHITELIST: { match: RegExp; tag: string }[] = [
  { match: /\bpython\b/i,         tag: 'python' },
  { match: /\b(api|rest)\b/i,     tag: 'api' },
  { match: /\b(scrap|crawl)/i,    tag: 'webscraping' },
  { match: /\bautomat/i,          tag: 'automation' },
  { match: /\bjavascript|js\b/i,  tag: 'javascript' },
  { match: /\btypescript|ts\b/i,  tag: 'typescript' },
  { match: /\bdjango\b/i,         tag: 'django' },
  { match: /\bfastapi\b/i,        tag: 'fastapi' },
  { match: /\bflask\b/i,          tag: 'flask' },
  { match: /\bdocker\b/i,         tag: 'docker' },
  { match: /\bwebhook/i,          tag: 'webhooks' },
  { match: /\btutorial\b/i,       tag: 'tutorial' },
  { match: /\bbeginner/i,         tag: 'beginners' },
]

function inferTags(title: string, content: string): string[] {
  const probe = `${title}\n${content.slice(0, 1000)}`
  const out: string[] = []
  for (const { match, tag } of TAG_WHITELIST) {
    if (match.test(probe) && !out.includes(tag)) out.push(tag)
    if (out.length >= 4) break
  }
  if (out.length === 0) out.push('tutorial')
  return out
}
