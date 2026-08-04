import {
  requestVoiceCache,
  waitForVoiceCacheControl,
} from '../lib/voiceServiceWorker'
import type {
  SpeechEngine,
  SpeechProgress,
  SpeechProgressPhase,
  SpeechRequest,
} from './types'

interface GeneratedAudio {
  samples: Float32Array
  sampleRate: number
}

interface GenerationTask {
  text: string
  rate: number
  resolve: (audio: GeneratedAudio) => void
  reject: (error: Error) => void
}

type WorkerMessage =
  | { type: 'sherpa-onnx-tts-progress'; status: string }
  | { type: 'sherpa-onnx-tts-phase'; phase: SpeechProgressPhase }
  | { type: 'sherpa-onnx-tts-ready'; numSpeakers: number }
  | {
      type: 'sherpa-onnx-tts-result'
      samples: Float32Array
      sampleRate: number
    }
  | { type: 'error'; message: string }

interface ServiceWorkerRuntimeMessage {
  type: 'voice-runtime-progress' | 'voice-runtime-cache'
  phase?: SpeechProgressPhase
  source?: SpeechProgress['source']
  fileName: string
  status?: 'stored' | 'failed'
  message?: string
  downloadedBytes?: number
  cachedBytes?: number
  totalBytes?: number
  chunkIndex?: number
  chunkCount?: number
}

interface VoiceCacheResponse {
  ok: boolean
  cachedBytes?: number
  totalBytes?: number
  message?: string
}

const CACHE_NAME = 'github-markdown-reader-voice-runtime-v9'
const INITIALIZATION_TIMEOUT_MS = 5 * 60 * 1000
const GENERATION_TIMEOUT_MS = 60 * 1000

/** 根据初始化阶段生成清晰的用户提示文案。 */
function getPhaseLabel(phase: SpeechProgressPhase): string {
  const labels: Record<SpeechProgressPhase, string> = {
    'checking-cache': '正在检查本地语音缓存。',
    'downloading-model': '正在下载本地自然语音模型。',
    'loading-model': '下载完成，正在载入语音模型。',
    'starting-runtime': '正在启动 WebAssembly 语音运行时。',
    'initializing-tts': '正在初始化中文词典、声线与推理引擎。',
    'generating-audio': '语音模型已就绪，正在生成当前句音频。',
  }
  return labels[phase]
}

/** 将 Emscripten 下载状态解析为播放器可展示的进度。 */
export function parseKokoroProgress(
  status: string,
  actualTotalBytes = 0,
): SpeechProgress {
  const match = status.match(/Downloading data\.\.\. \((\d+)\/(\d+)\)/)
  if (!match) {
    return {
      phase: 'starting-runtime',
      percent: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      label: status || getPhaseLabel('starting-runtime'),
    }
  }
  const downloadedBytes = Number(match[1])
  const reportedTotalBytes = Number(match[2])
  const totalBytes = Math.max(reportedTotalBytes, actualTotalBytes)
  const visibleDownloadedBytes = Math.min(downloadedBytes, totalBytes)
  const percent =
    totalBytes > 0
      ? Math.min(100, (visibleDownloadedBytes / totalBytes) * 100)
      : 0
  return {
    phase: percent >= 100 ? 'loading-model' : 'downloading-model',
    percent,
    downloadedBytes: visibleDownloadedBytes,
    totalBytes,
    label:
      percent >= 100 ? getPhaseLabel('loading-model') : '正在下载语音模型。',
  }
}

/** 使用 sherpa-onnx WebAssembly 与 Kokoro 模型生成并播放本地中文语音。 */
export class KokoroSpeechEngine implements SpeechEngine {
  readonly kind = 'kokoro' as const
  readonly label = '本地自然女声'
  private worker: Worker | null = null
  private audioContext: AudioContext | null = null
  private source: AudioBufferSourceNode | null = null
  private initializePromise: Promise<void> | null = null
  private initializeResolve: (() => void) | null = null
  private initializeReject: ((error: Error) => void) | null = null
  private progressListener: ((progress: SpeechProgress) => void) | null = null
  private activeTask: GenerationTask | null = null
  private queue: GenerationTask[] = []
  private prepared = new Map<string, Promise<GeneratedAudio>>()
  private playbackToken = 0
  private runtimeTotalBytes = 0
  private initializationTimer: number | null = null

