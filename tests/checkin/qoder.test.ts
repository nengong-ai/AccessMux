// Qoder checkin 单测（T027 验收标准 2/4）。
// 离线：注入 fetchImpl 模拟 exchange → campaigns → claim 三发链路。
// 覆盖：PAT 缺失跳过、Cosy-ClientType 软门、幂等 replayed、软门空列表语义。

import { describe, expect, it } from 'vitest';
import {
  claimQoderCampaign,
  exchangeQoderPat,
  fetchQoderCampaigns,
  runQoderCheckin,
} from '../../src/checkin/qoder.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** 三发链路的可编程 fetch：按 URL 后缀分派。 */
function chainFetch(overrides: {
  exchange?: Response | (() => Response);
  campaigns?: Response | (() => Response);
  claim?: Response | (() => Response);
  seen?: Seen[];
} = {}): typeof fetch {
  return (async (url: string, init: RequestInit = {}) => {
    const seen = overrides.seen;
    if (seen !== undefined) {
      seen.push({
        url: String(url),
        method: String(init.method ?? 'GET'),
        headers: (init.headers ?? {}) as Record<string, string>,
        ...(init.body === undefined ? {} : { body: String(init.body) }),
      });
    }
    const pick = (value: Response | (() => Response) | undefined, fallback: () => Response): Response =>
      value === undefined ? fallback() : (typeof value === 'function' ? value() : value);
    if (String(url).endsWith('/api/v1/jobToken/exchange')) {
      return pick(overrides.exchange, () => jsonResponse({ token: 'job-token-1' }));
    }
    if (String(url).endsWith('/claim')) {
      return pick(overrides.claim, () => jsonResponse({ data: { status: 'CLAIMED', replayed: false, benefit: { amount: 100 } } }));
    }
    return pick(overrides.campaigns, () => jsonResponse({
      campaigns: [{ campaignId: 'c1', campaignKey: 'daily-100', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMABLE', benefit: { amount: 100 } }],
    }));
  }) as unknown as typeof fetch;
}

describe('exchangeQoderPat', () => {
  it('PAT 换 token：POST personal_token，返回 jobToken', async () => {
    const seen: Seen[] = [];
    const outcome = await exchangeQoderPat('pat-value', { fetchImpl: chainFetch({ seen }) });
    expect(outcome.token).toBe('job-token-1');
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.body).toContain('personal_token');
    expect(seen[0]?.body).toContain('pat-value');
  });

  it('HTTP 401：抛可识别错误（不含原值）', async () => {
    await expect(
      exchangeQoderPat('bad-pat', { fetchImpl: chainFetch({ exchange: jsonResponse({ message: 'unauthorized' }, 401) }) }),
    ).rejects.toThrow(/HTTP 401/);
  });

  it('响应无 token：抛错（PAT 可能无效）', async () => {
    await expect(
      exchangeQoderPat('pat', { fetchImpl: chainFetch({ exchange: jsonResponse({ ok: true }) }) }),
    ).rejects.toThrow(/PAT/);
  });
});

describe('fetchQoderCampaigns', () => {
  it('必带 Cosy-ClientType=10（缺它上游 200 空列表——软门）', async () => {
    const seen: Seen[] = [];
    await fetchQoderCampaigns('job-token-1', { fetchImpl: chainFetch({ seen }) });
    const headers = seen[0]?.headers ?? {};
    const lowered = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    expect(lowered['cosy-clienttype']).toBe('10');
    expect(lowered['authorization']).toBe('Bearer job-token-1');
  });

  it('**不带任何 Cosy-Machine* 设备头**（macOS 铁律，不伪造设备指纹）', async () => {
    const seen: Seen[] = [];
    await fetchQoderCampaigns('job-token-1', { fetchImpl: chainFetch({ seen }) });
    const headers = seen[0]?.headers ?? {};
    for (const key of Object.keys(headers)) {
      expect(key.toLowerCase()).not.toContain('machine');
    }
  });

  it('空 campaigns：如实返回空数组（不猜、不报错）', async () => {
    const campaigns = await fetchQoderCampaigns('job-token-1', {
      fetchImpl: chainFetch({ campaigns: jsonResponse({ campaigns: [] }) }),
    });
    expect(campaigns).toEqual([]);
  });
});

describe('claimQoderCampaign', () => {
  it('状态 CLAIMED：归一成功 + 金额', async () => {
    const outcome = await claimQoderCampaign('job-token-1', 'c1', {
      fetchImpl: chainFetch({ claim: jsonResponse({ data: { status: 'CLAIMED', replayed: false, benefit: { amount: 100 } } }) }),
    });
    expect(outcome).toEqual({ kind: 'claimed', replayed: false, credits: 100 });
  });

  it('replayed=true：服务端判定重复领（幂等证据）', async () => {
    const outcome = await claimQoderCampaign('job-token-1', 'c1', {
      fetchImpl: chainFetch({ claim: jsonResponse({ data: { status: 'CLAIMED', replayed: true, benefit: { amount: 100 } } }) }),
    });
    expect(outcome).toMatchObject({ kind: 'claimed', replayed: true });
  });

  it('状态异常：归为 error', async () => {
    const outcome = await claimQoderCampaign('job-token-1', 'c1', {
      fetchImpl: chainFetch({ claim: jsonResponse({ data: { status: 'PENDING' } }) }),
    });
    expect(outcome).toMatchObject({ kind: 'error' });
  });
});

describe('runQoderCheckin', () => {
  it('未配 PAT：跳过+原因（不报错，验收标准 4）', async () => {
    const result = await runQoderCheckin({
      resolvePat: () => undefined,
      fetchImpl: chainFetch(),
    });
    expect(result).toMatchObject({ source: 'qoder', verdict: 'skipped' });
    expect(result.message).toContain('PAT');
  });

  it('PAT 无效（exchange 401/403）：跳过+重新生成指引', async () => {
    const result = await runQoderCheckin({
      resolvePat: () => 'expired-pat',
      fetchImpl: chainFetch({ exchange: jsonResponse({}, 401) }),
    });
    expect(result).toMatchObject({ source: 'qoder', verdict: 'skipped' });
    expect(result.message).toContain('重新生成');
  });

  it('PAT 无效真机形态（exchange HTTP 400）：同样归"跳过+重新生成"', async () => {
    const result = await runQoderCheckin({
      resolvePat: () => 'bad-pat',
      fetchImpl: chainFetch({ exchange: jsonResponse({ errorCode: 'BadRequest' }, 400) }),
    });
    expect(result).toMatchObject({ source: 'qoder', verdict: 'skipped' });
    expect(result.message).toContain('重新生成');
  });

  it('满链成功：PAT → token → 可领活动 → claim，输出"已领取 +100"', async () => {
    const seen: Seen[] = [];
    const result = await runQoderCheckin({
      resolvePat: () => 'good-pat',
      fetchImpl: chainFetch({ seen }),
    });
    expect(result).toMatchObject({ source: 'qoder', verdict: 'claimed' });
    expect(result.message).toContain('100');
    expect(seen.map((s) => s.url.replace(/^.*qoder\.com\.cn/, ''))).toEqual([
      '/api/v1/jobToken/exchange',
      '/sash/api/v1/me/campaigns',
      '/sash/api/v1/me/campaigns/c1/claim',
    ]);
  });

  it('活动已领（claimStatus=CLAIMED）：输出"已领"，不发 claim 请求（幂等）', async () => {
    const seen: Seen[] = [];
    const result = await runQoderCheckin({
      resolvePat: () => 'good-pat',
      fetchImpl: chainFetch({
        seen,
        campaigns: jsonResponse({
          campaigns: [{ campaignId: 'c1', campaignKey: 'daily-100', actionType: 'CLAIM_BENEFIT', claimStatus: 'CLAIMED', benefit: { amount: 100 } }],
        }),
      }),
    });
    expect(result).toMatchObject({ source: 'qoder', verdict: 'already' });
    expect(seen.map((s) => s.url)).not.toContainEqual(expect.stringContaining('/claim'));
  });

  it('无活动下发：inactive（如实报告，不猜"被软门拦"）', async () => {
    const result = await runQoderCheckin({
      resolvePat: () => 'good-pat',
      fetchImpl: chainFetch({ campaigns: jsonResponse({ campaigns: [] }) }),
    });
    expect(result).toMatchObject({ source: 'qoder', verdict: 'inactive' });
  });

  it('网络失败：error 级（退出码非 0 的路径）', async () => {
    const result = await runQoderCheckin({
      resolvePat: () => 'good-pat',
      fetchImpl: (async () => { throw new Error('ENOTFOUND'); }) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ source: 'qoder', verdict: 'error' });
  });
});
