// Error kind → status 映射的单测。

import { describe, expect, it } from 'vitest';
import { STATUS_BY_KIND, statusFor } from '../../src/protocol/error-map.js';

describe('error-map', () => {
  it('STATUS_BY_KIND 七档完整', () => {
    expect(STATUS_BY_KIND).toEqual({
      authentication: 401,
      hard_credit: 402,
      soft_rate: 429,
      not_found: 502,
      server: 502,
      client: 400,
      unconfigured: 503,
    });
  });

  it('statusFor 返回每档对应 HTTP', () => {
    expect(statusFor('authentication')).toBe(401);
    expect(statusFor('hard_credit')).toBe(402);
    expect(statusFor('soft_rate')).toBe(429);
    expect(statusFor('server')).toBe(502);
    expect(statusFor('client')).toBe(400);
    expect(statusFor('unconfigured')).toBe(503);
  });
});