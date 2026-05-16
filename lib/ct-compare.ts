// Constant-time comparison for fixed-length hex digests (e.g. SHA-256
// auth-cookie hashes). Pure JS so it is safe in the Edge runtime, where
// node:crypto.timingSafeEqual is unavailable. The inputs' length is not
// secret (digest length is public); only the bytes are.
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
