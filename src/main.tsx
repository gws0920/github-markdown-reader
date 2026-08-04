import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { registerVoiceCache } from './lib/voiceServiceWorker'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('应用挂载节点不存在。')

void registerVoiceCache()

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
