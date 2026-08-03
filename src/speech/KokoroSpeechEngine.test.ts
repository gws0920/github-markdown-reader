import { describe, expect, it } from 'vitest'
import { parseKokoroProgress } from './KokoroSpeechEngine'

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
