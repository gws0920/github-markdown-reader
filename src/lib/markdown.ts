import { Lexer, type Token, type Tokens } from 'marked'
import type {
  Chapter,
  ChapterSection,
  ReadingBlock,
  ReadingBlockType,
  SpeechSentence,
} from '../types'

const MAX_SENTENCE_LENGTH = 220

/** 生成稳定且可安全用于 DOM 的短标识。 */
function createStableId(value: string): string {
  let hash = 2166136261
  for (const character of value) {
    hash ^= character.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return Math.abs(hash >>> 0).toString(36)
}

/** 清理 Markdown 行内语法，只保留适合朗读和展示的自然文本。 */
export function cleanInlineMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<https?:\/\/[^>]+>/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[`*_~]/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 将过长句子按次级标点或安全长度继续拆分。 */
function splitLongSentence(sentence: string): string[] {
  if (sentence.length <= MAX_SENTENCE_LENGTH) {
    return [sentence]
  }

  const pieces = sentence.split(/(?<=[，,；;：:])\s*/).filter(Boolean)
  const result: string[] = []
  let buffer = ''

  for (const piece of pieces) {
    if (`${buffer}${piece}`.length <= MAX_SENTENCE_LENGTH) {
      buffer += piece
      continue
    }
    if (buffer) result.push(buffer.trim())
    if (piece.length <= MAX_SENTENCE_LENGTH) {
      buffer = piece
      continue
    }
    for (let index = 0; index < piece.length; index += MAX_SENTENCE_LENGTH) {
      result.push(piece.slice(index, index + MAX_SENTENCE_LENGTH).trim())
    }
    buffer = ''
  }

  if (buffer) result.push(buffer.trim())
  return result.filter(Boolean)
}

/** 按中英文句末标点切分朗读句子，并保留句末标点。 */
export function splitIntoSentences(value: string): string[] {
  const text = cleanInlineMarkdown(value)
  if (!text) return []

  const matches = text.match(
    /[^。！？!?…]+(?:……|[。！？!?…]+[”’」』】）)]*)?|[^。！？!?…]+$/g,
  )
  return (matches ?? [text])
    .flatMap((sentence) => splitLongSentence(sentence.trim()))
    .filter(Boolean)
}

/** 从列表项中递归提取可朗读文本。 */
function extractListText(item: Tokens.ListItem): string {
  return cleanInlineMarkdown(
    item.tokens
      .filter((token) => token.type !== 'space')
      .map((token) => ('text' in token ? String(token.text) : ''))
      .join(' '),
  )
}

/** 将 marked 标记转换为统一的阅读块描述。 */
function tokenToBlock(
  token: Token,
): { type: ReadingBlockType; text: string; level?: number } | null {
  if (token.type === 'heading') {
    return {
      type: 'heading',
      text: cleanInlineMarkdown(token.text),
      level: token.depth,
    }
  }
  if (token.type === 'paragraph' || token.type === 'text') {
    return { type: 'paragraph', text: cleanInlineMarkdown(token.text) }
  }
  if (token.type === 'blockquote') {
    const text = (token.tokens ?? [])
      .map((child) => ('text' in child ? String(child.text) : ''))
      .join(' ')
    return { type: 'quote', text: cleanInlineMarkdown(text) }
  }
  if (token.type === 'list') {
    return {
      type: 'list',
      text: token.items.map(extractListText).filter(Boolean).join('。'),
    }
  }
  if (token.type === 'table') {
    const rows = [token.header, ...token.rows]
    const text = rows
      .map((row: Tokens.TableCell[]) =>
        row
          .map((cell: Tokens.TableCell) => cleanInlineMarkdown(cell.text))
          .filter(Boolean)
          .join('，'),
      )
      .filter(Boolean)
      .join('。')
    return { type: 'table', text }
  }
  return null
}

/** 从文件路径生成没有扩展名和序号前缀的章节备用标题。 */
function titleFromPath(path: string): string {
  const fileName = path.split('/').at(-1) ?? path
  return fileName
    .replace(/\.(md|markdown)$/i, '')
    .replace(/^\d+[\s._-]*/, '')
    .replace(/[-_]+/g, ' ')
    .trim()
}

/** 将 Markdown 文本转换为正文块、逐句队列和章节目录。 */
export function parseMarkdownChapter(
  markdown: string,
  path: string,
  sourceUrl: string,
): Chapter {
  const tokens = new Lexer().lex(markdown)
  const chapterId = `chapter-${createStableId(path)}`
  const blocks: ReadingBlock[] = []
  const sentences: SpeechSentence[] = []
  const sections: ChapterSection[] = []
  let title = ''

  for (const token of tokens) {
    const descriptor = tokenToBlock(token)
    if (!descriptor?.text) continue

    if (!title && descriptor.type === 'heading') {
      title = descriptor.text
    }

    const blockId = `${chapterId}-block-${blocks.length}`
    const blockSentences = splitIntoSentences(descriptor.text).map(
      (text, index) => {
        const order = sentences.length + index
        return {
          id: `${chapterId}-sentence-${order}`,
          domId: `${chapterId}-sentence-${order}`,
          chapterId,
          blockId,
          text,
          order,
        }
      },
    )

    if (blockSentences.length === 0) continue
    if (descriptor.type === 'heading') {
      sections.push({
        id: blockId,
        title: descriptor.text,
        level: descriptor.level ?? 2,
        sentenceIndex: sentences.length,
      })
    }

    blocks.push({
      id: blockId,
      type: descriptor.type,
      level: descriptor.level,
      sentences: blockSentences,
    })
    sentences.push(...blockSentences)
  }

  if (sentences.length === 0) {
    throw new Error(`章节没有可朗读内容：${path}`)
  }

  return {
    id: chapterId,
    title: title || titleFromPath(path) || '未命名章节',
    path,
    sourceUrl,
    blocks,
    sentences,
    sections,
  }
}
