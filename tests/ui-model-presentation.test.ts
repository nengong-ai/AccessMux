import { describe, expect, it } from 'vitest';
import { modelBrandIcon } from '../src/ui/public/brand-assets.js';
import { compactContext, modelBadges, modelVerification } from '../src/ui/public/app.js';

describe('模型能力与上下文摘要', () => {
  it.each([
    ['workbuddy', 'glm-5.3'],
    ['workbuddy', 'deepseek-v4.1-flash'],
    ['qoder', 'kimi-k2.5'],
    ['qoder', 'qwen3.5-coder'],
  ])('%s adapter 的 %s 按模型 ID 选择品牌标识', (provider, modelId) => {
    expect(provider).toBeTruthy();
    expect(modelBrandIcon(modelId)).toContain('<svg');
    expect(modelBrandIcon(modelId)).not.toBe(modelBrandIcon(provider));
  });

  it.each([
    [1_000_000, '1M'], [200_000, '200K'], [1_234_567, '1.23M'], [12_345, '12.34K'],
  ])('以不夸大的十进制数字显示 %s tokens', (value, label) => {
    expect(compactContext(value).label).toBe(label);
    expect(compactContext(value).full).toContain(value.toLocaleString('zh-CN'));
  });

  it('调用待验证独立，免费与已取得的零倍率都显示', () => {
    const origin = { kind: 'platform' as const, reference: 'qoder:test', field: 'fee', updated_at: new Date().toISOString() };
    const model = { id: 'glm-5.3', free: true, freeSource: origin, feeFreshness: 'fresh' as const, priceMultiplier: { value: 0, current: true, updated_at: origin.updated_at, source: origin }, tags: ['unverified'] };
    const markup = modelBadges(model);
    expect(markup).not.toContain('调用待验证');
    expect(modelVerification(model)).toContain('调用待验证');
    expect(markup).toContain('免费');
    expect(markup).toContain('0×');
    expect(modelBadges({ id: 'paid-history', free: false, feeFreshness: 'failed' })).toContain('上次不免费');
    expect(modelBadges({ id: 'unknown-model' })).toContain('费用未确认');
  });
});
