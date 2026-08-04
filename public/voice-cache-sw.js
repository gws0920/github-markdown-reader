const CACHE_NAME = 'github-markdown-reader-voice-runtime-v9'
const DB_NAME = 'github-markdown-reader-voice-chunks'
const DB_VERSION = 1
const CHUNK_STORE = 'chunks'
const LEASE_STORE = 'leases'
const MODEL_FILE = 'sherpa-onnx-wasm-main-tts.data'
const MANIFEST_FILE = 'voice-runtime-manifest.json'
const CDN_BASE =
  'https://huggingface.co/datasets/gws0920/github-markdown-reader-voice-runtime/resolve/main/'
const ACCELERATOR_TIMEOUT_MS = 30000
const STORAGE_MARGIN_BYTES = 50 * 1024 * 1024
const DOWNLOAD_CONCURRENCY = 3
const CHUNK_RETRY_COUNT = 3
const LEASE_DURATION_MS = 10 * 60 * 1000
let manifestPromise = null

/** 安装后立即接管当前页面，确保首次模型请求也可进入缓存。 */
self.addEventListener('install', () => self.skipWaiting())

/** 激活后接管现有客户端，并删除旧版整包模型缓存。 */
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
                  (key.startsWith('github-markdown-reader-kokoro-') ||
                    key.startsWith('github-markdown-reader-voice-runtime-')) &&
                  key !== CACHE_NAME,
              )
              .map((key) => caches.delete(key)),
          ),
        ),
    ]),
  )
})

/** 将 IndexedDB 请求转换为 Promise。 */
function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/** 等待 IndexedDB 事务完成。 */
function transactionToPromise(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

/** 打开保存模型分片和多标签页租约的 IndexedDB。 */
function openChunkDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(CHUNK_STORE)) {
        const store = database.createObjectStore(CHUNK_STORE, { keyPath: 'id' })
        store.createIndex('fileKey', 'fileKey', { unique: false })
      }
      if (!database.objectStoreNames.contains(LEASE_STORE)) {
        database.createObjectStore(LEASE_STORE, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/** 创建区分运行时版本、文件哈希和分片序号的稳定键。 */
function createChunkId(fileKey, index) {
  return `${fileKey}:${index}`
}

/** 读取一个已完成模型分片。 */
async function readChunk(fileKey, index) {
  const database = await openChunkDatabase()
  const transaction = database.transaction(CHUNK_STORE, 'readonly')
  const record = await requestToPromise(
    transaction.objectStore(CHUNK_STORE).get(createChunkId(fileKey, index)),
  )
  database.close()
  return record ?? null
}

/** 保存一个已校验完成的模型分片。 */
async function writeChunk(fileKey, index, bytes) {
  const database = await openChunkDatabase()
  const transaction = database.transaction(CHUNK_STORE, 'readwrite')
  transaction.objectStore(CHUNK_STORE).put({
    id: createChunkId(fileKey, index),
    fileKey,
    index,
    size: bytes.byteLength,
    bytes,
  })
  await transactionToPromise(transaction)
  database.close()
}

/** 汇总当前模型已经持久化的分片和字节数。 */
async function readChunkSummary(fileKey, chunkCount) {
  const chunks = new Map()
  let cachedBytes = 0
  for (let index = 0; index < chunkCount; index += 1) {
    const record = await readChunk(fileKey, index)
    if (!record) continue
    chunks.set(index, record)
    cachedBytes += record.size
  }
  return { chunks, cachedBytes }
}

/** 删除与当前运行时哈希不一致的旧模型分片。 */
async function deleteStaleChunks(fileKey) {
  const database = await openChunkDatabase()
  const transaction = database.transaction(CHUNK_STORE, 'readwrite')
  const store = transaction.objectStore(CHUNK_STORE)
  const cursorRequest = store.openCursor()
  await new Promise((resolve, reject) => {
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result
      if (!cursor) {
        resolve()
        return
      }
      if (cursor.value.fileKey !== fileKey) cursor.delete()
      cursor.continue()
    }
    cursorRequest.onerror = () => reject(cursorRequest.error)
  })
  await transactionToPromise(transaction)
  database.close()
}

/** 清除全部可续传模型分片。 */
async function clearChunkDatabase() {
  const database = await openChunkDatabase()
  const transaction = database.transaction(
    [CHUNK_STORE, LEASE_STORE],
    'readwrite',
  )
  transaction.objectStore(CHUNK_STORE).clear()
  transaction.objectStore(LEASE_STORE).clear()
  await transactionToPromise(transaction)
  database.close()
}

/** 统计 IndexedDB 中已持久化模型分片的总字节数。 */
async function readTotalChunkBytes() {
  const database = await openChunkDatabase()
  const transaction = database.transaction(CHUNK_STORE, 'readonly')
  const request = transaction.objectStore(CHUNK_STORE).openCursor()
  let bytes = 0
  await new Promise((resolve, reject) => {
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) {
        resolve()
        return
      }
      bytes += cursor.value.size || 0
      cursor.continue()
    }
    request.onerror = () => reject(request.error)
  })
  database.close()
  return bytes
}

