import type { Chapter, GitHubSource, ParsedGitHubUrl } from '../types'
import { parseMarkdownChapter } from './markdown'

const API_ROOT = 'https://api.github.com'
const RAW_ROOT = 'https://raw.githubusercontent.com'
const MARKDOWN_EXTENSIONS = ['.md', '.markdown']
const IGNORED_SEGMENTS = new Set([
  '.git',
  '.github',
  'node_modules',
  'vendor',
  'dist',
  'build',
])
const IGNORED_FILES = new Set([
  'readme.md',
  'license.md',
  'contributing.md',
  'code_of_conduct.md',
  'changelog.md',
])

interface RepositoryResponse {
  default_branch: string
}

interface GitTreeItem {
  path: string
  type: 'blob' | 'tree'
}

interface GitTreeResponse {
  tree: GitTreeItem[]
  truncated: boolean
}

/** 解析 GitHub 网页地址，提取仓库及待解析的分支路径信息。 */
export function parseGitHubUrl(value: string): ParsedGitHubUrl {
  let url: URL

  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('请输入完整的 GitHub 地址。')
  }

  if (url.hostname !== 'github.com') {
    throw new Error('目前只支持 github.com 的公开地址。')
  }

  const segments = url.pathname
    .split('/')
    .filter(Boolean)
    .map(decodeURIComponent)
  if (segments.length < 2) {
    throw new Error('地址中缺少仓库名称。')
  }

  const [owner, rawRepo, mode, ...remainder] = segments
  const repo = rawRepo.replace(/\.git$/i, '')
  if (!owner || !repo) {
    throw new Error('无法识别仓库所有者或仓库名称。')
  }

  if (!mode) {
    return {
      owner,
      repo,
      kind: 'repository',
      remainder: [],
      originalUrl: url.href,
    }
  }

  if (mode !== 'tree' && mode !== 'blob') {
    throw new Error('仅支持仓库、目录或 Markdown 文件地址。')
  }

  if (remainder.length === 0) {
    throw new Error('地址中缺少分支信息。')
  }

  return {
    owner,
    repo,
    kind: mode === 'blob' ? 'file' : 'directory',
    remainder,
    originalUrl: url.href,
  }
}

