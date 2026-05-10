import { cfg } from '../../config'
import { getPool } from '../../db'
import { digest } from '../../memory/digest'

// Real allowlisted web fetch. Hosts match by suffix on the URL hostname.
// Size cap: 512 KB raw response. Timeout: 10s. HTML stripped to plain text
// via a tiny tag-stripping regex (no external dependency).
//
// Memory hook: each successful fetch's title+text feed memory.digest as a
// 'web' episode. Strictly fire-and-forget — return shape and timing
// unchanged. Skipped in dry-run mode.

const MAX_BYTES = 512 * 1024
const TIMEOUT_MS = 10_000

export interface FetchResult {
  url: string
  ok: boolean
  status: number
  title: string | null
  text: string
  bytes: number
  logMessage: string
}

function allowlist(): string[] {
  return cfg.LILA_WEB_ALLOWLIST.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
}

function hostAllowed(host: string): boolean {
  const list = allowlist()
  const h = host.toLowerCase()
  return list.some(suffix => h === suffix || h.endsWith('.' + suffix))
}

function stripHtml(html: string): { title: string | null; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim().slice(0, 200) : null
  const noScripts = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
  const text = decodeEntities(noScripts.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 8000)
  return { title, text }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

export async function fetchUrl(args: { url: string }): Promise<FetchResult> {
  const url = String(args.url ?? '').trim()
  if (cfg.LILA_DRY_RUN) {
    return {
      url, ok: true, status: 200, title: '[dry-run]', text: `[dry-run fetch of ${url}]`, bytes: 0,
      logMessage: `[dry-run] web.fetch ${url}`,
    }
  }
  let parsed: URL
  try { parsed = new URL(url) } catch {
    return { url, ok: false, status: 0, title: null, text: '', bytes: 0, logMessage: `web.fetch: invalid url "${url}"` }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { url, ok: false, status: 0, title: null, text: '', bytes: 0, logMessage: `web.fetch: only http(s) — got ${parsed.protocol}` }
  }
  if (!hostAllowed(parsed.hostname)) {
    return {
      url, ok: false, status: 0, title: null, text: '', bytes: 0,
      logMessage: `web.fetch: host "${parsed.hostname}" not in allowlist (${allowlist().join(',')})`,
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'lila-autonomy/1.0 (+https://parksystems.example)' },
    })
    const reader = res.body?.getReader()
    let bytes = 0
    const chunks: Uint8Array[] = []
    if (reader) {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        if (value) {
          bytes += value.byteLength
          if (bytes > MAX_BYTES) {
            chunks.push(value.slice(0, MAX_BYTES - (bytes - value.byteLength)))
            try { await reader.cancel() } catch { /* ignore */ }
            break
          }
          chunks.push(value)
        }
      }
    }
    const buf = Buffer.concat(chunks.map(c => Buffer.from(c)))
    const body = buf.toString('utf8')
    const ct = (res.headers.get('content-type') ?? '').toLowerCase()
    const isHtml = ct.includes('text/html') || /<html[\s>]/i.test(body.slice(0, 200))
    const { title, text } = isHtml ? stripHtml(body) : { title: null, text: body.slice(0, 8000) }
    if (res.ok && process.env.DATABASE_URL) {
      // Best-effort memory ingest. Own connection so we don't depend on the
      // caller having a db handle. Errors silently dropped.
      void getPool().connect().then(async conn => {
        try {
          await digest(conn, {
            source: 'web',
            source_id: url,
            actor: 'web',
            text: `${title ?? ''}\n${text}`.trim().slice(0, 2000),
            detail: text.slice(0, 4000),
          })
        } catch { /* swallow */ }
        finally { conn.release() }
      }).catch(() => { /* connect failed; ignore */ })
    }
    return {
      url, ok: res.ok, status: res.status, title, text, bytes,
      logMessage: `web.fetch ${parsed.hostname} ${res.status} (${bytes}B)`,
    }
  } catch (e) {
    return {
      url, ok: false, status: 0, title: null, text: '', bytes: 0,
      logMessage: `web.fetch error: ${String(e).slice(0, 120)}`,
    }
  } finally {
    clearTimeout(timer)
  }
}
