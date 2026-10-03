// refreshTraeCredential 测试：四 edition 各自走对应合同。

import { describe, expect, it } from 'vitest';
import { refreshTraeCredential } from '../../../src/adapters/trae/refresh.js';
import type { TraeCredential } from '../../../src/adapters/trae/credential-store.js';

function buildFetch(expectedPath: string, expectedClientId: string, expectedDeviceInfo: boolean, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const headers = init?.headers as Record<string, string> | undefined;
    const body = JSON.parse((init?.body as string) ?? '{}') as Record<string, unknown>;
    expect(String(url)).toContain(expectedPath);
    expect(body['ClientID']).toBe(expectedClientId);
    expect(body['RefreshToken']).toBe('rt');
    expect(body['UserID']).toBe('uid');
    if (expectedDeviceInfo) {
      expect(body['DeviceInfo']).toBeDefined();
      const di = body['DeviceInfo'] as Record<string, unknown>;
      expect(di['DeviceID']).toBe('dev');
      expect(di['MachineID']).toBe('mac');
      expect(di['PlatformCode']).toBe('SOLO_PC');
      expect(di['DeviceType']).toBe('PC');
    } else {
      expect(body['DeviceInfo']).toBeUndefined();
    }
    void headers;
    return new Response(JSON.stringify({
      Result: {
        Token: 'new-access',
        TokenExpireAt: 1_900_000_000,
        RefreshToken: 'new-refresh',
      },
    }), { status, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const baseCredential: TraeCredential = {
  accessToken: 'old-access',
  refreshToken: 'rt',
  userId: 'uid',
  host: 'https://example.com',
  expiresAtMs: 0,
  edition: 'cn',
  source: 'desktop',
};

describe('refreshTraeCredential per-edition 合同', () => {
  it('cn edition: /cloudide/... + ono9krqynydwx5 + 不带 DeviceInfo', async () => {
    const { fetchImpl } = buildFetch('/cloudide/api/v3/trae/oauth/ExchangeToken', 'ono9krqynydwx5', false);
    const out = await refreshTraeCredential({ ...baseCredential, edition: 'cn' }, fetchImpl, undefined);
    expect(out.accessToken).toBe('new-access');
    expect(out.refreshToken).toBe('new-refresh');
    expect(out.expiresAtMs).toBe(1_900_000_000);
  });

  it('sg edition: 同样 /cloudide/... + 共享 clientId', async () => {
    const { fetchImpl } = buildFetch('/cloudide/api/v3/trae/oauth/ExchangeToken', 'ono9krqynydwx5', false);
    const out = await refreshTraeCredential({ ...baseCredential, edition: 'sg' }, fetchImpl, undefined);
    expect(out.accessToken).toBe('new-access');
  });

  it('solo edition: 同 cn / sg 合同', async () => {
    const { fetchImpl } = buildFetch('/cloudide/api/v3/trae/oauth/ExchangeToken', 'ono9krqynydwx5', false);
    const out = await refreshTraeCredential({ ...baseCredential, edition: 'solo' }, fetchImpl, undefined);
    expect(out.accessToken).toBe('new-access');
  });

  it('solo-sg edition: /trae/api/v3/... + en1oxy7wnw8j9n + 带 DeviceInfo', async () => {
    const { fetchImpl } = buildFetch('/trae/api/v3/oauth/ExchangeToken', 'en1oxy7wnw8j9n', true);
    const out = await refreshTraeCredential(
      { ...baseCredential, edition: 'solo-sg', host: 'https://coresg-normal.trae.ai' },
      fetchImpl,
      undefined,
      { deviceId: 'dev', machineId: 'mac' },
    );
    expect(out.accessToken).toBe('new-access');
  });
});

describe('refreshTraeCredential 错误处理', () => {
  it('非 2xx 抛错', async () => {
    const fetchImpl = (async () => new Response('boom', { status: 500 })) as unknown as typeof fetch;
    await expect(refreshTraeCredential(baseCredential, fetchImpl)).rejects.toThrow(/refresh failed/i);
  });

  it('Result 缺 Token 抛错', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ Result: {} }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
    await expect(refreshTraeCredential(baseCredential, fetchImpl)).rejects.toThrow(/no token/);
  });

  it('Result.TokenExpireAt 无效抛错', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ Result: { Token: 'x', TokenExpireAt: 'invalid' } }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
    await expect(refreshTraeCredential(baseCredential, fetchImpl)).rejects.toThrow(/invalid expiry/);
  });

  it('refreshToken undefined 时抛错', async () => {
    const fetchImpl = (async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    await expect(refreshTraeCredential({ ...baseCredential, refreshToken: undefined }, fetchImpl)).rejects.toThrow(/refresh token/);
  });

  it('host 为空抛错', async () => {
    const fetchImpl = (async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    await expect(refreshTraeCredential({ ...baseCredential, host: '' }, fetchImpl)).rejects.toThrow(/host/);
  });
});