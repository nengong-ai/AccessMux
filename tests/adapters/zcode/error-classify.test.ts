// T019 上游错误分类（验收标准 3：401/429/3012 三分类）。

import { describe, expect, it } from 'vitest';
import {
  classifyUpstreamResponse,
  ZcodeUpstreamError,
} from '../../../src/adapters/zcode/error-classify.js';

describe('ZCode 上游错误分类', () => {
  it('401 → relogin（JWT 无 refresh，只能重登）', () => {
    const error = classifyUpstreamResponse({ status: 401, body: { code: 1006, msg: 'unauthorized' } });
    expect(error).toBeInstanceOf(ZcodeUpstreamError);
    expect(error.kind).toBe('relogin');
    expect(error.message).toContain('重新登录');
  });

  it('429 → rateLimited（限流可重试）', () => {
    const error = classifyUpstreamResponse({ status: 429, body: undefined });
    expect(error.kind).toBe('rateLimited');
    expect(error.message).toContain('429');
  });

  it('405 + code 3012 → prefixGate（前缀门，触发降级兜底）', () => {
    const error = classifyUpstreamResponse({
      status: 405,
      body: { code: 3012, msg: 'request has been blocked due to unusual activity.', logid: 'x' },
    });
    expect(error.kind).toBe('prefixGate');
    expect(error.upstreamCode).toBe(3012);
    expect(error.message).toContain('前缀门');
  });

  it('405 无 JSON body 也按前缀门同族处理', () => {
    const error = classifyUpstreamResponse({ status: 405, body: undefined });
    expect(error.kind).toBe('prefixGate');
  });

  it('其余 → upstream 透传（含上游 msg）', () => {
    const error = classifyUpstreamResponse({ status: 500, body: { code: 3001, msg: 'parameter error' } });
    expect(error.kind).toBe('upstream');
    expect(error.message).toContain('parameter error');
  });

  it('error 包装形态（{error:{code,message}}）也能提取 code/message', () => {
    const error = classifyUpstreamResponse({
      status: 400,
      body: { error: { code: 'invalid_request', message: 'max_tokens too large' } },
    });
    expect(error.kind).toBe('upstream');
    expect(error.upstreamCode).toBe('invalid_request');
    expect(error.message).toContain('max_tokens too large');
  });

  it('3006（model not allowed）附权益提示（T019 真机实证的权益粒度模型门）', () => {
    const error = classifyUpstreamResponse({
      status: 400,
      body: { code: 3006, msg: 'model not allowed' },
    });
    expect(error.kind).toBe('upstream');
    expect(error.message).toContain('不在当前 Start Plan 权益内');
  });
});
