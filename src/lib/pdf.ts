import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
} from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { splitIntoSentences } from './markdown'
import type { Chapter, PdfSource, ReadingBlock, SpeechSentence } from '../types'

const MAX_PDF_BYTES = 150 * 1024 * 1024

GlobalWorkerOptions.workerSrc = pdfWorkerUrl

interface PdfTextItem {
  str: string
  hasEOL?: boolean
  transform?: number[]
  width?: number
  height?: number
}

interface PdfTextLine {
  text: string
  x: number
  y: number
  height: number
}

interface LoadedPdfBook {
  source: PdfSource
  chapters: Chapter[]
  sourceKey: string
}

/** 将 PDF 文件大小格式化为适合来源信息展示的文本。 */
function formatPdfSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 判断两个相邻字符是否应直接拼接，避免给中文字符之间插入多余空格。 */
function shouldJoinWithoutSpace(previous: string, next: string): boolean {
  return (
    /[\p{Script=Han}，。！？；：、“”‘’（）【】]/u.test(previous) ||
    /[\p{Script=Han}，。！？；：、“”‘’（）【】]/u.test(next)
  )
}

/** 将同一视觉行内的 PDF 文本项按中英文排版规则拼接。 */
function joinPdfLineItems(items: PdfTextItem[]): string {
  let text = ''
  items.forEach((item) => {
    const value = item.str.trim()
    if (!value) return
    const previous = text.trimEnd().at(-1) ?? ''
    const next = value.at(0) ?? ''
    const separator = !text || shouldJoinWithoutSpace(previous, next) ? '' : ' '
    text += `${separator}${value}`
  })
  return text.trim()
}

/** 根据文本项坐标恢复 PDF 的视觉行，并兼容缺少坐标的旧测试数据。 */
function createPdfTextLines(items: PdfTextItem[]): PdfTextLine[] {
  const positioned = items.some((item) => item.transform?.length)
  if (!positioned) {
    const lines: PdfTextLine[] = []
    let current: PdfTextItem[] = []
    items.forEach((item) => {
      current.push(item)
      if (item.hasEOL) {
        lines.push({ text: joinPdfLineItems(current), x: 0, y: 0, height: 12 })
        current = []
      }
    })
    if (current.length)
      lines.push({ text: joinPdfLineItems(current), x: 0, y: 0, height: 12 })
    return lines.filter((line) => line.text)
  }

  const rows: Array<{ y: number; items: PdfTextItem[] }> = []
  items
    .filter((item) => item.str.trim())
    .sort((left, right) => {
      const yDiff = (right.transform?.[5] ?? 0) - (left.transform?.[5] ?? 0)
      return Math.abs(yDiff) > 2
        ? yDiff
        : (left.transform?.[4] ?? 0) - (right.transform?.[4] ?? 0)
    })
    .forEach((item) => {
      const y = item.transform?.[5] ?? 0
      const row = rows.find((candidate) => Math.abs(candidate.y - y) <= 2)
      if (row) row.items.push(item)
      else rows.push({ y, items: [item] })
    })

  return rows.map((row) => {
    const sorted = row.items.sort(
      (left, right) => (left.transform?.[4] ?? 0) - (right.transform?.[4] ?? 0),
    )
    return {
      text: joinPdfLineItems(sorted),
      x: sorted[0]?.transform?.[4] ?? 0,
      y: row.y,
      height: Math.max(...sorted.map((item) => item.height ?? 12)),
    }
  })
}

/** 判断当前视觉行是否应开启新段落，保留明显行距、缩进和完整句末。 */
function shouldStartPdfParagraph(
  previous: PdfTextLine,
  current: PdfTextLine,
  baseX: number,
): boolean {
  const verticalGap = previous.y - current.y
  const typicalHeight = Math.max(previous.height, current.height, 10)
  const indented = current.x - baseX > typicalHeight * 0.9
  const previousEnded = /[。！？；.!?;：:]([”’」』】）》])?$/.test(
    previous.text,
  )
  return verticalGap > typicalHeight * 1.65 || indented || previousEnded
}

