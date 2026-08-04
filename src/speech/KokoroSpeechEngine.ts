import type { SpeechEngine, SpeechProgress, SpeechRequest } from './types'

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
  | { type: 'sherpa-onnx-tts-ready'; numSpeakers: number }
  | {
      type: 'sherpa-onnx-tts-result'
      samples: Float32Array
      sampleRate: number
    }
  | { type: 'error'; message: string }

const CACHE_NAME = 'github-markdown-reader-kokoro-v7'
const KOKORO_DATA_BYTES = 215321623

/** 将 Emscripten 下载状态解析为播放器可展示的进度。 */
export function parseKokoroProgress(status: string): SpeechProgress {
  const match = status.match(/Downloading data\.\.\. \((\d+)\/(\d+)\)/)
  if (!match) {
    return { percent: 0, downloadedBytes: 0, totalBytes: 0, label: status }
  }
  const downloadedBytes = Number(match[1])
  const reportedTotalBytes = Number(match[2])
  const totalBytes = Math.max(reportedTotalBytes, KOKORO_DATA_BYTES)
  const visibleDownloadedBytes = Math.min(downloadedBytes, totalBytes)
  return {
    percent:
      totalBytes > 0
        ? Math.min(100, (visibleDownloadedBytes / totalBytes) * 100)
        : 0,
    downloadedBytes: visibleDownloadedBytes,
    totalBytes,
    label: status,
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

  /** 在用户点击播放的同步阶段创建并唤醒音频上下文，避免异步下载后被自动播放策略拦截。 */
  activate(): void {
    if (typeof AudioContext === 'undefined') return
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
    this.initializePromise = new Promise<void>((resolve, reject) => {
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
      this.worker.addEventListener('error', () => {
        this.failInitialization(new Error('本地语音运行时加载失败。'))
      })
    })
    return this.initializePromise
  }

  /** 生成并播放单句音频，高亮仅在真实音频开始时触发。 */
  async speak(request: SpeechRequest): Promise<void> {
    await this.initialize(this.progressListener ?? undefined)
    this.stopAudioOnly()
    const token = ++this.playbackToken
    try {
      const audio = await this.getPreparedOrGenerate(request.text, request.rate)
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
  }

  /** 删除浏览器中缓存的 Kokoro 模型与运行时文件。 */
  static async clearCache(): Promise<boolean> {
    if (!('caches' in window)) return false
    return window.caches.delete(CACHE_NAME)
  }

  /** 处理 Worker 初始化、生成结果和错误消息。 */
  private handleWorkerMessage(message: WorkerMessage): void {
    if (message.type === 'sherpa-onnx-tts-progress') {
      this.progressListener?.(parseKokoroProgress(message.status))
      return
    }
    if (message.type === 'sherpa-onnx-tts-ready') {
      this.progressListener = null
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
    if (this.initializeReject) this.failInitialization(error)
    else {
      this.activeTask?.reject(error)
      this.activeTask = null
      this.pumpQueue()
    }
  }

  /** 结束初始化并清理不可用的 Worker。 */
  private failInitialization(error: Error): void {
    this.initializeReject?.(error)
    this.initializeResolve = null
    this.initializeReject = null
    this.initializePromise = null
    this.worker?.terminate()
    this.worker = null
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
      sid: 3,
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
