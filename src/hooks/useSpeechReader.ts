import { useCallback, useEffect, useRef, useState } from 'react'
import { BrowserSpeechEngine } from '../speech/BrowserSpeechEngine'
import { KokoroSpeechEngine } from '../speech/KokoroSpeechEngine'
import type {
  SpeechEngine,
  SpeechEngineKind,
  SpeechProgress,
} from '../speech/types'
import type { Chapter, PlaybackStatus } from '../types'

interface SpeechReaderOptions {
  chapters: Chapter[]
  initialChapterIndex?: number
  initialSentenceIndex?: number
  initialRate?: number
  initialContinuous?: boolean
  onPositionChange?: (chapterIndex: number, sentenceIndex: number) => void
}

interface SpeechReaderResult {
  supported: boolean
  status: PlaybackStatus
  error: string
  fallbackReason: string
  diagnostic: string
  engineKind: SpeechEngineKind
  engineLabel: string
  progress: SpeechProgress | null
  chapterIndex: number
  sentenceIndex: number
  rate: number
  continuous: boolean
  play: () => void
  pause: () => void
  retry: () => void
  selectEngine: (kind: SpeechEngineKind) => void
  retryNaturalVoice: () => void
  cancelNaturalVoice: () => void
  clearNaturalVoiceCache: () => Promise<boolean>
  getNaturalVoiceCacheInfo: () => Promise<{
    ok: boolean
    cachedBytes: number
    totalBytes: number
    message?: string
  }>
  previousSentence: () => void
  nextSentence: () => void
  previousChapter: () => void
  nextChapter: () => void
  selectChapter: (index: number, sentenceIndex?: number) => void
  setRate: (rate: number) => void
  setContinuous: (continuous: boolean) => void
}