  /** 注册 Service Worker 资源消息，动态获取当前模型文件的真实大小。 */
  constructor() {
    navigator.serviceWorker?.addEventListener(
      'message',
      this.handleServiceWorkerMessage,
    )
  }

  /** 在用户点击播放的同步阶段创建并唤醒音频上下文，避免异步下载后被自动播放策略拦截。 */
  activate(): void {
    if (typeof AudioContext === 'undefined') return
    void navigator.storage?.persist?.()
    this.audioContext ??= new AudioContext()
    if (this.audioContext.state === 'suspended') {
      void this.audioContext.resume()
    }
  }

  /** 创建模型 Worker 并等待运行时及模型初始化完成。 */
  async initialize(
    onProgress?: (progress: SpeechProgress) => void,
  ): Promise<void> {
    if (this.initializePromise) return this.initializePromise
    this.progressListener = onProgress ?? null
    this.initializePromise = (async () => {
      this.emitPhase('checking-cache')
      await waitForVoiceCacheControl()
      return new Promise<void>((resolve, reject) => {
        this.initializeResolve = resolve
        this.initializeReject = reject
        const workerUrl = `${import.meta.env.BASE_URL}voice-runtime/sherpa-onnx-tts.worker.js`
        this.worker = new Worker(workerUrl, { type: 'module' })
        this.worker.addEventListener(
          'message',
          (event: MessageEvent<WorkerMessage>) => {
            this.handleWorkerMessage(event.data)
          },
        )
        this.worker.addEventListener('error', (event) => {
          this.failInitialization(
            new Error(
              `本地语音运行时加载失败：${event.message || 'Worker 脚本异常'}（${event.filename || workerUrl}:${event.lineno || 0}）`,
            ),
          )
        })
        this.worker.addEventListener('messageerror', () => {
          this.failInitialization(
            new Error('本地语音 Worker 返回了无法解析的消息。'),
          )
        })
      })
    })().catch((error) => {
      this.initializePromise = null
      throw error
    })
    return this.initializePromise
  }

  /** 生成并播放单句音频，高亮仅在真实音频开始时触发。 */
  async speak(request: SpeechRequest): Promise<void> {
    await this.initialize(this.progressListener ?? undefined)
    this.stopAudioOnly()
    const token = ++this.playbackToken
    try {
      this.emitPhase('generating-audio')
      const audio = await this.waitForGeneratedAudio(
        this.getPreparedOrGenerate(request.text, request.rate),
      )
      if (token !== this.playbackToken) return
      const context =
        this.audioContext ?? new AudioContext({ sampleRate: audio.sampleRate })
      this.audioContext = context
      if (context.state === 'suspended') await context.resume()
      const buffer = context.createBuffer(
        1,
        audio.samples.length,
        audio.sampleRate,
      )
      buffer.getChannelData(0).set(audio.samples)
      const source = context.createBufferSource()
      source.buffer = buffer
      source.connect(context.destination)
      source.onended = () => {
        if (token !== this.playbackToken) return
        this.source = null
        request.onEnd()
      }
      this.source = source
      request.onStart()
      source.start()
    } catch (error) {
      if (token !== this.playbackToken) return
      request.onError(
        error instanceof Error ? error : new Error('本地语音生成失败。'),
      )
    }
  }

  /** 在当前句播放期间预生成下一句，降低连续朗读停顿。 */
  prepare(text: string, rate: number): void {
    if (
      !this.worker ||
      !text ||
      this.prepared.has(this.createCacheKey(text, rate))
    )
      return
    const key = this.createCacheKey(text, rate)
    const promise = this.generate(text, rate).catch((error) => {
      this.prepared.delete(key)
      throw error
    })
    this.prepared.set(key, promise)
  }

  /** 暂停 AudioContext，从当前音频位置保留播放状态。 */
  pause(): void {
    void this.audioContext?.suspend()
  }

  /** 恢复被暂停的 AudioContext。 */
  resume(): void {
    void this.audioContext?.resume()
  }

  /** 取消当前播放并让尚未返回的生成结果失效。 */
  stop(): void {
    this.playbackToken += 1
    this.stopAudioOnly()
  }

  /** 终止 Worker、音频上下文和全部等待任务。 */
  destroy(): void {
    this.stop()
    this.worker?.terminate()
    this.worker = null
    void this.audioContext?.close()
    this.audioContext = null
    const error = new Error('本地语音引擎已关闭。')
    this.activeTask?.reject(error)
    this.queue.forEach((task) => task.reject(error))
    this.activeTask = null
    this.queue = []
    this.prepared.clear()
    this.clearInitializationTimer()
    navigator.serviceWorker?.removeEventListener(
      'message',
      this.handleServiceWorkerMessage,
    )
  }