/** 尝试获取 IndexedDB 下载租约，供不支持 Web Locks 的浏览器使用。 */
async function acquireDownloadLease(lockName, owner) {
  const database = await openChunkDatabase()
  const transaction = database.transaction(LEASE_STORE, 'readwrite')
  const store = transaction.objectStore(LEASE_STORE)
  const current = await requestToPromise(store.get(lockName))
  const now = Date.now()
  const acquired =
    !current || current.expiresAt <= now || current.owner === owner
  if (acquired) {
    store.put({ id: lockName, owner, expiresAt: now + LEASE_DURATION_MS })
  }
  await transactionToPromise(transaction)
  database.close()
  return acquired
}

/** 释放 IndexedDB 下载租约。 */
async function releaseDownloadLease(lockName, owner) {
  const database = await openChunkDatabase()
  const transaction = database.transaction(LEASE_STORE, 'readwrite')
  const store = transaction.objectStore(LEASE_STORE)
  const current = await requestToPromise(store.get(lockName))
  if (current?.owner === owner) store.delete(lockName)
  await transactionToPromise(transaction)
  database.close()
}

/** 延长当前标签页的下载租约，避免长时间下载时被其他标签页重复接管。 */
async function renewDownloadLease(lockName, owner) {
  const database = await openChunkDatabase()
  const transaction = database.transaction(LEASE_STORE, 'readwrite')
  const store = transaction.objectStore(LEASE_STORE)
  const lease = await requestToPromise(store.get(lockName))
  if (lease?.owner === owner) {
    store.put({
      name: lockName,
      owner,
      expiresAt: Date.now() + LEASE_DURATION_MS,
    })
  }
  await transactionToPromise(transaction)
  database.close()
}

