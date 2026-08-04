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

  it('压缩传输分母偏小时仍使用模型真实大小且不超过百分之百', () => {
    expect(
      parseKokoroProgress(
        'Downloading data... (173748224/147010355)',
        215321623,
      ),
    ).toEqual({
      percent: (173748224 / 215321623) * 100,
      downloadedBytes: 173748224,
      totalBytes: 215321623,
      label: 'Downloading data... (173748224/147010355)',
    })
  })

  it('异常累计值超过模型大小时限制为百分之百', () => {
    expect(
      parseKokoroProgress(
        'Downloading data... (300000000/147010355)',
        215321623,
      ),
    ).toEqual({
      percent: 100,
      downloadedBytes: 215321623,
      totalBytes: 215321623,
      label: 'Downloading data... (300000000/147010355)',
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
