import { describe, expect, it } from 'vitest'
import {
  cleanInlineMarkdown,
  parseMarkdownChapter,
  splitIntoSentences,
} from './markdown'

describe('splitIntoSentences', () => {
  it('按中英文句末标点切分并保留标点', () => {
    expect(splitIntoSentences('第一句。第二句！Is it ready? Yes.')).toEqual([
      '第一句。',
      '第二句！',
      'Is it ready?',
      'Yes.',
    ])
  })

  it('清理图片、链接和裸地址', () => {
    expect(
      cleanInlineMarkdown(
        '查看 [正文](https://example.com) ![封面](cover.png) https://example.com/a',
      ),
    ).toBe('查看 正文 封面')
  })

  it('移除神经语音词表不支持的装饰性表情符号', () => {
    expect(cleanInlineMarkdown('重点提示 ❓ 请继续阅读。')).toBe(
      '重点提示 请继续阅读。',
    )
  })

  it('将超长文本继续拆分为安全长度', () => {
    const sentences = splitIntoSentences(`${'很长的内容，'.repeat(60)}结束。`)
    expect(sentences.length).toBeGreaterThan(1)
    expect(sentences.every((sentence) => sentence.length <= 220)).toBe(true)
  })
})

describe('parseMarkdownChapter', () => {
  it('忽略代码并生成稳定句子和小节', () => {
    const markdown = `# 第一章\n\n这是第一句。这是第二句！\n\n## 小节\n\n- 条目一\n- 条目二\n\n\`\`\`ts\nconst hidden = true\n\`\`\``
    const chapter = parseMarkdownChapter(
      markdown,
      '01-first.md',
      'https://example.com/raw',
    )

    expect(chapter.title).toBe('第一章')
    expect(chapter.sections.map((section) => section.title)).toEqual([
      '第一章',
      '小节',
    ])
    expect(
      chapter.sentences.some((sentence) => sentence.text.includes('hidden')),
    ).toBe(false)
    expect(new Set(chapter.sentences.map((sentence) => sentence.id)).size).toBe(
      chapter.sentences.length,
    )
  })
})