/** 提供系统语音默认、本地自然语音可手动切换的逐句朗读状态机。 */
export function useSpeechReader({
  chapters,
  initialChapterIndex = 0,
  initialSentenceIndex = 0,
  initialRate = 1,
  initialContinuous = true,
  onPositionChange,
}: SpeechReaderOptions): SpeechReaderResult {
  const supported =
    typeof window !== 'undefined' &&
    (typeof Worker !== 'undefined' || 'speechSynthesis' in window)
  const [status, setStatus] = useState<PlaybackStatus>('idle')
  const [error, setError] = useState('')
  const [fallbackReason, setFallbackReason] = useState('')
  const [diagnostic, setDiagnostic] = useState('')
  const [engineKind, setEngineKind] = useState<SpeechEngineKind>('browser')
  const [engineLabel, setEngineLabel] = useState('系统语音')
  const [progress, setProgress] = useState<SpeechProgress | null>(null)
  const [chapterIndex, setChapterIndex] = useState(initialChapterIndex)
  const [sentenceIndex, setSentenceIndex] = useState(initialSentenceIndex)
  const [rate, updateRate] = useState(initialRate)
  const [continuous, updateContinuous] = useState(initialContinuous)
  const statusRef = useRef<PlaybackStatus>('idle')
  const chapterIndexRef = useRef(initialChapterIndex)
  const sentenceIndexRef = useRef(initialSentenceIndex)
  const rateRef = useRef(initialRate)
  const continuousRef = useRef(initialContinuous)
  const chaptersRef = useRef(chapters)
  const engineRef = useRef<SpeechEngine>(new BrowserSpeechEngine())
  const initializedRef = useRef(false)
  const speakCurrentRef = useRef<() => void>(() => undefined)

  /** 同步 React 状态与事件回调使用的播放状态。 */
  const updateStatus = useCallback((nextStatus: PlaybackStatus) => {
    statusRef.current = nextStatus
    setStatus(nextStatus)
  }, [])

  /** 更新朗读位置，并向持久化层报告变更。 */
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

  /** 读取当前位置之后最适合预生成的下一句文本。 */
  const getNextSentenceText = useCallback((): string => {
    const chapter = chaptersRef.current[chapterIndexRef.current]
    if (!chapter) return ''
    if (sentenceIndexRef.current + 1 < chapter.sentences.length) {
      return chapter.sentences[sentenceIndexRef.current + 1].text
    }
    if (
      continuousRef.current &&
      chapterIndexRef.current + 1 < chaptersRef.current.length
    ) {
      return (
        chaptersRef.current[chapterIndexRef.current + 1].sentences[0]?.text ??
        ''
      )
    }
    return ''
  }, [])

  /** 将朗读位置推进到下一句或连续播放的下一章。 */
  const advancePosition = useCallback((): boolean => {
    const chapter = chaptersRef.current[chapterIndexRef.current]
    if (!chapter) return false
    if (sentenceIndexRef.current + 1 < chapter.sentences.length) {
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

  /** 切换到系统语音并记录高质量语音不可用的原因。 */
  const switchToBrowserEngine = useCallback(
    async (reason: string, details = reason): Promise<void> => {
      engineRef.current.destroy()
      const browserEngine = new BrowserSpeechEngine()
      await browserEngine.initialize()
      engineRef.current = browserEngine
      initializedRef.current = true
      setEngineKind(browserEngine.kind)
      setEngineLabel(browserEngine.label)
      setFallbackReason(reason)
      setDiagnostic(details)
      setProgress(null)
    },
    [],
  )

  /** 初始化当前引擎，Kokoro 失败时自动启用系统语音。 */
  const ensureEngine = useCallback(async (): Promise<void> => {
    if (initializedRef.current) return
    setError('')
    if (engineRef.current.kind === 'kokoro') {
      setProgress({
        phase: 'checking-cache',
        percent: 0,
        downloadedBytes: 0,
        totalBytes: 0,
        label: '正在检查本地语音缓存。',
      })
    }
    try {
      await engineRef.current.initialize(setProgress)
      initializedRef.current = true
      setEngineKind(engineRef.current.kind)
      setEngineLabel(engineRef.current.label)
      setProgress(null)
    } catch (initializationError) {
      console.error(
        '[SpeechReader] 本地自然语音初始化失败',
        initializationError,
      )
      const reason =
        initializationError instanceof Error
          ? initializationError.message
          : '本地自然语音初始化失败。'
      const details =
        initializationError instanceof Error
          ? (initializationError.stack ?? initializationError.message)
          : String(initializationError)
      await switchToBrowserEngine(reason, details)
    }
  }, [switchToBrowserEngine])

  /** 本地语音生成失败时切换系统语音，并自动重播当前句。 */
  const recoverSpeechFailure = useCallback(
    async (speechError: Error): Promise<void> => {
      const details = speechError.stack ?? speechError.message
      console.error('[SpeechReader] 本地自然语音播放失败', speechError)
      if (engineRef.current.kind !== 'kokoro') {
        setError(speechError.message)
        setDiagnostic(details)
        updateStatus('error')
        return
      }
      try {
        await switchToBrowserEngine(
          `本地自然语音播放失败：${speechError.message}`,
          details,
        )
        updateStatus('idle')
        window.setTimeout(() => speakCurrentRef.current(), 30)
      } catch (fallbackError) {
        console.error('[SpeechReader] 系统语音回退失败', fallbackError)
        const fallbackDetails =
          fallbackError instanceof Error
            ? (fallbackError.stack ?? fallbackError.message)
            : String(fallbackError)
        setError('本地自然语音和系统语音均无法启动。')
        setDiagnostic(`${details}\n\n系统语音回退失败：\n${fallbackDetails}`)
        updateStatus('error')
      }
    },
    [switchToBrowserEngine, updateStatus],
  )

  /** 播放当前句，并在音频真正开始后更新高亮与预生成下一句。 */
  const speakCurrent = useCallback(async () => {
    if (!supported) {
      setError('当前浏览器不支持语音朗读。')
      updateStatus('error')
      return
    }
    const chapter = chaptersRef.current[chapterIndexRef.current]
    const sentence = chapter?.sentences[sentenceIndexRef.current]
    if (!sentence) {
      updateStatus('idle')
      return
    }

    setError('')
    updateStatus('idle')
    try {
      await ensureEngine()
      await engineRef.current.speak({
        text: sentence.text,
        rate: rateRef.current,
        onStart: () => {
          setProgress(null)
          updateStatus('playing')
          const nextText = getNextSentenceText()
          if (nextText) engineRef.current.prepare(nextText, rateRef.current)
        },
        onEnd: () => {
          if (statusRef.current !== 'playing') return
          if (advancePosition())
            window.setTimeout(() => speakCurrentRef.current(), 30)
          else updateStatus('idle')
        },
        onError: (speechError) => {
          void recoverSpeechFailure(speechError)
        },
      })
    } catch (speechError) {
      void recoverSpeechFailure(
        speechError instanceof Error
          ? speechError
          : new Error('语音播放失败。'),
      )
    }
  }, [
    advancePosition,
    ensureEngine,
    getNextSentenceText,
    recoverSpeechFailure,
    supported,
    updateStatus,
  ])

  speakCurrentRef.current = () => void speakCurrent()

  /** 开始新语音或恢复当前引擎暂停的音频。 */
  const play = useCallback(() => {
    if (statusRef.current === 'paused') {
      engineRef.current.resume()
      updateStatus('playing')
      return
    }
    engineRef.current.activate?.()
    speakCurrentRef.current()
  }, [updateStatus])

  /** 暂停当前引擎并保留高亮和音频位置。 */
  const pause = useCallback(() => {
    if (statusRef.current !== 'playing') return
    engineRef.current.pause()
    updateStatus('paused')
  }, [updateStatus])

  /** 重新播放发生错误的当前句。 */
  const retry = useCallback(() => {
    setError('')
    speakCurrentRef.current()
  }, [])

  /** 根据用户选择切换语音引擎，播放中切换时从当前句重新开始。 */
  const selectEngine = useCallback(
    (kind: SpeechEngineKind) => {
      if (engineRef.current.kind === kind) return
      const wasPlaying = statusRef.current === 'playing'
      engineRef.current.destroy()
      engineRef.current =
        kind === 'kokoro' ? new KokoroSpeechEngine() : new BrowserSpeechEngine()
      initializedRef.current = false
      setEngineKind(kind)
      setEngineLabel(kind === 'kokoro' ? '本地自然女声（实验）' : '系统语音')
      setError('')
      setDiagnostic('')
      setFallbackReason('')
      setProgress(null)
      updateStatus('idle')
      if (wasPlaying) {
        window.setTimeout(() => speakCurrentRef.current(), 30)
      }
    },
    [updateStatus],
  )

  /** 重新创建 Kokoro 引擎并尝试恢复本地自然语音。 */
  const retryNaturalVoice = useCallback(() => {
    engineRef.current.destroy()
    engineRef.current = new KokoroSpeechEngine()
    initializedRef.current = false
    setEngineKind('kokoro')
    setEngineLabel('本地自然女声')
    setFallbackReason('')
    setProgress(null)
    speakCurrentRef.current()
  }, [])

  /** 取消正在初始化的本地语音并立即切换到系统语音。 */
  const cancelNaturalVoice = useCallback(() => {
    void switchToBrowserEngine('已取消本地自然语音下载。').then(() => {
      updateStatus('idle')
    })
  }, [switchToBrowserEngine, updateStatus])

  /** 清除浏览器中缓存的本地自然语音模型。 */
  const clearNaturalVoiceCache = useCallback(
    () => KokoroSpeechEngine.clearCache(),
    [],
  )

  /** 查询已保存的模型分片大小，为清除缓存确认框提供准确数据。 */
  const getNaturalVoiceCacheInfo = useCallback(
    () => KokoroSpeechEngine.getCacheInfo(),
    [],
  )

  /** 跳转到指定位置，并在原本播放时从新位置继续。 */
  const moveTo = useCallback(
    (
      nextChapterIndex: number,
      nextSentenceIndex: number,
      keepPlaying = true,
    ) => {
      const wasPlaying = statusRef.current === 'playing'
      engineRef.current.stop()
      updatePosition(nextChapterIndex, nextSentenceIndex)
      updateStatus('idle')
      if (wasPlaying && keepPlaying) {
        window.setTimeout(() => speakCurrentRef.current(), 30)
      }
    },
    [updatePosition, updateStatus],
  )

  /** 跳转到上一句，章首时进入上一章末句。 */
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

  /** 跳转到下一句，章末时进入下一章首句。 */
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

  /** 选择章节或章节内小节，并停止当前音频。 */
  const selectChapter = useCallback(
    (index: number, nextSentenceIndex = 0) =>
      moveTo(index, nextSentenceIndex, false),
    [moveTo],
  )

  /** 更新语速，播放中从当前句按新速度重新生成。 */
  const setRate = useCallback((nextRate: number) => {
    rateRef.current = nextRate
    updateRate(nextRate)
    if (statusRef.current === 'playing') {
      engineRef.current.stop()
      speakCurrentRef.current()
    }
  }, [])

  /** 更新章节结束后的连续播放偏好。 */
  const setContinuous = useCallback((nextContinuous: boolean) => {
    continuousRef.current = nextContinuous
    updateContinuous(nextContinuous)
  }, [])

  useEffect(() => {
    chaptersRef.current = chapters
  }, [chapters])

  useEffect(
    () => () => {
      engineRef.current.destroy()
    },
    [],
  )

  return {
    supported,
    status,
    error,
    fallbackReason,
    diagnostic,
    engineKind,
    engineLabel,
    progress,
    chapterIndex,
    sentenceIndex,
    rate,
    continuous,
    play,
    pause,
    retry,
    selectEngine,
    retryNaturalVoice,
    cancelNaturalVoice,
    clearNaturalVoiceCache,
    getNaturalVoiceCacheInfo,
    previousSentence,
    nextSentence,
    previousChapter,
    nextChapter,
    selectChapter,
    setRate,
    setContinuous,
  }
}
