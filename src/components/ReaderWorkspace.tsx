import { useCallback, useEffect, useMemo, useRef } from 'react'
import {
  BookOpenText,
  ChevronLeft,
  ChevronRight,
  CircleStop,
  List,
  Pause,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward,
  Volume2,
  X,
} from 'lucide-react'
import { useSpeechReader } from '../hooks/useSpeechReader'
import { loadReaderState, saveReaderState } from '../lib/storage'
import type { Chapter, GitHubSource, ReadingBlock } from '../types'

interface ReaderWorkspaceProps {
  chapters: Chapter[]
  source: GitHubSource
  sourceInput: string
  menuOpen: boolean
  onMenuClose: () => void
}

/** 根据阅读块层级选择语义化标题元素。 */
function HeadingBlock({
  block,
  activeSentenceId,
}: {
  block: ReadingBlock
  activeSentenceId: string
}) {
  const content = block.sentences.map((sentence) => (
    <span
      className={`sentence ${sentence.id === activeSentenceId ? 'sentence--active' : ''}`}
      id={sentence.domId}
      key={sentence.id}
    >
      {sentence.text}
    </span>
  ))
  if (block.level === 1)
    return <h2 className="article-heading article-heading--one">{content}</h2>
  if (block.level === 2)
    return <h3 className="article-heading article-heading--two">{content}</h3>
  return <h4 className="article-heading article-heading--three">{content}</h4>
}

/** 渲染包含逐句定位节点的正文块。 */
function ArticleBlock({
  block,
  activeSentenceId,
}: {
  block: ReadingBlock
  activeSentenceId: string
}) {
  if (block.type === 'heading') {
    return <HeadingBlock block={block} activeSentenceId={activeSentenceId} />
  }
  const Tag = block.type === 'quote' ? 'blockquote' : 'p'
  return (
    <Tag className={`article-block article-block--${block.type}`}>
      {block.sentences.map((sentence) => (
        <span
          className={`sentence ${sentence.id === activeSentenceId ? 'sentence--active' : ''}`}
          id={sentence.domId}
          key={sentence.id}
        >
          {sentence.text}{' '}
        </span>
      ))}
    </Tag>
  )
}

