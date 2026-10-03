// T023 · usage 归一与估算的单测。
// 口径铁律：真数透传不改写；估算必须带 estimated 标识；缺数返回 undefined 而不是 0。

import { describe, expect, it } from 'vitest';
import {
  estimateTokens,
  estimateTurnUsage,
  normalizeAnthropicUsage,
  normalizeOpenAiUsage,
  usageFromTokenBreakdown,
} from '../src/usage.js';

describe('normalizeOpenAiUsage', () => {
  it('真数透传：三个计数 + details 原样带出，不带 estimated', () => {
    const usage = normalizeOpenAiUsage({
      prompt_tokens: 12,
      completion_tokens: 34,
      total_tokens: 46,
      prompt_tokens_details: { cached_tokens: 8 },
    });
    expect(usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 34,
      total_tokens: 46,
      prompt_tokens_details: { cached_tokens: 8 },
    });
    expect(usage?.estimated).toBeUndefined();
  });

  it('缺 total 时用 prompt+completion 兜底；非法值（负数/非数字）忽略', () => {
    expect(normalizeOpenAiUsage({ prompt_tokens: 3, completion_tokens: 4 })).toEqual({
      prompt_tokens: 3,
      completion_tokens: 4,
      total_tokens: 7,
    });
    expect(normalizeOpenAiUsage({ prompt_tokens: -1, completion_tokens: 'x', total_tokens: 5 })).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 5,
    });
  });

  it('一个计数都没有 → undefined（不伪造 0）', () => {
    expect(normalizeOpenAiUsage(undefined)).toBeUndefined();
    expect(normalizeOpenAiUsage(null)).toBeUndefined();
    expect(normalizeOpenAiUsage({})).toBeUndefined();
    expect(normalizeOpenAiUsage({ id: 'x' })).toBeUndefined();
  });
});

describe('normalizeAnthropicUsage', () => {
  it('input/output → prompt/completion；缓存读写进 details', () => {
    expect(normalizeAnthropicUsage({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 5,
    })).toEqual({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 5 },
    });
  });
});

describe('usageFromTokenBreakdown（opencode / zcode app-server 同款分桶）', () => {
  it('opencode 口径：input 不含缓存 → prompt 含（用上游 total 消歧）', () => {
    // opencode 实测样本：{input:2, output:2, reasoning:0, cache:{read:3794,write:0}, total:3798}
    expect(usageFromTokenBreakdown({
      input: 2,
      output: 2,
      reasoning: 0,
      cacheRead: 3794,
      cacheWrite: 0,
      total: 3798,
    })).toEqual({
      prompt_tokens: 3796,
      completion_tokens: 2,
      total_tokens: 3798,
      prompt_tokens_details: { cached_tokens: 3794, cache_write_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    });
  });

  it('opencode：reasoning 并入 completion（total 与上游一致）', () => {
    // opencode 实测样本：{input:3658, output:1, reasoning:64, cache:{read:138,write:0}, total:3861}
    const usage = usageFromTokenBreakdown({
      input: 3658,
      output: 1,
      reasoning: 64,
      cacheRead: 138,
      cacheWrite: 0,
      total: 3861,
    });
    expect(usage?.prompt_tokens).toBe(3796);
    expect(usage?.completion_tokens).toBe(65);
    expect(usage?.total_tokens).toBe(3861); // == 上游 total
    expect(usage?.completion_tokens_details).toEqual({ reasoning_tokens: 64 });
  });

  it('ZCode app-server 口径：input 已含缓存 → prompt 不再叠加（同一 total 判据）', () => {
    // CLI 自身 DB 实测行：input 15050（含 cache_read 10176）/ output 84 / total 15134
    const usage = usageFromTokenBreakdown({
      input: 15050,
      output: 84,
      reasoning: 0,
      cacheRead: 10176,
      cacheWrite: 0,
      total: 15134,
    });
    expect(usage?.prompt_tokens).toBe(15050);
    expect(usage?.completion_tokens).toBe(84);
    expect(usage?.total_tokens).toBe(15134); // == 上游 total（未重复计缓存）
  });

  it('无 total 时按「input 含缓存」保守处理（不虚增）', () => {
    expect(usageFromTokenBreakdown({ input: 100, output: 5, cacheRead: 80 })).toEqual({
      prompt_tokens: 100,
      completion_tokens: 5,
      total_tokens: 105,
      prompt_tokens_details: { cached_tokens: 80 },
    });
  });

  it('全空 → undefined', () => {
    expect(usageFromTokenBreakdown({})).toBeUndefined();
  });
});

describe('estimateTokens / estimateTurnUsage', () => {
  it('CJK 按字计、拉丁按 1/4 字符计', () => {
    expect(estimateTokens('你好世界')).toBe(4);
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('')).toBe(0);
  });

  it('估算结果一律带 estimated: true，且 total = prompt + completion', () => {
    const usage = estimateTurnUsage('你好', 'ok');
    expect(usage.estimated).toBe(true);
    expect(usage.prompt_tokens).toBe(2);
    expect(usage.completion_tokens).toBe(1);
    expect(usage.total_tokens).toBe(3);
  });
});