  /** 删除浏览器中缓存的 Kokoro 模型与运行时文件。 */
  static async clearCache(): Promise<boolean> {
    const response = await requestVoiceCache<VoiceCacheResponse>(
      {
        type: 'clear-voice-runtime-cache',
      },
      60000,
    )
    return response.ok
  }

  /** 读取已经保存的模型分片大小，用于缓存清理确认。 */
  static async getCacheInfo(): Promise<{
    ok: boolean
    cachedBytes: number
    totalBytes: number
    message?: string
  }> {
    const response = await requestVoiceCache<VoiceCacheResponse>(
      {
        type: 'get-voice-runtime-cache-info',
      },
      30000,
    )
    return {
      ...response,
      cachedBytes: response.cachedBytes ?? 0,
      totalBytes: response.totalBytes ?? 0,
    }
  }

  /** 处理 Worker 初始化、生成结果和错误消息。 */
  private handleWorkerMessage(message: WorkerMessage): void {
    if (message.type === 'sherpa-onnx-tts-progress') {
      const progress = parseKokoroProgress(
        message.status,
        this.runtimeTotalBytes,
      )
      this.progressListener?.(progress)
      if (progress.phase === 'loading-model') this.startInitializationTimer()
      return
    }
    if (message.type === 'sherpa-onnx-tts-phase') {
      this.emitPhase(message.phase)
      if (
        message.phase === 'loading-model' ||
        message.phase === 'initializing-tts'
      ) {
        this.startInitializationTimer()
      }
      return
    }
    if (message.type === 'sherpa-onnx-tts-ready') {
      this.clearInitializationTimer()
      this.initializeResolve?.()
      this.initializeResolve = null
      this.initializeReject = null
      return
    }
    if (message.type === 'sherpa-onnx-tts-result') {
      const task = this.activeTask
      this.activeTask = null
      task?.resolve({
        samples: message.samples,
        sampleRate: message.sampleRate,
      })
      this.pumpQueue()
      return
    }
    const error = new Error(message.message || '本地语音运行时出错。')
    console.error('[KokoroSpeechEngine] Worker 返回错误', error)
    if (this.initializeReject) this.failInitialization(error)
    else {
      this.activeTask?.reject(error)
      this.activeTask = null
      this.pumpQueue()
    }
  }

  /** 接收 Service Worker 广播的模型来源与实际 Content-Length。 */
  private handleServiceWorkerMessage = (event: MessageEvent): void => {
    const message = event.data as ServiceWorkerRuntimeMessage
    if (!message?.fileName?.endsWith('.data')) return
    if (message.totalBytes) this.runtimeTotalBytes = message.totalBytes
    if (message.type === 'voice-runtime-cache' && message.status === 'failed') {
      this.progressListener?.({
        phase: 'downloading-model',
        percent: 0,
        downloadedBytes: message.downloadedBytes ?? 0,
        totalBytes: message.totalBytes ?? this.runtimeTotalBytes,
        cachedBytes: message.cachedBytes,
        label: `本次无法保存续传进度：${message.message ?? '缓存写入失败。'}`,
      })
      return
    }
    if (message.type !== 'voice-runtime-progress' || !message.phase) return
    const totalBytes = message.totalBytes ?? this.runtimeTotalBytes
    const downloadedBytes = message.downloadedBytes ?? 0
    const percent =
      totalBytes > 0 ? Math.min(100, (downloadedBytes / totalBytes) * 100) : 0
    this.progressListener?.({
      phase: message.phase,
      percent,
      downloadedBytes,
      totalBytes,
      cachedBytes: message.cachedBytes,
      source: message.source,
      chunkIndex: message.chunkIndex,
      chunkCount: message.chunkCount,
      label:
        message.phase === 'checking-cache' && (message.cachedBytes ?? 0) > 0
          ? `已缓存 ${((message.cachedBytes ?? 0) / 1024 / 1024).toFixed(1)} MB，准备继续下载。`
          : getPhaseLabel(message.phase),
    })
    if (message.phase === 'loading-model') this.startInitializationTimer()
  }