/** 将 PDF.js 文本项恢复为带段落分隔的可读文本。 */
export function joinPdfTextItems(items: PdfTextItem[]): string {
  const lines = createPdfTextLines(items)
  if (!lines.length) return ''
  const baseX = Math.min(...lines.map((line) => line.x))
  const paragraphs: string[] = []
  let paragraph = ''

  lines.forEach((line, index) => {
    const previous = lines[index - 1]
    if (previous && shouldStartPdfParagraph(previous, line, baseX)) {
      if (paragraph.trim()) paragraphs.push(paragraph.trim())
      paragraph = ''
    }
    if (/^[A-Za-z]/.test(line.text) && /[A-Za-z]-$/.test(paragraph)) {
      paragraph = paragraph.slice(0, -1) + line.text
      return
    }
    const previousCharacter = paragraph.trimEnd().at(-1) ?? ''
    const nextCharacter = line.text.at(0) ?? ''
    const separator =
      !paragraph || shouldJoinWithoutSpace(previousCharacter, nextCharacter)
        ? ''
        : ' '
    paragraph += `${separator}${line.text}`
  })
  if (paragraph.trim()) paragraphs.push(paragraph.trim())
  return paragraphs.join('\n\n')
}

/** 将单页纯文本转换为与 Markdown 阅读器一致的章节、正文块和句子模型。 */
export function createPdfPageChapter(
  text: string,
  pageNumber: number,
  documentName: string,
  sourceUrl: string,
  previewUrl?: string,
): Chapter | null {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
  if (paragraphs.length === 0) return null

  const chapterId = `pdf-page-${pageNumber}`
  const title = `${documentName} · 第 ${pageNumber} 页`
  const blocks: ReadingBlock[] = []
  const sentences: SpeechSentence[] = []
  const allParagraphs = [title, ...paragraphs]

  allParagraphs.forEach((paragraph, blockIndex) => {
    const blockId = `${chapterId}-block-${blockIndex}`
    const blockSentences = splitIntoSentences(paragraph).map(
      (sentenceText, sentenceOffset) => {
        const order = sentences.length + sentenceOffset
        return {
          id: `${chapterId}-sentence-${order}`,
          domId: `${chapterId}-sentence-${order}`,
          chapterId,
          blockId,
          text: sentenceText,
          order,
        }
      },
    )
    if (blockSentences.length === 0) return
    blocks.push({
      id: blockId,
      type: blockIndex === 0 ? 'heading' : 'paragraph',
      level: blockIndex === 0 ? 1 : undefined,
      sentences: blockSentences,
    })
    sentences.push(...blockSentences)
  })

  return {
    id: chapterId,
    title,
    path: `page-${pageNumber}`,
    sourceUrl,
    blocks,
    sentences,
    sections: [
      {
        id: `${chapterId}-block-0`,
        title,
        level: 1,
        sentenceIndex: 0,
      },
    ],
    previewUrl,
  }
}

/** 将 PDF 页面渲染为轻量 JPEG 预览，保留页面中的图片、表格和原始版式。 */
async function renderPdfPagePreview(
  page: Awaited<ReturnType<PDFDocumentProxy['getPage']>>,
): Promise<string> {
  const naturalViewport = page.getViewport({ scale: 1 })
  const scale = Math.min(1.6, 1200 / naturalViewport.width)
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(viewport.width)
  canvas.height = Math.ceil(viewport.height)
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) throw new Error('浏览器无法创建 PDF 页面预览。')
  await page.render({ canvas, canvasContext: context, viewport }).promise
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (result) =>
        result ? resolve(result) : reject(new Error('PDF 页面预览生成失败。')),
      'image/jpeg',
      0.82,
    )
  })
  return URL.createObjectURL(blob)
}

/** 校验二进制内容是否具有 PDF 文件签名。 */
function assertPdfSignature(data: ArrayBuffer): void {
  const signature = new TextDecoder('latin1').decode(data.slice(0, 5))
  if (signature !== '%PDF-') {
    throw new Error('读取到的内容不是有效的 PDF 文件。')
  }
}

