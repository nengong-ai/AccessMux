// Production daemon and production adapters; only external HTTP/identity is synthetic.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { writeFile, readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
let fixture, levels, options, consume, waitFor
const repo = process.argv[2]
const output = process.argv[3]
const load = path => import(pathToFileURL(join(repo, 'dist', path)).href)
const { buildServer } = await load('protocol/server.js')
const { registerAdapter, clearRegistry } = await load('adapters/registry.js')
const { WorkBuddyAdapter } = await load('adapters/workbuddy/index.js')
const { TraeAdapter } = await load('adapters/trae/index.js')
const { ConfigStore, buildDefaultConfig } = await load('config/store.js')
const { runOnboard } = await load('onboard/onboard.js')
const { allHosts } = await load('onboard/hosts.js')
let roster = [{ id: 'first', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }, { id: 'high-only', efforts: ['high'] },
  { id: 'disable', efforts: ['off', 'high'], disable: true }]
let unavailable = false
const received = []
const upstream = createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json')
  if (req.url.includes('/v3/config')) {
    if (unavailable) { res.writeHead(503).end('{}'); return }
    res.end(JSON.stringify({ data: { models: roster.map(m => ({ id: m.id, name: m.id,
      maxInputTokens: 10000, maxOutputTokens: 1000, supportsReasoning: true,
      reasoning: { supportedEfforts: m.efforts, canDisableThinking: m.disable === true } })),
      agents: [{ name: 'cli', models: roster.map(m => m.id) }] } })); return
  }
  if (req.url.includes('get_detail_param')) {
    res.end(JSON.stringify({ config_info_list: roster.map(m => ({ config_name: m.id, display_config: { name: m.id } })) })); return
  }
  if (req.url.includes('/models?')) {
    res.end(JSON.stringify({ data: { list: [{ function: 'solo_agent_remote', models: roster.map(m => ({ id: m.id, name: m.id,
      capabilities: { reasoning: true, reasoning_effort_options: m.efforts } })) }] } })); return
  }
  if (req.url.includes('chat/completions') || req.url.includes('llm_utils_chat')) {
    let body = ''; for await (const chunk of req) body += chunk
    const parsed = JSON.parse(body); received.push({ path: req.url, body: parsed })
    const content = parsed.messages.at(-1).content
    const text = Array.isArray(content) ? content[0].text : content
    const marker = `${parsed.reasoning_effort ?? 'default'}:${text}`
    res.setHeader('content-type', 'text/event-stream')
    const usage = { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 }
    if (req.url.includes('llm_utils_chat')) res.end(`event: output\ndata: ${JSON.stringify({ response: marker })}\n\nevent: token_usage\ndata: ${JSON.stringify(usage)}\n\nevent: done\ndata: {}\n\ndata: [DONE]\n\n`)
    else res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: marker } }], usage })}\n\ndata: [DONE]\n\n`)
    return
  }
  res.end('{}')
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${upstream.address().port}`
const syntheticFetch = (url, init) => { const parsed = new URL(url); return fetch(origin + parsed.pathname + parsed.search, init) }
const store = { status: async () => ({ state: 'logged-in' }),
  resolve: async () => ({ accessToken: 'synthetic-only', userId: 'fixture-user', host: 'https://synthetic.invalid',
    variant: 'cn', edition: 'cn', userRegion: 'CN', expiresAtMs: Date.now() + 3600000 }), dispose: () => {} }
const adapters = [new WorkBuddyAdapter({ credentialStore: store, fetchImpl: syntheticFetch, metadataCachePath: null,
  resolveClientVersion: async () => '9.9.9' }), new TraeAdapter('cn', { credentialStore: store, fetchImpl: syntheticFetch,
  identityResolver: async () => ({ edition: 'cn', machineId: 'synthetic-machine', deviceId: 'synthetic-device', platform: 'darwin' }) })]
