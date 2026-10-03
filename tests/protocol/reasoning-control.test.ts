import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { buildServer } from '../../src/protocol/server.js';
import { clearRegistry, registerAdapter } from '../../src/adapters/registry.js';
import { WorkBuddyAdapter } from '../../src/adapters/workbuddy/index.js';
import { TraeAdapter } from '../../src/adapters/trae/index.js';
import type { ProviderAdapter } from '../../src/adapters/types.js';
import { FakeAdapter } from './fake-adapter.js';

// No native credential store, identity discovery, real catalog, or real inference.
// Public HTTP and the production session->authenticated loopback shim are real.
const evidence: unknown[] = [];
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); clearRegistry(); vi.unstubAllEnvs(); });
afterAll(() => {
  if (process.env.ACCESSMUX_T045_EVIDENCE_PATH) writeFileSync(process.env.ACCESSMUX_T045_EVIDENCE_PATH, JSON.stringify(evidence, null, 2));
});

interface Row { id: string; efforts?: string[]; supported?: boolean; disable?: boolean }
const rows = (): Row[] => [
  { id: 'single', efforts: ['high'], supported: true },
  { id: 'multi', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], supported: true },
  { id: 'empty', supported: true },
  { id: 'unsupported', efforts: ['high'], supported: false },
  { id: 'disable', efforts: ['off', 'high'], supported: true, disable: true },
];
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const usage = { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 };

