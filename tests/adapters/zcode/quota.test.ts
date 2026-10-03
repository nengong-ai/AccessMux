// T019 额度映射：balance → QuotaState + 权益模型过滤（当日过期语义如实表达）+ 429 重试 + 401。

import { describe, expect, it, vi } from 'vitest';
import {
  balanceResponseToOutcome,
  entitledModelsFromCapabilities,
  fetchZcodeQuota,
  parseExpiry,
} from '../../../src/adapters/zcode/quota.js';

describe('balanceResponseToOutcome', () => {
  it('remaining>0 且未过期 → ok', () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const result = balanceResponseToOutcome(
      { code: 0, data: { balances: [{ total_units: 1e8, used_units: 5, remaining_units: 1e8 - 5, expires_at: future }] } },
      Date.now(),
    );
    expect(result.state).toBe('ok');
  });

  it('已过 expires_at → exhausted（Start Plan 当日过期语义）', () => {
    const past = new Date(Date.now() - 3600_000).toISOString();
    const result = balanceResponseToOutcome(
      { code: 0, data: { balances: [{ remaining_units: 999, expires_at: past }] } },
      Date.now(),
    );
    expect(result.state).toBe('exhausted');
  });

  it('remaining=0 → exhausted；balances 空/形状不符 → unknown（不编数）', () => {
    expect(
      balanceResponseToOutcome({ code: 0, data: { balances: [{ remaining_units: 0 }] } }, Date.now()).state,
    ).toBe('exhausted');
    expect(balanceResponseToOutcome({ code: 0, data: { balances: [] } }, Date.now()).state).toBe('unknown');
    expect(balanceResponseToOutcome({ code: 0, data: {} }, Date.now()).state).toBe('unknown');
    expect(balanceResponseToOutcome('garbage', Date.now()).state).toBe('unknown');
    expect(balanceResponseToOutcome({ code: 500 }, Date.now()).state).toBe('unknown');
  });

  it('多条并存取剩余最大条目', () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const result = balanceResponseToOutcome(
      {
        code: 0,
        data: {
          balances: [
            { remaining_units: 0, expires_at: future },
            { remaining_units: 42, expires_at: future },
          ],
        },
      },
      Date.now(),
    );
    expect(result.state).toBe('ok');
  });

  it('带 capabilities 时给出权益模型清单（T019 真机形态：只放行 flash）', () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const result = balanceResponseToOutcome(
      {
        code: 0,
        data: {
          balances: [
            {
              remaining_units: 42,
              expires_at: future,
              capabilities: ['model:glm-5.3-flash'],
            },
          ],
        },
      },
      Date.now(),
    );
    expect(result.state).toBe('ok');
    expect(result.entitledModels).toEqual(['GLM-5.3-Flash']);
  });

  it('无模型 capability → entitledModels 为 undefined（调用方退回固定清单）', () => {
    const future = new Date(Date.now() + 3600_000).toISOString();
    const result = balanceResponseToOutcome(
      { code: 0, data: { balances: [{ remaining_units: 42, expires_at: future, capabilities: ['other:thing'] }] } },
      Date.now(),
    );
    expect(result.entitledModels).toBeUndefined();
  });
});

describe('entitledModelsFromCapabilities', () => {
  it('`model:<id>` 与固定清单不区分大小写精确匹配；跨条目汇总', () => {
    expect(
      entitledModelsFromCapabilities([
        { capabilities: ['model:glm-5.3-flash'] },
        { capabilities: ['model:GLM-5-Turbo', 'not-a-model'] },
      ]),
    ).toEqual(['GLM-5.3-Flash', 'GLM-5-Turbo']);
  });

  it('匹配不到任何清单内模型 → undefined；清单外 capability 不虚列', () => {
    expect(entitledModelsFromCapabilities([{ capabilities: ['model:glm-9.9-plus'] }])).toBeUndefined();
    expect(entitledModelsFromCapabilities([{ capabilities: [] }, { remaining_units: 1 }])).toBeUndefined();
  });
});

describe('parseExpiry', () => {
  it('ISO 字符串 / epoch 秒 / epoch 毫秒', () => {
    expect(parseExpiry('2026-10-01T00:00:00+08:00')).toBe(Date.parse('2026-10-01T00:00:00+08:00'));
    expect(parseExpiry(1_760_000_000)).toBe(1_760_000_000_000);
    expect(parseExpiry(1_760_000_000_000)).toBe(1_760_000_000_000);
    expect(parseExpiry('not-a-date')).toBeUndefined();
    expect(parseExpiry(undefined)).toBeUndefined();
  });
});

describe('fetchZcodeQuota', () => {
  it.each(['fetch', 'body'])('R10 %s 挂起超时返回 unknown 且底层收到 abort', async (phase) => {
    let aborted = false;
    const fetchImpl: typeof fetch = async (_url, init) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; });
      if (phase === 'fetch') return new Promise<Response>(() => undefined);
      return { status: 200, text: () => new Promise<string>(() => undefined) } as Response;
    };
    await expect(fetchZcodeQuota({ jwt: 'synthetic', deviceMid: 'synthetic' }, { fetchImpl, timeoutMs: 15 })).resolves.toBe('unknown');
    expect(aborted).toBe(true);
  });
  it('B04 错误回声短 JWT 精确脱敏，独立日志 sink 也安全', async () => {
    const log = vi.fn();
    await fetchZcodeQuota({ jwt: 'short-raw', deviceMid: 'mid' }, { log, fetchImpl: async () => { throw new Error('oops short-raw PAT=short-pat Authorization: Basic abc'); } });
    expect(log).toHaveBeenCalled(); const text = log.mock.calls.flat().join('');
    expect(text).not.toContain('short-raw'); expect(text).not.toContain('short-pat'); expect(text).not.toContain('Basic abc');
  });
  it('带上 R014 最小两头（Bearer + X-Device-Mid）', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ code: 0, data: { balances: [{ remaining_units: 7 }] } }), { status: 200 }),
    );
    await expect(fetchZcodeQuota({ jwt: 'jwt-1', deviceMid: 'mid-1' }, { fetchImpl })).resolves.toBe('ok');
    const init = fetchImpl.mock.calls[0]?.[1] as { headers: Record<string, string> };
    expect(init.headers['authorization']).toBe('Bearer jwt-1');
    expect(init.headers['x-device-mid']).toBe('mid-1');
  });

  it('429 重试一次；持续 429 → unknown（不当成不可用抛错）', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 429 }));
    await expect(
      fetchZcodeQuota({ jwt: 'j', deviceMid: 'm' }, { fetchImpl, retryDelayMs: 1 }),
    ).resolves.toBe('unknown');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('401 → relogin 错误上抛（fetchQuota 由 adapter 收敛为 unknown，probe 收敛为 logged-out）', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 401 }));
    await expect(
      fetchZcodeQuota({ jwt: 'j', deviceMid: 'm' }, { fetchImpl }),
    ).rejects.toMatchObject({ kind: 'relogin' });
  });

  it('网络失败 → unknown', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    await expect(fetchZcodeQuota({ jwt: 'j', deviceMid: 'm' }, { fetchImpl })).resolves.toBe('unknown');
  });
});