/** 发送 GitHub API 请求，并将常见失败转换为可恢复的中文提示。 */
async function fetchGitHubJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_ROOT}${path}`, {
    headers: { Accept: 'application/vnd.github+json' },
  })

  if (response.ok) {
    return response.json() as Promise<T>
  }

  if (
    response.status === 403 &&
    response.headers.get('x-ratelimit-remaining') === '0'
  ) {
    throw new Error('GitHub 请求次数已用完，请稍后重试。')
  }
  if (response.status === 404) {
    throw new Error('内容不存在，或仓库不是公开仓库。')
  }
  throw new Error(`GitHub 请求失败（${response.status}）。`)
}

/** 检查候选分支是否存在，用于支持名称中包含斜杠的分支。 */
async function branchExists(
  owner: string,
  repo: string,
  branch: string,
): Promise<boolean> {
  const encodedBranch = branch.split('/').map(encodeURIComponent).join('/')
  const response = await fetch(
    `${API_ROOT}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodedBranch}`,
    { headers: { Accept: 'application/vnd.github+json' } },
  )
  return response.ok
}

/** 将初步解析结果补全为明确的默认分支、分支名称和仓库内路径。 */
export async function resolveGitHubSource(
  parsed: ParsedGitHubUrl,
): Promise<GitHubSource> {
  if (parsed.kind === 'repository') {
    const repository = await fetchGitHubJson<RepositoryResponse>(
      `/repos/${encodeURIComponent(parsed.owner)}/${encodeURIComponent(parsed.repo)}`,
    )
    return {
      ...parsed,
      sourceType: 'github',
      branch: repository.default_branch,
      path: '',
    }
  }

  for (let index = parsed.remainder.length; index >= 1; index -= 1) {
    const branch = parsed.remainder.slice(0, index).join('/')
    if (await branchExists(parsed.owner, parsed.repo, branch)) {
      return {
        sourceType: 'github',
        owner: parsed.owner,
        repo: parsed.repo,
        branch,
        path: parsed.remainder.slice(index).join('/'),
        kind: parsed.kind,
        originalUrl: parsed.originalUrl,
      }
    }
  }

  throw new Error('无法识别地址中的分支名称。')
}

/** 判断仓库文件是否是适合加入章节目录的 Markdown 正文。 */
function isReadableMarkdown(path: string): boolean {
  const lowerPath = path.toLowerCase()
  const segments = lowerPath.split('/')
  const fileName = segments.at(-1) ?? ''
  return (
    MARKDOWN_EXTENSIONS.some((extension) => lowerPath.endsWith(extension)) &&
    !segments.some((segment) => IGNORED_SEGMENTS.has(segment)) &&
    !IGNORED_FILES.has(fileName)
  )
}

/** 根据目录前缀筛选并自然排序仓库中的 Markdown 文件。 */
function selectMarkdownPaths(items: GitTreeItem[], prefix: string): string[] {
  const normalizedPrefix = prefix.replace(/^\/+|\/+$/g, '')
  return items
    .filter((item) => item.type === 'blob')
    .map((item) => item.path)
    .filter(
      (path) => !normalizedPrefix || path.startsWith(`${normalizedPrefix}/`),
    )
    .filter(isReadableMarkdown)
    .sort((left, right) =>
      left.localeCompare(right, 'zh-CN', { numeric: true }),
    )
}

/** 构造公开仓库文件的 Raw 内容地址。 */
function createRawUrl(source: GitHubSource, path: string): string {
  return `${RAW_ROOT}/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/${source.branch
    .split('/')
    .map(encodeURIComponent)
    .join('/')}/${path.split('/').map(encodeURIComponent).join('/')}`
}

/** 下载单个 Markdown 文件，并转换为可阅读章节。 */
async function loadChapter(
  source: GitHubSource,
  path: string,
): Promise<Chapter> {
  const rawUrl = createRawUrl(source, path)
  const response = await fetch(rawUrl)
  if (!response.ok) {
    throw new Error(`无法读取章节：${path}`)
  }
  const markdown = await response.text()
  return parseMarkdownChapter(markdown, path, rawUrl)
}

/** 加载 GitHub 来源下的全部章节，并限制并发以避免瞬时请求过多。 */
export async function loadChapters(source: GitHubSource): Promise<Chapter[]> {
  if (source.kind === 'file') {
    if (!isReadableMarkdown(source.path)) {
      throw new Error('该文件不是可朗读的 Markdown 文档。')
    }
    return [await loadChapter(source, source.path)]
  }

  const tree = await fetchGitHubJson<GitTreeResponse>(
    `/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}/git/trees/${encodeURIComponent(source.branch)}?recursive=1`,
  )
  if (tree.truncated) {
    throw new Error('仓库文件过多，GitHub 未返回完整目录。请改用具体目录地址。')
  }

  const paths = selectMarkdownPaths(tree.tree, source.path)
  if (paths.length === 0) {
    throw new Error('没有找到可朗读的 Markdown 章节。')
  }

  const chapters: Chapter[] = []
  for (let index = 0; index < paths.length; index += 4) {
    const batch = paths.slice(index, index + 4)
    chapters.push(
      ...(await Promise.all(batch.map((path) => loadChapter(source, path)))),
    )
  }
  return chapters
}

/** 解析地址并加载章节，作为界面层的统一入口。 */
export async function loadGitHubBook(value: string): Promise<{
  source: GitHubSource
  chapters: Chapter[]
}> {
  const source = await resolveGitHubSource(parseGitHubUrl(value))
  const chapters = await loadChapters(source)
  return { source, chapters }
}
