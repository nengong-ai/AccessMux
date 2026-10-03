// WorkBuddy region / endpoint 解析 + 变体映射。
import { describe, expect, it } from 'vitest';
import { REGION_GATEWAYS, variantOfHost } from '../../../src/adapters/workbuddy/region.js';

describe('REGION_GATEWAYS', () => {
  it('CN 与 Global 都返回 https:// 形态 base', () => {
    expect(REGION_GATEWAYS.cn.catalog.startsWith('https://')).toBe(true);
    expect(REGION_GATEWAYS.cn.refresh.startsWith('https://')).toBe(true);
    expect(REGION_GATEWAYS.cn.chat.startsWith('https://')).toBe(true);
    expect(REGION_GATEWAYS.global.catalog.startsWith('https://')).toBe(true);
  });

  it('CN 与 Global 是不同 host', () => {
    expect(REGION_GATEWAYS.cn.chat).not.toBe(REGION_GATEWAYS.global.chat);
  });
});

describe('variantOfHost', () => {
  it('.codebuddy.cn / .tencent.com → cn', () => {
    expect(variantOfHost('https://api.codebuddy.cn')).toBe('cn');
    expect(variantOfHost('https://copilot.tencent.com')).toBe('cn');
    expect(variantOfHost('https://www.codebuddy.cn/v1/models')).toBe('cn');
  });

  it('.workbuddy.ai → global', () => {
    expect(variantOfHost('https://api.workbuddy.ai')).toBe('global');
    expect(variantOfHost('https://www.workbuddy.ai')).toBe('global');
  });

  it('未知或空 host 兜底 cn（MVP 默认）', () => {
    expect(variantOfHost(undefined)).toBe('cn');
    expect(variantOfHost('')).toBe('cn');
    expect(variantOfHost('not-a-url')).toBe('cn');
    expect(variantOfHost('https://unknown.example.com')).toBe('cn');
  });
});