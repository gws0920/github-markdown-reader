import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowRight, Github, List, LoaderCircle } from 'lucide-react'
import { ReaderWorkspace } from './components/ReaderWorkspace'
import { loadGitHubBook } from './lib/github'
import type { Chapter, GitHubSource } from './types'

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
  const [source, setSource] = useState<GitHubSource | null>(null)
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)

  /** 加载指定 GitHub 地址对应的 Markdown 章节。 */
  const loadSource = useCallback(async (value: string) => {
    if (!value.trim()) return
    setLoading(true)
    setError('')

    try {
      const result = await loadGitHubBook(value)
      setSource(result.source)
      setChapters(result.chapters)
      setLoadedSourceInput(value.trim())
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

  /** 提交地址输入框并加载用户当前填写的来源。 */
  const handleLoad = async (event?: FormEvent) => {
    event?.preventDefault()
    await loadSource(sourceInput)
  }

  useEffect(() => {
    void loadSource(initialSource)
  }, [initialSource, loadSource])

  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="brand">
          <span className="brand__edition">Vol. 01 · Reader</span>
          <div className="brand__name">Folio</div>
          <span className="brand__tagline">
            GitHub Markdown, spoken clearly.
          </span>
        </div>
        <form className="source-form" onSubmit={handleLoad}>
          <label htmlFor="source-url">GitHub 公开地址</label>
          <div className="source-form__control">
            <Github aria-hidden="true" />
            <input
              id="source-url"
              value={sourceInput}
              onChange={(event) => setSourceInput(event.target.value)}
              spellCheck="false"
              placeholder="https://github.com/owner/repository"
            />
            <button type="submit" disabled={loading}>
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
          <div className="empty-state__number">01</div>
          <div>
            <span className="eyebrow">Listen to the long read</span>
            <h1>
              把长篇 Markdown，
              <br />
              变成可以听的杂志。
            </h1>
            <p>
              粘贴公开仓库、目录或单个文档地址。Folio
              会整理章节、拆分句子，并在朗读时同步标出当前位置。
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
