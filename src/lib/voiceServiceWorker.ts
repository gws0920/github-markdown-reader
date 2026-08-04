let registrationPromise: Promise<ServiceWorkerRegistration | null> | null = null

/** 注册语音缓存 Service Worker，并在当前会话中复用注册 Promise。 */
export function registerVoiceCache(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return Promise.resolve(null)
  registrationPromise ??= navigator.serviceWorker
    .register(`${import.meta.env.BASE_URL}voice-cache-sw.js`, {
      scope: import.meta.env.BASE_URL,
    })
    .catch(() => null)
  return registrationPromise
}

/** 等待 Service Worker 激活并取得当前页面控制权，避免大模型绕过缓存直连。 */
export async function waitForVoiceCacheControl(
  timeoutMs = 10000,
): Promise<ServiceWorker> {
  const registration = await registerVoiceCache()
  if (!registration) throw new Error('浏览器无法启动语音缓存服务。')
  await navigator.serviceWorker.ready
  if (navigator.serviceWorker.controller) {
    return navigator.serviceWorker.controller
  }
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      navigator.serviceWorker.removeEventListener(
        'controllerchange',
        handleControllerChange,
      )
      reject(new Error('语音缓存服务未能接管当前页面。'))
    }, timeoutMs)

    /** 在 Service Worker 接管页面后结束等待。 */
    function handleControllerChange(): void {
      const controller = navigator.serviceWorker.controller
      if (!controller) return
      window.clearTimeout(timer)
      navigator.serviceWorker.removeEventListener(
        'controllerchange',
        handleControllerChange,
      )
      resolve(controller)
    }

    navigator.serviceWorker.addEventListener(
      'controllerchange',
      handleControllerChange,
    )
  })
}

/** 向当前 Service Worker 发送请求并等待 MessageChannel 响应。 */
export async function requestVoiceCache<T>(
  message: object,
  timeoutMs = 10000,
): Promise<T> {
  const controller = await waitForVoiceCacheControl()
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel()
    const timer = window.setTimeout(
      () => reject(new Error('语音缓存操作超时。')),
      timeoutMs,
    )
    channel.port1.onmessage = (event: MessageEvent<T>) => {
      window.clearTimeout(timer)
      resolve(event.data)
    }
    controller.postMessage(message, [channel.port2])
  })
}