for (const adapter of adapters) registerAdapter(adapter)
const config = buildDefaultConfig(adapters)
config.checkin = { sources: { workbuddy: false, qoder: false, zcode: false } }
const app = buildServer({ controlTimeoutMs: 1000, store: new ConfigStore(config), configPath: join(process.env.HOME, 'synthetic.yaml') })
let f
const evidence = { node: process.version, production: ['buildServer', 'WorkBuddyAdapter', 'TraeAdapter'], directory: [], upstream: [] }
try {
  const daemon = await app.listen({ host: '127.0.0.1', port: 0 })
  const home = process.env.HOME
  const profile = join(home, '.dsh/profiles/desktop')
  const installed = join(profile, 'node_modules/dsh-accessmux-connect')
  const installLog = []
  // Exercise the default-port installation branch without binding/contacting real 8080.
  // Every transport is forwarded to THIS production daemon on its random port.
  const onboardFetch = (url, init) => {
    const target = new URL(url)
    assert.equal(target.hostname, '127.0.0.1'); assert.equal(target.port, '8080')
    return fetch(daemon + target.pathname + target.search, init)
  }
  const deps = { homeDir: home, repoRoot: repo, port: 8080, fetchFn: onboardFetch,
    spawnFn: () => { throw new Error('test must reuse the production daemon, never spawn a service') },
    ask: async () => true, choose: async () => 'dsh', openUi: async () => { throw new Error('must not open real browser') },
    isTTY: false, log: line => installLog.push(line), closeAsk: () => {} }
  const statusFirst = await runOnboard({ host: 'dsh', yes: true, openUi: false }, deps)
  assert.equal(statusFirst, 0)
  const afterFirst = await readFile(join(profile, 'package.json'), 'utf8')
  const statusRepeat = await runOnboard({ host: 'dsh', yes: true, openUi: false }, deps)
  assert.equal(statusRepeat, 0)
  assert.equal(await readFile(join(profile, 'package.json'), 'utf8'), afterFirst)
  assert.equal(allHosts().find(h => h.id === 'dsh').detect({ homeDir: home }).onboarded, true)
  evidence.onboard = { statusFirst, statusRepeat, repeatedPackageUnchanged: true, log: installLog,
    transport: 'default 8080 URLs forwarded by injected fetch to actual random-port production daemon; no fake responses' }
  ;({ fixture, levels, options, consume, waitFor } = await import(pathToFileURL(join(installed, 'scripts/reasoning-fixture.mjs')).href))
  f = await fixture([], await import(pathToFileURL(join(installed, 'index.js')).href), `${daemon}/v1`)
  evidence.ports = [upstream.address().port, new URL(daemon).port]
  evidence.directory.push(await (await fetch(`${daemon}/v1/models`)).json())
  assert.equal((await f.ctx.llm.listModels('accessmux')).length, 6)
  for (const source of ['workbuddy', 'trae-cn']) {
    const id = `${source}:first`
    assert.deepEqual(levels(await f.ctx.llm.resolveModelInfo('accessmux', id)), ['low', 'medium', 'high', 'xhigh', 'max'])
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max', undefined]) {
      const marker = `${source}-${effort ?? 'default'}`
      const chunks = await consume(f.ctx.llm.stream(options(id, effort, marker)))
      assert.ok(JSON.stringify(chunks).includes(`${effort ?? 'default'}:${marker}`), JSON.stringify(chunks))
      assert.equal(received.at(-1).body.reasoning_effort, effort)
    }
    await assert.rejects(f.ctx.llm.resolveCallConfig({ provider: 'accessmux', model: `${source}:high-only`, reasoningEffort: 'low' }), /reasoning effort/)
  }
  await Promise.all(['off', 'high', undefined].map((effort, i) => consume(f.ctx.llm.stream(options('workbuddy:disable', effort, `parallel-${i}`)))))
  for (const [i, effort] of ['off', 'high', undefined].entries()) {
    const body = received.find(r => r.body.messages.at(-1).content?.[0]?.text === `parallel-${i}` || r.body.messages.at(-1).content === `parallel-${i}`).body
    assert.equal(body.reasoning_effort, effort)
  }
  roster = [{ id: 'first', efforts: ['high'] }, { id: 'new-model', efforts: ['low'] }]
  await waitFor(async () => levels(await f.ctx.llm.resolveModelInfo('accessmux', 'workbuddy:first')).join() === 'high')
  assert.equal((await f.ctx.llm.listModels('accessmux')).length, 4)
  evidence.directory.push(await (await fetch(`${daemon}/v1/models`)).json())
  await assert.rejects(f.ctx.llm.resolveCallConfig({ provider: 'accessmux', model: 'workbuddy:first', reasoningEffort: 'low' }), /reasoning effort/)
  await consume(f.ctx.llm.stream(options('workbuddy:new-model', 'low', 'new-without-manual-config')))
  assert.equal(received.at(-1).body.reasoning_effort, 'low')
  roster = [{ id: 'first', efforts: [] }]
  await waitFor(async () => levels(await f.ctx.llm.resolveModelInfo('accessmux', 'workbuddy:first')).length === 0)
  evidence.directory.push(await (await fetch(`${daemon}/v1/models`)).json())
  const before = received.length
  // stale host selection is refused by the PUBLIC daemon too, before inference.
  const invalid = await fetch(`${daemon}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'workbuddy:first', reasoning_effort: 'high', messages: [{ role: 'user', content: 'invalid' }], stream: true }) })
  assert.equal(invalid.status, 400); assert.equal(received.length, before)
  evidence.invalid = { status: invalid.status, body: await invalid.json(), upstreamCalls: 0 }
  roster = [{ id: 'first', efforts: ['low', 'high'] }]
  await waitFor(async () => levels(await f.ctx.llm.resolveModelInfo('accessmux', 'workbuddy:first')).join() === 'low,high')
  evidence.directory.push(await (await fetch(`${daemon}/v1/models`)).json())
  unavailable = true
  const fail = await fetch(`${daemon}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'workbuddy:first', reasoning_effort: 'high', messages: [{ role: 'user', content: 'catalog-failure' }] }) })
  assert.equal(fail.status, 400); evidence.catalogFailure = { status: fail.status, body: await fail.json() }
  clearRegistry()
  await waitFor(async () => (await f.ctx.llm.listModels('accessmux')).length === 0)
  evidence.directory.push(await (await fetch(`${daemon}/v1/models`)).json())
  assert.equal(received.length, before) // catalog failure and source removal issued zero inference
  evidence.sourceDisappeared = { models: await f.ctx.llm.listModels('accessmux'), noNewUpstream: true }
  evidence.upstream = received
  evidence.pass = true
  if (output) await writeFile(output, JSON.stringify(evidence, null, 2) + '\n')
  console.log(JSON.stringify({ pass: true, requests: received.length, directorySnapshots: evidence.directory.length, ports: evidence.ports }))
} finally {
  if (f) await f.close()
  await app.close()
  for (const adapter of adapters) await adapter.dispose()
  clearRegistry(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve))
}
