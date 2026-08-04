import { describe, expect, it, vi } from 'vitest'

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(),
}))
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({
  default: '/pdf.worker.mjs',
}))

import { createPdfPageChapter, joinPdfTextItems } from './pdf'

describe('PDF text conversion', () => {
  it('拼接中文文本项时不插入多余空格', () => {
    expect(
      joinPdfTextItems([
        { str: '这是' },
        { str: '中文' },
        { str: 'PDF。', hasEOL: true },
        { str: 'Next' },
        { str: 'page' },
      ]),
    ).toBe('这是中文PDF。\n\nNext page')
  })

  it('合并英文 PDF 的行尾断词', () => {
    expect(
      joinPdfTextItems([
        { str: 'virtual ma-', hasEOL: true },
        { str: 'chines provide', hasEOL: true },
        { str: 'better performance.' },
      ]),
    ).toBe('virtual machines provide better performance.')
  })

  it('按视觉行距恢复 PDF 段落', () => {
    expect(
      joinPdfTextItems([
        { str: '第一段第一行', transform: [1, 0, 0, 1, 20, 100], height: 10 },
        { str: '继续内容。', transform: [1, 0, 0, 1, 20, 88], height: 10 },
        { str: '第二段。', transform: [1, 0, 0, 1, 20, 62], height: 10 },
      ]),
    ).toBe('第一段第一行继续内容。\n\n第二段。')
  })

  it('按首行缩进恢复 PDF 段落', () => {
    expect(
      joinPdfTextItems([
        { str: '上一段内容', transform: [1, 0, 0, 1, 20, 100], height: 10 },
        { str: '新段落内容', transform: [1, 0, 0, 1, 32, 88], height: 10 },
      ]),
    ).toBe('上一段内容\n\n新段落内容')
  })

  it('将 PDF 页面转换为可逐句朗读的章节', () => {
    const chapter = createPdfPageChapter(
      '第一句话。第二句话！',
      2,
      '测试文档',
      'https://example.com/book.pdf',
    )

    expect(chapter?.title).toBe('测试文档 · 第 2 页')
    expect(chapter?.path).toBe('page-2')
    expect(chapter?.sentences.map((sentence) => sentence.text)).toEqual([
      '测试文档 · 第 2 页',
      '第一句话。',
      '第二句话！',
    ])
  })

  it('忽略没有文本层的空白页面', () => {
    expect(createPdfPageChapter('   ', 1, '扫描件', '')).toBeNull()
  })
})
