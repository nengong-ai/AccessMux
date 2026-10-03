// T019 直连形态客户端：请求形状（前缀首块/最小三头）、流式/非流式解析、429 重试、错误分类。

import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../../../src/types.js';
import {
  buildDirectBody,
  directTurn,
  foldForDirect,
  parseSseFrame,
} from '../../../src/adapters/zcode/direct-client.js';
import { OFFICIAL_HARNESS_PREFIX } from '../../../src/adapters/zcode/prefix.js';
import { ZcodeUpstreamError } from '../../../src/adapters/zcode/error-classify.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(frames: object[]): Response {
  const text = frames.map((frame) => `event: x\ndata: ${JSON.stringify(frame)}\n\n`).join('');
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const MESSAGES: ChatMessage[] = [
  { role: 'system', content: '你是测试助手' },
  { role: 'user', content: 'hi' },
];

describe('foldForDirect / buildDirectBody', () => {
  it('system 折叠：官方前缀必须是无条件首块，宿主 system 追加其后', () => {
    const folded = foldForDirect(MESSAGES);
    expect(folded.system[0]?.text).toBe(OFFICIAL_HARNESS_PREFIX);
    expect(folded.system).toHaveLength(2);
    expect(folded.system[1]?.text).toBe('你是测试助手');
    expect(folded.text).toBe('hi');
  });

  it('无 system 消息时只有前缀块；多轮折叠成转录', () => {
    expect(foldForDirect([{ role: 'user', content: 'q' }]).system).toHaveLength(1);
    const folded = foldForDirect([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ]);
    expect(folded.text).toBe('user:\nq1\n\nassistant:\na1\n\nuser:\nq2');
  });

  it('请求体：model/max_tokens/system/messages/stream 齐备（门槛触发面）', () => {
    const body = buildDirectBody({ model: 'GLM-5.3-Flash', messages: MESSAGES, stream: true, jwt: 'j' });
    expect(body['model']).toBe('GLM-5.3-Flash');
    expect(typeof body['max_tokens']).toBe('number');
    expect(Array.isArray(body['system'])).toBe(true);
    expect(body['messages']).toEqual([{ role: 'user', content: 'hi' }]);
    expect(body['stream']).toBe(true);
  });

  it('T036 无图请求：content 保持纯字符串（与历史报文字节一致）', () => {
    const body = buildDirectBody({ model: 'GLM-5.3-Flash', messages: [{ role: 'user', content: '纯文本' }], stream: false, jwt: 'j' });
    expect((body['messages'] as Array<{ content: unknown }>)[0]?.content).toBe('纯文本');
  });

  it('T036 带图请求：content 升级为 Anthropic blocks（text 在前、image 追加）', () => {
    const image = { type: 'image' as const, mediaType: 'image/png' as const, data: 'QUFB' };
    const body = buildDirectBody({
      model: 'GLM-5.3-Flash',
      messages: [{ role: 'user', content: '看图', images: [image] }],
      stream: false,
      jwt: 'j',
    });
    expect((body['messages'] as Array<{ content: unknown }>)[0]?.content).toEqual([
      { type: 'text', text: '看图' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUFB' } },
    ]);
  });

  it('T036 多条消息的图片全部收集（折叠语义不变）', () => {
    const folded = foldForDirect([
      { role: 'user', content: 'q1', images: [{ type: 'image', mediaType: 'image/png', data: 'QQ==' }] },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2', images: [{ type: 'image', mediaType: 'image/jpeg', data: 'Qg==' }] },
    ]);
    expect(folded.images).toHaveLength(2);
    expect(folded.images.map((i) => i.mediaType)).toEqual(['image/png', 'image/jpeg']);
  });
});

describe('parseSseFrame', () => {
  it('取 data 行（多行 data 拼接）、忽略注释与 event 行', () => {
    expect(parseSseFrame('event: message_start\ndata: {"type":"message_start"}')).toEqual({
      event: 'message_start',
      data: '{"type":"message_start"}',
    });
    expect(parseSseFrame(': comment\n')).toBeUndefined();
  });
});

describe('directTurn', () => {
  it('R01 CRLF、多行 data、UTF-8 跨 chunk 都能完成，message_stop 即终态', async () => {
    const wire = 'event: content_block_delta\r\ndata: {"type":"content_block_delta",\r\ndata: "delta":{"type":"text_delta","text":"中文"}}\r\n\r\ndata: {"type":"message_stop"}\r\n\r\n';
    const bytes = new TextEncoder().encode(wire);
    let at = 0;
    const body = new ReadableStream<Uint8Array>({ pull(c) { if (at < bytes.length) c.enqueue(bytes.slice(at, ++at)); else c.close(); } });
    const chunks = [];
    for await (const chunk of directTurn({ model: 'GLM-5.3-Flash', messages: MESSAGES, stream: true, jwt: 'synthetic' }, { fetchImpl: async () => new Response(body) })) chunks.push(chunk);
    expect(chunks.map((c) => c.delta).join('')).toBe('中文'); expect(chunks.at(-1)?.done).toBe(true);
  });
  it.each(['EOF', 'bad-json', 'error', 'reader-error'])('R01 部分输出后 %s 必须失败，不能发成功 done', async (mode) => {
    const prefix = 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"PARTIAL"}}\r\n\r\n';
    const suffix = mode === 'bad-json' ? 'data: {"type":' : mode === 'error' ? 'data: {"type":"error","error":{"message":"PAT=short-secret"}}\r\n\r\n' : '';
    let step = 0;
    const stream = new ReadableStream<Uint8Array>({ pull(c) { if (step++ === 0) c.enqueue(new TextEncoder().encode(prefix)); else if (mode === 'reader-error') c.error(new Error('synthetic read failure')); else { if (suffix) c.enqueue(new TextEncoder().encode(suffix)); c.close(); } } });
    const chunks: Array<{ delta: string; done: boolean }> = [];
    let error: unknown;
    try { for await (const chunk of directTurn({ model: 'GLM-5.3-Flash', messages: MESSAGES, stream: true, jwt: 'synthetic' }, { fetchImpl: async () => new Response(stream) })) chunks.push(chunk); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(Error); expect(String(error)).not.toContain('short-secret');
    expect(chunks.map((c) => c.delta).join('')).toBe('PARTIAL'); expect(chunks.some((c) => c.done)).toBe(false);
  });
  it('R01 消费者在部分输出 break 会取消底层 reader', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n')); }, cancel });
    for await (const _ of directTurn({ model: 'GLM-5.3-Flash', messages: MESSAGES, stream: true, jwt: 'synthetic' }, { fetchImpl: async () => new Response(body) })) break;
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('非流式：content 文本块拼接为单 chunk', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { content: [{ type: 'text', text: '你好' }, { type: 'text', text: '！' }] }),
    );
    const chunks = [];
    for await (const chunk of directTurn(
      { model: 'GLM-5.3-Flash', messages: MESSAGES, stream: false, jwt: 'jwt-x' },
      { fetchImpl, rateLimitRetries: 0 },
    )) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual([
      { delta: '你好！', done: false },
      { delta: '', done: true },
    ]);
    // 最小头集：只有三个语义头（R017 §5.3）
    const headers = (fetchImpl.mock.calls[0]?.[1] as { headers: Record<string, string> }).headers;
    expect(Object.keys(headers).sort()).toEqual(['anthropic-version', 'authorization', 'content-type']);
    expect(headers['authorization']).toBe('Bearer jwt-x');
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });

  it('流式：content_block_delta.text_delta 逐帧上屏，收尾 done', async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse([
        { type: 'message_start' },
        { type: 'content_block_start' },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'AB' } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'CD' } },
        { type: 'content_block_stop' },
        { type: 'message_stop' },
      ]),
    );
    const chunks = [];
    for await (const chunk of directTurn(
      { model: 'GLM-5.3-Flash', messages: MESSAGES, stream: true, jwt: 'j' },
      { fetchImpl, rateLimitRetries: 0 },
    )) {
      chunks.push(chunk.delta);
    }
    expect(chunks.join('')).toBe('ABCD');
  });

  // T023：Anthropic 形状用量——输入在 message_start、输出在 message_delta，合并成一条
  it('流式：message_start/message_delta 的 usage 合并后挂在终帧', async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse([
        { type: 'message_start', message: { usage: { input_tokens: 273, output_tokens: 1 } } },
        { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ok' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
        { type: 'message_stop' },
      ]),
    );
    const chunks = [];
    for await (const chunk of directTurn(
      { model: 'GLM-5.3-Flash', messages: MESSAGES, stream: true, jwt: 'j' },
      { fetchImpl, rateLimitRetries: 0 },
    )) {
      chunks.push(chunk);
    }
    const done = chunks.find((c) => c.done);
    expect(done?.usage).toEqual({ prompt_tokens: 273, completion_tokens: 7, total_tokens: 280 });
    expect(done?.usage?.estimated).toBeUndefined();
  });

  it('非流式：响应体 usage 透传（含缓存字段 → details）', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 30 },
      }),
    );
    const chunks = [];
    for await (const chunk of directTurn(
      { model: 'GLM-5.3-Flash', messages: MESSAGES, stream: false, jwt: 'j' },
      { fetchImpl, rateLimitRetries: 0 },
    )) {
      chunks.push(chunk);
    }
    const done = chunks.find((c) => c.done);
    expect(done?.usage).toEqual({
      prompt_tokens: 100,
      completion_tokens: 5,
      total_tokens: 105,
      prompt_tokens_details: { cached_tokens: 30 },
    });
  });

  it('上游不给 usage → 终帧不带 usage（不编数，由协议层决定是否兜底估算）', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { content: [{ type: 'text', text: 'hi' }] }),
    );
    const chunks = [];
    for await (const chunk of directTurn(
      { model: 'GLM-5.3-Flash', messages: MESSAGES, stream: false, jwt: 'j' },
      { fetchImpl, rateLimitRetries: 0 },
    )) {
      chunks.push(chunk);
    }
    const done = chunks.find((c) => c.done);
    expect(done?.usage).toBeUndefined();
  });

  it('405/3012 → prefixGate 错误（触发 session 层降级）', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(405, { code: 3012, msg: 'request has been blocked due to unusual activity.' }),
    );
    await expect(async () => {
      for await (const _ of directTurn(
        { model: 'GLM-5.3-Flash', messages: MESSAGES, stream: false, jwt: 'j' },
        { fetchImpl, rateLimitRetries: 0 },
      )) {
        void _;
      }
    }).rejects.toMatchObject({ kind: 'prefixGate' });
  });

  it('429 先重试一次，第二次成功即正常返回', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(jsonResponse(200, { content: [{ type: 'text', text: 'ok' }] }));
    const chunks = [];
    for await (const chunk of directTurn(
      { model: 'GLM-5.3-Flash', messages: MESSAGES, stream: false, jwt: 'j' },
      { fetchImpl, retryDelayMs: 1 },
    )) {
      chunks.push(chunk.delta);
    }
    expect(chunks.join('')).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('401 → relogin（不重试、不降级）', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(401, { code: 1006 }));
    await expect(async () => {
      for await (const _ of directTurn(
        { model: 'GLM-5.3-Flash', messages: MESSAGES, stream: false, jwt: 'j' },
        { fetchImpl, rateLimitRetries: 0 },
      )) {
        void _;
      }
    }).rejects.toMatchObject({ kind: 'relogin' });
  });

  it('流内 error 事件 → ZcodeUpstreamError', async () => {
    const fetchImpl = vi.fn(async () =>
      sseResponse([{ type: 'error', error: { message: 'overloaded' } }]),
    );
    await expect(async () => {
      for await (const _ of directTurn(
        { model: 'GLM-5.3-Flash', messages: MESSAGES, stream: true, jwt: 'j' },
        { fetchImpl, rateLimitRetries: 0 },
      )) {
        void _;
      }
    }).rejects.toBeInstanceOf(ZcodeUpstreamError);
  });
});
