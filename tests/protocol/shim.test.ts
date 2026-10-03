// LoopbackShim 通用工厂测试：bearer 认证 / host loopback / 路由表。

import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createLoopbackShim } from '../../src/protocol/shim.js';

/** 用 raw http.request 发请求，让 Host header 真的能被改写（fetch 会强制覆盖）。 */
function rawGet(port: number, path: string, headers: Record<string, string>): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'GET', headers },
      (res) => {
        resolve({ status: res.statusCode ?? 0 });
        res.resume();
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const catalog = {
  current: () => [{ id: 'm1', owned_by: 'test' }],
};

afterEach(async () => {
  // 每个 case 自管 close
});

describe('LoopbackShim', () => {
  it('ready 后 baseUrl 是 http://127.0.0.1:<port>', async () => {
    const shim = createLoopbackShim({ catalog, chat: async () => ({ ok: true, status: 200, kind: 'unconfigured', message: '' }) });
    await shim.ready;
    const url = shim.baseUrl();
    expect(url.startsWith('http://127.0.0.1:')).toBe(true);
    await shim.close();
  });

  it('GET /healthz 需要 bearer（dsh 风格全路由门）', async () => {
    const shim = createLoopbackShim({ catalog, chat: async () => ({ ok: true, status: 200, kind: 'unconfigured', message: '' }) });
    await shim.ready;
    const noToken = await fetch(`${shim.baseUrl()}/healthz`);
    expect(noToken.status).toBe(401);
    const withToken = await fetch(`${shim.baseUrl()}/healthz`, { headers: { Authorization: `Bearer ${shim.token()}` } });
    expect(withToken.status).toBe(200);
    await shim.close();
  });

  it('GET /v1/models 需要 bearer', async () => {
    const shim = createLoopbackShim({ catalog, chat: async () => ({ ok: true, status: 200, kind: 'unconfigured', message: '' }) });
    await shim.ready;
    const noToken = await fetch(`${shim.baseUrl()}/v1/models`);
    expect(noToken.status).toBe(401);
    const withToken = await fetch(`${shim.baseUrl()}/v1/models`, { headers: { Authorization: `Bearer ${shim.token()}` } });
    expect(withToken.status).toBe(200);
    const body = await withToken.json() as { data: Array<{ id: string; owned_by: string; object: string }> };
    expect(body.data).toEqual([{ id: 'm1', object: 'model', owned_by: 'test', created: 0 }]);
    await shim.close();
  });

  it('bearer 错误返回 401（不接受错误 secret）', async () => {
    const shim = createLoopbackShim({ catalog, chat: async () => ({ ok: true, status: 200, kind: 'unconfigured', message: '' }) });
    await shim.ready;
    const res = await fetch(`${shim.baseUrl()}/v1/models`, { headers: { Authorization: 'Bearer wrong-secret' } });
    expect(res.status).toBe(401);
    await shim.close();
  });

  it('Origin 非 loopback 403', async () => {
    const shim = createLoopbackShim({ catalog, chat: async () => ({ ok: true, status: 200, kind: 'unconfigured', message: '' }) });
    await shim.ready;
    const res = await fetch(`${shim.baseUrl()}/v1/models`, {
      headers: { Origin: 'https://evil.example.com', Authorization: `Bearer ${shim.token()}` },
    });
    expect(res.status).toBe(403);
    await shim.close();
  });

  it('POST /v1/chat/completions 需要 JSON Content-Type', async () => {
    const shim = createLoopbackShim({ catalog, chat: async () => ({ ok: true, status: 200, kind: 'unconfigured', message: '' }) });
    await shim.ready;
    const res = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${shim.token()}`, 'Content-Type': 'text/plain' },
      body: '{}',
    });
    expect(res.status).toBe(415);
    await shim.close();
  });

  it('POST /v1/chat/completions body 非法 JSON 返回 400', async () => {
    const shim = createLoopbackShim({ catalog, chat: async () => ({ ok: true, status: 200, kind: 'unconfigured', message: '' }) });
    await shim.ready;
    const res = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${shim.token()}`, 'Content-Type': 'application/json' },
      body: 'not-json',
    });
    expect(res.status).toBe(400);
    await shim.close();
  });

  it('POST /v1/chat/completions 上游 401 → shim 返回 401', async () => {
    const shim = createLoopbackShim({
      catalog,
      chat: async () => ({ ok: false, status: 401, kind: 'authentication', message: 'token expired' }),
    });
    await shim.ready;
    const res = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${shim.token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'm1', messages: [] }),
    });
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('authentication');
    await shim.close();
  });

  it('404 unknown route', async () => {
    const shim = createLoopbackShim({ catalog, chat: async () => ({ ok: true, status: 200, kind: 'unconfigured', message: '' }) });
    await shim.ready;
    const res = await fetch(`${shim.baseUrl()}/no/such/path`, {
      headers: { Authorization: `Bearer ${shim.token()}` },
    });
    expect(res.status).toBe(404);
    await shim.close();
  });

  it('token 每次不同（不沿用旧 secret）', async () => {
    const shim1 = createLoopbackShim({ catalog, chat: async () => ({ ok: true, status: 200, kind: 'unconfigured', message: '' }) });
    const shim2 = createLoopbackShim({ catalog, chat: async () => ({ ok: true, status: 200, kind: 'unconfigured', message: '' }) });
    await Promise.all([shim1.ready, shim2.ready]);
    expect(shim1.token()).not.toBe(shim2.token());
    await shim1.close();
    await shim2.close();
  });
});