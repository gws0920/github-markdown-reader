import { afterEach, describe, expect, it, vi } from 'vitest'
import { KokoroSpeechEngine, parseKokoroProgress } from './KokoroSpeechEngine'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseKokoroProgress', () => {
  it('解析 Emscripten 模型下载进度', () => {
    expect(
      parseKokoroProgress('Downloading data... (52428800/104857600)'),
    ).toEqual({
      phase: 'downloading-model',
      percent: 50,
      downloadedBytes: 52428800,
      totalBytes: 104857600,
      label: '正在下载语音模型。',
    })
  })

  it('压缩传输分母偏小时仍使用模型真实大小且不超过百分之百', () => {
    expect(
      parseKokoroProgress(
        'Downloading data... (173748224/147010355)',
        215321623,
      ),
    ).toEqual({
      phase: 'downloading-model',
      percent: (173748224 / 215321623) * 100,
      downloadedBytes: 173748224,
      totalBytes: 215321623,
      label: '正在下载语音模型。',
    })
  })

  it('异常累计值超过模型大小时限制为百分之百', () => {
    expect(
      parseKokoroProgress(
        'Downloading data... (300000000/147010355)',
        215321623,
      ),
    ).toEqual({
      phase: 'loading-model',
      percent: 100,
      downloadedBytes: 215321623,
      totalBytes: 215321623,
      label: '下载完成，正在载入语音模型。',
    })
  })

  it('保留非下载阶段的初始化状态', () => {
    expect(parseKokoroProgress('Running...')).toEqual({
      phase: 'starting-runtime',
      percent: 0,
      downloadedBytes: 0,
      totalBytes: 0,
      label: 'Running...',
    })
  })
})

describe('KokoroSpeechEngine activation', () => {
  it('在异步模型加载前同步创建并恢复音频上下文', () => {
    const resume = vi.fn().mockResolvedValue(undefined)
    const AudioContextMock = vi.fn(function AudioContextMock() {
      return { state: 'suspended', resume }
    })
    vi.stubGlobal('AudioContext', AudioContextMock)

    const engine = new KokoroSpeechEngine()
    engine.activate()
    engine.activate()

    expect(AudioContextMock).toHaveBeenCalledTimes(1)
    expect(resume).toHaveBeenCalledTimes(2)
  })

  it('首句生成超过一分钟时终止 Worker 并返回明确错误', async () => {
    vi.useFakeTimers()
    const terminate = vi.fn()
    const onError = vi.fn()
    const engine = new KokoroSpeechEngine()
    const internals = engine as unknown as {
      initializePromise: Promise<void>
      progressListener: (progress: unknown) => void
      prepared: Map<string, Promise<never>>
      worker: { terminate: () => void }
    }
    internals.initializePromise = Promise.resolve()
    internals.progressListener = vi.fn()
    internals.worker = { terminate }
    internals.prepared.set('1:测试句子。', new Promise(() => undefined))

    const speaking = engine.speak({
      text: '测试句子。',
      rate: 1,
      onStart: vi.fn(),
      onEnd: vi.fn(),
      onError,
    })
    await vi.advanceTimersByTimeAsync(60_000)
    await speaking

    expect(terminate).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('生成超过 60 秒'),
      }),
    )
    vi.useRealTimers()
  })
})
