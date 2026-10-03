/**
 * adapter.js 测试：INERT_AUTH 行为、provider 组装、PiAiAdapter 集成。
 * 用真实 devDependencies（宿主同版本 @deepseek-ai/dsh-llm-pi-ai 0.2.0-rc.2）
 * 构造——宿主 0.2.0 契约下构造器能接受这些 options 本身就是一条契约测试。
 * 全部离线：目录由替身 catalog 提供。
 */
import { describe, expect, it } from 'vitest'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { AccessMuxCatalog } from '../catalog.js'
import { ACCESSMUX_STREAM_IDLE_TIMEOUT_MS, INERT_AUTH, createAccessmuxAdapter } from '../adapter.js'

/** @param {Array<{id: string, adapterId: string, shortId: string, name: string}>} models */
function catalogOf(models) {
  const catalog = new AccessMuxCatalog({ baseURL: 'http://127.0.0.1:8080/v1' })
  catalog.models = models
  return catalog
}

const ROSTER = [
  { id: 'workbuddy:hy4-preview', adapterId: 'workbuddy', shortId: 'hy4-preview', name: 'WorkBuddy · hy4-preview' },
  { id: 'trae-cn:glm-5.2', adapterId: 'trae-cn', shortId: 'glm-5.2', name: 'Trae CN · glm-5.2' },
]

describe('INERT_AUTH', () => {
  it('ambient 凭据通道全部回答"nothing stored, nothing set"', async () => {
    await expect(INERT_AUTH.credentials.read()).resolves.toBeUndefined()
    await expect(INERT_AUTH.credentials.list()).resolves.toEqual([])
    await expect(INERT_AUTH.authContext.env()).resolves.toBeUndefined()
    await expect(INERT_AUTH.authContext.fileExists()).resolves.toBe(false)
    await expect(INERT_AUTH.credentials.delete()).resolves.toBeUndefined()
  })

  it('凭据写入被拒绝（该路由没有 pi-ai 凭据生命周期）', async () => {
    await expect(INERT_AUTH.credentials.modify()).rejects.toThrow(/no pi-ai credential lifecycle/)
  })
})

describe('createAccessmuxAdapter', () => {
  it('PiAiAdapter 接受组装结果：listModels 报全格式 id 与显示名', async () => {
    const { adapter } = createAccessmuxAdapter({
      baseURL: 'http://127.0.0.1:8080/v1',
      catalog: catalogOf(ROSTER),
      apiKey: () => 'local',
    })
    expect(adapter).toBeInstanceOf(PiAiAdapter)
    const models = await adapter.listModels('accessmux')
    expect(models.map(m => m.id)).toEqual(['workbuddy:hy4-preview', 'trae-cn:glm-5.2'])
    expect(models.map(m => m.name)).toEqual(['WorkBuddy · hy4-preview', 'Trae CN · glm-5.2'])
    expect(models.every(m => m.provider === 'accessmux')).toBe(true)
  })

  it('模型描述符带守护 baseURL 与保守元数据；其它 provider 报 NO_ADAPTER', async () => {
    const { adapter } = createAccessmuxAdapter({
      baseURL: 'http://127.0.0.1:9099/v1',
      catalog: catalogOf(ROSTER),
    })
    const resolved = await adapter.resolveModel('accessmux', 'workbuddy:hy4-preview')
    expect(resolved.name).toBe('WorkBuddy · hy4-preview')
    expect(resolved.inputModalities).toEqual(['text'])
    expect(resolved.context?.contextWindow).toBe(1_000_000)
    await expect(adapter.resolveModel('other', 'workbuddy:hy4-preview'))
      .rejects.toThrow(/does not own provider "other"/)
    await expect(adapter.listModels('nope')).rejects.toThrow(/NO_ADAPTER|does not own provider/)
  })

  it('resolveApiKey 返回注入的占位 key（pi-ai 据此发 Bearer）', async () => {
    const { adapter } = createAccessmuxAdapter({
      baseURL: 'http://127.0.0.1:8080/v1',
      catalog: catalogOf(ROSTER),
      apiKey: () => 'local',
    })
    // PiAiAdapterOptions.resolveApiKey 的签名经 INERT_AUTH 同构注入；
    // 直接从 config 上调用以锁定契约（provider/profile 参数仅透传）。
    const key = await /** @type {any} */ (adapter).config.resolveApiKey('accessmux', undefined)
    expect(key).toBe('local')
  })

  it('invalidate 换新 profiles 快照（PiAiAdapter 以对象同一性识别失效）', async () => {
    const { adapter, invalidate } = createAccessmuxAdapter({
      baseURL: 'http://127.0.0.1:8080/v1',
      catalog: catalogOf(ROSTER),
    })
    const before = /** @type {any} */ (adapter).config.profiles()
    invalidate()
    const after = /** @type {any} */ (adapter).config.profiles()
    expect(before).not.toBe(after)
    expect(await adapter.listModels('accessmux')).toHaveLength(2)
  })

  it('空目录组仍然注册（守护不可达时宿主隐藏空组，而不是插件消失）', async () => {
    const { adapter } = createAccessmuxAdapter({
      baseURL: 'http://127.0.0.1:8080/v1',
      catalog: catalogOf([]),
    })
    await expect(adapter.listModels('accessmux')).resolves.toEqual([])
  })

  it('流式空闲上限与 workbuddy 路由同值', () => {
    expect(ACCESSMUX_STREAM_IDLE_TIMEOUT_MS).toBe(300_000)
  })
})

