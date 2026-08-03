export type GitHubSourceKind = 'repository' | 'directory' | 'file'

export interface GitHubSource {
  owner: string
  repo: string
  branch: string
  path: string
  kind: GitHubSourceKind
  originalUrl: string
}

export interface ParsedGitHubUrl {
  owner: string
  repo: string
  kind: GitHubSourceKind
  remainder: string[]
  originalUrl: string
}

export type ReadingBlockType =
  'heading' | 'paragraph' | 'list' | 'quote' | 'table'

export interface SpeechSentence {
  id: string
  domId: string
  chapterId: string
  blockId: string
  text: string
  order: number
}

export interface ReadingBlock {
  id: string
  type: ReadingBlockType
  level?: number
  sentences: SpeechSentence[]
}

export interface ChapterSection {
  id: string
  title: string
  level: number
  sentenceIndex: number
}

export interface Chapter {
  id: string
  title: string
  path: string
  sourceUrl: string
  blocks: ReadingBlock[]
  sentences: SpeechSentence[]
  sections: ChapterSection[]
}

export type PlaybackStatus = 'idle' | 'playing' | 'paused' | 'error'

export interface SavedReaderState {
  chapterPath: string
  sentenceIndex: number
  rate: number
  voiceURI: string
  continuous: boolean
}
