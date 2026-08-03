const CACHE_NAME = 'github-markdown-reader-kokoro-v2'

/** 安装后立即接管当前页面，确保首次模型请求也可进入缓存。 */
self.addEventListener('install', () => self.skipWaiting())

/** 激活后接管现有客户端。 */
self.addEventListener('activate', (event) =>
  event.waitUntil(self.clients.claim()),
)

/** 对语音运行时资源采用缓存优先策略，并在首次请求后写入 Cache Storage。 */
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (!url.pathname.includes('/voice-runtime/')) return
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(event.request)
      if (cached) return cached
      const response = await fetch(event.request)
      if (response.ok) await cache.put(event.request, response.clone())
      return response
    }),
  )
})
