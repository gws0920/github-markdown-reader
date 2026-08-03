import { describe, expect, it } from 'vitest'
import { parseGitHubUrl } from './github'

describe('parseGitHubUrl', () => {
  it('解析仓库根地址', () => {
    expect(parseGitHubUrl('https://github.com/example/reader')).toMatchObject({
      owner: 'example',
      repo: 'reader',
      kind: 'repository',
      remainder: [],
    })
  })

  it('解析中文目录地址并保留分支候选段', () => {
    expect(
      parseGitHubUrl(
        'https://github.com/example/reader/tree/feature/audio/%E7%AB%A0%E8%8A%82',
      ),
    ).toMatchObject({
      kind: 'directory',
      remainder: ['feature', 'audio', '章节'],
    })
  })

  it('解析 Markdown 文件地址', () => {
    expect(
      parseGitHubUrl('https://github.com/example/reader/blob/main/docs/01.md'),
    ).toMatchObject({
      kind: 'file',
      remainder: ['main', 'docs', '01.md'],
    })
  })

  it('拒绝非 GitHub 地址', () => {
    expect(() => parseGitHubUrl('https://example.com/owner/repo')).toThrow(
      '目前只支持 github.com 的公开地址。',
    )
  })
})