/** 使用 Web Locks 或 IndexedDB 租约串行化多标签页模型下载。 */
async function runWithDownloadLock(lockName, task) {
  if (self.navigator.locks?.request) {
    return self.navigator.locks.request(lockName, { mode: 'exclusive' }, task)
  }
  const owner =
    crypto.randomUUID?.() ??
    `${Date.now()}-${Math.random().toString(16).slice(2)}`
  while (!(await acquireDownloadLease(lockName, owner))) {
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  const renewalTimer = setInterval(() => {
    void renewDownloadLease(lockName, owner)
  }, LEASE_DURATION_MS / 3)
  try {
    return await task()
  } finally {
    clearInterval(renewalTimer)
    await releaseDownloadLease(lockName, owner)
  }
}

/** 向全部页面广播语音运行时状态。 */
async function broadcast(message) {
  const clients = await self.clients.matchAll({ type: 'window' })
  clients.forEach((client) => client.postMessage(message))
}

/** 获取语音运行时清单并在 Service Worker 生命周期内复用。 */
async function loadRuntimeManifest() {
  manifestPromise ??= fetch(
    new URL(`voice-runtime/${MANIFEST_FILE}`, self.registration.scope),
    { cache: 'no-store' },
  ).then((response) => {
    if (!response.ok) throw new Error('语音运行时清单加载失败。')
    return response.json()
  })
  return manifestPromise
}

/** 计算 ArrayBuffer 的 SHA-256 十六进制摘要。 */
async function sha256(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('')
}

/** 检查剩余存储空间是否足以保存缺失分片和安全余量。 */
async function assertStorageCapacity(missingBytes) {
  if (!self.navigator.storage?.estimate) return
  const estimate = await self.navigator.storage.estimate()
  if (!estimate.quota || estimate.usage === undefined) return
  const available = estimate.quota - estimate.usage
  if (available < missingBytes + STORAGE_MARGIN_BYTES) {
    throw new Error('浏览器剩余空间不足，无法缓存本地自然语音模型。')
  }
}

/** 从公开 CDN 下载并校验一个 Range 分片，失败时最多重试三次。 */
async function downloadChunk(fileName, file, index, signal) {
  const start = index * file.chunkSize
  const end = Math.min(file.size - 1, start + file.chunkSize - 1)
  let lastError = new Error('模型分片下载失败。')
  for (let attempt = 1; attempt <= CHUNK_RETRY_COUNT; attempt += 1) {
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => controller.abort(), ACCELERATOR_TIMEOUT_MS)
    try {
      const response = await fetch(`${CDN_BASE}${fileName}`, {
        headers: { Range: `bytes=${start}-${end}` },
        signal: controller.signal,
      })
      if (response.status !== 206) {
        throw new Error(`CDN 不支持模型分片请求：${response.status}`)
      }
      const bytes = await response.arrayBuffer()
      if (bytes.byteLength !== end - start + 1) {
        throw new Error('模型分片长度校验失败。')
      }
      const digest = await sha256(bytes)
      if (digest !== file.chunks[index]) {
        throw new Error('模型分片完整性校验失败。')
      }
      return bytes
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (signal.aborted) throw lastError
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
  }
  throw lastError
}

/** 读取本地分片或从 CDN 下载、校验并持久化缺失分片。 */
async function getOrDownloadChunk(
  fileName,
  file,
  fileKey,
  index,
  signal,
  progress,
) {
  const cached = await readChunk(fileKey, index)
  if (cached) return cached.bytes
  const bytes = await downloadChunk(fileName, file, index, signal)
  try {
    await writeChunk(fileKey, index, bytes)
    progress.cachedBytes += bytes.byteLength
    await broadcast({
      type: 'voice-runtime-cache',
      status: 'stored',
      fileName,
      chunkIndex: index,
      chunkCount: file.chunks.length,
      cachedBytes: progress.cachedBytes,
      totalBytes: file.size,
    })
  } catch (error) {
    await broadcast({
      type: 'voice-runtime-cache',
      status: 'failed',
      fileName,
      message: error instanceof Error ? error.message : String(error),
    })
  }
  return bytes
}

/** 按顺序输出分片，同时最多预取三个缺失分片。 */
async function streamModelChunks(
  controller,
  fileName,
  file,
  fileKey,
  signal,
  initialCachedBytes,
) {
  const progress = { cachedBytes: initialCachedBytes }
  const pending = new Map()
  const schedule = (index) => {
    if (index >= file.chunks.length || pending.has(index)) return
    pending.set(
      index,
      getOrDownloadChunk(fileName, file, fileKey, index, signal, progress),
    )
  }
  for (let index = 0; index < DOWNLOAD_CONCURRENCY; index += 1) schedule(index)
  for (let index = 0; index < file.chunks.length; index += 1) {
    if (signal.aborted) throw new DOMException('下载已取消。', 'AbortError')
    schedule(index + DOWNLOAD_CONCURRENCY)
    const bytes = await pending.get(index)
    pending.delete(index)
    controller.enqueue(new Uint8Array(bytes))
    await broadcast({
      type: 'voice-runtime-progress',
      phase: 'downloading-model',
      source: 'cdn',
      fileName,
      chunkIndex: index + 1,
      chunkCount: file.chunks.length,
      downloadedBytes: Math.min(file.size, (index + 1) * file.chunkSize),
      cachedBytes: progress.cachedBytes,
      totalBytes: file.size,
    })
  }
  controller.close()
  await broadcast({
    type: 'voice-runtime-progress',
    phase: 'loading-model',
    source: 'local-resume',
    fileName,
    downloadedBytes: file.size,
    cachedBytes: file.size,
    totalBytes: file.size,
  })
}

/** 在 CDN 不可用时回退到 Pages 整包响应，本路径不承诺断点续传。 */
async function fetchPagesFallback(request, file, resumeBytes) {
  await broadcast({
    type: 'voice-runtime-progress',
    phase: 'downloading-model',
    source: 'pages-fallback',
    fileName: MODEL_FILE,
    downloadedBytes: 0,
    cachedBytes: resumeBytes,
    totalBytes: file.size,
  })
  const response = await fetch(request)
  const headers = new Headers(response.headers)
  headers.delete('content-encoding')
  headers.delete('content-length')
  headers.delete('vary')
  headers.set('Content-Length', String(file.size))
  headers.set('X-Voice-Runtime-Source', 'pages-fallback')
  headers.set('X-Voice-Runtime-Cache', 'miss')
  headers.set('X-Voice-Runtime-Resume-Bytes', String(resumeBytes))
  headers.set('X-Voice-Runtime-Total-Bytes', String(file.size))
  headers.set('X-Voice-Runtime-Version', 'voice-runtime-v2')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/** 创建支持 IndexedDB 断点续传的模型数据响应。 */
async function createResumableModelResponse(request) {
  const manifest = await loadRuntimeManifest()
  const file = manifest.files[MODEL_FILE]
  if (!file?.chunks?.length) throw new Error('语音模型分片清单无效。')
  const fileKey = `${manifest.version}:${file.sha256}`
  await deleteStaleChunks(fileKey)
  const summary = await readChunkSummary(fileKey, file.chunks.length)
  const missingBytes = file.size - summary.cachedBytes
  await assertStorageCapacity(missingBytes)
  await broadcast({
    type: 'voice-runtime-progress',
    phase: 'checking-cache',
    source: summary.cachedBytes > 0 ? 'local-resume' : 'cdn',
    fileName: MODEL_FILE,
    downloadedBytes: summary.cachedBytes,
    cachedBytes: summary.cachedBytes,
    totalBytes: file.size,
  })

  if (missingBytes > 0) {
    const firstMissing = Array.from(
      { length: file.chunks.length },
      (_, index) => index,
    ).find((index) => !summary.chunks.has(index))
    if (firstMissing !== undefined) {
      const probeController = new AbortController()
      try {
        const probe = await downloadChunk(
          MODEL_FILE,
          file,
          firstMissing,
          probeController.signal,
        )
        await writeChunk(fileKey, firstMissing, probe)
        summary.cachedBytes += probe.byteLength
      } catch {
        return fetchPagesFallback(request, file, summary.cachedBytes)
      }
    }
  }

  const abortController = new AbortController()
  const stream = new ReadableStream({
    start(controller) {
      void runWithDownloadLock(`voice-model:${fileKey}`, () =>
        streamModelChunks(
          controller,
          MODEL_FILE,
          file,
          fileKey,
          abortController.signal,
          summary.cachedBytes,
        ),
      ).catch((error) => controller.error(error))
    },
    cancel() {
      abortController.abort()
    },
  })
  const cacheStatus = summary.cachedBytes >= file.size ? 'hit' : 'resume'
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(file.size),
      'Accept-Ranges': 'bytes',
      'X-Voice-Runtime-Source': cacheStatus === 'hit' ? 'local-resume' : 'cdn',
      'X-Voice-Runtime-Cache': cacheStatus,
      'X-Voice-Runtime-Resume-Bytes': String(summary.cachedBytes),
      'X-Voice-Runtime-Total-Bytes': String(file.size),
      'X-Voice-Runtime-Version': manifest.version,
      'X-Voice-Runtime-Sha256': file.sha256,
    },
  })
}

