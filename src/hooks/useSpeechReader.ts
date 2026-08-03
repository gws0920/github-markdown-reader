import { useCallback, useEffect, useRef, useState } from 'react'
import type { Chapter, PlaybackStatus } from '../types'

interface SpeechReaderOptions {
  chapters: Chapter[]
  initialChapterIndex?: number
  initialSentenceIndex?: number
  initialRate?: number
  initialVoiceURI?: string
  initialContinuous?: boolean
  onPositionChange?: (chapterIndex: number, sentenceIndex: number) => void
}

interface SpeechReaderResult {
  supported: boolean
  status: PlaybackStatus
  error: string
  voices: SpeechSynthesisVoice[]
  chapterIndex: number
  sentenceIndex: number
  rate: number
  voiceURI: string
  continuous: boolean
  play: () => void
  pause: () => void
  stop: () => void
  retry: () => void
  previousSentence: () => void
  nextSentence: () => void
  previousChapter: () => void
  nextChapter: () => void
  selectChapter: (index: number, sentenceIndex?: number) => void
  setRate: (rate: number) => void
  setVoiceURI: (voiceURI: string) => void
  setContinuous: (continuous: boolean) => void
}

/** 提供严格逐句的浏览器朗读状态机，并保证任意时刻只存在一个活动语音实例。 */
export function useSpeechReader({
  chapters,
  initialChapterIndex = 0,
  initialSentenceIndex = 0,
  initialRate = 1,
  initialVoiceURI = '',
  initialContinuous = true,
  onPositionChange,
}: SpeechReaderOptions): SpeechReaderResult {
  const supported =
    typeof window !== 'undefined' &&
    'speechSynthesis' in window &&
    'SpeechSynthesisUtterance' in window
  const [status, setStatus] = useState<PlaybackStatus>('idle')
  const [error, setError] = useState('')
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])
  const [chapterIndex, setChapterIndex] = useState(initialChapterIndex)
  const [sentenceIndex, setSentenceIndex] = useState(initialSentenceIndex)
  const [rate, updateRate] = useState(initialRate)
  const [voiceURI, updateVoiceURI] = useState(initialVoiceURI)
  const [continuous, updateContinuous] = useState(initialContinuous)
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null)
  const statusRef = useRef<PlaybackStatus>('idle')
  const chapterIndexRef = useRef(initialChapterIndex)
  const sentenceIndexRef = useRef(initialSentenceIndex)
  const rateRef = useRef(initialRate)
  const voiceURIRef = useRef(initialVoiceURI)
  const continuousRef = useRef(initialContinuous)
  const chaptersRef = useRef(chapters)
  const speakCurrentRef = useRef<() => void>(() => undefined)

  /** 同步 React 状态与事件回调读取的播放状态引用。 */
  const updateStatus = useCallback((nextStatus: PlaybackStatus) => {
    statusRef.current = nextStatus
    setStatus(nextStatus)
  }, [])

  /** 更新当前朗读位置，并向外部持久化层报告变更。 */
  const updatePosition = useCallback(
    (nextChapterIndex: number, nextSentenceIndex: number) => {
      chapterIndexRef.current = nextChapterIndex
      sentenceIndexRef.current = nextSentenceIndex
      setChapterIndex(nextChapterIndex)
      setSentenceIndex(nextSentenceIndex)
      onPositionChange?.(nextChapterIndex, nextSentenceIndex)
    },
    [onPositionChange],
  )

  /** 取消浏览器当前语音，并清除本地语音实例引用。 */
  const cancelSpeech = useCallback(() => {
    if (!supported) return
    window.speechSynthesis.cancel()
    utteranceRef.current = null
  }, [supported])

  /** 推进到下一句或下一章，并返回是否成功移动。 */
  const advancePosition = useCallback((): boolean => {
    const currentChapter = chaptersRef.current[chapterIndexRef.current]
    if (!currentChapter) return false

    if (sentenceIndexRef.current + 1 < currentChapter.sentences.length) {
      updatePosition(chapterIndexRef.current, sentenceIndexRef.current + 1)
      return true
    }

    if (
      continuousRef.current &&
      chapterIndexRef.current + 1 < chaptersRef.current.length
    ) {
      updatePosition(chapterIndexRef.current + 1, 0)
      return true
    }
    return false
  }, [updatePosition])

  /** 创建并播放当前位置的单句语音，结束后按连续播放规则推进。 */
  const speakCurrent = useCallback(() => {
    if (!supported) {
      setError('当前浏览器不支持系统语音朗读。')
      updateStatus('error')
      return
    }

    const chapter = chaptersRef.current[chapterIndexRef.current]
    const sentence = chapter?.sentences[sentenceIndexRef.current]
    if (!sentence) {
      updateStatus('idle')
      return
    }

    cancelSpeech()
    setError('')
    const utterance = new SpeechSynthesisUtterance(sentence.text)
    utterance.lang = 'zh-CN'
    utterance.rate = rateRef.current
    const selectedVoice = voices.find(
      (voice) => voice.voiceURI === voiceURIRef.current,
    )
    if (selectedVoice) utterance.voice = selectedVoice

    utterance.onstart = () => updateStatus('playing')
    utterance.onend = () => {
      utteranceRef.current = null
      if (statusRef.current !== 'playing') return
      if (advancePosition()) {
        window.setTimeout(() => speakCurrentRef.current(), 40)
      } else {
        updateStatus('idle')
      }
    }
    utterance.onerror = (event) => {
      utteranceRef.current = null
      if (event.error === 'canceled' || event.error === 'interrupted') return
      setError('语音播放意外中断，请重试当前句。')
      updateStatus('error')
    }

    utteranceRef.current = utterance
    window.speechSynthesis.speak(utterance)
  }, [advancePosition, cancelSpeech, supported, updateStatus, voices])

  speakCurrentRef.current = speakCurrent

  /** 开始新语音或恢复浏览器暂停的当前语音。 */
  const play = useCallback(() => {
    if (!supported) {
      setError('当前浏览器不支持系统语音朗读。')
      updateStatus('error')
      return
    }
    if (statusRef.current === 'paused' && window.speechSynthesis.paused) {
      window.speechSynthesis.resume()
      updateStatus('playing')
      return
    }
    speakCurrentRef.current()
  }, [supported, updateStatus])

  /** 暂停当前语音并保留当前位置和高亮。 */
  const pause = useCallback(() => {
    if (!supported || statusRef.current !== 'playing') return
    window.speechSynthesis.pause()
    updateStatus('paused')
  }, [supported, updateStatus])

  /** 停止当前语音并保留当前句，供用户稍后重新播放。 */
  const stop = useCallback(() => {
    cancelSpeech()
    updateStatus('idle')
  }, [cancelSpeech, updateStatus])

  /** 重新播放发生错误的当前句。 */
  const retry = useCallback(() => {
    setError('')
    speakCurrentRef.current()
  }, [])

  /** 跳转到指定位置，并按需延续原有播放状态。 */
  const moveTo = useCallback(
    (
      nextChapterIndex: number,
      nextSentenceIndex: number,
      keepPlaying = true,
    ) => {
      const wasPlaying = statusRef.current === 'playing'
      cancelSpeech()
      updatePosition(nextChapterIndex, nextSentenceIndex)
      updateStatus('idle')
      if (wasPlaying && keepPlaying) {
        window.setTimeout(() => speakCurrentRef.current(), 40)
      }
    },
    [cancelSpeech, updatePosition, updateStatus],
  )

  /** 跳转到上一句，位于章首时进入上一章末句。 */
  const previousSentence = useCallback(() => {
    if (sentenceIndexRef.current > 0) {
      moveTo(chapterIndexRef.current, sentenceIndexRef.current - 1)
      return
    }
    if (chapterIndexRef.current > 0) {
      const previous = chaptersRef.current[chapterIndexRef.current - 1]
      moveTo(
        chapterIndexRef.current - 1,
        Math.max(0, previous.sentences.length - 1),
      )
    }
  }, [moveTo])

  /** 跳转到下一句，位于章末时进入下一章首句。 */
  const nextSentence = useCallback(() => {
    const chapter = chaptersRef.current[chapterIndexRef.current]
    if (!chapter) return
    if (sentenceIndexRef.current + 1 < chapter.sentences.length) {
      moveTo(chapterIndexRef.current, sentenceIndexRef.current + 1)
      return
    }
    if (chapterIndexRef.current + 1 < chaptersRef.current.length) {
      moveTo(chapterIndexRef.current + 1, 0)
    }
  }, [moveTo])

  /** 跳转到上一章第一句。 */
  const previousChapter = useCallback(() => {
    if (chapterIndexRef.current > 0) moveTo(chapterIndexRef.current - 1, 0)
  }, [moveTo])

  /** 跳转到下一章第一句。 */
  const nextChapter = useCallback(() => {
    if (chapterIndexRef.current + 1 < chaptersRef.current.length) {
      moveTo(chapterIndexRef.current + 1, 0)
    }
  }, [moveTo])

  /** 选择章节或章节内小节，并停止当前语音后更新位置。 */
  const selectChapter = useCallback(
    (index: number, nextSentenceIndex = 0) =>
      moveTo(index, nextSentenceIndex, false),
    [moveTo],
  )

  /** 更新朗读倍速，播放中会从当前句按新倍速重新开始。 */
  const setRate = useCallback((nextRate: number) => {
    rateRef.current = nextRate
    updateRate(nextRate)
    if (statusRef.current === 'playing') speakCurrentRef.current()
  }, [])

  /** 更新系统语音，播放中会从当前句使用新声音重新开始。 */
  const setVoiceURI = useCallback((nextVoiceURI: string) => {
    voiceURIRef.current = nextVoiceURI
    updateVoiceURI(nextVoiceURI)
    if (statusRef.current === 'playing') speakCurrentRef.current()
  }, [])

  /** 更新章节结束后的连续播放偏好。 */
  const setContinuous = useCallback((nextContinuous: boolean) => {
    continuousRef.current = nextContinuous
    updateContinuous(nextContinuous)
  }, [])

  useEffect(() => {
    chaptersRef.current = chapters
  }, [chapters])

  useEffect(() => {
    if (!supported) return undefined

    /** 读取系统语音列表，并优先选择中文语音。 */
    const refreshVoices = () => {
      const availableVoices = window.speechSynthesis.getVoices()
      setVoices(availableVoices)
      if (!voiceURIRef.current) {
        const preferred =
          availableVoices.find(
            (voice) => voice.lang.toLowerCase() === 'zh-cn',
          ) ??
          availableVoices.find((voice) =>
            voice.lang.toLowerCase().startsWith('zh'),
          )
        if (preferred) {
          voiceURIRef.current = preferred.voiceURI
          updateVoiceURI(preferred.voiceURI)
        }
      }
    }

    refreshVoices()
    window.speechSynthesis.addEventListener('voiceschanged', refreshVoices)
    return () =>
      window.speechSynthesis.removeEventListener('voiceschanged', refreshVoices)
  }, [supported])

  useEffect(() => cancelSpeech, [cancelSpeech])

  return {
    supported,
    status,
    error,
    voices,
    chapterIndex,
    sentenceIndex,
    rate,
    voiceURI,
    continuous,
    play,
    pause,
    stop,
    retry,
    previousSentence,
    nextSentence,
    previousChapter,
    nextChapter,
    selectChapter,
    setRate,
    setVoiceURI,
    setContinuous,
  }
}
