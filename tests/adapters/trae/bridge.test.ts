// Trae SoloBridge 测试：display id → wire id 翻译、reasoning effort 翻译。

import { describe, expect, it } from 'vitest';
import { TraeSoloBridge, type TraeChatResult } from '../../../src/adapters/trae/bridge.js';
import type { ChatCompletionChunk } from '../../../src/types.js';

function okResult(model: string, chunks: string[]): TraeChatResult {
  // 模拟 Trae 上游 SSE 命名事件；bridge 会再翻译回 OpenAI 形状。
  const body = chunks.map((delta, i) => `event: output\ndata: ${JSON.stringify({
    response: delta,
    ...(i === chunks.length - 1 ? { finish_reason: 'stop' } : {}),
  })}\n\n`).join('')
    + `event: done\ndata: ${JSON.stringify({ finish_reason: 'stop' })}\n\n`
    + 'data: [DONE]\n\n';
  return {
    ok: true,
    status: 200,
    kind: 'unconfigured',
    message: '',
    response: new Response(body, { headers: { 'Content-Type': 'text/event-stream' } }),
  };
}

describe('TraeSoloBridge chatStream', () => {
  it('display id == wire id 时直接转发', async () => {
    let captured = '';
    const bridge = new TraeSoloBridge(async (body) => {
      captured = body;
      return okResult('glm-5.2', ['a', 'b']);
    });
    const result = await bridge.chatStream({ bodyJson: JSON.stringify({ model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }] }) });
    expect(result.ok).toBe(true);
    const parsed = JSON.parse(captured) as { model: string };
    expect(parsed.model).toBe('glm-5.2');
  });

  it('display id 与 wire id 不同时改写', async () => {
    let captured = '';
    const bridge = new TraeSoloBridge(
      async (body) => { captured = body; return okResult('Seed-Code', ['x']); },
      { current: () => [{ id: 'Seed-Code', name: 'GLM-5.3', wireConfigName: 'glm-5.3', wireFunction: 'solo_work_remote' }] },
    );
    const result = await bridge.chatStream({ bodyJson: JSON.stringify({ model: 'Seed-Code', messages: [{ role: 'user', content: 'hi' }] }) });
    expect(result.ok).toBe(true);
    const parsed = JSON.parse(captured) as { model: string; function: string };
    expect(parsed.model).toBe('glm-5.3');
    expect(parsed.function).toBe('solo_work_remote');
  });

  it('reasoning_effort 不在能力表内被剥离', async () => {
    let captured = '';
    const bridge = new TraeSoloBridge(
      async (body) => { captured = body; return okResult('glm-5.2', ['x']); },
      { current: () => [{ id: 'glm-5.2', name: 'GLM-5.2', reasoning: { supported: ['low', 'medium'] } }] },
    );
    await bridge.chatStream({ bodyJson: JSON.stringify({ model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'xhigh' }) });
    const parsed = JSON.parse(captured) as { reasoning_effort?: string };
    expect(parsed.reasoning_effort).toBeUndefined();
  });

  it('reasoning_effort 在能力表内保留', async () => {
    let captured = '';
    const bridge = new TraeSoloBridge(
      async (body) => { captured = body; return okResult('glm-5.2', ['x']); },
      { current: () => [{ id: 'glm-5.2', name: 'GLM-5.2', reasoning: { supported: ['low', 'medium'] } }] },
    );
    await bridge.chatStream({ bodyJson: JSON.stringify({ model: 'glm-5.2', messages: [{ role: 'user', content: 'hi' }], reasoning_effort: 'low' }) });
    const parsed = JSON.parse(captured) as { reasoning_effort?: string };
    expect(parsed.reasoning_effort).toBe('low');
  });

  it('上游非 ok 直接透传 result', async () => {
    const bridge = new TraeSoloBridge(async () => ({ ok: false, status: 401, kind: 'authentication', message: 'token expired' }));
    const result = await bridge.chatStream({ bodyJson: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }) });
    expect(result).toMatchObject({ ok: false, status: 401, kind: 'authentication' });
  });

  it('SSE bridge 把上游 chunk 转成 ChatCompletionChunk 流', async () => {
    const bridge = new TraeSoloBridge(async () => okResult('m', ['hello', ' ', 'world']));
    const result = await bridge.chatStream({ bodyJson: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }) });
    expect(result.ok).toBe(true);
    if (!result.response) throw new Error('expected response');
    const reader = result.response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const collected: string[] = [];
    let sawDone = false;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      let idx = buffer.indexOf('\n\n');
      while (idx !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (block.startsWith('data: ')) {
          const payload = block.slice(6).trim();
          if (payload === '[DONE]') { sawDone = true; break; }
          const parsed = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
          };
          const choice = parsed.choices?.[0];
          if (choice !== undefined) {
            const delta = choice.delta?.content ?? '';
            collected.push(delta);
          }
        }
        idx = buffer.indexOf('\n\n');
      }
      if (sawDone) break;
    }
    expect(collected.join('')).toBe('hello world');
    expect(sawDone).toBe(true);
  });

  // T023：上游 token_usage 事件 → OpenAI 形状的 usage（挂在收尾帧上）
  it('token_usage 事件翻成 usage 字段（含缓存明细映射）', async () => {
    const upstream = [
      'event: output\ndata: {"response":"OK"}\n\n',
      'event: token_usage\ndata: {"prompt_tokens":19,"completion_tokens":97,"total_tokens":116,'
        + '"reasoning_tokens":95,"cache_read_input_tokens":12,"cache_creation_input_tokens":3}\n\n',
      'event: done\ndata: {"finish_reason":"stop"}\n\n',
      'data: [DONE]\n\n',
    ].join('');
    const bridge = new TraeSoloBridge(async () => ({
      ok: true,
      status: 200,
      kind: 'unconfigured',
      message: '',
      response: new Response(upstream, { headers: { 'Content-Type': 'text/event-stream' } }),
    }));
    const result = await bridge.chatStream({ bodyJson: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }) });
    if (!result.response) throw new Error('expected response');

    const text = await result.response.text();
    const frames = text
      .split('\n\n')
      .filter((block) => block.startsWith('data: ') && !block.includes('[DONE]'))
      .map((block) => JSON.parse(block.slice(6)) as {
        choices: Array<{ finish_reason: string | null }>;
        usage?: Record<string, unknown>;
      });
    const finish = frames.find((f) => f.choices[0]?.finish_reason === 'stop');
    expect(finish?.usage).toEqual({
      prompt_tokens: 19,
      completion_tokens: 97,
      total_tokens: 116,
      prompt_tokens_details: { cached_tokens: 12, cache_write_tokens: 3 },
    });
  });
});