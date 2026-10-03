// WorkBuddy catalog 测试。
import { describe, expect, it } from 'vitest';
import { WorkBuddyCatalog, FALLBACK_WORKBUDDY_MODELS_CN, fallbackModelsFor } from '../../../src/adapters/workbuddy/catalog.js';

describe('WorkBuddyCatalog', () => {
  it('CN variant 首构造填入静态兜底', () => {
    const cat = new WorkBuddyCatalog('cn');
    expect(cat.current().length).toBeGreaterThan(0);
    expect(cat.current()[0]?.id).toBe('DeepSeek-V4-Flash-Official');
  });

  it('Global variant 首构造填入空（Phase 2+ 再补）', () => {
    const cat = new WorkBuddyCatalog('global');
    expect(cat.current()).toEqual([]);
  });

  it('set() 接受新列表', () => {
    const cat = new WorkBuddyCatalog('cn');
    cat.set([{ id: 'm1', displayName: 'M1', supportVision: false, supportTools: true, input: ['text'], output: ['text'], status: 'available' }]);
    expect(cat.current()).toEqual([expect.objectContaining({ id: 'm1' })]);
  });

  it('set() 拒绝空列表', () => {
    const cat = new WorkBuddyCatalog('cn');
    expect(() => cat.set([])).toThrow(/cannot be empty/);
  });

  it('set() 深拷贝 reasoning 与 input/output 数组', () => {
    const cat = new WorkBuddyCatalog('cn');
    const effortArr = ['low', 'high'];
    cat.set([{ id: 'm', displayName: 'M', supportVision: false, supportTools: true, input: ['text'], output: ['text'], status: 'available', reasoning: { supports: true, supportedEfforts: effortArr, canDisableThinking: true } }]);
    // set 时已深拷贝：cat 内部的 supportedEfforts 是新数组，原数组 mutation 不影响
    effortArr.push('medium');
    expect(cat.current()[0]?.reasoning?.supportedEfforts).toEqual(['low', 'high']);
  });
});

describe('fallbackModelsFor', () => {
  it('CN 返回静态兜底', () => {
    expect(fallbackModelsFor('cn')).toEqual(FALLBACK_WORKBUDDY_MODELS_CN);
  });
  it('Global 返回空数组', () => {
    expect(fallbackModelsFor('global')).toEqual([]);
  });
});

// parseWorkBuddyCatalogResponse 的行为用例在 parse-catalog.test.ts
// （四轮返工按 /v3/config 真实形状重写；旧 modelId/abilities 字段形状
// 不在真实协议里，已随实现一并移除）。