/** 从 PDF 文档逐页提取文本，并忽略没有文本层的空白页。 */
async function extractPdfChapters(
  document: PDFDocumentProxy,
  documentName: string,
  sourceUrl: string,
): Promise<Chapter[]> {
  const chapters: Chapter[] = []

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber)
    const content = await page.getTextContent()
    const items: PdfTextItem[] = content.items.flatMap((item) =>
      'str' in item
        ? [
            {
              str: item.str,
              hasEOL: item.hasEOL,
              transform: item.transform,
              width: item.width,
              height: item.height,
            },
          ]
        : [],
    )
    const previewUrl = await renderPdfPagePreview(page)
    const chapter = createPdfPageChapter(
      joinPdfTextItems(items),
      pageNumber,
      documentName,
      sourceUrl,
      previewUrl,
    )
    if (chapter) chapters.push(chapter)
    page.cleanup()
  }

  if (chapters.length === 0) {
    throw new Error('PDF 没有可提取的文字，可能是扫描件或纯图片文档。')
  }
  return chapters
}

/** 解析 PDF 二进制并生成可供播放器消费的章节列表。 */
async function parsePdfData(
  data: ArrayBuffer,
  documentName: string,
  sourceUrl: string,
): Promise<Chapter[]> {
  assertPdfSignature(data)
  const loadingTask = getDocument({ data })
  const document = await loadingTask.promise
  try {
    return await extractPdfChapters(document, documentName, sourceUrl)
  } finally {
    await document.destroy()
  }
}

/** 从 URL 路径提取 PDF 文件名，并为无文件名链接提供稳定标题。 */
function getPdfNameFromUrl(url: URL): string {
  const fileName = decodeURIComponent(url.pathname.split('/').at(-1) ?? '')
  return fileName.replace(/\.pdf$/i, '') || url.hostname
}

/** 加载支持跨域访问的公开 PDF 链接并转换为朗读章节。 */
export async function loadPdfUrl(value: string): Promise<LoadedPdfBook> {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('请输入完整的 PDF 链接。')
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('PDF 链接仅支持 HTTP 或 HTTPS。')
  }

  let response: Response
  try {
    response = await fetch(url.href)
  } catch {
    throw new Error('无法下载 PDF，请确认链接公开且允许跨域访问。')
  }
  if (!response.ok) {
    throw new Error(`PDF 下载失败（${response.status}）。`)
  }
  const length = Number(response.headers.get('content-length') ?? 0)
  if (length > MAX_PDF_BYTES) {
    throw new Error('PDF 超过 150 MB，请选择更小的文件。')
  }

  const data = await response.arrayBuffer()
  if (data.byteLength > MAX_PDF_BYTES) {
    throw new Error('PDF 超过 150 MB，请选择更小的文件。')
  }
  const name = getPdfNameFromUrl(url)
  return {
    source: {
      sourceType: 'pdf',
      origin: 'url',
      name,
      detail: url.hostname,
      originalUrl: url.href,
    },
    chapters: await parsePdfData(data, name, url.href),
    sourceKey: url.href,
  }
}

/** 加载用户选择的本地 PDF 文件，所有解析均在浏览器中完成。 */
export async function loadPdfFile(file: File): Promise<LoadedPdfBook> {
  if (
    !file.name.toLowerCase().endsWith('.pdf') &&
    file.type !== 'application/pdf'
  ) {
    throw new Error('请选择 PDF 文件。')
  }
  if (file.size > MAX_PDF_BYTES) {
    throw new Error('PDF 超过 150 MB，请选择更小的文件。')
  }
  const name = file.name.replace(/\.pdf$/i, '') || '本地 PDF'
  return {
    source: {
      sourceType: 'pdf',
      origin: 'file',
      name,
      detail: `${formatPdfSize(file.size)} · 本地文件`,
      originalUrl: '',
    },
    chapters: await parsePdfData(await file.arrayBuffer(), name, ''),
    sourceKey: `pdf-file:${file.name}:${file.size}:${file.lastModified}`,
  }
}
