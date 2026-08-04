const CACHE_NAME = 'github-markdown-reader-kokoro-v5'

/** 安装后立即接管当前页面，确保首次模型请求也可进入缓存。 */
self.addEventListener('install', () => self.skipWaiting())

/** 激活后接管现有客户端。 */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys
              .filter(
                (key) =>
                  key.startsWith('github-markdown-reader-kokoro-') &&
                  key !== CACHE_NAME,
              )
              .map((key) => caches.delete(key)),
          ),
        ),
    ]),
  )
})

/** 对语音运行时资源采用缓存优先策略，并在首次请求后写入 Cache Storage。 */
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (!url.pathname.includes('/voice-runtime/')) return
  let finishCacheWork
  const cacheWork = new Promise((resolve) => {
    finishCacheWork = resolve
  })
  event.waitUntil(cacheWork)
  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(event.request)
      if (cached) {
        finishCacheWork()
        return cached
      }
      try {
        const response = await fetch(event.request)
        if (response.ok) {
          void cache
            .put(event.request, response.clone())
            .finally(finishCacheWork)
        } else {
          finishCacheWork()
        }
        return response
      } catch (error) {
        finishCacheWork()
        throw error
      }
    }),
  )
})
