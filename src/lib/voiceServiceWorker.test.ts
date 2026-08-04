import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
})

/** 创建具备 controllerchange 事件能力的 Service Worker 容器测试替身。 */
function createServiceWorkerContainer(
  register: () => Promise<ServiceWorkerRegistration>,
) {
  const events = new EventTarget()
  let controller: ServiceWorker | null = null
  return {
    container: {
      register: vi.fn(register),
      ready: register(),
      get controller() {
        return controller
      },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    },
    /** 设置页面控制器并触发浏览器标准 controllerchange 事件。 */
    takeControl(worker: ServiceWorker) {
      controller = worker
      events.dispatchEvent(new Event('controllerchange'))
    },
  }
}

describe('voiceServiceWorker', () => {
  it('保留 Service Worker 注册失败的原始错误', async () => {
    const registrationError = new Error('registration exploded')
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        register: vi.fn().mockRejectedValue(registrationError),
      },
    })
    const { waitForVoiceCacheControl } = await import('./voiceServiceWorker')

    await expect(waitForVoiceCacheControl(20)).rejects.toThrow(
      /语音缓存服务注册失败[\s\S]*registration exploded/,
    )
  })

  it('页面未受控时请求激活 Worker 主动接管', async () => {
    const activeWorker = { state: 'activated', postMessage: vi.fn() }
    const registration = {
      scope: 'https://example.com/reader/',
      active: activeWorker,
      waiting: null,
      installing: null,
      update: vi.fn().mockResolvedValue(undefined),
    } as unknown as ServiceWorkerRegistration
    const mock = createServiceWorkerContainer(async () => registration)
    activeWorker.postMessage.mockImplementation(() => {
      mock.takeControl(activeWorker as unknown as ServiceWorker)
    })
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: mock.container,
    })
    const { waitForVoiceCacheControl } = await import('./voiceServiceWorker')

    await expect(waitForVoiceCacheControl(50)).resolves.toBe(activeWorker)
    expect(activeWorker.postMessage).toHaveBeenCalledWith({
      type: 'claim-voice-runtime-clients',
    })
  })
})
