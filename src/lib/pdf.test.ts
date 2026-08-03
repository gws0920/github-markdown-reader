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
    ).toBe('这是中文PDF。 Next page')
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
