import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkBuddyAdapter, WorkBuddySession } from '../../src/adapters/workbuddy/index.js';
import { TraeAdapter, TraeSession } from '../../src/adapters/trae/index.js';
import { bridgeTraeSoloStream } from '../../src/adapters/trae/sse-bridge.js';
import { createLoopbackShim, type LoopbackShim } from '../../src/protocol/shim.js';
import type { ShimSessionLease } from '../../src/protocol/shim-session-pool.js';
import type { ProviderSession } from '../../src/adapters/types.js';

it.each(['workbuddy', 'trae'] as const)('control plane passes the actual %s AbortSignal into catalog refresh', async (id) => {
  const adapter = id === 'workbuddy' ? new WorkBuddyAdapter() : new TraeAdapter('cn');
  const store = (adapter as unknown as { credentialStore: { status(): Promise<unknown> } }).credentialStore;
  vi.spyOn(store, 'status').mockResolvedValue({ state: 'signed-in' });
  const controller = new AbortController();
  const refresh = vi.spyOn(adapter, 'refreshCatalog').mockResolvedValue();
  await adapter.probe({ signal: controller.signal });
  expect(refresh).toHaveBeenCalledWith({ force: true, signal: controller.signal });
  await adapter.dispose();
});

const input = { model: 'synthetic-model', messages: [{ role: 'user' as const, content: 'hello' }], stream: true };
const content = 'data: {"choices":[{"delta":{"content":"PARTIAL"}}]}\n\n';
const done = 'data: [DONE]\n\n';
const secret = 'short-synthetic-token';
const shims: LoopbackShim[] = [];
afterEach(async () => { vi.unstubAllGlobals(); for (const shim of shims.splice(0)) await shim.close(); });
function lease(): ShimSessionLease {
  return { shim: { ready: Promise.resolve(), baseUrl: () => 'http://127.0.0.1:1', token: () => 'fake', close: async () => {} }, release: () => {} };
}
function responseParts(parts: Array<string | Error>): Response {
  const encoder = new TextEncoder(); let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const part = parts[index++];
      if (part instanceof Error) controller.error(part);
      else if (part === undefined) controller.close();
      else controller.enqueue(encoder.encode(part));
    },
  }));
}
async function collect(session: ProviderSession): Promise<{ text: string; done: boolean; error?: string }> {
  let text = ''; let done = false;
  try {
    // Production consumer deliberately breaks at done.
    for await (const chunk of session.runTurn(input)) { text += chunk.delta; if (chunk.done) { done = true; break; } }
    return { text, done };
  } catch (error) { return { text, done, error: String(error) }; }
}
for (const [name, Session] of [['workbuddy', WorkBuddySession], ['trae', TraeSession]] as const) {
  describe(`R01 ${name} strict SSE consumer`, () => {
    it.each([
      ['first error', [`data: {"error":{"message":"${secret}"}}\n\n`, content, done]],
      ['middle error', [content, `data: {"error":{"message":"${secret}"}}\n\n`, done]],
      ['tail error', [content, 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n', 'event: error\ndata: {}\n\n', done]],
      ['bad JSON', [content, 'data: {"choices":\n\n', done]],
      ['half JSON EOF', [content, 'data: {"choices":']],
      ['clean EOF', [content]],
      ['reader error', [content, new Error(secret)]],
      ['spoofed internal error prefix', [content, new Error(`${name} upstream ${secret}`)]],
    ] as const)('%s cannot yield successful done or leak raw payload', async (_label, parts) => {
      vi.stubGlobal('fetch', vi.fn(async () => responseParts([...parts])));
      const result = await collect(new Session(lease()));
      expect(result.done).toBe(false); expect(result.error).toBeDefined(); expect(result.error).not.toContain(secret);
    });
    it('CRLF, split chunks and multiline JSON decode with unchanged content and usage', async () => {
      const text = 'data: {\r\ndata: "choices":[{"delta":{"content":"hello"}}]}\r\n\r\n'
        + 'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1,"total_tokens":4}}\r\n\r\n'
        + 'data: [DONE]\r\n\r\n';
      vi.stubGlobal('fetch', vi.fn(async () => responseParts([...text])));
      const chunks = []; for await (const chunk of new Session(lease()).runTurn(input)) chunks.push(chunk);
      expect(chunks.map((c) => c.delta).join('')).toBe('hello');
      expect(chunks.at(-1)).toMatchObject({ done: true, usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } });
    });
    it('cancelled partial stream fails without a done and cancels the reader', async () => {
      let cancelled = false;
      vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(new TextEncoder().encode(content)); }, cancel() { cancelled = true; },
      }))));
      const session = new Session(lease()); const iterator = session.runTurn(input)[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toMatchObject({ delta: 'PARTIAL', done: false });
      // Abort-aware fake fetch body: cancellation closes the active reader.
      await session.cancel(); await iterator.return?.(); expect(cancelled).toBe(true);
    });
  });
}

