import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('应用挂载节点不存在。')

/** 注册语音运行时缓存 Service Worker，失败时不影响系统语音回退。 */
async function registerVoiceCache(): Promise<void> {
  if (!('serviceWorker' in navigator)) return
  try {
    await navigator.serviceWorker.register(
      `${import.meta.env.BASE_URL}voice-cache-sw.js`,
      { scope: import.meta.env.BASE_URL },
    )
  } catch {
    // 缓存增强不可用时继续运行应用。
  }
}

void registerVoiceCache()

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