/** 组合章节目录、正文与底部长条播放器，并管理阅读位置持久化。 */
export function ReaderWorkspace({
  chapters,
  source,
  sourceInput,
  menuOpen,
  onMenuClose,
}: ReaderWorkspaceProps) {
  const savedState = useMemo(() => loadReaderState(sourceInput), [sourceInput])
  const initialChapterIndex = Math.max(
    0,
    chapters.findIndex((chapter) => chapter.path === savedState?.chapterPath),
  )
  const articleRef = useRef<HTMLElement | null>(null)
  const manualScrollUntilRef = useRef(0)

  /** 保存位置变更，同时避免保存不存在的章节。 */
  const handlePositionChange = useCallback(
    (chapterIndex: number, sentenceIndex: number) => {
      const chapter = chapters[chapterIndex]
      if (!chapter) return
      const current = loadReaderState(sourceInput)
      saveReaderState(sourceInput, {
        chapterPath: chapter.path,
        sentenceIndex,
        rate: current?.rate ?? savedState?.rate ?? 1,
        voiceURI: current?.voiceURI ?? savedState?.voiceURI ?? '',
        continuous: current?.continuous ?? savedState?.continuous ?? true,
      })
    },
    [chapters, savedState, sourceInput],
  )

  const reader = useSpeechReader({
    chapters,
    initialChapterIndex,
    initialSentenceIndex: Math.min(
      savedState?.sentenceIndex ?? 0,
      Math.max(0, chapters[initialChapterIndex].sentences.length - 1),
    ),
    initialRate: savedState?.rate,
    initialVoiceURI: savedState?.voiceURI,
    initialContinuous: savedState?.continuous,
    onPositionChange: handlePositionChange,
  })

  const chapter = chapters[reader.chapterIndex]
  const activeSentence = chapter.sentences[reader.sentenceIndex]
  const progress = ((reader.sentenceIndex + 1) / chapter.sentences.length) * 100

  /** 保存非位置类的播放器偏好。 */
  const persistPreferences = useCallback(() => {
    saveReaderState(sourceInput, {
      chapterPath: chapter.path,
      sentenceIndex: reader.sentenceIndex,
      rate: reader.rate,
      voiceURI: reader.voiceURI,
      continuous: reader.continuous,
    })
  }, [chapter.path, reader, sourceInput])

  /** 允许下一次高亮变化主动滚动到当前句。 */
  const enableFollowing = useCallback(() => {
    manualScrollUntilRef.current = 0
  }, [])

  /** 标记用户正在手动浏览正文，短时间内不强制自动定位。 */
  const suspendFollowing = useCallback(() => {
    manualScrollUntilRef.current = Date.now() + 4000
  }, [])

  /** 包装播放器跳转操作，在用户主动控制时恢复高亮跟随。 */
  const runNavigation = useCallback(
    (action: () => void) => {
      enableFollowing()
      action()
    },
    [enableFollowing],
  )

  useEffect(() => {
    persistPreferences()
  }, [persistPreferences])

  useEffect(() => {
    if (!activeSentence || Date.now() < manualScrollUntilRef.current) return
    document.getElementById(activeSentence.domId)?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    })
  }, [activeSentence])

  return (
    <>
      <main className="reading-layout">
        <aside
          className={`catalog ${menuOpen ? 'catalog--open' : ''}`}
          aria-label="章节目录"
        >
          <div className="catalog__header">
            <div>
              <span className="eyebrow">Contents</span>
              <h2>章节目录</h2>
            </div>
            <button
              className="icon-button catalog__close"
              onClick={onMenuClose}
              aria-label="关闭目录"
            >
              <X aria-hidden="true" />
            </button>
          </div>
          <ol className="catalog__list">
            {chapters.map((item, index) => (
              <li key={item.id}>
                <button
                  className={`catalog__chapter ${index === reader.chapterIndex ? 'is-active' : ''}`}
                  onClick={() => {
                    runNavigation(() => reader.selectChapter(index))
                    onMenuClose()
                  }}
                >
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <strong>{item.title}</strong>
                </button>
                {index === reader.chapterIndex && item.sections.length > 1 ? (
                  <ol className="catalog__sections">
                    {item.sections.slice(1).map((section) => (
                      <li key={section.id}>
                        <button
                          onClick={() => {
                            runNavigation(() =>
                              reader.selectChapter(
                                index,
                                section.sentenceIndex,
                              ),
                            )
                            onMenuClose()
                          }}
                        >
                          {section.title}
                        </button>
                      </li>
                    ))}
                  </ol>
                ) : null}
              </li>
            ))}
          </ol>
          <div className="catalog__meta">
            <span>{source.owner}</span>
            <span>{source.repo}</span>
            <span>{source.branch}</span>
          </div>
        </aside>

        <article
          className="article"
          ref={articleRef}
          onWheel={suspendFollowing}
          onTouchStart={suspendFollowing}
        >
          <header className="article__masthead">
            <div className="article__issue">
              <span>
                Issue {String(reader.chapterIndex + 1).padStart(2, '0')}
              </span>
              <span>{chapter.sentences.length} sentences</span>
            </div>
            <h1>{chapter.title}</h1>
            <a href={chapter.sourceUrl} target="_blank" rel="noreferrer">
              查看原始 Markdown
            </a>
          </header>
          <div className="article__body">
            {chapter.blocks.map((block) => (
              <ArticleBlock
                activeSentenceId={activeSentence?.id ?? ''}
                block={block}
                key={block.id}
              />
            ))}
          </div>
          <footer className="article__footer">
            <BookOpenText aria-hidden="true" />
            <span>本章朗读完毕后，可自动进入下一章。</span>
          </footer>
        </article>
      </main>

      <section className="player" aria-label="朗读播放器">
        <div className="player__transport">
          <button
            className="icon-button"
            onClick={() => runNavigation(reader.previousChapter)}
            disabled={reader.chapterIndex === 0}
            aria-label="上一章"
          >
            <SkipBack aria-hidden="true" />
          </button>
          <button
            className="icon-button"
            onClick={() => runNavigation(reader.previousSentence)}
            disabled={reader.chapterIndex === 0 && reader.sentenceIndex === 0}
            aria-label="上一句"
          >
            <ChevronLeft aria-hidden="true" />
          </button>
          <button
            className="icon-button icon-button--primary"
            onClick={() => {
              enableFollowing()
              if (reader.status === 'playing') reader.pause()
              else reader.play()
            }}
            aria-label={reader.status === 'playing' ? '暂停' : '播放'}
          >
            {reader.status === 'playing' ? (
              <Pause aria-hidden="true" />
            ) : (
              <Play aria-hidden="true" />
            )}
          </button>
          <button
            className="icon-button"
            onClick={() => runNavigation(reader.nextSentence)}
            aria-label="下一句"
          >
            <ChevronRight aria-hidden="true" />
          </button>
          <button
            className="icon-button"
            onClick={() => runNavigation(reader.nextChapter)}
            disabled={reader.chapterIndex === chapters.length - 1}
            aria-label="下一章"
          >
            <SkipForward aria-hidden="true" />
          </button>
        </div>

        <div className="player__now">
          <div className="player__title-row">
            <strong>{chapter.title}</strong>
            <span>
              {reader.sentenceIndex + 1} / {chapter.sentences.length}
            </span>
          </div>
          <div
            className="progress"
            aria-label={`章节进度 ${Math.round(progress)}%`}
          >
            <span style={{ width: `${progress}%` }} />
          </div>
          {reader.error ? (
            <button className="player__error" onClick={reader.retry}>
              {reader.error} <RotateCcw aria-hidden="true" />
            </button>
          ) : null}
        </div>

        <div className="player__settings">
          <label>
            <span className="sr-only">朗读倍速</span>
            <select
              value={reader.rate}
              onChange={(event) => reader.setRate(Number(event.target.value))}
            >
              {[0.75, 1, 1.25, 1.5, 2].map((value) => (
                <option key={value} value={value}>
                  {value}x
                </option>
              ))}
            </select>
          </label>
          <label className="voice-select">
            <Volume2 aria-hidden="true" />
            <span className="sr-only">系统语音</span>
            <select
              value={reader.voiceURI}
              onChange={(event) => reader.setVoiceURI(event.target.value)}
            >
              {reader.voices.map((voice) => (
                <option key={voice.voiceURI} value={voice.voiceURI}>
                  {voice.name} · {voice.lang}
                </option>
              ))}
            </select>
          </label>
          <label className="continuous-toggle">
            <input
              type="checkbox"
              checked={reader.continuous}
              onChange={(event) => reader.setContinuous(event.target.checked)}
            />
            <span>连续</span>
          </label>
          <button
            className="icon-button"
            onClick={reader.stop}
            aria-label="停止朗读"
          >
            <CircleStop aria-hidden="true" />
          </button>
        </div>
      </section>
    </>
  )
}

export { List }
