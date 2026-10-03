// daemon 请求日志测试（T010 #1）：每个 LLM 请求一行 model/status/duration_ms，
// 错误摘要经 redactLogText 脱敏（Bearer/JWT/长 token 只留形状）。
// 默认开启；ACCESSMUX_REQUEST_LOG=0 关闭；ACCESSMUX_DEBUG=1 追加诊断字段。

import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearRegistry, registerAdapter } from '../../src/adapters/registry.js';
import { buildServer } from '../../src/protocol/server.js';
import { FakeAdapter } from './fake-adapter.js';

const TOKEN_LIKE = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefabcdefabcdefabcdefabcdefab';

afterEach(() => {
  clearRegistry();
  vi.restoreAllMocks();
  delete process.env['ACCESSMUX_REQUEST_LOG'];
  delete process.env['ACCESSMUX_DEBUG'];
});

type ErrSpy = ReturnType<typeof vi.spyOn>;

function spyStderr(): ErrSpy {
  return vi.spyOn(console, 'error');
}

function reqLines(spy: ErrSpy): string[] {
  return spy.mock.calls.map((c) => c.map(String).join(' ')).filter((l) => l.includes('[accessmux-req]'));
}

describe('daemon 请求日志', () => {
  it('chat/completions 成功：一行 model/status/duration_ms/stream/adapter', async () => {
    const spy = spyStderr();
    registerAdapter(new FakeAdapter({ id: 'fake', chunks: ['ok'] }));
    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'fake:m1', messages: [{ role: 'user', content: 'hi' }], stream: true },
    });
    expect(res.statusCode).toBe(200);
    const line = reqLines(spy).find((l) => l.includes('[accessmux-req]'));
    expect(line).toBeDefined();
    expect(line).toContain('path=/v1/chat/completions');
    expect(line).toContain('model=fake:m1');
    expect(line).toContain('adapter=fake');
    expect(line).toContain('status=200');
    expect(line).toMatch(/duration_ms=\d+/);
    expect(line).toContain('stream=true');
    await app.close();
  });

  it('未知模型 404：日志带错误摘要', async () => {
    const spy = spyStderr();
    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'nope:x', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(404);
    const line = reqLines(spy).find((l) => l.includes('[accessmux-req]'));
    expect(line).toContain('status=404');
    expect(line).toContain('error=');
    expect(line).toContain('nope:x');
    await app.close();
  });

  it('流式中途失败：status=500 + 脱敏后的错误摘要（token 不外泄）', async () => {
    const spy = spyStderr();
    const fake = new FakeAdapter({ id: 'fake', chunks: [] });
    // runTurn 抛带 token 形状的错误，验证日志脱敏
    fake.launch = async (ctx) => {
      void ctx;
      return {
        async *runTurn() { throw new Error(`upstream 401: Bearer ${TOKEN_LIKE}`); },
        async cancel() { /* no-op */ },
      };
    };
    registerAdapter(fake);
    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'fake:m1', messages: [{ role: 'user', content: 'hi' }], stream: true },
    });
    expect(res.statusCode).toBe(200); // hijack 后 HTTP 层 200，错误走 SSE error 帧
    const line = reqLines(spy).find((l) => l.includes('[accessmux-req]'));
    expect(line).toContain('status=500');
    expect(line).not.toContain(TOKEN_LIKE);
    expect(line).toContain('Bearer <redacted>'); // Bearer 整段吃掉（含 JWT 形状）
    await app.close();
  });

  it('/v1/messages 同样落日志（Anthropic 路径）', async () => {
    const spy = spyStderr();
    registerAdapter(new FakeAdapter({ id: 'fake', chunks: ['好'] }));
    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: { model: 'fake:m1', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(200);
    const line = reqLines(spy).find((l) => l.includes('[accessmux-req]'));
    expect(line).toContain('path=/v1/messages');
    expect(line).toContain('status=200');
    await app.close();
  });

  it('ACCESSMUX_REQUEST_LOG=0 时不输出', async () => {
    process.env['ACCESSMUX_REQUEST_LOG'] = '0';
    const spy = spyStderr();
    registerAdapter(new FakeAdapter({ id: 'fake', chunks: ['ok'] }));
    const app = buildServer();
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'fake:m1', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(reqLines(spy)).toHaveLength(0);
    await app.close();
  });

  it('ACCESSMUX_DEBUG=1 追加 msg_count/prompt_chars；默认不输出 debug 行', async () => {
    const spyDefault = spyStderr();
    registerAdapter(new FakeAdapter({ id: 'fake', chunks: ['ok'] }));
    const app1 = buildServer();
    await app1.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'fake:m1', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(reqLines(spyDefault).some((l) => l.includes('msg_count='))).toBe(false);
    await app1.close();

    process.env['ACCESSMUX_DEBUG'] = '1';
    const spyDebug = vi.spyOn(console, 'error');
    const app2 = buildServer();
    await app2.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'fake:m1', messages: [{ role: 'user', content: 'hi' }] },
    });
    const lines = reqLines(spyDebug);
    expect(lines.some((l) => l.includes('msg_count=1'))).toBe(true);
    expect(lines.some((l) => l.includes('prompt_chars=2'))).toBe(true);
    await app2.close();
  });
});
