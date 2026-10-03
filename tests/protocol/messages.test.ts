// /v1/messages 协议级测试：使用 FakeAdapter，不依赖真实桥接源（T001/T002）。
// 覆盖：合成 Anthropic 请求 → 结构正确响应、错误路径、与 /v1/chat/completions 共存回归。

import { afterEach, describe, expect, it } from 'vitest';
import { clearRegistry, registerAdapter } from '../../src/adapters/registry.js';
import { buildServer } from '../../src/protocol/server.js';
import { AdapterNotImplementedError } from '../../src/adapters/types.js';
import { FakeAdapter, lastUserContent } from './fake-adapter.js';

afterEach(() => {
  clearRegistry();
});

function mountWithFake(opts: Parameters<typeof FakeAdapter>[0] = {}): FakeAdapter {
  const fake = new FakeAdapter({ id: 'fake', chunks: ['你好', '，', '世界'], ...opts });
  registerAdapter(fake);
  return fake;
}

describe('POST /v1/messages 协议翻译', () => {
  it('system + 多轮 messages → 结构正确的 Anthropic 风格响应', async () => {
    const fake = mountWithFake();
    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'fake:fake-model',
        max_tokens: 64,
        system: '你是一个简洁的助手。',
        messages: [
          { role: 'user', content: '第一轮' },
          { role: 'assistant', content: '好的' },
          { role: 'user', content: '再来一轮' },
        ],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.type).toBe('message');
    expect(body.role).toBe('assistant');
    expect(body.model).toBe('fake:fake-model');
    expect(body.stop_reason).toBe('end_turn');
    expect(body.stop_sequence).toBeNull();
    // T023：fake adapter 不上报用量 → 协议层兜底估算，且必须带 estimated 标识
    expect(body.usage.estimated).toBe(true);
    expect(body.usage.input_tokens).toBeGreaterThan(0);
    expect(body.usage.output_tokens).toBeGreaterThan(0);
    expect(Array.isArray(body.content)).toBe(true);
    expect(body.content[0]).toEqual({ type: 'text', text: '你好，世界' });
    expect(typeof body.id).toBe('string');
    expect(body.id.startsWith('msg_')).toBe(true);

    // 验证 system 被拼到 messages 最前；最后一条 user 是 "再来一轮"
    const msgs = fake.turnCalls[0].messages;
    expect(msgs[0]).toEqual({ role: 'system', content: '你是一个简洁的助手。' });
    expect(msgs[msgs.length - 1]).toEqual({ role: 'user', content: '再来一轮' });
    expect(lastUserContent(fake)).toBe('再来一轮');

    await app.close();
  });

  // T023：上游真数（含缓存分桶）按 Anthropic 形状拆回 input/output/cache_*。
  it('adapter 上报真数 → usage 按 Anthropic 形状给出（缓存单列、无 estimated）', async () => {
    const fake = mountWithFake({
      usage: {
        prompt_tokens: 3796, // = 未命中 2 + 缓存读 3794（OpenAI 口径）
        completion_tokens: 66, // = output 2 + reasoning 64
        total_tokens: 3862,
        prompt_tokens_details: { cached_tokens: 3794, reasoning_tokens: 64 },
      },
    });
    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'fake:fake-model',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(res.statusCode).toBe(200);
    const usage = res.json().usage as Record<string, unknown>;
    expect(usage['input_tokens']).toBe(2); // 3796 - 3794（缓存命中不计入 input_tokens）
    expect(usage['output_tokens']).toBe(66);
    expect(usage['cache_read_input_tokens']).toBe(3794);
    expect(usage['estimated']).toBeUndefined();
    await app.close();
  });

  it('system 接受 [{type:"text", text:...}] 数组形式', async () => {
    const fake = mountWithFake();
    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'fake:fake-model',
        max_tokens: 16,
        system: [
          { type: 'text', text: '规则一' },
          { type: 'text', text: '规则二' },
        ],
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(fake.turnCalls[0].messages[0]).toEqual({ role: 'system', content: '规则一\n规则二' });
    await app.close();
  });

  it('content block 数组里的 text 拼接为单字符串', async () => {
    const fake = mountWithFake();
    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'fake:fake-model',
        max_tokens: 16,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'part1 ' },
              { type: 'text', text: 'part2' },
            ],
          },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(fake.turnCalls[0].messages).toEqual([{ role: 'user', content: 'part1 part2' }]);
    await app.close();
  });

  it('空流（adapter 不产出任何 delta）仍返回结构合法响应', async () => {
    mountWithFake({ chunks: [] });
    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'fake:fake-model',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.content).toEqual([]);
    expect(body.stop_reason).toBe('end_turn');
    await app.close();
  });
});

