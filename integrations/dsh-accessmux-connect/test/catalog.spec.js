/**
 * catalog.js 纯逻辑测试：目录解析、元数据补齐、活目录降级与单飞。
 * 全部离线（fetch 用注入替身），不 import 任何宿主包。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  AccessMuxCatalog,
  fetchModels,
  modelInfoOf,
  modelMeta,
  parseModelsResponse,
} from '../catalog.js'

/** 守护 /v1/models 的标准响应形状。 */
const WIRE = {
  object: 'list',
  data: [
    { id: 'workbuddy:hy4-preview', object: 'model', owned_by: 'workbuddy' },
    { id: 'trae-cn:glm-5.2', object: 'model', owned_by: 'trae-cn' },
    { id: 'trae-global:gpt-5.4', object: 'model', owned_by: 'trae-global' },
  ],
}

/** @param {unknown} body @param {number} [status] */
function jsonResponse(body, status = 200) {
  return /** @type {Response} */ ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })
}

describe('parseModelsResponse', () => {
  it('解析标准响应并把三来源翻成带显示名的目录行', () => {
    const models = parseModelsResponse(WIRE)
    expect(models.map(m => m.id)).toEqual([
      'workbuddy:hy4-preview',
      'trae-cn:glm-5.2',
      'trae-global:gpt-5.4',
    ])
    expect(models[0]).toMatchObject({
      adapterId: 'workbuddy',
      shortId: 'hy4-preview',
      name: 'WorkBuddy · hy4-preview',
    })
    expect(models[1].name).toBe('Trae CN · glm-5.2')
    expect(models[2].name).toBe('Trae Global · gpt-5.4')
  })

  it('未知来源保留原段名而不是丢弃', () => {
    const models = parseModelsResponse({ data: [{ id: 'future-src:x' }] })
    expect(models).toHaveLength(1)
    expect(models[0].name).toBe('future-src · x')
  })

  it('优先保留 daemon 的 display_name/name 优惠标签，同时维持原始 wire id', () => {
    const [model] = parseModelsResponse({ data: [{
      id: 'workbuddy:hy4-preview', name: 'Hy4 preview · 夜间免费 · WorkBuddy', display_name: 'Hy4 preview · 夜间免费 · WorkBuddy',
    }] })
    expect(model).toMatchObject({ id: 'workbuddy:hy4-preview', name: 'Hy4 preview · 夜间免费 · WorkBuddy' })
  })

  it('跳过坏行而不是整次失败', () => {
    const models = parseModelsResponse({
      data: [
        null,
        {},
        { id: 42 },
        { id: 'no-separator' },
        { id: ':leading-empty' },
        { id: 'trailing:' },
        { id: 'workbuddy:ok' },
      ],
    })
    expect(models.map(m => m.id)).toEqual(['workbuddy:ok'])
  })

  it('非对象/缺 data 返回空数组', () => {
    expect(parseModelsResponse(null)).toEqual([])
    expect(parseModelsResponse('nope')).toEqual([])
    expect(parseModelsResponse({})).toEqual([])
  })
})

describe('modelInfoOf / modelMeta', () => {
  it('id 必须含非空两段', () => {
    expect(modelInfoOf('workbuddy:glm-5.3')).toBeDefined()
    expect(modelInfoOf('nocolon')).toBeUndefined()
    expect(modelInfoOf(':lead')).toBeUndefined()
    expect(modelInfoOf('trail:')).toBeUndefined()
  })

  it('workbuddy 用 1M/64K 预算，trae 用 200K/32K，全部 text-only', () => {
    expect(modelMeta('workbuddy:hy4-preview')).toEqual({
      contextWindow: 1_000_000,
      maxTokens: 64_000,
      input: ['text'],
    })
    expect(modelMeta('trae-cn:glm-5.2')).toEqual({
      contextWindow: 200_000,
      maxTokens: 32_000,
      input: ['text'],
    })
    expect(modelMeta('trae-global:gpt-5.4').input).toEqual(['text'])
    // 未知来源按 trae 的保守值兜底
    expect(modelMeta('future-src:x').contextWindow).toBe(200_000)
  })
})

