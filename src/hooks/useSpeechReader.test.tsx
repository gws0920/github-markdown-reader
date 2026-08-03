import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Chapter } from '../types'
import { useSpeechReader } from './useSpeechReader'

class MockUtterance {
  text: string
  lang = ''
  rate = 1
  voice: SpeechSynthesisVoice | null = null
  onstart: (() => void) | null = null
  onend: (() => void) | null = null
  onerror: ((event: SpeechSynthesisErrorEvent) => void) | null = null

  /** 创建测试用语音实例并保存朗读文本。 */
  constructor(text: string) {
    this.text = text
  }
}

const utterances: MockUtterance[] = []
const synthesis = {
  paused: false,
  speak: vi.fn((utterance: MockUtterance) => {
    utterances.push(utterance)
    utterance.onstart?.()
  }),
  cancel: vi.fn(),
  pause: vi.fn(() => {
    synthesis.paused = true
  }),
  resume: vi.fn(() => {
    synthesis.paused = false
  }),
  getVoices: vi.fn(() => []),
}

const chapter: Chapter = {
  id: 'chapter-one',
  title: '第一章',
  path: '01.md',
  sourceUrl: 'https://example.com/01.md',
  sections: [],
  blocks: [],
  sentences: [
    {
      id: 'sentence-0',
      domId: 'sentence-0',
      chapterId: 'chapter-one',
      blockId: 'block-0',
      text: '第一句。',
      order: 0,
    },
    {
      id: 'sentence-1',
      domId: 'sentence-1',
      chapterId: 'chapter-one',
      blockId: 'block-0',
      text: '第二句。',
      order: 1,
    },
  ],
}

describe('useSpeechReader', () => {
  beforeEach(() => {
    utterances.length = 0
    synthesis.paused = false
    vi.clearAllMocks()
    Object.defineProperty(globalThis, 'Worker', {
      value: undefined,
      configurable: true,
    })
    Object.defineProperty(window, 'speechSynthesis', {
      value: synthesis,
      configurable: true,
    })
    Object.defineProperty(window, 'SpeechSynthesisUtterance', {
      value: MockUtterance,
      configurable: true,
    })
    Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', {
      value: MockUtterance,
      configurable: true,
    })
  })

  it('自然语音不可用时回退系统语音，并在结束后推进位置', async () => {
    const { result } = renderHook(() =>
      useSpeechReader({ chapters: [chapter] }),
    )

    act(() => result.current.play())
    await waitFor(() => expect(synthesis.speak).toHaveBeenCalledTimes(1))
    expect(utterances[0].text).toBe('第一句。')
    expect(result.current.sentenceIndex).toBe(0)
    expect(result.current.engineKind).toBe('browser')

    act(() => utterances[0].onend?.())
    await waitFor(() => expect(synthesis.speak).toHaveBeenCalledTimes(2))
    expect(result.current.sentenceIndex).toBe(1)
    expect(utterances[1].text).toBe('第二句。')
  })

  it('暂停时保留当前句并可恢复', async () => {
    const { result } = renderHook(() =>
      useSpeechReader({ chapters: [chapter] }),
    )
    act(() => result.current.play())
    await waitFor(() => expect(result.current.status).toBe('playing'))

    act(() => result.current.pause())
    expect(result.current.status).toBe('paused')
    expect(result.current.sentenceIndex).toBe(0)

    act(() => result.current.play())
    expect(synthesis.resume).toHaveBeenCalledOnce()
    expect(result.current.status).toBe('playing')
  })
})
