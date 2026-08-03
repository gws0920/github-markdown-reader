import type { SavedReaderState } from '../types'

const STORAGE_PREFIX = 'github-markdown-reader:'

/** 根据来源地址生成隔离的阅读进度存储键。 */
function createStorageKey(sourceUrl: string): string {
  return `${STORAGE_PREFIX}${sourceUrl}`
}

/** 读取指定来源的本地阅读状态，格式异常时安全忽略。 */
export function loadReaderState(sourceUrl: string): SavedReaderState | null {
  try {
    const value = localStorage.getItem(createStorageKey(sourceUrl))
    return value ? (JSON.parse(value) as SavedReaderState) : null
  } catch {
    return null
  }
}

/** 保存指定来源的阅读状态，供刷新后恢复。 */
export function saveReaderState(
  sourceUrl: string,
  state: SavedReaderState,
): void {
  localStorage.setItem(createStorageKey(sourceUrl), JSON.stringify(state))
}
