import {
  ChangeEvent,
  FormEvent,
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react'
import { ArrowRight, FileUp, Link2, List, LoaderCircle } from 'lucide-react'
import { ReaderWorkspace } from './components/ReaderWorkspace'
import { loadGitHubBook } from './lib/github'
import type { Chapter, ReaderSource } from './types'

const EXAMPLE_SOURCE =
  'https://github.com/xdash/FDE-the-Guidance-Book-of-Forward-Deployed-Engineer'

/** 从查询参数读取可分享的 GitHub 来源地址。 */
function getInitialSource(): string {
  const source = new URLSearchParams(window.location.search).get('source')
  return source || EXAMPLE_SOURCE
}

/** 渲染应用入口，负责来源加载、错误恢复和阅读工作区切换。 */
export default function App() {
  const initialSource = useMemo(getInitialSource, [])
  const [sourceInput, setSourceInput] = useState(initialSource)
  const [loadedSourceInput, setLoadedSourceInput] = useState('')
  const [source, setSource] = useState<ReaderSource | null>(null)
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  /** 根据输入地址加载 GitHub Markdown 或公开 PDF，并切换到阅读工作区。 */
  const loadSource = useCallback(async (value: string) => {
    if (!value.trim()) return
    setLoading(true)
    setError('')

    try {
      let url: URL
      try {
        url = new URL(value.trim())
      } catch {
        throw new Error('请输入完整的 GitHub 地址或 PDF 链接。')
      }
      const result =
        url.hostname === 'github.com'
          ? { ...(await loadGitHubBook(value)), sourceKey: value.trim() }
          : await (await import('./lib/pdf')).loadPdfUrl(value)
      setSource(result.source)
      setChapters(result.chapters)
      setLoadedSourceInput(result.sourceKey)
      const nextUrl = new URL(window.location.href)
      nextUrl.searchParams.set('source', value.trim())
      window.history.replaceState({}, '', nextUrl)
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : '加载失败，请重试。',
      )
    } finally {
      setLoading(false)
    }
  }, [])

  /** 打开系统文件选择器，让用户选择本地 PDF。 */
  const handleChoosePdf = () => {
    fileInputRef.current?.click()
  }

  /** 读取用户选择的本地 PDF，并在浏览器内完成章节解析。 */
  const handlePdfFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setLoading(true)
    setError('')
    try {
      const result = await (await import('./lib/pdf')).loadPdfFile(file)
      setSourceInput(file.name)
      setSource(result.source)
      setChapters(result.chapters)
      setLoadedSourceInput(result.sourceKey)
      const nextUrl = new URL(window.location.href)
      nextUrl.searchParams.delete('source')
      window.history.replaceState({}, '', nextUrl)
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : 'PDF 加载失败。',
      )
    } finally {
      setLoading(false)
    }
  }

  /** 提交地址输入框并加载用户当前填写的来源。 */
  const handleLoad = async (event?: FormEvent) => {
    event?.preventDefault()
    await loadSource(sourceInput)
  }

  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="brand">
          <div className="brand__name">文档章节朗读</div>
          <span className="brand__tagline">Markdown 与 PDF · 本地生成语音</span>
        </div>
        <form className="source-form" onSubmit={handleLoad}>
          <label htmlFor="source-url">GitHub 或 PDF 公开地址</label>
          <div className="source-form__control">
            <Link2 aria-hidden="true" />
            <input
              id="source-url"
              value={sourceInput}
              onChange={(event) => setSourceInput(event.target.value)}
              spellCheck="false"
              placeholder="GitHub 仓库或公开 PDF 链接"
            />
            <input
              ref={fileInputRef}
              hidden
              type="file"
              accept="application/pdf,.pdf"
              onChange={handlePdfFile}
            />
            <button
              className="source-form__upload"
              type="button"
              disabled={loading}
              onClick={handleChoosePdf}
              aria-label="选择本地 PDF"
              title="选择本地 PDF"
            >
              <FileUp aria-hidden="true" />
              <span>选择 PDF</span>
            </button>
            <button type="submit" disabled={loading} aria-label="开始阅读">
              {loading ? (
                <LoaderCircle className="spin" aria-hidden="true" />
              ) : (
                <ArrowRight aria-hidden="true" />
              )}
              <span>{loading ? '正在编排' : '开始阅读'}</span>
            </button>
          </div>
          {error ? <p className="source-form__error">{error}</p> : null}
        </form>
        {chapters.length > 0 ? (
          <button className="menu-button" onClick={() => setMenuOpen(true)}>
            <List aria-hidden="true" />
            目录
          </button>
        ) : null}
      </header>

      {source && chapters.length > 0 ? (
        <ReaderWorkspace
          key={loadedSourceInput}
          chapters={chapters}
          source={source}
          sourceInput={loadedSourceInput}
          menuOpen={menuOpen}
          onMenuClose={() => setMenuOpen(false)}
        />
      ) : (
        <main className="empty-state">
          <div className="empty-state__number">公开阅读</div>
          <div>
            <span className="eyebrow">从链接或 PDF 开始</span>
            <h1>
              把长篇 Markdown，
              <br />
              变成可以听的杂志。
            </h1>
            <p>
              粘贴 GitHub 仓库、Markdown 文档或公开 PDF 链接，也可以选择本地
              PDF。应用会整理章节、拆分句子，并在朗读时同步标出当前位置。
            </p>
            <button onClick={() => void handleLoad()} disabled={loading}>
              加载示例读物 <ArrowRight aria-hidden="true" />
            </button>
          </div>
        </main>
      )}
    </div>
  )
}
