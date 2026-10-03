// TraeCatalog + 静态兜底测试。

import { describe, expect, it } from 'vitest';
import { TraeCatalog, FALLBACK_TRAE_MODELS_CN, FALLBACK_TRAE_MODELS_AI, fallbackModelsFor } from '../../../src/adapters/trae/catalog.js';

describe('TraeCatalog 静态兜底', () => {
  it('CN 兜底含 DeepSeek / GLM / Kimi', () => {
    const ids = FALLBACK_TRAE_MODELS_CN.map((m) => m.id);
    expect(ids).toContain('DeepSeek-V4-Flash-Official');
    expect(ids).toContain('glm-5.2');
    expect(ids).toContain('kimi-k2.6');
  });

  it('AI 兜底含 Gemini / MiniMax / GPT', () => {
    const ids = FALLBACK_TRAE_MODELS_AI.map((m) => m.id);
    expect(ids).toContain('gemini-3.1-pro');
    expect(ids).toContain('minimax-m3');
    expect(ids).toContain('gpt-5.4');
  });

  it('CN 与 AI 兜底几乎不重叠', () => {
    const cn = new Set(FALLBACK_TRAE_MODELS_CN.map((m) => m.id));
    const ai = new Set(FALLBACK_TRAE_MODELS_AI.map((m) => m.id));
    let overlap = 0;
    for (const id of cn) if (ai.has(id)) overlap++;
    expect(overlap).toBe(0);
  });

  it('fallbackModelsFor(region) 路由', () => {
    expect(fallbackModelsFor('cn')).toBe(FALLBACK_TRAE_MODELS_CN);
    expect(fallbackModelsFor('ai')).toBe(FALLBACK_TRAE_MODELS_AI);
  });
});

describe('TraeCatalog 实例', () => {
  it('默认 region=cn 构造时 current() 是 CN 兜底', () => {
    const c = new TraeCatalog();
    expect(c.current()).toBe(FALLBACK_TRAE_MODELS_CN);
  });

  it('region=ai 构造时 current() 是 AI 兜底', () => {
    const c = new TraeCatalog('ai');
    expect(c.current()).toBe(FALLBACK_TRAE_MODELS_AI);
  });

  it('set 替换快照', () => {
    const c = new TraeCatalog();
    c.set([{ id: 'x', name: 'X' }]);
    expect(c.current().map((m) => m.id)).toEqual(['x']);
  });

  it('set 空数组抛错（避免把 provider 整个挂掉）', () => {
    const c = new TraeCatalog();
    expect(() => c.set([])).toThrow(/cannot be empty/);
  });

  it('set 时 copy input 数组（防御外层修改）', () => {
    const c = new TraeCatalog();
    const input = ['text', 'image'];
    c.set([{ id: 'x', name: 'X', input }]);
    input.push('audio');
    expect(c.current()[0]?.input).toEqual(['text', 'image']);
  });
});