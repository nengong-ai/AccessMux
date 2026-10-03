// WorkBuddy refresh 测试（四轮返工按 dsh upstream.ts:647-666 真实协议重写）：
// POST /v2/plugin/auth/token/refresh，无 body，X-Refresh-Token 头，
// {code,msg,data} envelope 响应。
import { describe, expect, it } from 'vitest';
import { refreshWorkBuddyCredential } from '../../../src/adapters/workbuddy/refresh.js';
import type { WorkBuddyCredential } from '../../../src/adapters/workbuddy/credential-store.js';

function buildFetchMock(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    return handler(url, init);
  }) as typeof fetch;
}

function okResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const baseCredential = {
  accessToken: 'old',
  refreshToken: 'rt',
  userId: 'u1',
  variant: 'cn' as const,
  expiresAtMs: 0,
  source: 'desktop' as const,
} satisfies Partial<WorkBuddyCredential> & Pick<WorkBuddyCredential, 'variant'>;

describe('refreshWorkBuddyCredential（真实协议）', () => {
  it('POST /v2/plugin/auth/token/refresh，X-Refresh-Token 头，无 body', async () => {
    let urlSeen = '';
    let initSeen: RequestInit | undefined;
    const fetchMock = buildFetchMock((url, init) => {
      urlSeen = url;
      initSeen = init;
      return okResponse({ code: 0, msg: '', data: { accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 3600 } });
    });
    const out = await refreshWorkBuddyCredential(baseCredential, fetchMock);
    expect(urlSeen).toBe('https://copilot.tencent.com/v2/plugin/auth/token/refresh');
    expect(initSeen?.method).toBe('POST');
    expect(initSeen?.body).toBeUndefined();
    const headers = initSeen?.headers as Record<string, string>;
    expect(headers['X-Refresh-Token']).toBe('rt');
    expect(headers['X-Auth-Refresh-Source']).toBe('workbuddy');
    expect(out.accessToken).toBe('new-access');
    expect(out.refreshToken).toBe('new-refresh');
    expect(out.expiresAtMs).toBeGreaterThan(Date.now());
  });

  it('envelope data.accessToken + expiresIn → expiresAtMs', async () => {
    const fetchMock = buildFetchMock(() => okResponse({
      code: 0, data: { accessToken: 'new', expiresIn: 7200 },
    }));
    const out = await refreshWorkBuddyCredential(baseCredential, fetchMock);
    expect(out.expiresAtMs).toBeGreaterThan(Date.now() + 7000_000);
  });

  it('refreshToken 缺失时只填 accessToken', async () => {
    const fetchMock = buildFetchMock(() => okResponse({
      code: 0, data: { accessToken: 'new' },
    }));
    const out = await refreshWorkBuddyCredential(baseCredential, fetchMock);
    expect(out.refreshToken).toBeUndefined();
  });

  it('refresh token 缺失抛错', async () => {
    await expect(refreshWorkBuddyCredential({ ...baseCredential, refreshToken: undefined }, buildFetchMock(() => okResponse({})))).rejects.toThrow(/refresh token is missing/);
  });

  it('envelope code !== 0 抛错（带 code + msg）', async () => {
    const fetchMock = buildFetchMock(() => okResponse({ code: 30001, msg: 'session expired' }));
    await expect(refreshWorkBuddyCredential(baseCredential, fetchMock)).rejects.toThrow(/code 30001.*session expired/);
  });

  it('非 2xx + 非 JSON body 抛 non-JSON（带 http 状态；对齐 dsh readEnvelope 顺序）', async () => {
    const fetchMock = buildFetchMock(() => new Response('upstream bad', { status: 401 }));
    await expect(refreshWorkBuddyCredential(baseCredential, fetchMock)).rejects.toThrow(/non-JSON.*http 401/);
  });

  it('非 2xx + JSON envelope 抛 token refresh failed（带 code + msg）', async () => {
    const fetchMock = buildFetchMock(() => okResponse({ code: 1001, msg: 'invalid refresh token' }, 401));
    await expect(refreshWorkBuddyCredential(baseCredential, fetchMock)).rejects.toThrow(/token refresh failed.*http 401.*code 1001/);
  });

  it('data.accessToken 缺失抛错', async () => {
    const fetchMock = buildFetchMock(() => okResponse({ code: 0, data: {} }));
    await expect(refreshWorkBuddyCredential(baseCredential, fetchMock)).rejects.toThrow(/no accessToken/);
  });

  it('非 JSON 响应抛错（envelope 语义）', async () => {
    const fetchMock = buildFetchMock(() => new Response('<html>bad</html>', { status: 200 }));
    await expect(refreshWorkBuddyCredential(baseCredential, fetchMock)).rejects.toThrow(/non-JSON/);
  });

  it('Global 走 www.workbuddy.ai/v2/plugin/auth/token/refresh', async () => {
    let urlSeen = '';
    const fetchMock = buildFetchMock((url) => {
      urlSeen = url;
      return okResponse({ code: 0, data: { accessToken: 'new' } });
    });
    await refreshWorkBuddyCredential({ ...baseCredential, variant: 'global' }, fetchMock);
    expect(urlSeen).toBe('https://www.workbuddy.ai/v2/plugin/auth/token/refresh');
  });

  it('abort signal 透传', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const fetchMock = (async (_input: unknown, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new Error('aborted');
      return okResponse({ code: 0, data: { accessToken: 'x' } });
    }) as typeof fetch;
    await expect(refreshWorkBuddyCredential(baseCredential, fetchMock, ctrl.signal)).rejects.toThrow();
  });
});
