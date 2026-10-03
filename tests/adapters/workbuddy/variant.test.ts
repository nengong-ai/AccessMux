// WorkBuddy variant 解析 + 区域枚举：MVP 只实装 CN；Global 占位识别但未实装。
import { describe, expect, it } from 'vitest';
import { parseWorkBuddyVariant } from '../../../src/adapters/workbuddy/variant.js';

describe('parseWorkBuddyVariant', () => {
  it('CN 接受；case-insensitive', () => {
    expect(parseWorkBuddyVariant('cn')).toBe('cn');
    expect(parseWorkBuddyVariant('CN')).toBe('cn');
    expect(parseWorkBuddyVariant('  cn  ')).toBe('cn');
  });

  it('Global 接受但识别为未实装占位', () => {
    expect(parseWorkBuddyVariant('global')).toBe('global');
    expect(parseWorkBuddyVariant('GLOBAL')).toBe('global');
  });

  it('非法 variant 抛错', () => {
    expect(() => parseWorkBuddyVariant('jp')).toThrow(/not recognized/);
    expect(() => parseWorkBuddyVariant('')).toThrow(/not recognized/);
    expect(() => parseWorkBuddyVariant(null)).toThrow(/must be a string/);
    expect(() => parseWorkBuddyVariant(42)).toThrow(/must be a string/);
  });
});