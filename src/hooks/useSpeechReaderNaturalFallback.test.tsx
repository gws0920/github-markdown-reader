import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Chapter } from '../types'

vi.mock('../speech/KokoroSpeechEngine', () => ({
  KokoroSpeechEngine: class MockKokoroSpeechEngine {
    readonly kind = 'kokoro' as const
    readonly label = '本地自然女声'

    /** 测试替身无需执行用户手势激活。 */
    activate(): void {}

    /** 模拟模型已经初始化完成。 */
    async initialize(): Promise<void> {}

    /** 模拟首句神经语音生成失败。 */
    async speak(request: { onError: (error: Error) => void }): Promise<void> {
      request.onError(new Error('mock generation failed'))
    }

    /** 测试替身无需预生成。 */
    prepare(): void {}

    /** 测试替身无需暂停。 */
    pause(): void {}

    /** 测试替身无需恢复。 */
    resume(): void {}

    /** 测试替身无需停止。 */
    stop(): void {}

    /** 测试替身无需销毁资源。 */
    destroy(): void {}

    /** 测试替身返回空缓存清理结果。 */
    static async clearCache(): Promise<boolean> {
      return true
    }

    /** 测试替身返回空缓存信息。 */
    static async getCacheInfo(): Promise<{
      ok: boolean
      cachedBytes: number
      totalBytes: number
    }> {
      return { ok: true, cachedBytes: 0, totalBytes: 0 }
    }
  },
}))

import { useSpeechReader } from './useSpeechReader'

class MockUtterance {
  lang = ''
  rate = 1
  voice: SpeechSynthesisVoice | null = null
  onstart: (() => void) | null = null
  onend: (() => void) | null = null
  onerror: ((event: SpeechSynthesisErrorEvent) => void) | null = null

  /** 保存系统语音测试文本。 */
  constructor(readonly text: string) {}
}

const speak = vi.fn((utterance: MockUtterance) => utterance.onstart?.())
const chapter: Chapter = {
  id: 'chapter',
  title: '章节',
  path: 'chapter.md',
  sourceUrl: 'https://example.com/chapter.md',
  sections: [],
  blocks: [],
  sentences: [
    {
      id: 'sentence',
      domId: 'sentence',
      chapterId: 'chapter',
      blockId: 'block',
      text: '需要自动回退的句子。',
      order: 0,
    },
  ],
}

describe('useSpeechReader natural voice recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    Object.defineProperty(globalThis, 'Worker', {
      configurable: true,
      value: class WorkerMock {},
    })
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        speak,
        cancel: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
        getVoices: vi.fn(() => []),
      },
    })
    Object.defineProperty(window, 'SpeechSynthesisUtterance', {
      configurable: true,
      value: MockUtterance,
    })
    Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', {
      configurable: true,
      value: MockUtterance,
    })
  })

  it('首句神经语音失败后自动使用系统语音重播当前位置', async () => {
    const { result } = renderHook(() =>
      useSpeechReader({ chapters: [chapter] }),
    )

    act(() => result.current.selectEngine('kokoro'))
    act(() => result.current.play())

    await waitFor(() => expect(speak).toHaveBeenCalledOnce())
    expect(result.current.engineKind).toBe('browser')
    expect(result.current.status).toBe('playing')
    expect(result.current.fallbackReason).toContain('mock generation failed')
    expect(result.current.diagnostic).toContain('mock generation failed')
  })

  it('默认使用系统语音且无需初始化本地模型', async () => {
    const { result } = renderHook(() =>
      useSpeechReader({ chapters: [chapter] }),
    )

    expect(result.current.engineKind).toBe('browser')
    expect(result.current.engineLabel).toBe('系统语音')
    act(() => result.current.play())

    await waitFor(() => expect(speak).toHaveBeenCalledOnce())
    expect(result.current.status).toBe('playing')
  })
})