describe('fetchModels', () => {
  it('请求落在 baseURL 的 models 路径并解析响应', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(WIRE))
    const models = await fetchModels('http://127.0.0.1:8080/v1', { fetchImpl })
    expect(models).toHaveLength(3)
    const call = /** @type {unknown[]} */ (fetchImpl.mock.calls[0])
    expect(String(call[0])).toBe('http://127.0.0.1:8080/v1/models')
  })

  it('非 200 抛错', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'x' }, 503))
    await expect(fetchModels('http://127.0.0.1:8080/v1', { fetchImpl }))
      .rejects.toThrow(/responded 503/)
  })

  it('网络失败原样抛出', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    })
    await expect(fetchModels('http://127.0.0.1:8080/v1', { fetchImpl }))
      .rejects.toThrow('ECONNREFUSED')
  })
})

describe('AccessMuxCatalog', () => {
  it('刷新成功后清单可见；id 无变化时再刷返回 false', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(WIRE))
    const catalog = new AccessMuxCatalog({ baseURL: 'http://127.0.0.1:8080/v1', fetchImpl })
    expect(catalog.current()).toEqual([])
    await expect(catalog.refresh()).resolves.toBe(true)
    expect(catalog.current()).toHaveLength(3)
    expect(catalog.lastError).toBeUndefined()
    await expect(catalog.refresh()).resolves.toBe(false)
  })

  it('同一原始 id 的公开显示名变化会更新模型选择器目录', async () => {
    let payload = { object: 'list', data: [{ id: 'workbuddy:hy4-preview', display_name: 'Hy4 preview · 夜间免费 · WorkBuddy' }] }
    const fetchImpl = vi.fn(async () => jsonResponse(payload))
    const catalog = new AccessMuxCatalog({ baseURL: 'http://127.0.0.1:8080/v1', fetchImpl })
    await catalog.refresh()
    payload = { object: 'list', data: [{ id: 'workbuddy:hy4-preview', display_name: 'Hy4 preview · 免费 · WorkBuddy' }] }
    await expect(catalog.refresh()).resolves.toBe(true)
    expect(catalog.current()[0]).toMatchObject({ id: 'workbuddy:hy4-preview', name: 'Hy4 preview · 免费 · WorkBuddy' })
  })

  it('清单变化（增删）时再刷返回 true', async () => {
    let roster = WIRE
    const fetchImpl = vi.fn(async () => jsonResponse(roster))
    const catalog = new AccessMuxCatalog({ baseURL: 'http://127.0.0.1:8080/v1', fetchImpl })
    await catalog.refresh()
    roster = { object: 'list', data: [WIRE.data[0]] }
    await expect(catalog.refresh()).resolves.toBe(true)
    expect(catalog.current()).toHaveLength(1)
  })

  it('守护不可达：保留旧清单、记录 lastError、返回 false', async () => {
    let healthy = true
    const fetchImpl = vi.fn(async () => {
      if (!healthy) throw new Error('ECONNREFUSED')
      return jsonResponse(WIRE)
    })
    const catalog = new AccessMuxCatalog({ baseURL: 'http://127.0.0.1:8080/v1', fetchImpl })
    await catalog.refresh()
    expect(catalog.current()).toHaveLength(3)
    healthy = false
    await expect(catalog.refresh()).resolves.toBe(false)
    expect(catalog.current()).toHaveLength(3)
    expect(catalog.lastError).toBe('ECONNREFUSED')
    // 恢复后自愈
    healthy = true
    await expect(catalog.refresh()).resolves.toBe(false) // 清单没变（同一份）
    expect(catalog.lastError).toBeUndefined()
  })

  it('并发刷新单飞：只发一个请求', async () => {
    /** @type {(value?: unknown) => void} */
    let release = () => {}
    const gate = new Promise(resolve => {
      release = resolve
    })
    const fetchImpl = vi.fn(async () => {
      await gate
      return jsonResponse(WIRE)
    })
    const catalog = new AccessMuxCatalog({ baseURL: 'http://127.0.0.1:8080/v1', fetchImpl })
    const [a, b] = [catalog.refresh(), catalog.refresh()]
    release()
    const [changedA, changedB] = await Promise.all([a, b])
    expect(changedA).toBe(true)
    expect(changedB).toBe(true) // 同一在途请求，两边都看到首次落地
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})
