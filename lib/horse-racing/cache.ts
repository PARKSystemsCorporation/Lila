// Simple in-memory TTL cache. Module-local: each Node process holds its
// own. Acceptable for a single-replica deploy; on N replicas each one
// independently consumes the API quota.

interface Entry<T> {
  value: T
  expiresAt: number
}

const store = new Map<string, Entry<unknown>>()

export function get<T>(key: string): T | undefined {
  const e = store.get(key)
  if (!e) return undefined
  if (Date.now() > e.expiresAt) {
    store.delete(key)
    return undefined
  }
  return e.value as T
}

export function set<T>(key: string, value: T, ttlMs: number): void {
  store.set(key, { value, expiresAt: Date.now() + ttlMs })
}

export function size(): number {
  return store.size
}

// Convenience for "give me the cached value or compute + cache it." Used
// by racing-api.ts to wrap every endpoint call in one line.
export async function memo<T>(
  key: string,
  ttlMs: number,
  loader: () => Promise<T>,
): Promise<T> {
  const hit = get<T>(key)
  if (hit !== undefined) return hit
  const v = await loader()
  set(key, v, ttlMs)
  return v
}