  /** 结束初始化并清理不可用的 Worker。 */
  private failInitialization(error: Error): void {
    this.clearInitializationTimer()
    this.initializeReject?.(error)
    this.initializeResolve = null
    this.initializeReject = null
    this.initializePromise = null
    this.worker?.terminate()
    this.worker = null
  }

  /** 向 UI 发送不带下载字节的初始化阶段。 */
  private emitPhase(phase: SpeechProgressPhase): void {
    const modelReady = phase === 'loading-model' || phase === 'generating-audio'
    this.progressListener?.({
      phase,
      percent: modelReady ? 100 : 0,
      downloadedBytes: modelReady ? this.runtimeTotalBytes : 0,
      totalBytes: this.runtimeTotalBytes,
      label: getPhaseLabel(phase),
    })
  }

  /** 限制首句和后续句子的推理等待时间，超时后终止无法取消的同步 WASM Worker。 */
  private waitForGeneratedAudio(
    audioPromise: Promise<GeneratedAudio>,
  ): Promise<GeneratedAudio> {
    return new Promise((resolve, reject) => {
      const startedAt = performance.now()
      const timer = window.setTimeout(() => {
        const activeText = this.activeTask?.text ?? ''
        console.error('[KokoroSpeechEngine] 单句生成超时', {
          timeoutMs: GENERATION_TIMEOUT_MS,
          elapsedMs: Math.round(performance.now() - startedAt),
          engine: 'sherpa-onnx-wasm-single-thread',
          crossOriginIsolated: window.crossOriginIsolated,
          sharedArrayBufferAvailable:
            typeof globalThis.SharedArrayBuffer !== 'undefined',
          textLength: activeText.length,
          textPreview: activeText.slice(0, 120),
          rate: this.activeTask?.rate,
          queuedTaskCount: this.queue.length,
        })
        this.worker?.terminate()
        this.worker = null
        this.activeTask = null
        reject(
          new Error(
            `本地自然语音生成超过 ${GENERATION_TIMEOUT_MS / 1000} 秒，已终止本次推理。`,
          ),
        )
      }, GENERATION_TIMEOUT_MS)
      audioPromise.then(
        (audio) => {
          window.clearTimeout(timer)
          resolve(audio)
        },
        (error) => {
          window.clearTimeout(timer)
          reject(error)
        },
      )
    })
  }

  /** 从模型载入阶段启动五分钟初始化看门狗。 */
  private startInitializationTimer(): void {
    if (this.initializationTimer !== null) return
    this.initializationTimer = window.setTimeout(() => {
      this.failInitialization(
        new Error('本地自然语音初始化超过 5 分钟，已自动回退。'),
      )
    }, INITIALIZATION_TIMEOUT_MS)
  }

  /** 清除初始化看门狗，避免 ready 或销毁后误触发。 */
  private clearInitializationTimer(): void {
    if (this.initializationTimer === null) return
    window.clearTimeout(this.initializationTimer)
    this.initializationTimer = null
  }

  /** 将文本生成请求加入单任务 Worker 队列。 */
  private generate(text: string, rate: number): Promise<GeneratedAudio> {
    return new Promise((resolve, reject) => {
      this.queue.push({ text, rate, resolve, reject })
      this.pumpQueue()
    })
  }

  /** 向 Worker 发送下一条等待生成的句子。 */
  private pumpQueue(): void {
    if (!this.worker || this.activeTask || this.queue.length === 0) return
    const task = this.queue.shift()
    if (!task) return
    this.activeTask = task
    this.worker.postMessage({
      type: 'generate',
      text: task.text,
      sid: 0,
      speed: task.rate,
    })
  }

  /** 优先消费预生成结果，否则立即生成当前句。 */
  private getPreparedOrGenerate(
    text: string,
    rate: number,
  ): Promise<GeneratedAudio> {
    const key = this.createCacheKey(text, rate)
    const prepared = this.prepared.get(key)
    if (prepared) {
      this.prepared.delete(key)
      return prepared
    }
    return this.generate(text, rate)
  }

  /** 创建区分文本和语速的预生成缓存键。 */
  private createCacheKey(text: string, rate: number): string {
    return `${rate}:${text}`
  }

  /** 停止当前 AudioBufferSourceNode，但保留模型和音频上下文。 */
  private stopAudioOnly(): void {
    if (!this.source) return
    this.source.onended = null
    try {
      this.source.stop()
    } catch {
      // 已结束的音频节点无需再次停止。
    }
    this.source.disconnect()
    this.source = null
  }
}

export { CACHE_NAME }
