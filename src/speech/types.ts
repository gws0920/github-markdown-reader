export type SpeechEngineKind = 'kokoro' | 'browser'
export type SpeechProgressPhase =
  | 'checking-cache'
  | 'downloading-model'
  | 'loading-model'
  | 'starting-runtime'
  | 'initializing-tts'
  | 'generating-audio'

export interface SpeechProgress {
  phase: SpeechProgressPhase
  percent: number
  downloadedBytes: number
  totalBytes: number
  label: string
  source?: 'cdn' | 'pages-fallback' | 'local-resume' | 'local-cache'
  cachedBytes?: number
  chunkIndex?: number
  chunkCount?: number
}

export interface SpeechCallbacks {
  onStart: () => void
  onEnd: () => void
  onError: (error: Error) => void
}

export interface SpeechRequest extends SpeechCallbacks {
  text: string
  rate: number
}

export interface SpeechEngine {
  readonly kind: SpeechEngineKind
  readonly label: string
  activate?: () => void
  initialize: (onProgress?: (progress: SpeechProgress) => void) => Promise<void>
  speak: (request: SpeechRequest) => Promise<void>
  prepare: (text: string, rate: number) => void
  pause: () => void
  resume: () => void
  stop: () => void
  destroy: () => void
}
