// T023：TraeSession 的 shim SSE → ChatCompletionChunk 解析（重点是 usage 透传）。
//
// 上游 token_usage 事件由 shim 侧的 bridge 翻成 OpenAI 形状（挂内容/收尾帧），
// 本测试用桩 lease + 桩 fetch 直接驱动生产 runTurn，验证 usage 落到终帧且不改写。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { TraeSession } from '../../../src/adapters/trae/index.js';
import type { ShimSessionLease } from '../../../src/protocol/shim-session-pool.js';

function fakeLease(): ShimSessionLease {
  return {
    shim: {
      ready: Promise.resolve(),
      baseUrl: () => 'http://127.0.0.1:1',
      token: () => 'stub-token',
      close: async () => undefined,
    },
    release: () => undefined,
  } as unknown as ShimSessionLease;
}

function sseResponse(frames: unknown[]): Response {
  const body = frames
    .map((frame) => (frame === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(frame)}\n\n`))
    .join('');
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TraeSession usage 透传（T023）', () => {
  it('shim 收尾帧带 usage → 终帧原样带出（真数，无 estimated）', async () => {
    vi.stubGlobal('fetch', (async () => sseResponse([
      { choices: [{ index: 0, delta: { content: '你' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: '好' }, finish_reason: null }] },
      {
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 273, completion_tokens: 7, total_tokens: 280 },
      },
      '[DONE]',
    ])) as unknown as typeof fetch);

    const session = new TraeSession(fakeLease());
    const chunks = [];
    for await (const chunk of session.runTurn({
      model: 'glm-5.2',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })) {
      chunks.push(chunk);
    }

    expect(chunks.map((c) => c.delta).join('')).toBe('你好');
    const done = chunks.find((c) => c.done);
    expect(done?.usage).toEqual({ prompt_tokens: 273, completion_tokens: 7, total_tokens: 280 });
    expect(done?.usage?.estimated).toBeUndefined();
  });

  it('usage 单独成帧（choices 为空）也能取到，挂在终帧上', async () => {
    vi.stubGlobal('fetch', (async () => sseResponse([
      { choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
      '[DONE]',
    ])) as unknown as typeof fetch);

    const session = new TraeSession(fakeLease());
    const chunks = [];
    for await (const chunk of session.runTurn({
      model: 'glm-5.2',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })) {
      chunks.push(chunk);
    }

    const done = chunks.find((c) => c.done);
    // finish_reason 帧先到也不再提前收尾：继续读到 usage 帧（choices 为空）与
    // [DONE]，把用量带在终帧上
    expect(done?.usage).toEqual({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
  });
});