async function fixture(kind: 'workbuddy' | 'trae', global = false) {
  let catalog = rows();
  let unavailable = false;
  const received: Record<string, any>[] = [];
  const upstream = (async (url: unknown, init?: RequestInit) => {
    const path = String(url);
    if (path.includes('/v3/config')) {
      if (unavailable) return new Response('{}', { status: 503 });
      return json({ data: { models: catalog.map(m => ({
        id: m.id, name: m.id, maxInputTokens: 10000, maxOutputTokens: 1000,
        supportsReasoning: m.supported,
        reasoning: { supportedEfforts: m.efforts ?? [], canDisableThinking: m.disable === true },
      })), agents: [{ name: 'cli', models: catalog.map(m => m.id) }] } });
    }
    if (path.includes('get_detail_param')) return json({ config_info_list: catalog.map(m => ({ config_name: m.id, display_config: { name: m.id } })) });
    if (path.includes('/models?')) return json({ data: { list: [{ function: 'solo_agent_remote', models: catalog.map(m => ({
      id: m.id, name: m.id, capabilities: { reasoning: m.supported, reasoning_effort_options: m.efforts ?? [] },
    })) }] } });
    if (path.includes('chat/completions') || path.includes('llm_utils_chat')) {
      const body = JSON.parse(String(init?.body));
      received.push(body);
      const marker = `${body.reasoning_effort ?? 'default'}:${body.messages[0].content instanceof Array ? body.messages[0].content[0].text : body.messages[0].content}`;
      await new Promise(resolve => setTimeout(resolve, 8));
      return kind === 'workbuddy'
        ? new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: marker } }], usage })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
        : new Response(`event: output\ndata: ${JSON.stringify({ response: marker })}\n\nevent: token_usage\ndata: ${JSON.stringify(usage)}\n\nevent: done\ndata: {}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
    }
    // Optional WorkBuddy promotion metadata is synthetic too.
    if (kind === 'workbuddy') return json({});
    throw new Error('unexpected synthetic upstream path');
  }) as typeof fetch;
  const store = {
    status: async () => ({ state: 'logged-in' }),
    resolve: async () => ({ accessToken: 'synthetic-only', userId: 'fixture-user', host: 'https://synthetic.invalid',
      variant: global ? 'global' : 'cn', edition: global ? 'sg' : 'cn', userRegion: global ? 'SG' : 'CN', expiresAtMs: Date.now() + 3600_000 }),
    dispose: () => undefined,
  };
  const adapter = kind === 'workbuddy'
    ? new WorkBuddyAdapter({ variant: global ? 'global' : 'cn', credentialStore: store as never, fetchImpl: upstream, metadataCachePath: null, resolveClientVersion: async () => '9.9.9' })
    : new TraeAdapter(global ? 'ai' : 'cn', { credentialStore: store as never, fetchImpl: upstream,
      identityResolver: async () => ({ edition: global ? 'sg' : 'cn', machineId: 'synthetic-machine', deviceId: 'synthetic-device', platform: 'darwin' }) });
  cleanups.push(() => adapter.dispose());
  const api = await start(adapter);
  return { ...api, adapter, received, update: (value: Row[]) => { catalog = value; }, failCatalog: () => { unavailable = true; } };
}

async function start(adapter: ProviderAdapter, controlTimeoutMs = 1000) {
  registerAdapter(adapter);
  const app = buildServer({ controlTimeoutMs });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  cleanups.push(() => app.close());
  return {
    directory: async () => (await (await fetch(`${origin}/v1/models`)).json() as any).data,
    request: async (id: string, effort?: unknown, stream = false, extra = {}, signal?: AbortSignal) => {
      const response = await fetch(`${origin}/v1/chat/completions`, { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        model: `${adapter.id}:${id}`, messages: [{ role: 'user', content: 'fixture' }], stream,
        ...(effort === undefined ? {} : { reasoning_effort: effort }), ...extra,
      }) });
      const text = await response.text();
      return { status: response.status, text, json: () => JSON.parse(text) };
    },
  };
}

describe.each([['workbuddy', false], ['workbuddy', true], ['trae', false], ['trae', true]] as const)('public HTTP -> %s session -> fake upstream (global=%s)', (kind, global) => {
  it.each([false, true])('effort arrives unchanged (stream=%s), usage and content remain usable', async stream => {
    const f = await fixture(kind, global);
    const result = await f.request('single', 'high', stream, { tools: [{ type: 'function' }], reasoning: { effort: 'low' } });
    expect(result.status).toBe(200);
    expect(result.text).toContain('high:fixture');
    if (stream) expect(result.text).toContain('[DONE]');
    else expect(result.json().usage).toEqual(usage);
    expect(f.received).toHaveLength(1);
    expect(f.received[0].reasoning_effort).toBe('high');
    expect(f.received[0].tools).toBeUndefined();
    expect(f.received[0].reasoning).toBeUndefined();
    expect(f.received[0].stream).toBe(true);
    evidence.push({ kind, global, stream, publicStatus: result.status, upstream: f.received[0] });
  });
  it('concurrent low/high turns do not share effort state; omission keeps upstream default', async () => {
    const f = await fixture(kind, global);
    const results = await Promise.all([f.request('multi', 'low', true), f.request('multi', 'high'), f.request('multi')]);
    expect(results.map(r => r.status)).toEqual([200, 200, 200]);
    for (const [index, effort] of ['low', 'high', 'default'].entries()) expect(results[index].text).toContain(`${effort}:fixture`);
    expect(f.received.map(m => m.reasoning_effort).sort()).toEqual(['high', 'low', undefined]);
    expect(Object.hasOwn(f.received.find(m => m.reasoning_effort === undefined)!, 'reasoning_effort')).toBe(false);
  });
  it.each([['single', 'low'], ['empty', 'high'], ['single', 'off'], ['single', 'unknown'], ['single', ''], ['single', null], ['single', 2], ['single', {}], ['single', []], ['single', 'HIGH']])('invalid %s / %j returns HTTP 400 before launch/upstream', async (id, effort) => {
    const f = await fixture(kind, global);
    let launches = 0;
    const launch = f.adapter.launch.bind(f.adapter);
    f.adapter.launch = async ctx => { launches++; return launch(ctx); };
    for (const stream of [false, true]) {
      const result = await f.request(id, effort, stream);
      expect(result.status).toBe(400);
      expect(result.json().error.message).toBeTruthy();
    }
    expect(launches).toBe(0);
    expect(f.received).toEqual([]);
  });
  it('changed directory is reflected by both capability projection and validation', async () => {
    const f = await fixture(kind, global);
    const single = (await f.directory()).find((m: any) => m.id.endsWith(':single'));
    expect(single.bridgeReasoning).toEqual({ supported: true, supportedEfforts: ['high'], canDisableThinking: false });
    const empty = (await f.directory()).find((m: any) => m.id.endsWith(':empty'));
    expect(empty.bridgeReasoning).toEqual({ supported: false, supportedEfforts: [], canDisableThinking: false });
    f.update([{ id: 'single', efforts: ['low'], supported: true }, { id: 'multi', efforts: [], supported: true }]);
    const updated = (await f.directory()).find((m: any) => m.id.endsWith(':single'));
    expect(updated.bridgeReasoning.supportedEfforts).toEqual(['low']);
    expect((await f.request('single', 'high')).status).toBe(400);
    expect((await f.request('multi', 'high')).status).toBe(400);
    expect((await f.request('empty', 'high')).status).toBe(400);
    expect(f.received).toEqual([]);
    expect((await f.request('single', 'low')).status).toBe(200);
    expect(f.received[0].reasoning_effort).toBe('low');
  });
  it('an already launched session cannot forward effort removed by a catalog refresh', async () => {
    const f = await fixture(kind, global);
    await f.directory();
    const session = await f.adapter.launch({ localSecret: 'synthetic' });
    try {
      f.update([{ id: 'single', supported: true, efforts: [] }]);
      await f.adapter.refreshCatalog({ force: true });
      await expect((async () => {
        for await (const _chunk of session.runTurn({ model: 'single', messages: [{ role: 'user', content: 'fixture' }], stream: true, reasoning_effort: 'high' })) {}
      })()).rejects.toThrow(/HTTP 400/);
      expect(f.received).toEqual([]);
    } finally { await session.cancel(); }
  });
  it.each([false, true])('catalog changes between public validation and launch still return HTTP 400 (stream=%s)', async stream => {
    const f = await fixture(kind, global);
    const launch = f.adapter.launch.bind(f.adapter);
    f.adapter.launch = async ctx => {
      f.update([{ id: 'single', supported: true, efforts: [] }]);
      await f.adapter.refreshCatalog({ force: true });
      return launch(ctx);
    };
    const response = await f.request('single', 'high', stream);
    expect(response.status).toBe(400);
    expect(response.json().error.message).toContain('HTTP 400');
    expect(f.received).toEqual([]);
  });
});

it.each([false, true])('WorkBuddy canDisableThinking gates off; supported=false and minimal are rejected (global=%s)', async global => {
  const f = await fixture('workbuddy', global);
  expect((await f.request('unsupported', 'high')).status).toBe(400);
  expect((await f.request('single', 'minimal')).status).toBe(400);
  f.update([{ id: 'off-lie', efforts: ['off', 'high'], supported: true }, { id: 'disable', efforts: ['high'], supported: true, disable: true }]);
  expect((await f.request('off-lie', 'off')).status).toBe(400);
  expect((await f.request('disable', 'off')).status).toBe(200);
  expect(f.received).toHaveLength(1);
  expect(f.received[0].reasoning_effort).toBe('off');
});

it('catalog failure does not authorize stale cached efforts', async () => {
  const f = await fixture('workbuddy');
  await f.directory(); f.failCatalog();
  expect((await f.request('single', 'high')).status).toBe(400);
  expect(f.received).toEqual([]);
});

it('unbridged source cannot claim tunable efforts; old requests still work', async () => {
  const adapter = new FakeAdapter();
  adapter.probe = async () => ({ availability: 'available', models: [{ id: 'fake-model', provider: adapter.id, reasoning: { supported: true, supportedEfforts: ['high'] } }] });
  const f = await start(adapter);
  expect((await f.directory())[0].bridgeReasoning.supported).toBe(false);
  expect((await f.request('fake-model', 'high')).status).toBe(400);
  expect(adapter.launchCalls).toHaveLength(0);
  expect((await f.request('fake-model')).status).toBe(200);
});

it('hanging catalog is bounded and rejected without a turn', async () => {
  const adapter = Object.assign(new FakeAdapter(), { bridgeReasoning: true });
  adapter.probe = async () => new Promise(() => undefined);
  const f = await start(adapter, 20);
  expect((await f.request('fake-model', 'high', true)).status).toBe(400);
  expect(adapter.launchCalls).toHaveLength(0);
});

it.each(['idle-timeout', 'disconnect'])('effort stream priming still cancels the session on %s', async reason => {
  vi.stubEnv('ACCESSMUX_IDLE_TIMEOUT_MS', '30');
  const adapter = Object.assign(new FakeAdapter(), { bridgeReasoning: true });
  adapter.probe = async () => ({ availability: 'available', models: [{ id: 'fake-model', provider: adapter.id, reasoning: { supported: true, supportedEfforts: ['high'] } }] });
  let cancellations = 0;
  let turnSignal: AbortSignal | undefined;
  let begin!: () => void;
  const begun = new Promise<void>(resolve => { begin = resolve; });
  adapter.launch = async () => ({
    runTurn: async function* (input) {
      turnSignal = input.signal; begin();
      await new Promise((_resolve, reject) => input.signal!.addEventListener('abort', () => reject(input.signal!.reason), { once: true }));
      yield { delta: 'unreachable', done: true };
    },
    cancel: async () => { cancellations++; },
  });
  const f = await start(adapter);
  const controller = new AbortController();
  const request = f.request('fake-model', 'high', true, {}, controller.signal);
  await begun;
  if (reason === 'disconnect') {
    const outcome = request.catch(() => 'aborted'); controller.abort();
    expect(await outcome).toBe('aborted');
    await new Promise(resolve => setTimeout(resolve, 40));
  } else {
    const response = await request;
    expect(response.status).toBe(500);
    expect(response.json().error.message).toContain('模型输出等待超时');
  }
  expect(turnSignal?.aborted).toBe(true);
  expect(cancellations).toBe(1);
});
