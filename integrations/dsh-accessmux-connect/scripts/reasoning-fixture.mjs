// @ts-nocheck -- synthetic runtime fixture; no production state.
// Synthetic loopback only. No native profiles, credential discovery or inference.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'

export const row = (id, efforts, disable = false) => ({ id, name: id,
  bridgeReasoning: { supported: efforts.length > 0, supportedEfforts: efforts, canDisableThinking: disable } })
export const levels = model => model.reasoning?.efforts.map(e => e.id) ?? []
export const options = (model, effort, text = 'synthetic') => ({ provider: 'accessmux', model,
  ...(effort === undefined ? {} : { reasoningEffort: effort }),
  messages: [{ role: 'user', content: [{ type: 'text', text }] }] })
export async function consume(iterable) { const chunks = []; for await (const chunk of iterable) chunks.push(chunk); return chunks }

export async function fixture(initialRows, pluginModule, baseURL) {
  pluginModule ??= await import('../index.js')
  let rows = initialRows
  let failed = false
  const requests = []
  const server = createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      if (failed) { res.writeHead(503).end('{}'); return }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: rows })); return
    }
    if (req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return }
    let body = ''; for await (const chunk of req) body += chunk
    const payload = JSON.parse(body)
    requests.push(payload)
    res.setHeader('content-type', 'text/event-stream')
    const marker = `${payload.reasoning_effort ?? 'default'}:${payload.messages.at(-1).content}`
    res.write(`data: ${JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', model: payload.model,
      choices: [{ index: 0, delta: { role: 'assistant', content: marker }, finish_reason: null }] })}\n\n`)
    res.end(`data: ${JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', model: payload.model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } })}\n\ndata: [DONE]\n\n`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const endpoint = baseURL ?? `http://127.0.0.1:${server.address().port}/v1`
  const ctx = new Context()
  const llmFiber = ctx.plugin(LlmRuntime)
  let updates = 0
  ctx.on('llm/adapters-updated', () => { updates++ })
  const pluginFiber = ctx.plugin(pluginModule, { baseURL: endpoint, pollMs: 5000 })
  await pluginFiber
  return { ctx, requests, endpoint, get updates() { return updates },
    setRows: value => { rows = value }, setFailed: value => { failed = value },
    close: async () => { await pluginFiber.dispose(); await llmFiber.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) } }
}

export async function waitFor(fn, timeout = 6500) {
  const end = Date.now() + timeout
  while (!(await fn())) { assert.ok(Date.now() < end, 'catalog did not refresh'); await new Promise(r => setTimeout(r, 25)) }
}

export async function verifyRegistered(pluginModule) {
  const id = 'fixture-source:model-a'
  const f = await fixture([row(id, ['low', 'medium', 'high', 'xhigh', 'max'])], pluginModule)
  const evidence = { node: process.version, source: 'synthetic loopback', snapshots: [], requests: [] }
  try {
    assert.equal(f.ctx.llm.listProviders()[0].id, 'accessmux')
    assert.equal((await f.ctx.llm.listModels('accessmux'))[0].id, id)
    const resolve = () => f.ctx.llm.resolveModelInfo('accessmux', id)
    assert.deepEqual(levels(await resolve()), ['low', 'medium', 'high', 'xhigh', 'max'])
    evidence.snapshots.push(await resolve())
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', undefined]) {
      const chunks = await consume(f.ctx.llm.stream(options(id, effort)))
      assert.ok(chunks.some(c => c.type === 'text-delta' || c.type === 'text'), JSON.stringify(chunks))
      assert.equal(f.requests.at(-1).reasoning_effort, effort)
    }
    await assert.rejects(f.ctx.llm.resolveCallConfig({ provider: 'accessmux', model: id, reasoningEffort: 'off' }), /reasoning effort/)
    f.setRows([row(id, ['high'])])
    await waitFor(async () => levels(await resolve()).join() === 'high')
    evidence.snapshots.push(await resolve())
    const before = f.requests.length
    await assert.rejects(f.ctx.llm.resolveCallConfig({ provider: 'accessmux', model: id, reasoningEffort: 'low' }), /reasoning effort/)
    assert.equal(f.requests.length, before)
    f.setRows([row(id, [])])
    await waitFor(async () => levels(await resolve()).length === 0)
    evidence.snapshots.push(await resolve())
    f.setRows([row(id, ['off', 'minimal', 'high'], true), row('another-source:model-b', ['low'])])
    await waitFor(async () => levels(await resolve()).join() === 'off,minimal,high')
    assert.equal((await f.ctx.llm.listModels('accessmux')).length, 2)
    evidence.snapshots.push(await resolve())
    await Promise.all(['off', 'minimal', 'high', undefined].map((effort, i) => consume(f.ctx.llm.stream(options(id, effort, `parallel-${i}`)))))
    for (const [i, effort] of ['off', 'minimal', 'high', undefined].entries()) {
      assert.equal(f.requests.find(r => r.messages.at(-1).content === `parallel-${i}`).reasoning_effort, effort)
    }
    evidence.requests = f.requests
    evidence.updates = f.updates
    return evidence
  } finally { await f.close() }
}
