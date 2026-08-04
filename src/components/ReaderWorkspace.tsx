import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BookOpenText,
  ChevronLeft,
  ChevronRight,
  DatabaseZap,
  FileText,
  ImageIcon,
  List,
  Pause,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward,
  Sparkles,
  X,
} from 'lucide-react'
import { useSpeechReader } from '../hooks/useSpeechReader'
import { loadReaderState, saveReaderState } from '../lib/storage'
import type { Chapter, ReaderSource, ReadingBlock } from '../types'

interface ReaderWorkspaceProps {
  chapters: Chapter[]
  source: ReaderSource
  sourceInput: string
  menuOpen: boolean
  onMenuClose: () => void
}

/** 根据来源类型生成目录底部展示的三段来源信息。 */
function getSourceMeta(source: ReaderSource): string[] {
  if (source.sourceType === 'github') {
    return [source.owner, source.repo, source.branch]
  }
  return [
    source.name,
    source.detail,
    source.origin === 'file' ? '本地解析' : '公开链接',
  ]
}

/** 将字节数量格式化为便于播放器展示的 MB 文本。 */
function formatMegabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
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
  const cacheDialogRef = useRef<HTMLDialogElement | null>(null)
  const manualScrollUntilRef = useRef(0)
  const [pdfViewMode, setPdfViewMode] = useState<'text' | 'page'>('text')
  const [cacheInfo, setCacheInfo] = useState({
    cachedBytes: 0,
    totalBytes: 0,
  })
  const [cacheMessage, setCacheMessage] = useState('')
  const [clearingCache, setClearingCache] = useState(false)

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
    initialContinuous: savedState?.continuous,
    onPositionChange: handlePositionChange,
  })

  const chapter = chapters[reader.chapterIndex]
  const sourceMeta = getSourceMeta(source)
  const activeSentence = chapter.sentences[reader.sentenceIndex]
  const progress = ((reader.sentenceIndex + 1) / chapter.sentences.length) * 100

  /** 切换章节或读物时恢复 PDF 文本预览，避免沿用上一页的原始页面模式。 */
  useEffect(() => {
    setPdfViewMode('text')
  }, [chapter.id, sourceInput])

  /** 保存非位置类的播放器偏好。 */
  const persistPreferences = useCallback(() => {
    saveReaderState(sourceInput, {
      chapterPath: chapter.path,
      sentenceIndex: reader.sentenceIndex,
      rate: reader.rate,
      voiceURI: '',
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

  /** 查询语音缓存并打开页面内确认对话框。 */
  const openCacheDialog = useCallback(async () => {
    setCacheMessage('')
    const result = await reader.getNaturalVoiceCacheInfo()
    setCacheInfo({
      cachedBytes: result.cachedBytes,
      totalBytes: result.totalBytes,
    })
    if (!result.ok) setCacheMessage(result.message ?? '无法读取缓存信息。')
    cacheDialogRef.current?.showModal()
  }, [reader])

  /** 二次确认后清除模型分片与语音运行时文件缓存。 */
  const confirmClearCache = useCallback(async () => {
    setClearingCache(true)
    setCacheMessage('')
    const cleared = await reader.clearNaturalVoiceCache()
    setClearingCache(false)
    if (!cleared) {
      setCacheMessage('缓存清除失败，请稍后重试。')
      return
    }
    setCacheInfo({ cachedBytes: 0, totalBytes: cacheInfo.totalBytes })
    setCacheMessage('语音缓存已清除。')
    window.setTimeout(() => cacheDialogRef.current?.close(), 650)
  }, [cacheInfo.totalBytes, reader])

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
              className="icon-button catalog__close has-tooltip"
              data-tooltip="关闭目录"
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
            {sourceMeta.map((item) => (
              <span key={item}>{item}</span>
            ))}
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
                {source.sourceType === 'pdf' ? 'Page' : 'Issue'}{' '}
                {String(reader.chapterIndex + 1).padStart(2, '0')}
              </span>
              <span>{chapter.sentences.length} sentences</span>
            </div>
            <h1>{chapter.title}</h1>
            {chapter.sourceUrl ? (
              <a href={chapter.sourceUrl} target="_blank" rel="noreferrer">
                {source.sourceType === 'pdf'
                  ? '打开原始 PDF'
                  : '查看原始 Markdown'}
              </a>
            ) : (
              <span className="article__local-source">
                本地 PDF · 仅在浏览器中解析
              </span>
            )}
          </header>
          {source.sourceType === 'pdf' && chapter.previewUrl ? (
            <div className="article__view-toggle" aria-label="PDF 预览模式">
              <button
                className={pdfViewMode === 'text' ? 'is-active' : ''}
                onClick={() => setPdfViewMode('text')}
                type="button"
              >
                <FileText aria-hidden="true" />
                文本预览
              </button>
              <button
                className={pdfViewMode === 'page' ? 'is-active' : ''}
                onClick={() => setPdfViewMode('page')}
                type="button"
              >
                <ImageIcon aria-hidden="true" />
                原始页面
              </button>
            </div>
          ) : null}
          {chapter.previewUrl && pdfViewMode === 'page' ? (
            <figure className="article__pdf-preview">
              <img
                alt={`${chapter.title} 原始页面预览`}
                src={chapter.previewUrl}
              />
              <figcaption>PDF 原始页面预览</figcaption>
            </figure>
          ) : null}
          {pdfViewMode === 'text' || source.sourceType !== 'pdf' ? (
            <div className="article__body">
              {chapter.blocks.map((block) => (
                <ArticleBlock
                  activeSentenceId={activeSentence?.id ?? ''}
                  block={block}
                  key={block.id}
                />
              ))}
            </div>
          ) : null}
          <footer className="article__footer">
            <BookOpenText aria-hidden="true" />
            <span>本章朗读完毕后，可自动进入下一章。</span>
          </footer>
        </article>
      </main>

      <section className="player" aria-label="朗读播放器">
        <div className="player__transport">
          <button
            className="icon-button has-tooltip"
            data-tooltip="上一章"
            onClick={() => runNavigation(reader.previousChapter)}
            disabled={reader.chapterIndex === 0}
            aria-label="上一章"
          >
            <SkipBack aria-hidden="true" />
          </button>
          <button
            className="icon-button has-tooltip"
            data-tooltip="上一句"
            onClick={() => runNavigation(reader.previousSentence)}
            disabled={reader.chapterIndex === 0 && reader.sentenceIndex === 0}
            aria-label="上一句"
          >
            <ChevronLeft aria-hidden="true" />
          </button>
          <button
            className="icon-button icon-button--primary has-tooltip"
            data-tooltip={reader.status === 'playing' ? '暂停朗读' : '播放朗读'}
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
            className="icon-button has-tooltip"
            data-tooltip="下一句"
            onClick={() => runNavigation(reader.nextSentence)}
            aria-label="下一句"
          >
            <ChevronRight aria-hidden="true" />
          </button>
          <button
            className="icon-button has-tooltip"
            data-tooltip="下一章"
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
            <div className="player__failure" role="alert">
              <button className="player__error" onClick={reader.retry}>
                {reader.error} <RotateCcw aria-hidden="true" />
              </button>
              {reader.diagnostic ? (
                <details>
                  <summary>查看错误详情</summary>
                  <pre>{reader.diagnostic}</pre>
                </details>
              ) : null}
            </div>
          ) : null}
          {reader.progress ? (
            <div className="player__notice" role="status">
              <span>
                {reader.progress.label}
                {reader.progress.totalBytes > 0
                  ? ` ${reader.progress.percent.toFixed(1)}%`
                  : ''}
                {reader.progress.totalBytes > 0
                  ? ` · ${formatMegabytes(reader.progress.downloadedBytes)} / ${formatMegabytes(reader.progress.totalBytes)}`
                  : ''}
                {reader.progress.source === 'local-resume'
                  ? ' · 本地续传'
                  : reader.progress.source === 'cdn'
                    ? ' · CDN 下载'
                    : reader.progress.source === 'pages-fallback'
                      ? ' · Pages 备用'
                      : reader.progress.source === 'local-cache'
                        ? ' · 本地缓存'
                        : ''}
              </span>
              <button onClick={reader.cancelNaturalVoice}>取消</button>
            </div>
          ) : reader.fallbackReason ? (
            <div
              className="player__notice player__notice--warning"
              role="status"
            >
              <span>{reader.fallbackReason} 已切换到系统语音。</span>
              <button onClick={reader.retryNaturalVoice}>重试自然语音</button>
              {reader.diagnostic ? (
                <details>
                  <summary>错误详情</summary>
                  <pre>{reader.diagnostic}</pre>
                </details>
              ) : null}
            </div>
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
          <div className={`engine-status engine-status--${reader.engineKind}`}>
            <Sparkles aria-hidden="true" />
            <span>{reader.engineLabel}</span>
          </div>
          <label className="continuous-toggle">
            <input
              type="checkbox"
              checked={reader.continuous}
              onChange={(event) => reader.setContinuous(event.target.checked)}
            />
            <span>连续</span>
          </label>
          <button
            className="icon-button has-tooltip"
            data-tooltip="清除语音缓存"
            onClick={() => void openCacheDialog()}
            aria-label="清除自然语音缓存"
          >
            <DatabaseZap aria-hidden="true" />
          </button>
        </div>
      </section>

      <dialog className="cache-dialog" ref={cacheDialogRef}>
        <form method="dialog" className="cache-dialog__sheet">
          <span className="eyebrow">Local voice storage</span>
          <h2>清除语音缓存？</h2>
          <p>
            当前已缓存 {formatMegabytes(cacheInfo.cachedBytes)}
            。清除后，下次使用本地自然语音需要重新下载
            {cacheInfo.totalBytes > 0
              ? ` ${formatMegabytes(cacheInfo.totalBytes)}`
              : '完整模型'}
            。
          </p>
          {cacheMessage ? (
            <p className="cache-dialog__message">{cacheMessage}</p>
          ) : null}
          <div className="cache-dialog__actions">
            <button value="cancel" disabled={clearingCache}>
              保留缓存
            </button>
            <button
              className="cache-dialog__danger"
              type="button"
              disabled={clearingCache}
              onClick={() => void confirmClearCache()}
            >
              {clearingCache ? '正在清除' : '确认清除'}
            </button>
          </div>
        </form>
      </dialog>
    </>
  )
}

export { List }
