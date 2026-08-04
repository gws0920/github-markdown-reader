const CACHE_NAME = 'github-markdown-reader-kokoro-v7'
const CDN_BASE =
  'https://huggingface.co/datasets/gws0920/github-markdown-reader-voice-runtime/resolve/main/'
const ACCELERATOR_TIMEOUT_MS = 15000

/** 安装后立即接管当前页面，确保首次模型请求也可进入缓存。 */
self.addEventListener('install', () => self.skipWaiting())

/** 激活后接管现有客户端，并删除旧版本语音缓存。 */
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

/** 向全部页面广播当前资源来源，便于播放器展示加速与回退状态。 */
async function broadcastRuntimeSource(source, fileName, totalBytes = 0) {
  const clients = await self.clients.matchAll({ type: 'window' })
  clients.forEach((client) =>
    client.postMessage({
      type: 'voice-runtime-source',
      source,
      fileName,
      totalBytes,
    }),
  )
}

/** 从本地请求路径提取语音运行时文件名，拒绝目录穿越片段。 */
function getRuntimeFileName(requestUrl) {
  const fileName = new URL(requestUrl).pathname.split('/').pop() ?? ''
  return /^[\w.-]+$/.test(fileName) ? fileName : ''
}

/** 仅加速体积最大的模型数据包，脚本和 WASM 保持同源以避免 MIME 限制。 */
function shouldUseReleaseCdn(fileName) {
  return fileName.endsWith('.data')
}

/** 从完整或分段响应头中提取资源总大小，优先采用 Content-Range 的完整长度。 */
function getResponseTotalBytes(response) {
  const contentRange = response.headers.get('content-range') ?? ''
  const rangeMatch = contentRange.match(/\/(\d+)$/)
  if (rangeMatch) return Number(rangeMatch[1])
  return Number(response.headers.get('content-length')) || 0
}

/** 为运行时响应增加实际资源来源标记，便于浏览器诊断缓存与回退行为。 */
function markRuntimeSource(response, source) {
  const headers = new Headers(response.headers)
  headers.delete('vary')
  headers.set('X-Voice-Runtime-Source', source)
  const totalBytes = getResponseTotalBytes(response)
  if (Number.isFinite(totalBytes) && totalBytes > 0) {
    headers.set('X-Voice-Runtime-Total-Bytes', String(totalBytes))
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/** 为返回页面的响应标记本次是否命中 Cache Storage。 */
function markRuntimeCache(response, cacheStatus) {
  const headers = new Headers(response.headers)
  headers.set('X-Voice-Runtime-Cache', cacheStatus)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/** 广播缓存写入结果，便于控制台诊断配额不足或响应不可缓存等问题。 */
async function broadcastCacheResult(fileName, status, message = '') {
  const clients = await self.clients.matchAll({ type: 'window' })
  clients.forEach((client) =>
    client.postMessage({
      type: 'voice-runtime-cache',
      fileName,
      status,
      message,
    }),
  )
}

/** 在限定时间内尝试公共模型 CDN，失败时由调用方切换 Pages 同源资源。 */
async function fetchCdnAsset(fileName, request) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ACCELERATOR_TIMEOUT_MS)
  try {
    const response = await fetch(`${CDN_BASE}${fileName}`, {
      headers: request.headers,
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`Voice CDN returned ${response.status}`)
    const totalBytes = getResponseTotalBytes(response)
    await broadcastRuntimeSource('cdn', fileName, totalBytes)
    return markRuntimeSource(response, 'cdn')
  } finally {
    clearTimeout(timer)
  }
}

/** 优先从公共模型 CDN 获取资源，不可用时无感回退到 Pages 仓库文件。 */
async function fetchRuntimeAsset(request) {
  const fileName = getRuntimeFileName(request.url)
  if (fileName && shouldUseReleaseCdn(fileName)) {
    try {
      return await fetchCdnAsset(fileName, request)
    } catch {
      await broadcastRuntimeSource('pages-fallback', fileName)
    }
  }
  const response = await fetch(request)
  return markRuntimeSource(response, 'pages-fallback')
}

/** 对语音运行时资源采用缓存优先，并将主源或兜底源响应写入统一缓存键。 */
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
        const cachedSource =
          cached.headers.get('X-Voice-Runtime-Source') ?? 'cache'
        const cachedTotalBytes =
          Number(cached.headers.get('X-Voice-Runtime-Total-Bytes')) || 0
        await broadcastRuntimeSource(
          cachedSource,
          getRuntimeFileName(event.request.url),
          cachedTotalBytes,
        )
        return markRuntimeCache(cached, 'hit')
      }
      try {
        const response = markRuntimeCache(
          await fetchRuntimeAsset(event.request),
          'miss',
        )
        if (response.ok) {
          void cache
            .put(event.request, response.clone())
            .then(() =>
              broadcastCacheResult(
                getRuntimeFileName(event.request.url),
                'stored',
              ),
            )
            .catch((error) =>
              broadcastCacheResult(
                getRuntimeFileName(event.request.url),
                'failed',
                error instanceof Error ? error.message : String(error),
              ),
            )
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
