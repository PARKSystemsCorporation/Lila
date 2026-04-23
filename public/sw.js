const CACHE = 'lila-v6'
const PRECACHE = ['/manifest.json', '/icon-192.svg', '/icon-512.svg']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)))
  self.skipWaiting()
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  )
  self.clients.claim()
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  const url = new URL(req.url)

  // Always network for API — data must be live.
  if (url.pathname.startsWith('/api/')) return

  // Navigations (HTML documents): network-first so auth redirects never get
  // cached as the "home" page. Fall back to the cached page only when offline.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && res.type === 'basic') {
            const clone = res.clone()
            caches.open(CACHE).then((c) => c.put(req, clone))
          }
          return res
        })
        .catch(() => caches.match(req).then((r) => r || caches.match('/login')))
    )
    return
  }

  // Static assets: cache-first.
  e.respondWith(
    caches.match(req).then(
      (cached) =>
        cached ||
        fetch(req).then((res) => {
          if (res.ok) {
            const clone = res.clone()
            caches.open(CACHE).then((c) => c.put(req, clone))
          }
          return res
        })
    )
  )
})