/** 为普通运行时文件标记来源并规范化可缓存响应头。 */
function markRuntimeResponse(response, source, cacheStatus) {
  const headers = new Headers(response.headers)
  headers.delete('vary')
  headers.set('X-Voice-Runtime-Source', source)
  headers.set('X-Voice-Runtime-Cache', cacheStatus)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/** 判断普通运行时响应是否具有与文件扩展名匹配的可执行 MIME 类型。 */
function isValidRuntimeResponse(request, response) {
  if (!response.ok || response.status !== 200) return false
  const pathname = new URL(request.url).pathname
  const contentType = response.headers.get('content-type')?.toLowerCase() || ''
  if (pathname.endsWith('.wasm'))
    return contentType.includes('application/wasm')
  if (pathname.endsWith('.json'))
    return contentType.includes('application/json')
  if (pathname.endsWith('.js')) {
    return (
      contentType.includes('javascript') ||
      contentType.includes('application/ecmascript')
    )
  }
  return !contentType.includes('text/html')
}

/** 广播损坏的运行时缓存或网络响应，便于页面和 Console 定位真实来源。 */
function reportInvalidRuntimeResponse(request, response, source) {
  const fileName = new URL(request.url).pathname.split('/').pop()
  void broadcast({
    type: 'voice-runtime-cache',
    status: 'failed',
    fileName,
    message: `${source} 返回了无效的运行时响应：HTTP ${response.status}，Content-Type ${response.headers.get('content-type') || '未知'}。`,
  })
}

/** 对 Worker、JS 和 WASM 使用整文件 Cache Storage 缓存，并返回独立缓存任务。 */
async function handleRegularRuntimeRequest(request) {
  const cache = await caches.open(CACHE_NAME)
  const cached = await cache.match(request)
  if (cached) {
    if (isValidRuntimeResponse(request, cached)) {
      return {
        response: markRuntimeResponse(cached, 'local-cache', 'hit'),
        cacheTask: Promise.resolve(),
      }
    }
    reportInvalidRuntimeResponse(request, cached, '本地缓存')
    await cache.delete(request)
  }
  const response = markRuntimeResponse(await fetch(request), 'pages', 'miss')
  if (!isValidRuntimeResponse(request, response)) {
    reportInvalidRuntimeResponse(request, response, '当前站点')
    return { response, cacheTask: Promise.resolve() }
  }
  const cacheTask = cache.put(request, response.clone()).catch((error) =>
    broadcast({
      type: 'voice-runtime-cache',
      status: 'failed',
      fileName: new URL(request.url).pathname.split('/').pop(),
      message: error instanceof Error ? error.message : String(error),
    }),
  )
  return { response, cacheTask }
}

/** 处理页面发来的缓存清理请求，并通过 MessagePort 返回结果。 */
self.addEventListener('message', (event) => {
  if (event.data?.type === 'activate-voice-runtime-now') {
    event.waitUntil(self.skipWaiting())
    return
  }
  if (event.data?.type === 'claim-voice-runtime-clients') {
    event.waitUntil(
      self.clients
        .claim()
        .then(() => event.ports[0]?.postMessage({ ok: true })),
    )
    return
  }
  if (event.data?.type === 'get-voice-runtime-cache-info') {
    event.waitUntil(
      Promise.all([loadRuntimeManifest(), readTotalChunkBytes()])
        .then(([manifest, cachedBytes]) =>
          event.ports[0]?.postMessage({
            ok: true,
            cachedBytes,
            totalBytes: manifest.files[MODEL_FILE]?.size || 0,
          }),
        )
        .catch((error) =>
          event.ports[0]?.postMessage({
            ok: false,
            cachedBytes: 0,
            totalBytes: 0,
            message: error instanceof Error ? error.message : String(error),
          }),
        ),
    )
    return
  }
  if (event.data?.type !== 'clear-voice-runtime-cache') return
  event.waitUntil(
    Promise.all([caches.delete(CACHE_NAME), clearChunkDatabase()])
      .then(() => event.ports[0]?.postMessage({ ok: true }))
      .catch((error) =>
        event.ports[0]?.postMessage({
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        }),
      ),
  )
})

/** 拦截语音运行时请求，并为大模型启用分片续传。 */
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (!url.pathname.includes('/voice-runtime/')) return
  const fileName = url.pathname.split('/').pop()
  if (fileName === MODEL_FILE && !event.request.headers.has('range')) {
    event.respondWith(createResumableModelResponse(event.request))
    return
  }
  const runtimeTask = handleRegularRuntimeRequest(event.request)
  event.respondWith(runtimeTask.then((result) => result.response))
  event.waitUntil(runtimeTask.then((result) => result.cacheTask))
})
