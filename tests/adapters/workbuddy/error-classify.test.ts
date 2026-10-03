// WorkBuddy upstream 错误分类。
import { describe, expect, it } from 'vitest';
import { classifyWorkBuddyUpstreamError, statusToKind } from '../../../src/adapters/workbuddy/error-classify.js';

describe('statusToKind', () => {
  it('401 / 403 → authentication', () => {
    expect(statusToKind(401)).toBe('authentication');
    expect(statusToKind(403)).toBe('authentication');
  });
  it('402 → hard_credit', () => {
    expect(statusToKind(402)).toBe('hard_credit');
  });
  it('429 → soft_rate', () => {
    expect(statusToKind(429)).toBe('soft_rate');
  });
  it('404 → not_found', () => {
    expect(statusToKind(404)).toBe('not_found');
  });
  it('5xx → server', () => {
    expect(statusToKind(500)).toBe('server');
    expect(statusToKind(502)).toBe('server');
    expect(statusToKind(503)).toBe('server');
  });
  it('其它 4xx → client', () => {
    expect(statusToKind(400)).toBe('client');
    expect(statusToKind(422)).toBe('client');
  });
  it('< 400 → unconfigured（不应出现但兜底）', () => {
    expect(statusToKind(200)).toBe('unconfigured');
    expect(statusToKind(0)).toBe('unconfigured');
  });
});

describe('classifyWorkBuddyUpstreamError', () => {
  it('带 body 时把 body 作为 message', () => {
    const r = classifyWorkBuddyUpstreamError({ status: 401, body: 'invalid token' });
    expect(r.kind).toBe('authentication');
    expect(r.message).toBe('invalid token');
  });

  it('body 缺失时合成默认 message', () => {
    const r = classifyWorkBuddyUpstreamError({ status: 500 });
    expect(r.kind).toBe('server');
    expect(r.message).toMatch(/HTTP 500/);
  });

  it('超长 body 被截到 1024 字节', () => {
    const huge = 'x'.repeat(2048);
    const r = classifyWorkBuddyUpstreamError({ status: 400, body: huge });
    expect(r.message.length).toBeLessThanOrEqual(1024);
  });
});