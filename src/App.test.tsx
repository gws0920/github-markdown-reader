import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { loadGitHubBook } from './lib/github'

vi.mock('./lib/github', () => ({
  loadGitHubBook: vi.fn(),
}))

describe('App startup', () => {
  beforeEach(() => {
    vi.mocked(loadGitHubBook).mockReset()
    window.history.replaceState({}, '', '/')
  })

  afterEach(() => cleanup())

  it('预填示例地址但不自动加载', () => {
    render(<App />)
    expect(screen.getByLabelText('GitHub 公开地址')).toHaveValue(
      'https://github.com/xdash/FDE-the-Guidance-Book-of-Forward-Deployed-Engineer',
    )
    expect(loadGitHubBook).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '开始阅读' })).toBeEnabled()
  })

  it('分享参数只预填地址而不自动加载', () => {
    const sharedSource = 'https://github.com/example/reader/blob/main/01.md'
    window.history.replaceState(
      {},
      '',
      `/?source=${encodeURIComponent(sharedSource)}`,
    )
    render(<App />)
    expect(screen.getByLabelText('GitHub 公开地址')).toHaveValue(sharedSource)
    expect(loadGitHubBook).not.toHaveBeenCalled()
  })
})
