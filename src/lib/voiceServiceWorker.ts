let registrationPromise: Promise<ServiceWorkerRegistration | null> | null = null

/** 将未知异常转换为可展示的完整错误文本。 */
function formatServiceWorkerError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ? `${error.message}\n${error.stack}` : error.message
  }
  return String(error)
}

/** 为 Service Worker 操作增加超时，避免浏览器状态异常时永久等待。 */
function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), timeoutMs)
    promise.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        window.clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** 收集当前页面与 Service Worker 注册状态，供错误详情定位。 */
function describeRegistration(
  registration: ServiceWorkerRegistration | null,
): string {
  return [
    `页面：${window.location.href}`,
    `安全上下文：${window.isSecureContext ? '是' : '否'}`,
    `注册范围：${registration?.scope ?? '无'}`,
    `controller：${navigator.serviceWorker.controller?.scriptURL ?? '无'}`,
    `active：${registration?.active?.state ?? '无'}`,
    `waiting：${registration?.waiting?.state ?? '无'}`,
    `installing：${registration?.installing?.state ?? '无'}`,
  ].join('\n')
}

/** 等待当前页面取得 Service Worker 控制权，并在事件竞争时重复检查 controller。 */
function waitForController(timeoutMs: number): Promise<ServiceWorker> {
  const current = navigator.serviceWorker.controller
  if (current) return Promise.resolve(current)
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup()
      reject(new Error(`等待页面接管超过 ${timeoutMs}ms。`))
    }, timeoutMs)

    /** 清除控制权监听和计时器。 */
    function cleanup(): void {
      window.clearTimeout(timer)
      navigator.serviceWorker.removeEventListener(
        'controllerchange',
        handleControllerChange,
      )
    }

    /** 在 controllerchange 后读取真实控制器并结束等待。 */
    function handleControllerChange(): void {
      const controller = navigator.serviceWorker.controller
      if (!controller) return
      cleanup()
      resolve(controller)
    }

    navigator.serviceWorker.addEventListener(
      'controllerchange',
      handleControllerChange,
    )
    handleControllerChange()
  })
}

/** 注册语音缓存 Service Worker，并保留原始注册错误用于诊断。 */
export function registerVoiceCache(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return Promise.resolve(null)
  registrationPromise ??= navigator.serviceWorker
    .register(`${import.meta.env.BASE_URL}voice-cache-sw.js`, {
      scope: import.meta.env.BASE_URL,
    })
    .catch((error) => {
      registrationPromise = null
      console.error('[VoiceServiceWorker] 注册失败', error)
      throw new Error(
        `语音缓存服务注册失败。\n${formatServiceWorkerError(error)}`,
      )
    })
  return registrationPromise
}

/** 等待 Service Worker 激活并主动请求接管，失败时返回完整诊断信息。 */
export async function waitForVoiceCacheControl(
  timeoutMs = 15000,
): Promise<ServiceWorker> {
  if (!('serviceWorker' in navigator)) {
    throw new Error('当前浏览器不支持 Service Worker，无法启用本地自然语音。')
  }

  let registration: ServiceWorkerRegistration | null = null
  try {
    registration = await registerVoiceCache()
    if (!registration) throw new Error('浏览器没有返回语音缓存注册实例。')
    await withTimeout(
      navigator.serviceWorker.ready,
      timeoutMs,
      '语音缓存服务激活超时。',
    )
    if (navigator.serviceWorker.controller) {
      return navigator.serviceWorker.controller
    }

    registration.active?.postMessage({ type: 'claim-voice-runtime-clients' })
    try {
      return await waitForController(timeoutMs)
    } catch {
      await registration.update()
      registration.waiting?.postMessage({ type: 'activate-voice-runtime-now' })
      registration.active?.postMessage({ type: 'claim-voice-runtime-clients' })
      return await waitForController(timeoutMs)
    }
  } catch (error) {
    console.error('[VoiceServiceWorker] 页面接管失败', {
      error,
      diagnostic: describeRegistration(registration),
    })
    throw new Error(
      `语音缓存服务未能接管当前页面。\n${formatServiceWorkerError(error)}\n${describeRegistration(registration)}`,
    )
  }
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
