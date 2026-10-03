// ZCode checkin 单测（T027 验收标准 3）。
// 离线：注入 fetchImpl。覆盖：plans 空 → 静默跳过；plans 非空 → 提示；
// 最小两头合同（Bearer + X-Device-Mid）；凭据缺失 → 跳过+原因。

import { describe, expect, it } from 'vitest';
import { fetchZcodePreview, runZcodeCheckin } from '../../src/checkin/zcode.js';

const CREDENTIAL = { jwt: 'test.jwt.value', deviceMid: 'device-mid-1' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('fetchZcodePreview', () => {
  it('plans=[]：empty（当前常态，静默跳过）', async () => {
    const outcome = await fetchZcodePreview(CREDENTIAL, {
      fetchImpl: (async () => jsonResponse({ code: 0, data: { plans: [] } })) as unknown as typeof fetch,
    });
    expect(outcome).toEqual({ kind: 'empty' });
  });

  it('plans 非空：提取活动名', async () => {
    const outcome = await fetchZcodePreview(CREDENTIAL, {
      fetchImpl: (async () => jsonResponse({
        code: 0,
        data: { plans: [{ plan_id: 'p1', name: '新用户礼包' }, { plan_id: 'p2' }] },
      })) as unknown as typeof fetch,
    });
    expect(outcome).toEqual({ kind: 'plans', planNames: ['新用户礼包', 'p2'] });
  });

  it('最小两头：Bearer + X-Device-Mid（R019 合同）', async () => {
    let headers: Record<string, string> = {};
    await fetchZcodePreview(CREDENTIAL, {
      fetchImpl: (async (_url: string, init: RequestInit) => {
        headers = init.headers as Record<string, string>;
        return jsonResponse({ code: 0, data: { plans: [] } });
      }) as unknown as typeof fetch,
    });
    expect(headers['authorization']).toBe('Bearer test.jwt.value');
    expect(headers['x-device-mid']).toBe('device-mid-1');
    expect(Object.keys(headers)).toHaveLength(2); // 只有两头，无设备头族
  });

  it('401：提示重新登录', async () => {
    const outcome = await fetchZcodePreview(CREDENTIAL, {
      fetchImpl: (async () => jsonResponse({}, 401)) as unknown as typeof fetch,
    });
    expect(outcome).toMatchObject({ kind: 'error' });
    expect((outcome as { message: string }).message).toContain('重新登录');
  });

  it('形状不符：error（不猜）', async () => {
    const outcome = await fetchZcodePreview(CREDENTIAL, {
      fetchImpl: (async () => jsonResponse({ hello: 'world' })) as unknown as typeof fetch,
    });
    expect(outcome).toMatchObject({ kind: 'error' });
  });
});

describe('runZcodeCheckin', () => {
  it('plans 空：静默跳过（"无需签到"如实公示）', async () => {
    const result = await runZcodeCheckin({
      loadCredential: () => CREDENTIAL,
      fetchImpl: (async () => jsonResponse({ code: 0, data: { plans: [] } })) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ source: 'zcode', verdict: 'skipped' });
    expect(result.message).toContain('自动发放');
  });

  it('plans 非空：hint 提示去官方客户端（绝不自动 claim）', async () => {
    const result = await runZcodeCheckin({
      loadCredential: () => CREDENTIAL,
      fetchImpl: (async () => jsonResponse({ code: 0, data: { plans: [{ plan_id: 'p1', name: '活动A' }] } })) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ source: 'zcode', verdict: 'hint' });
    expect(result.message).toContain('官方客户端');
    expect(result.message).toContain('活动A');
  });

  it('凭据缺失：跳过+原因', async () => {
    const result = await runZcodeCheckin({
      loadCredential: () => { throw new Error('no zcodejwttoken'); },
      fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ source: 'zcode', verdict: 'skipped' });
  });
});
