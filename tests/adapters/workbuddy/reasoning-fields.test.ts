// WorkBuddy reasoning effort 翻译矩阵（端口 spec §2.2.6）。
import { describe, expect, it } from 'vitest';
import {
  WORKBUDDY_PUBLIC_EFFORTS,
  WORKBUDDY_REASONING_EFFORTS,
  dropUnsupportedEffortForInternational,
  workBuddyReasoningFields,
} from '../../../src/adapters/workbuddy/reasoning-fields.js';

describe('词表常量', () => {
  it('effort 词表含 off/minimal/low/medium/high/xhigh/max', () => {
    expect(WORKBUDDY_REASONING_EFFORTS).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('公共 effort 不含 minimal（上游词表约束）', () => {
    expect(WORKBUDDY_PUBLIC_EFFORTS).not.toContain('minimal');
    expect(WORKBUDDY_PUBLIC_EFFORTS).toContain('off');
  });
});

describe('workBuddyReasoningFields', () => {
  it('supports !== true → reasoning: false + 空 supported', () => {
    const f = workBuddyReasoningFields({ supports: false });
    expect(f).toEqual({ reasoning: false, supported: [] });
  });

  it('supports=true + 非空 declared → 用 declared，去掉 minimal', () => {
    const f = workBuddyReasoningFields({
      supports: true,
      supportedEfforts: ['low', 'medium', 'minimal', 'high'],
      canDisableThinking: false,
    });
    expect(f.reasoning).toBe(true);
    expect(f.supported).toEqual(['low', 'medium', 'high']);
  });

  it('canDisableThinking=true → 加 off', () => {
    const f = workBuddyReasoningFields({
      supports: true,
      supportedEfforts: ['low', 'high'],
      canDisableThinking: true,
    });
    expect(f.supported).toEqual(['off', 'low', 'high']);
  });

  it('canDisableThinking=false → 不加 off', () => {
    const f = workBuddyReasoningFields({
      supports: true,
      supportedEfforts: ['low', 'high'],
      canDisableThinking: false,
    });
    expect(f.supported).not.toContain('off');
  });

  it('declared 空 + observed validation=validating + 非空 efforts → 用 observed', () => {
    const f = workBuddyReasoningFields({
      supports: true,
      supportedEfforts: [],
      observed: { validation: 'validating', efforts: ['low', 'medium'] },
    });
    expect(f.supported).toEqual(['low', 'medium']);
  });

  it('declared 空 + observed validation=valid → 不使用 observed', () => {
    const f = workBuddyReasoningFields({
      supports: true,
      supportedEfforts: [],
      observed: { validation: 'valid', efforts: ['low'] },
    });
    expect(f.supported).toEqual([]);
  });

  it('declared 空 + observed 也空 → reasoning=true 但 supported 空', () => {
    const f = workBuddyReasoningFields({
      supports: true,
      supportedEfforts: [],
      observed: { validation: 'validating', efforts: [] },
    });
    expect(f.reasoning).toBe(true);
    expect(f.supported).toEqual([]);
  });

  it('非法 effort 字符串被过滤掉', () => {
    const f = workBuddyReasoningFields({
      supports: true,
      supportedEfforts: ['low', 'NONSENSE', 'high'],
      canDisableThinking: false,
    });
    expect(f.supported).toEqual(['low', 'high']);
  });
});

describe('dropUnsupportedEffortForInternational', () => {
  it('effort=off + supported 不含 off → 删字段', () => {
    const body = { model: 'm', reasoning_effort: 'off' };
    const out = dropUnsupportedEffortForInternational(body, ['low', 'high']);
    expect(out).not.toHaveProperty('reasoning_effort');
  });

  it('effort=low + supported 含 low → 保留', () => {
    const body = { model: 'm', reasoning_effort: 'low' };
    const out = dropUnsupportedEffortForInternational(body, ['low']);
    expect(out).toEqual(body);
  });

  it('effort 不是字符串 → 原样返回', () => {
    const body = { model: 'm' };
    expect(dropUnsupportedEffortForInternational(body, [])).toBe(body);
  });

  it('不影响其它字段', () => {
    const body = { model: 'm', temperature: 0.7 };
    const out = dropUnsupportedEffortForInternational(body, ['low']);
    expect(out).toEqual({ model: 'm', temperature: 0.7 });
  });
});