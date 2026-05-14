// Module-scoped sequencing queue for The Racing API.
//
// Free tier is 1 RPS. A token bucket works, but a strict serialiser with a
// post-resolution sleep is harder to misconfigure: every enqueued task
// awaits the previous one, then waits MIN_GAP_MS before the next runs.
// MUST be module-scoped — request-scoped instantiation breaks the 1 RPS
// guarantee under concurrent Next.js requests.

const MIN_GAP_MS = 1_000

let queue: Promise<void> = Promise.resolve()
let lastFinishedAt = 0

export function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const result = queue.then(async () => {
    const gap = Date.now() - lastFinishedAt
    if (gap < MIN_GAP_MS) {
      await new Promise(r => setTimeout(r, MIN_GAP_MS - gap))
    }
    try {
      return await fn()
    } finally {
      lastFinishedAt = Date.now()
    }
  })
  // Detach failures from the chain so one bad call doesn't poison the
  // queue for every subsequent request.
  queue = result.then(() => undefined, () => undefined)
  return result
}
