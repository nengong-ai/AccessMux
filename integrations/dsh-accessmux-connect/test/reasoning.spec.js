// @ts-nocheck -- synthetic integration harness uses runtime Cordis augmentation.
import { describe, expect, it } from 'vitest'
import { AccessMuxCatalog, parseBridgeReasoning, parseModelsResponse } from '../catalog.js'
import { createAccessmuxAdapter } from '../adapter.js'
import { fixture, row, levels, consume, options, verifyRegistered } from '../scripts/reasoning-fixture.mjs'

describe('effective bridge capability parsing', () => {
  it('intersects fixed SDK vocabulary, excludes off without disable and never infers from upstream', () => {
    const [model] = parseModelsResponse({ data: [{ id: 'fixture:m', reasoning: { supported: true, supportedEfforts: ['low'] },
      bridgeReasoning: { supported: true, supportedEfforts: ['high', 'ultra', '__proto__', { high: true }, 'high', 'off'], canDisableThinking: false } }] })
    expect(model.thinkingLevelMap).toEqual({ off: null, minimal: null, low: null, medium: null, high: 'high', xhigh: null, max: null })
    expect(parseModelsResponse({ data: [{ id: 'fixture:m', reasoning: { supported: true, supportedEfforts: ['high'] } }] })[0].thinkingLevelMap).toBeUndefined()
  })
  it.each([null, [], true, 'high', { supported: false, supportedEfforts: ['high'] },
    { supported: 'true', supportedEfforts: ['high'] }, { supported: true, supportedEfforts: 'high' },
    { supported: true, supportedEfforts: [] }, { supported: true, supportedEfforts: ['ultra'] },
    { supported: true, supportedEfforts: ['off'], canDisableThinking: 'true' }])('rejects invalid/unknown metadata: %j', value => {
    expect(parseBridgeReasoning(value)).toBeUndefined()
  })
  it('same ID/name changes five -> one -> none -> restored, equality ignores ordering and duplicates', async () => {
    let current = row('fixture:m', ['low', 'medium', 'high', 'xhigh', 'max'])
    const catalog = new AccessMuxCatalog({ baseURL: 'http://127.0.0.1:9/v1', fetchImpl: async () => new Response(JSON.stringify({ data: [current] })) })
    expect(await catalog.refresh()).toBe(true)
    const { adapter, invalidate } = createAccessmuxAdapter({ baseURL: catalog.baseURL, catalog })
    expect(levels(await adapter.resolveModel('accessmux', current.id))).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    for (const efforts of [['high'], [], ['low', 'medium', 'high', 'xhigh', 'max']]) {
      current = row(current.id, efforts)
      expect(await catalog.refresh()).toBe(true); invalidate()
      expect(levels(await adapter.resolveModel('accessmux', current.id))).toEqual(efforts)
    }
    current = row(current.id, ['max', 'high', 'medium', 'low', 'xhigh', 'high'])
    expect(await catalog.refresh()).toBe(false)
  })
})

it('real Cordis plugin + LlmRuntime + PiAiAdapter + pi-ai send exact dynamic efforts to loopback', async () => {
  const evidence = await verifyRegistered()
  expect(evidence.requests).toHaveLength(10)
  expect(evidence.updates).toBeGreaterThanOrEqual(5) // initial registration + first refresh + 3 capability changes
}, 25000)

it('prepared SDK call freezes capability, concurrent off/default stay distinct and illegal choices never issue HTTP', async () => {
  const id = 'fixture:prepared'
  const f = await fixture([row(id, ['off', 'low', 'high'], true)])
  try {
    const catalog = new AccessMuxCatalog({ baseURL: f.endpoint })
    await catalog.refresh()
    const { adapter, invalidate } = createAccessmuxAdapter({ baseURL: f.endpoint, catalog })
    const prepared = await adapter.prepareCall('accessmux', id)
    f.setRows([row(id, ['high'])]); await catalog.refresh(); invalidate()
    expect(levels(await adapter.resolveModel('accessmux', id))).toEqual(['high'])
    await Promise.all([consume(prepared.stream(options(id, 'off', 'frozen-off'))), consume(prepared.stream(options(id, undefined, 'frozen-default')))])
    expect(f.requests.find(r => r.messages.at(-1).content === 'frozen-off').reasoning_effort).toBe('off')
    expect(Object.hasOwn(f.requests.find(r => r.messages.at(-1).content === 'frozen-default'), 'reasoning_effort')).toBe(false)
    const before = f.requests.length
    for (const effort of ['low', 'off', 'ultra', '', null, {}, 4, ['high']]) {
      await expect(consume(adapter.stream(options(id, effort)))).rejects.toThrow(/reasoning effort/)
    }
    expect(f.requests).toHaveLength(before)
    f.setRows([row(id, [])]); await catalog.refresh(); invalidate()
    await expect(consume(adapter.stream(options(id, 'off')))).rejects.toThrow(/reasoning effort/)
    await consume(adapter.stream(options(id, undefined)))
    expect(Object.hasOwn(f.requests.at(-1), 'reasoning_effort')).toBe(false)
    f.setRows([]); await catalog.refresh(); invalidate()
    await expect(adapter.resolveModel('accessmux', id)).rejects.toThrow(/no configured model/)
  } finally { await f.close() }
})

it('failed refresh keeps known roster, never creates models/efforts; first timeout settles then recovery works', async () => {
  let failed = true
  const catalog = new AccessMuxCatalog({ baseURL: 'http://127.0.0.1:9/v1', timeoutMs: 20,
    fetchImpl: async (_url, init) => {
      if (!failed) return new Response(JSON.stringify({ data: [row('fixture:recovery', ['high'])] }))
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }))
    } })
  const first = catalog.refresh()
  const { adapter, invalidate } = createAccessmuxAdapter({ baseURL: catalog.baseURL, catalog, awaitFirstRefresh: () => first })
  expect(await adapter.listModels('accessmux')).toEqual([])
  failed = false; expect(await catalog.refresh()).toBe(true); invalidate()
  expect(levels(await adapter.resolveModel('accessmux', 'fixture:recovery'))).toEqual(['high'])
  failed = true; expect(await catalog.refresh()).toBe(false)
  expect(catalog.current().map(m => m.id)).toEqual(['fixture:recovery'])
  expect(levels(await adapter.resolveModel('accessmux', 'fixture:recovery'))).toEqual(['high'])
})
