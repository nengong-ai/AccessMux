// WorkBuddy checkin 单测（T027 验收标准 1/4）。
// 离线：注入 fetchImpl，不发真请求；覆盖 active 门控、幂等、错误语义。

import { describe, expect, it } from 'vitest';
import {
  claimWorkBuddyDaily,
  fetchWorkBuddyCheckinStatus,
  runWorkBuddyCheckin,
} from '../../src/checkin/workbuddy.js';

const CREDENTIAL = { accessToken: 'test-access-token', userId: 'test-user' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function activeEnvelope(extra: Record<string, unknown> = {}): unknown {
  return {
    code: 0,
    msg: 'OK',
    data: { active: true, today_checked_in: false, today_credit: 100, streak_days: 3, ...extra },
  };
}

describe('fetchWorkBuddyCheckinStatus', () => {
  it('active=true + 未签：归一状态与金额', async () => {
    const outcome = await fetchWorkBuddyCheckinStatus(CREDENTIAL, {
      fetchImpl: (async () => jsonResponse(activeEnvelope())) as unknown as typeof fetch,
    });
    expect(outcome).toEqual({ kind: 'active', todayCheckedIn: false, todayCredit: 100, streakDays: 3 });
  });

  it('active=false：活动关闭（不报错）', async () => {
    const outcome = await fetchWorkBuddyCheckinStatus(CREDENTIAL, {
      fetchImpl: (async () => jsonResponse({ code: 0, msg: 'OK', data: { active: false } })) as unknown as typeof fetch,
    });
    expect(outcome).toEqual({ kind: 'inactive' });
  });

  it('基础四头不含任何设备/Turing 头（铁律）', async () => {
    let seen: Record<string, string> = {};
    await fetchWorkBuddyCheckinStatus(CREDENTIAL, {
      fetchImpl: (async (_url: string, init: RequestInit) => {
        seen = init.headers as Record<string, string>;
        return jsonResponse(activeEnvelope());
      }) as unknown as typeof fetch,
    });
    expect(seen['Authorization']).toBe('Bearer test-access-token');
    expect(seen['X-User-Id']).toBe('test-user');
    expect(seen['Content-Type']).toBe('application/json');
    for (const key of Object.keys(seen)) {
      expect(key.toLowerCase()).not.toContain('device');
      expect(key.toLowerCase()).not.toContain('turing');
    }
  });

  it('业务码非 0 且 DEAD_MARKER：提示重新登录', async () => {
    const outcome = await fetchWorkBuddyCheckinStatus(CREDENTIAL, {
      fetchImpl: (async () => jsonResponse({ code: 12153, msg: 'Offline user session not found', data: {} })) as unknown as typeof fetch,
    });
    expect(outcome).toMatchObject({ kind: 'error' });
    expect((outcome as { message: string }).message).toContain('重新登录');
  });

  it('网络失败：可诊断错误，不抛异常', async () => {
    const outcome = await fetchWorkBuddyCheckinStatus(CREDENTIAL, {
      fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch,
    });
    expect(outcome).toMatchObject({ kind: 'error' });
    expect((outcome as { message: string }).message).toContain('网络失败');
  });
});

describe('claimWorkBuddyDaily', () => {
  it('成功：返回 credit 与连签', async () => {
    const outcome = await claimWorkBuddyDaily(CREDENTIAL, {
      fetchImpl: (async () => jsonResponse({ code: 0, msg: 'OK', data: { credit: 100, streak_days: 4 } })) as unknown as typeof fetch,
    });
    expect(outcome).toEqual({ kind: 'claimed', credit: 100, streakDays: 4 });
  });

  it('服务端幂等拒绝（already）：归为 already 而非报错', async () => {
    const outcome = await claimWorkBuddyDaily(CREDENTIAL, {
      fetchImpl: (async () => jsonResponse({ code: 40001, msg: 'alreadyClaimed', data: {} })) as unknown as typeof fetch,
    });
    expect(outcome).toEqual({ kind: 'already' });
  });
});

describe('runWorkBuddyCheckin', () => {
  it('活动关闭：优雅输出"活动关闭"，且绝不发 claim 请求', async () => {
    const calls: string[] = [];
    const result = await runWorkBuddyCheckin({
      resolveCredential: async () => CREDENTIAL,
      fetchImpl: (async (url: string) => {
        calls.push(String(url));
        return jsonResponse({ code: 0, msg: 'OK', data: { active: false } });
      }) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ source: 'workbuddy', verdict: 'inactive' });
    expect(calls).toHaveLength(1); // 只有 status 一发
    expect(calls[0]).toContain('checkin-status');
  });

  it('今日已领：输出"已领"，绝不重复 claim（幂等验收）', async () => {
    const calls: string[] = [];
    const result = await runWorkBuddyCheckin({
      resolveCredential: async () => CREDENTIAL,
      fetchImpl: (async (url: string) => {
        calls.push(String(url));
        return jsonResponse(activeEnvelope({ today_checked_in: true }));
      }) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ source: 'workbuddy', verdict: 'already' });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('checkin-status');
  });

  it('active + 未签：status → claim 两发，输出"已领取"', async () => {
    const calls: string[] = [];
    const result = await runWorkBuddyCheckin({
      resolveCredential: async () => CREDENTIAL,
      fetchImpl: (async (url: string) => {
        calls.push(String(url));
        if (String(url).endsWith('/checkin-status')) return jsonResponse(activeEnvelope());
        return jsonResponse({ code: 0, msg: 'OK', data: { credit: 100, streak_days: 1 } });
      }) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ source: 'workbuddy', verdict: 'claimed' });
    expect(result.message).toContain('+100');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('daily-checkin');
  });

  it('凭据缺失：跳过+原因（验收标准 4）', async () => {
    const result = await runWorkBuddyCheckin({
      resolveCredential: async () => { throw new Error('no signed-in account found'); },
      fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch,
    });
    expect(result).toMatchObject({ source: 'workbuddy', verdict: 'skipped' });
    expect(result.message).toContain('登录');
  });
});
