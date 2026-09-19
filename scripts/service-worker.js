/* BUILD_CONFIGURATION */

const cacheName = configuration.cachePrefix + configuration.release
const shellUrl = new URL(configuration.shell, self.location.origin).href
const assetUrls = new Set(configuration.assets.map((path) => new URL(path, self.location.origin).href))

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(cacheName)
    try {
      await cache.addAll([...assetUrls].map((url) => new Request(url, { cache: 'reload' })))
    } catch (error) {
      await caches.delete(cacheName)
      throw error
    }
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const cacheNames = await caches.keys()
    await Promise.all(cacheNames
      .filter((name) => name.startsWith(configuration.cachePrefix) && name !== cacheName)
      .map((name) => caches.delete(name)))
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  const scopePath = new URL(self.registration.scope).pathname
  const isAppNavigation = request.mode === 'navigate' &&
    (url.pathname === scopePath || url.pathname === `${scopePath}index.html`)
  const cacheUrl = isAppNavigation ? shellUrl : url.href
  if (!isAppNavigation && !assetUrls.has(cacheUrl)) return

  event.respondWith((async () => {
    const cache = await caches.open(cacheName)
    const cached = await cache.match(cacheUrl)
    return cached ?? fetch(request)
  })())
})
