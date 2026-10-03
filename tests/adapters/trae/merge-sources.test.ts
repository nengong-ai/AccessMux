// mergeTraeModelSources 测试：wire.id / wire.name join；无 match 丢弃；
// creditMultiplier 优先级。

import { describe, expect, it } from 'vitest';
import { mergeTraeModelSources } from '../../../src/adapters/trae/merge-sources.js';

describe('mergeTraeModelSources', () => {
  it('wire.id == remote.id 直接 join，wireConfigName 不写', () => {
    const out = mergeTraeModelSources(
      [{ id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 100 }],
      [{ id: 'glm-5.2', name: 'GLM-5.2', function: 'solo_work_lite' }],
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe('glm-5.2');
    expect(out[0]?.wireConfigName).toBeUndefined();
    expect(out[0]?.wireFunction).toBe('solo_work_lite');
    expect(out[0]?.input).toEqual(['text']);
  });

  it('wire.name == remote.name fallback join（display id ≠ wire id）', () => {
    const out = mergeTraeModelSources(
      [{ id: 'Seed-Code', name: 'GLM-5.3', contextWindow: 100 }],
      [{ id: 'glm-5.3', name: 'GLM-5.3', function: 'solo_work_remote' }],
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.wireConfigName).toBe('glm-5.3');
  });

  it('wire 与 remote 不匹配 → 丢弃（不可调用）', () => {
    const out = mergeTraeModelSources(
      [{ id: 'unknown-model', name: 'Unknown' }],
      [{ id: 'real-model', name: 'Real', function: 'solo_work_lite' }],
    );
    expect(out).toEqual([]);
  });

  it('creditMultiplier：wire 的优先 over remote', () => {
    const out = mergeTraeModelSources(
      [{ id: 'x', name: 'X', creditMultiplier: 0.8 }],
      [{ id: 'x', name: 'X', creditMultiplier: 0.08 }],
    );
    expect(out[0]?.creditMultiplier).toBe(0.08);
  });

  it('creditMultiplier：wire 缺时 fallback 到 remote', () => {
    const out = mergeTraeModelSources(
      [{ id: 'x', name: 'X', creditMultiplier: 0.5 }],
      [{ id: 'x', name: 'X' }],
    );
    expect(out[0]?.creditMultiplier).toBe(0.5);
  });

  it('同名大小写不敏感 join', () => {
    const out = mergeTraeModelSources(
      [{ id: 'foo', name: 'GLM-5.3' }],
      [{ id: 'glm-5.3', name: 'glm-5.3' }],
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.wireConfigName).toBe('glm-5.3');
  });

  it('remote 的 multimodal 与 reasoningSupported 透传', () => {
    const out = mergeTraeModelSources(
      [{ id: 'x', name: 'X', multimodal: true, reasoningSupported: true, reasoning: { supported: ['low', 'medium'] } }],
      [{ id: 'x', name: 'X' }],
    );
    expect(out[0]?.multimodal).toBe(true);
    expect(out[0]?.reasoningSupported).toBe(true);
    expect(out[0]?.reasoning?.supported).toEqual(['low', 'medium']);
  });
});