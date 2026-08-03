import type { SpeechEngine, SpeechProgress, SpeechRequest } from './types'

/** 使用浏览器 Web Speech API 提供无需模型下载的兼容朗读能力。 */
export class BrowserSpeechEngine implements SpeechEngine {
  readonly kind = 'browser' as const
  readonly label = '系统语音（兼容模式）'
  private utterance: SpeechSynthesisUtterance | null = null
  private voice: SpeechSynthesisVoice | null = null

  /** 检查浏览器语音能力并选择可用的中文声音。 */
  async initialize(
    onProgress?: (progress: SpeechProgress) => void,
  ): Promise<void> {
    void onProgress
    if (
      !('speechSynthesis' in window) ||
      !('SpeechSynthesisUtterance' in window)
    ) {
      throw new Error('当前浏览器不支持系统语音朗读。')
    }
    this.voice = this.findPreferredVoice()
  }

  /** 播放单句文本，并将浏览器语音事件转为统一回调。 */
  async speak(request: SpeechRequest): Promise<void> {
    this.stop()
    const utterance = new SpeechSynthesisUtterance(request.text)
    utterance.lang = 'zh-CN'
    utterance.rate = request.rate
    if (this.voice) utterance.voice = this.voice
    utterance.onstart = request.onStart
    utterance.onend = request.onEnd
    utterance.onerror = (event) => {
      if (event.error === 'canceled' || event.error === 'interrupted') return
      request.onError(new Error('系统语音播放意外中断。'))
    }
    this.utterance = utterance
    window.speechSynthesis.speak(utterance)
  }

  /** 系统语音无需预生成，保留空实现以满足统一接口。 */
  prepare(text: string, rate: number): void {
    void text
    void rate
  }

  /** 暂停系统正在播放的语音。 */
  pause(): void {
    window.speechSynthesis.pause()
  }

  /** 恢复系统暂停的语音。 */
  resume(): void {
    window.speechSynthesis.resume()
  }

  /** 取消系统语音队列并释放当前实例。 */
  stop(): void {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel()
    this.utterance = null
  }

  /** 销毁浏览器语音引擎并停止播放。 */
  destroy(): void {
    this.stop()
  }

  /** 从系统声音列表中优先选择中国大陆中文声音。 */
  private findPreferredVoice(): SpeechSynthesisVoice | null {
    const voices = window.speechSynthesis.getVoices()
    return (
      voices.find((voice) => voice.lang.toLowerCase() === 'zh-cn') ??
      voices.find((voice) => voice.lang.toLowerCase().startsWith('zh')) ??
      null
    )
  }
}
