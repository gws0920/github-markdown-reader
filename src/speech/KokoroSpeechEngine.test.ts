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
      percent: 50,
      downloadedBytes: 52428800,
      totalBytes: 104857600,
      label: 'Downloading data... (52428800/104857600)',
    })
  })

  it('保留非下载阶段的初始化状态', () => {
    expect(parseKokoroProgress('Running...')).toEqual({
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
})
