// 推理 effort 词汇表与解析测试。

import { describe, expect, it } from 'vitest';
import {
  applyReasoningEffort,
  parseReasoningCapability,
  TRAE_REASONING_EFFORTS,
} from '../../../src/adapters/trae/reasoning.js';

describe('TRAE_REASONING_EFFORTS', () => {
  it('五档：minimal / low / medium / high / xhigh', () => {
    expect(TRAE_REASONING_EFFORTS).toEqual(['minimal', 'low', 'medium', 'high', 'xhigh']);
  });
});

describe('parseReasoningCapability', () => {
  it('缺字段返回 undefined', () => {
    expect(parseReasoningCapability(null)).toBeUndefined();
    expect(parseReasoningCapability({})).toBeUndefined();
  });

  it('保留词表内的 effort，过滤掉词表外的', () => {
    const cap = parseReasoningCapability({
      reasoning_effort_options: ['low', 'medium', 'BOGUS'],
      default_reasoning_effort: 'medium',
    });
    expect(cap).toEqual({ supported: ['low', 'medium'], defaultEffort: 'medium' });
  });

  it('default 不在 supported 时不填', () => {
    const cap = parseReasoningCapability({
      reasoning_effort_options: ['low'],
      default_reasoning_effort: 'high',
    });
    expect(cap?.defaultEffort).toBeUndefined();
  });

  it('非数组 reasoning_effort_options 不崩', () => {
    expect(parseReasoningCapability({ reasoning_effort_options: 'low,medium' })).toBeUndefined();
  });
});

describe('applyReasoningEffort', () => {
  const capability = parseReasoningCapability({ reasoning_effort_options: ['low', 'medium', 'high'] });

  it('effort undefined 不写字段', () => {
    expect(applyReasoningEffort({ model: 'x' }, undefined, capability)).toEqual({ model: 'x' });
  });

  it('effort 在能力表内写入', () => {
    expect(applyReasoningEffort({ model: 'x' }, 'medium', capability)).toEqual({ model: 'x', reasoning_effort: 'medium' });
  });

  it('effort 不在能力表内抛错', () => {
    expect(() => applyReasoningEffort({ model: 'x' }, 'xhigh', capability)).toThrow(/xhigh/);
  });

  it('capability undefined 但 effort 非 undefined 抛错', () => {
    expect(() => applyReasoningEffort({ model: 'x' }, 'low', undefined)).toThrow(/low/);
  });
});