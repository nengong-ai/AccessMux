// checkin 协调器单测（T027 验收标准 4/5）。
// 覆盖：逐源开关、退出码语义（error → 1）、PAT 文件读写（0600）、
// 结果行格式、单源异常隔离。

import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { printCheckinResults, runCheckinAll } from '../../src/checkin/index.js';
import { readQoderPat, writeQoderPat } from '../../src/checkin/pat-store.js';
import { formatCheckinLine } from '../../src/checkin/types.js';

let tmpDir = '';
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'accessmux-checkin-')); });
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

const OK_CREDENTIAL = { accessToken: 't', userId: 'u' };
const ZCODE_CREDENTIAL = { jwt: 'a.b.c', deviceMid: 'mid' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** 全源成功的 fetch 分派器（按域名路由）。 */
function allOkFetch(): typeof fetch {
  return (async (url: string) => {
    const target = String(url);
    if (target.includes('workbuddy.cn')) {
      return jsonResponse({ code: 0, msg: 'OK', data: { active: false } });
    }
    if (target.includes('zcode.z.ai')) {
      return jsonResponse({ code: 0, data: { plans: [] } });
    }
    return jsonResponse({ campaigns: [] });
  }) as unknown as typeof fetch;
}

describe('runCheckinAll', () => {
  it('默认全源：逐源结果按 WorkBuddy → Qoder → ZCode 顺序', async () => {
    const results = await runCheckinAll({
      fetchImpl: allOkFetch(),
      resolveWorkBuddyCredential: async () => OK_CREDENTIAL,
      loadZcodeCheckinCredential: () => ZCODE_CREDENTIAL,
    });
    expect(results.map((r) => r.source)).toEqual(['workbuddy', 'qoder', 'zcode']);
    expect(results[0]).toMatchObject({ verdict: 'inactive' });
    expect(results[1]).toMatchObject({ verdict: 'skipped' }); // 无 PAT
    expect(results[2]).toMatchObject({ verdict: 'skipped' }); // plans 空
  });

  it('sources 开关：显式 false 的源完全不跑（不解析凭据）', async () => {
    let zcodeTouched = false;
    const results = await runCheckinAll({
      sources: { workbuddy: false, zcode: true },
      fetchImpl: allOkFetch(),
      resolveWorkBuddyCredential: async () => { throw new Error('不该被调用'); },
      loadZcodeCheckinCredential: () => { zcodeTouched = true; return ZCODE_CREDENTIAL; },
    });
    expect(zcodeTouched).toBe(true);
    expect(results.map((r) => r.source)).toEqual(['qoder', 'zcode']);
  });

  it('凭据解析抛异常：该源归 skipped/error，不拖垮其余（单源隔离）', async () => {
    const results = await runCheckinAll({
      fetchImpl: allOkFetch(),
      resolveWorkBuddyCredential: async () => { throw new Error('decrypt failed'); },
      loadZcodeCheckinCredential: () => ZCODE_CREDENTIAL,
    });
    expect(results).toHaveLength(3);
    expect(results[0]?.source).toBe('workbuddy');
    expect(results[0]?.verdict).toBe('skipped');
    expect(results[2]?.source).toBe('zcode');
  });

  it('Qoder exchange 无 token：该源 error，其余源结果不受影响（单源隔离）', async () => {
    const results = await runCheckinAll({
      fetchImpl: allOkFetch(),
      resolveWorkBuddyCredential: async () => OK_CREDENTIAL,
      loadZcodeCheckinCredential: () => ZCODE_CREDENTIAL,
      qoderPat: 'p',
    });
    expect(results).toHaveLength(3);
    expect(results[1]).toMatchObject({ source: 'qoder', verdict: 'error' });
    expect(results[0]?.verdict).not.toBe('error');
    expect(results[2]?.verdict).not.toBe('error');
  });
});

describe('printCheckinResults', () => {
  it('全无 error：退出码 0；含 error：退出码 1', () => {
    const lines: string[] = [];
    const ok = printCheckinResults([
      { source: 'workbuddy', verdict: 'already', message: '今日已领' },
      { source: 'qoder', verdict: 'inactive', message: '无活动' },
    ], (line) => lines.push(line));
    expect(ok).toBe(0);
    expect(lines[0]).toBe('workbuddy\t已领：今日已领');

    const bad = printCheckinResults([
      { source: 'qoder', verdict: 'error', message: '网络失败' },
    ], (line) => lines.push(line));
    expect(bad).toBe(1);
  });
});

describe('formatCheckinLine', () => {
  it('每源一行；四类正常结论都有中文标签', () => {
    expect(formatCheckinLine({ source: 'workbuddy', verdict: 'claimed', message: '领取成功' })).toBe('workbuddy\t已领取：领取成功');
    expect(formatCheckinLine({ source: 'qoder', verdict: 'already', message: 'x' })).toBe('qoder\t已领：x');
    expect(formatCheckinLine({ source: 'zcode', verdict: 'inactive', message: 'x' })).toBe('zcode\t活动关闭：x');
    expect(formatCheckinLine({ source: 'qoder', verdict: 'skipped', message: 'x' })).toBe('qoder\t跳过：x');
  });
});

describe('Qoder PAT 文件（0600 权限契约）', () => {
  it('写入后可读回；文件权限 0600', () => {
    const path = join(tmpDir, 'qoder.pat');
    const { path: written } = writeQoderPat('  pat-abc  ', path);
    expect(written).toBe(path);
    expect(readQoderPat(path)).toBe('pat-abc'); // trim
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('不存在 / 空内容：返回 undefined；空值写入被拒绝', () => {
    expect(readQoderPat(join(tmpDir, 'nope.pat'))).toBeUndefined();
    const empty = join(tmpDir, 'empty.pat');
    writeQoderPat('x', empty);
    // 空 PAT 不允许写入（防误清空）
    expect(() => writeQoderPat('   ', empty)).toThrow(/为空/);
    expect(readQoderPat(empty)).toBe('x'); // 原值未被破坏
  });
});
