// Edge-runtime-safe HMAC sign/verify for the viewer cookie.
//
// Layout: '<base64url-payload>.<base64url-sig>'
// Payload: JSON { key: string, exp: number /* unix seconds */ }
// Signed with HMAC-SHA256 + VIEWER_COOKIE_SECRET.
//
// Used by middleware.ts (edge) and the API routes. No node-only deps.

interface ViewerPayload {
  key: string
  exp: number   // unix seconds
}

const enc = new TextEncoder()
const dec = new TextDecoder()

function b64urlEncode(buf: Uint8Array): string {
  let s = ''
  for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i])
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(s: string): Uint8Array {
  const pad = (4 - (s.length % 4)) % 4
  const norm = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad)
  const bin = atob(norm)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign', 'verify'],
  )
}

export async function signViewerCookie(payload: ViewerPayload, secret: string): Promise<string> {
  const data = b64urlEncode(enc.encode(JSON.stringify(payload)))
  const k = await importHmacKey(secret)
  const sigBuf = await crypto.subtle.sign('HMAC', k, enc.encode(data))
  const sig = b64urlEncode(new Uint8Array(sigBuf))
  return `${data}.${sig}`
}

export async function verifyViewerCookie(
  cookie: string | undefined | null,
  secret: string,
): Promise<ViewerPayload | null> {
  if (!cookie || !secret) return null
  const dot = cookie.indexOf('.')
  if (dot < 1) return null
  const data = cookie.slice(0, dot)
  const sig  = cookie.slice(dot + 1)
  if (!data || !sig) return null

  let sigBytes: Uint8Array
  try { sigBytes = b64urlDecode(sig) } catch { return null }

  const k = await importHmacKey(secret)
  let ok = false
  try {
    ok = await crypto.subtle.verify('HMAC', k, sigBytes as BufferSource, enc.encode(data))
  } catch { return null }
  if (!ok) return null

  let payload: ViewerPayload
  try {
    payload = JSON.parse(dec.decode(b64urlDecode(data)))
  } catch { return null }

  if (typeof payload?.key !== 'string') return null
  if (typeof payload?.exp !== 'number') return null
  if (Math.floor(Date.now() / 1000) > payload.exp) return null

  return payload
}

// 30-day cookie. Re-verification against Gumroad happens on first
// /api/viewer/login of each window — covers active subscriptions
// without re-prompting the viewer for their key every visit.
export const VIEWER_COOKIE_TTL_SECONDS = 30 * 24 * 60 * 60
