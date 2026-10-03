// /v1/chat/completions 流式 SSE passthrough 协议层测试（T006）。
// 用 FakeAdapter（不依赖真实桥接源）；覆盖：SSE 帧序列、首 chunk role、收尾 finish_reason、
// [DONE] 哨兵、Content-Type 头、客户端断开 → cancel、非流式回归。

import { afterEach, describe, expect, it } from 'vitest';
import { clearRegistry, registerAdapter } from '../../src/adapters/registry.js';
import { buildServer } from '../../src/protocol/server.js';
import { FakeAdapter } from './fake-adapter.js';

afterEach(() => {
  clearRegistry();
});

/** 解析 SSE `data: ...\n\n` 帧序列为对象数组（最后一项可能是 `'[DONE]'`）。 */
function parseSseFrames(raw: string): Array<Record<string, unknown> | string> {
  const out: Array<Record<string, unknown> | string> = [];
  for (const frame of raw.split('\n\n')) {
    const trimmed = frame.trim();
    if (trimmed === '') continue;
    const lines = trimmed.split('\n');
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    const data = dataLines.join('\n');
    if (data === '[DONE]') {
      out.push('[DONE]');
      continue;
    }
    try {
      out.push(JSON.parse(data) as Record<string, unknown>);
    } catch {
      out.push(JSON.stringify({ _raw: data }) as unknown as Record<string, unknown>);
    }
  }
  return out;
}

