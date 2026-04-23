// Bluesky (AT Protocol) post. Free, no API fees. To enable:
//   BSKY_HANDLE           your handle, e.g. lila.bsky.social
//   BSKY_APP_PASSWORD     an app password from Settings → App Passwords
//                         (NOT your main account password)
//
// Default PDS host is bsky.social; override via BSKY_PDS if you run your own.

const PDS_DEFAULT = 'https://bsky.social'

export function isConfigured(): boolean {
  return !!(process.env.BSKY_HANDLE && process.env.BSKY_APP_PASSWORD)
}

interface Session { jwt: string; did: string; expiresAt: number }
let cache: Session | null = null

async function getSession(): Promise<Session | null> {
  if (cache && cache.expiresAt > Date.now() + 60_000) return cache
  const handle = process.env.BSKY_HANDLE
  const password = process.env.BSKY_APP_PASSWORD
  if (!handle || !password) return null
  const host = process.env.BSKY_PDS ?? PDS_DEFAULT

  try {
    const res = await fetch(`${host}/xrpc/com.atproto.server.createSession`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: handle, password }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const d = await res.json()
    cache = {
      jwt: d.accessJwt,
      did: d.did,
      // Access JWT lives ~2h; refresh well before that to stay safe.
      expiresAt: Date.now() + 60 * 60_000,
    }
    return cache
  } catch {
    return null
  }
}

export async function postSkeet(text: string): Promise<{ ok: boolean; uri?: string; error?: string }> {
  const s = await getSession()
  if (!s) return { ok: false, error: 'Bluesky credentials missing or auth failed' }
  const host = process.env.BSKY_PDS ?? PDS_DEFAULT

  try {
    const res = await fetch(`${host}/xrpc/com.atproto.repo.createRecord`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${s.jwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        repo: s.did,
        collection: 'app.bsky.feed.post',
        record: {
          $type: 'app.bsky.feed.post',
          text: text.slice(0, 300),
          createdAt: new Date().toISOString(),
        },
      }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) {
      const err = await res.text().catch(() => '')
      // 401 probably means the cached JWT expired; invalidate so next try re-auths.
      if (res.status === 401) cache = null
      return { ok: false, error: `Bluesky ${res.status}: ${err.slice(0, 300)}` }
    }
    const data = await res.json()
    return { ok: true, uri: data?.uri }
  } catch (e) {
    return { ok: false, error: `Bluesky network: ${String(e)}` }
  }
}