describe('R01 Trae named-SSE bridge and actual shim transport', () => {
  it.each([
    ['missing done', ['event: output\ndata: {"response":"PARTIAL"}\n\n']],
    ['first error', [`event: error\ndata: {"message":"${secret}"}\n\n`]],
    ['middle error', ['event: output\ndata: {"response":"PARTIAL"}\n\n', `event: error\ndata: {"message":"${secret}"}\n\n`, 'event: done\ndata: {}\n\n']],
    ['tail error', ['event: done\ndata: {}\n\n', `data: {"error":{"message":"${secret}"}}\n\n`]],
    ['bad JSON', ['event: output\ndata: {"response":\n\n']],
    ['reader error', ['event: output\ndata: {"response":"PARTIAL"}\n\n', new Error(secret)]],
    ['spoofed internal error prefix', [new Error(`Trae upstream ${secret}`)]],
  ] as const)('%s does not synthesize a successful response', async (_label, parts) => {
    const response = bridgeTraeSoloStream(responseParts([...parts]), 'm');
    const error = await response.text().catch(String); expect(error).toContain('Trae upstream'); expect(error).not.toContain(secret);
  });
  it('explicit done at EOF is accepted with delayed usage and CRLF', async () => {
    const response = bridgeTraeSoloStream(responseParts([
      'event: output\r\ndata: {"response":"OK"}\r\n\r\n',
      'event: done\r\ndata: {}\r\n\r\n',
      'event: token_usage\r\ndata: {"prompt_tokens":9,"completion_tokens":2}\r\n\r\n',
    ]), 'm');
    const text = await response.text(); expect(text).toContain('OK'); expect(text).toContain('"prompt_tokens":9'); expect(text).toContain('[DONE]');
  });
  it.each([false, true])('reader failure through real loopback shim (Trae bridge=%s) rejects body and sanitizes logs', async (trae) => {
    const logs: unknown[][] = [];
    const shim = createLoopbackShim({ catalog: { current: () => [] }, logger: { warn: (...args) => logs.push(args), error: (...args) => logs.push(args) },
      chat: async () => {
        const upstream = responseParts([trae ? 'event: output\ndata: {"response":"PARTIAL"}\n\n' : content, new Error(secret)]);
        return { ok: true, status: 200, kind: 'unconfigured', message: '', response: trae ? bridgeTraeSoloStream(upstream, 'm') : upstream };
      },
    }); shims.push(shim); await shim.ready;
    const result = await fetch(`${shim.baseUrl()}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${shim.token()}`, 'Content-Type': 'application/json' }, body: '{}' }).then((res) => res.text()).then(() => 'success', () => 'failed');
    expect(result).toBe('failed'); expect(JSON.stringify(logs)).not.toContain(secret);
  });
  it('shim maps status 0 to 502 instead of invalid HTTP status, with safe error text', async () => {
    const shim = createLoopbackShim({ catalog: { current: () => [] }, chat: async () => ({ ok: false, status: 0, kind: 'server', message: `Authorization: Bearer ${secret}` }) });
    shims.push(shim); await shim.ready;
    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${shim.token()}`, 'Content-Type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(502); expect(await response.text()).not.toContain(secret);
  });
});