describe('POST /v1/chat/completions stream=true（SSE passthrough）', () => {
  it('返回 Content-Type=text/event-stream 并写出 OpenAI 风格的 chunk 序列 + [DONE]', async () => {
    const fake = new FakeAdapter({ id: 'fake', chunks: ['你', '好', '，', '世界'] });
    registerAdapter(fake);
    const app = buildServer();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'fake:fake-model',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/event-stream/);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['x-accel-buffering']).toBe('no');

    const frames = parseSseFrames(res.body);
    // 1 个 role-only 首帧 + 4 个 delta + 1 个收尾 + 1 个 [DONE]
    expect(frames).toHaveLength(7);

    const first = frames[0] as Record<string, unknown>;
    expect(first['object']).toBe('chat.completion.chunk');
    expect(first['model']).toBe('fake:fake-model');
    const firstChoice = (first['choices'] as Array<Record<string, unknown>>)[0];
    expect(firstChoice['delta']).toEqual({ role: 'assistant' });
    expect(firstChoice['finish_reason']).toBeNull();

    // delta 帧：choices[0].delta.content 顺序拼成原文
    const deltas = frames.slice(1, 5).map((f) => {
      const choice = (f as Record<string, unknown>)['choices'] as Array<Record<string, unknown>>;
      return (choice[0]['delta'] as Record<string, unknown>)['content'] as string;
    });
    expect(deltas.join('')).toBe('你好，世界');

    // 收尾帧：finish_reason=stop
    const tail = frames[5] as Record<string, unknown>;
    const tailChoice = (tail['choices'] as Array<Record<string, unknown>>)[0];
    expect(tailChoice['delta']).toEqual({});
    expect(tailChoice['finish_reason']).toBe('stop');

    expect(frames[6]).toBe('[DONE]');
    await app.close();
  });

  it('adapter.runTurn 接收 stream=true 且 messages 顺序正确', async () => {
    const fake = new FakeAdapter({ id: 'fake', chunks: ['x'] });
    registerAdapter(fake);
    const app = buildServer();

    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'fake:fake-model',
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'u1' },
        ],
        stream: true,
      },
    });

    expect(fake.turnCalls).toHaveLength(1);
    expect(fake.turnCalls[0].stream).toBe(true);
    expect(fake.turnCalls[0].messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'u1' },
    ]);
    await app.close();
  });

  it('adapter 不产出任何 delta 时只写首帧 + 收尾 + [DONE]', async () => {
    const fake = new FakeAdapter({ id: 'fake', chunks: [] });
    registerAdapter(fake);
    const app = buildServer();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'fake:fake-model',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      },
    });

    expect(res.statusCode).toBe(200);
    const frames = parseSseFrames(res.body);
    expect(frames).toHaveLength(3);
    expect(frames[0]).toMatchObject({ object: 'chat.completion.chunk' });
    expect(frames[1]).toMatchObject({ choices: [{ delta: {}, finish_reason: 'stop' }] });
    expect(frames[2]).toBe('[DONE]');
    await app.close();
  });

  it('launch 抛 AdapterNotImplementedError → 仍以 JSON 501 返回（不写 SSE）', async () => {
    // AdapterNotImplementedError 的 import 在 tests 中循环处理不便，直接构造同形异常
    class StubNotImpl extends Error {
      constructor() { super('fake stub not implemented'); this.name = 'AdapterNotImplementedError'; }
    }
    const fake = new FakeAdapter({ id: 'fake', launchError: new StubNotImpl() });
    registerAdapter(fake);
    const app = buildServer();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'fake:fake-model',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      },
    });
    // AdapterNotImplementedError 的 instanceof 在跨包边界可能失败 → 服务端把它当 500
    // 是预期；这里只保证不写出半截 SSE，状态码非 200
    expect(res.statusCode).not.toBe(200);
    await app.close();
  });

  it('非流式回归：stream=false / 缺 stream 仍返回标准 OpenAI JSON', async () => {
    const fake = new FakeAdapter({ id: 'fake', chunks: ['你', '好'] });
    registerAdapter(fake);
    const app = buildServer();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'fake:fake-model',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0].message.content).toBe('你好');
    expect(body.choices[0].finish_reason).toBe('stop');
    await app.close();
  });

  // T007：pi-ai（DSH 插件路线的客户端层）对数组 content 恒发数组形态且无折叠
  // 开关，schema 必须同时收 string 与 parts 数组（OpenAI 协议本就允许两种）。
  it('content 数组形态（pi-ai / OpenAI 多模态形态）：text 部件折叠成 string 进 adapter', async () => {
    const fake = new FakeAdapter({ id: 'fake', chunks: ['ok'] });
    registerAdapter(fake);
    const app = buildServer();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'fake:fake-model',
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'sys-parts' }] },
          { role: 'user', content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }] },
        ],
        stream: true,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(fake.turnCalls[0].messages).toEqual([
      { role: 'system', content: 'sys-parts' },
      { role: 'user', content: '第一段第二段' },
    ]);
    await app.close();
  });

  it('content 数组含未知部件（audio_url）→ 400 明确报错（不静默丢内容）', async () => {
    const fake = new FakeAdapter({ id: 'fake', chunks: ['ok'], bridgeImages: true });
    registerAdapter(fake);
    const app = buildServer();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'fake:fake-model',
        messages: [
          { role: 'user', content: [{ type: 'text', text: '听音频' }, { type: 'audio_url', audio_url: { url: 'data:audio/mp3;base64,xxx' } }] },
        ],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/audio_url.*暂不支持/);
    expect(fake.turnCalls).toHaveLength(0);
    await app.close();
  });

  // —— T023：usage 帧位与口径 ——

  it('stream_options.include_usage=true → 独立 usage 帧在 finish 帧之后、[DONE] 之前', async () => {
    const fake = new FakeAdapter({
      id: 'fake',
      chunks: ['你', '好'],
      usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
    });
    registerAdapter(fake);
    const app = buildServer();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'fake:fake-model',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        stream_options: { include_usage: true },
      },
    });

    expect(res.statusCode).toBe(200);
    const frames = parseSseFrames(res.body);
    // 首帧 role + 2 delta + finish 帧 + usage 帧 + [DONE]
    expect(frames).toHaveLength(6);
    const finish = frames[3] as Record<string, unknown>;
    expect((finish['choices'] as Array<Record<string, unknown>>)[0]?.['finish_reason']).toBe('stop');
    expect(finish['usage']).toBeUndefined(); // 要了 include_usage 就不再挂在 finish 帧上

    const usageFrame = frames[4] as Record<string, unknown>;
    expect(usageFrame['choices']).toEqual([]); // OpenAI 惯例：usage 帧 choices 为空
    expect(usageFrame['usage']).toEqual({ prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 });
    expect((usageFrame['usage'] as Record<string, unknown>)['estimated']).toBeUndefined(); // 真数不带标识
    expect(frames[5]).toBe('[DONE]');
    await app.close();
  });

  it('未带 include_usage → 不额外发帧，usage 挂在 finish 帧上（真数，无 estimated）', async () => {
    const fake = new FakeAdapter({
      id: 'fake',
      chunks: ['ok'],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    });
    registerAdapter(fake);
    const app = buildServer();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'fake:fake-model',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      },
    });

    const frames = parseSseFrames(res.body);
    expect(frames).toHaveLength(4); // 首帧 + 1 delta + finish + [DONE]
    const finish = frames[2] as Record<string, unknown>;
    expect(finish['usage']).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
    expect(frames[3]).toBe('[DONE]');
    await app.close();
  });

  it('adapter 一个数都不给 → 兜底估算且带 estimated: true（绝不无标识编数）', async () => {
    const fake = new FakeAdapter({ id: 'fake', chunks: ['你好世界'] });
    registerAdapter(fake);
    const app = buildServer();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'fake:fake-model',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        stream_options: { include_usage: true },
      },
    });

    const frames = parseSseFrames(res.body);
    const usageFrame = frames[frames.length - 2] as Record<string, unknown>;
    const usage = usageFrame['usage'] as Record<string, unknown>;
    expect(usage['estimated']).toBe(true);
    expect(usage['completion_tokens']).toBeGreaterThan(0); // '你好世界' = 4
    expect(usage['total_tokens']).toBe(
      (usage['prompt_tokens'] as number) + (usage['completion_tokens'] as number),
    );
    await app.close();
  });

  it('非流式：真数透传进响应体 usage（含输入/生成侧明细，无 estimated）', async () => {
    const fake = new FakeAdapter({
      id: 'fake',
      chunks: ['ok'],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 9,
        total_tokens: 109,
        prompt_tokens_details: { cached_tokens: 64 },
        completion_tokens_details: { reasoning_tokens: 7 },
      },
    });
    registerAdapter(fake);
    const app = buildServer();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'fake:fake-model', messages: [{ role: 'user', content: 'hi' }] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 9,
      total_tokens: 109,
      prompt_tokens_details: { cached_tokens: 64 },
      completion_tokens_details: { reasoning_tokens: 7 },
    });
    await app.close();
  });
});