describe('首刷落定门（T025 headless 启动竞态：慢刷新 × 快消费）', () => {
  function closedGate() {
    /** @type {(value?: unknown) => void} */
    let open = () => {}
    const promise = new Promise((resolve) => { open = resolve })
    return { promise, open: () => open(undefined) }
  }

  /** @param {Promise<unknown>} pending */
  async function settled(pending) {
    return Promise.race([pending.then(() => true, () => true), new Promise((resolve) => setTimeout(() => resolve(false), 25))])
  }

  const FLASH = { id: 'workbuddy:deepseek-v4.1-flash', adapterId: 'workbuddy', shortId: 'deepseek-v4.1-flash', name: 'WorkBuddy · deepseek-v4.1-flash' }

  it('resolveModel 在首刷落定前挂起：不提前失败也不提前成功，落定后拿到新目录', async () => {
    const catalog = new AccessMuxCatalog({ baseURL: 'http://127.0.0.1:8080/v1' })
    const gate = closedGate()
    const { adapter } = createAccessmuxAdapter({
      baseURL: 'http://127.0.0.1:8080/v1',
      catalog,
      awaitFirstRefresh: () => gate.promise,
    })
    const pending = adapter.resolveModel('accessmux', 'workbuddy:deepseek-v4.1-flash')
    // 消费已发起、目录仍空、门未开：T023 竞态形态下这里会立刻 UNKNOWN_MODEL。
    expect(await settled(pending)).toBe(false)
    catalog.models = [FLASH] // 模拟首刷完成写回目录
    gate.open()
    const resolved = await pending
    expect(resolved.id).toBe('workbuddy:deepseek-v4.1-flash')
    expect(resolved.context?.contextWindow).toBe(1_000_000)
  })

  it('listModels 同样过门：门开且目录就绪后返回完整清单', async () => {
    const catalog = new AccessMuxCatalog({ baseURL: 'http://127.0.0.1:8080/v1' })
    const gate = closedGate()
    const { adapter } = createAccessmuxAdapter({
      baseURL: 'http://127.0.0.1:8080/v1',
      catalog,
      awaitFirstRefresh: () => gate.promise,
    })
    const pending = adapter.listModels('accessmux')
    expect(await settled(pending)).toBe(false)
    catalog.models = [...ROSTER, FLASH]
    gate.open()
    expect((await pending).map(m => m.id)).toEqual(['workbuddy:hy4-preview', 'trae-cn:glm-5.2', 'workbuddy:deepseek-v4.1-flash'])
  })

  it('prepareCall 过门后才解析模型（首个 next 在门前不落定）', async () => {
    const catalog = new AccessMuxCatalog({ baseURL: 'http://127.0.0.1:8080/v1' })
    const gate = closedGate()
    const { adapter } = createAccessmuxAdapter({
      baseURL: 'http://127.0.0.1:8080/v1',
      catalog,
      awaitFirstRefresh: () => gate.promise,
    })
    const pending = adapter.prepareCall('accessmux', 'workbuddy:deepseek-v4.1-flash')
    expect(await settled(pending)).toBe(false)
    catalog.models = [FLASH]
    gate.open()
    const prepared = await pending
    expect(prepared.model.id).toBe('workbuddy:deepseek-v4.1-flash')
  })

  it('stream 首块过门；门开但目录仍空时给的是空目录的诚实错误（UNKNOWN_MODEL），不是竞态期的假空目录', async () => {
    const catalog = new AccessMuxCatalog({ baseURL: 'http://127.0.0.1:9/v1' }) // 死端口：不该走到网络
    const gate = closedGate()
    const { adapter } = createAccessmuxAdapter({
      baseURL: 'http://127.0.0.1:9/v1',
      catalog,
      awaitFirstRefresh: () => gate.promise,
    })
    const first = adapter.stream({
      provider: 'accessmux',
      model: 'workbuddy:deepseek-v4.1-flash',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'QPROBE' }] }],
    })[Symbol.asyncIterator]().next()
    expect(await settled(first)).toBe(false)
    gate.open() // 首刷"落定但失败"：目录仍空
    await expect(first).rejects.toThrow(/has no configured model/)
  })

  it('门 promise 拒绝也放行（刷新链意外拒绝不挂死消费）', async () => {
    const catalog = new AccessMuxCatalog({ baseURL: 'http://127.0.0.1:8080/v1' })
    /** @type {(reason?: unknown) => void} */
    let rejectGate = () => {}
    const promise = new Promise((_, reject) => { rejectGate = reject })
    const { adapter } = createAccessmuxAdapter({
      baseURL: 'http://127.0.0.1:8080/v1',
      catalog,
      awaitFirstRefresh: () => promise,
    })
    const pending = adapter.resolveModel('accessmux', 'workbuddy:hy4-preview')
    catalog.models = ROSTER
    rejectGate(new Error('unexpected'))
    await expect(pending).resolves.toMatchObject({ id: 'workbuddy:hy4-preview' })
  })
})