describe('POST /v1/messages 错误路径', () => {
  it('未知模型 → 404 not_found_error', async () => {
    mountWithFake();
    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'nobody:no-such',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(res.statusCode).toBe(404);
    const body = res.json();
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('not_found_error');
    expect(body.error.message).toMatch(/nobody/);
    await app.close();
  });

  it('缺 max_tokens → 400 invalid_request_error', async () => {
    mountWithFake();
    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'fake:fake-model',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.type).toBe('invalid_request_error');
    await app.close();
  });

  it('messages 为空数组 → 400', async () => {
    mountWithFake();
    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: { model: 'fake:fake-model', max_tokens: 16, messages: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.type).toBe('invalid_request_error');
    await app.close();
  });

  it('messages.role 出现 "system" → 400（Anthropic 把 system 提到顶层字段）', async () => {
    mountWithFake();
    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'fake:fake-model',
        max_tokens: 16,
        messages: [{ role: 'system', content: 'should not appear here' }],
      },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('非 text content block（如 image）→ 400', async () => {
    mountWithFake();
    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'fake:fake-model',
        max_tokens: 16,
        messages: [
          {
            role: 'user',
            content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x' } }],
          },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.type).toBe('invalid_request_error');
    await app.close();
  });

  it('stream=true → 501 api_error（流式待 Phase 2）', async () => {
    mountWithFake();
    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'fake:fake-model',
        max_tokens: 16,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().error.type).toBe('api_error');
    expect(res.json().error.message).toMatch(/流式/);
    await app.close();
  });

  it('adapter 抛 AdapterNotImplementedError → 501 api_error', async () => {
    mountWithFake({ launchError: new AdapterNotImplementedError('fake', 'T000-fake') });
    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'fake:fake-model',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(res.statusCode).toBe(501);
    const body = res.json();
    expect(body.type).toBe('error');
    expect(body.error.type).toBe('api_error');
    expect(body.error.message).toMatch(/T000-fake/);
    await app.close();
  });
});

describe('与 /v1/chat/completions 共存回归', () => {
  it('同一 fake adapter 同时服务于两个端点，互不干扰', async () => {
    const fake = mountWithFake();
    const app = buildServer();

    const messages = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'fake:fake-model',
        max_tokens: 16,
        messages: [{ role: 'user', content: 'A' }],
      },
    });
    expect(messages.statusCode).toBe(200);

    const chat = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'fake:fake-model',
        messages: [{ role: 'user', content: 'B' }],
      },
    });
    expect(chat.statusCode).toBe(200);
    expect(chat.json().choices[0].message.content).toBe('你好，世界');

    // 两次调用都被记录
    expect(fake.turnCalls).toHaveLength(2);
    expect(fake.turnCalls[0].messages).toEqual([{ role: 'user', content: 'A' }]);
    expect(fake.turnCalls[1].messages).toEqual([{ role: 'user', content: 'B' }]);
    await app.close();
  });

  it('/health 与 /v1/models 不受新端点影响', async () => {
    mountWithFake({ modelIds: ['fake-model-a', 'fake-model-b'] });
    const app = buildServer();
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json().adapters).toContain('fake');

    const models = await app.inject({ method: 'GET', url: '/v1/models' });
    expect(models.statusCode).toBe(200);
    const ids = models.json().data.map((m: { id: string }) => m.id);
    expect(ids).toContain('fake:fake-model-a');
    expect(ids).toContain('fake:fake-model-b');
    await app.close();
  });
});
