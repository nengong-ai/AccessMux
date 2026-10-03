// WorkBuddy /v3/config 模型目录解析测试（四轮返工按 dsh upstream.ts:
// 534-553 + 694-730 + 1100-1153 真实协议重写）。
import { describe, expect, it } from 'vitest';
import { parseWorkBuddyCatalogResponse } from '../../../src/adapters/workbuddy/parse-catalog.js';
import { retainWorkBuddyPromotionOnBaseRate } from '../../../src/adapters/workbuddy/catalog-metadata.js';
import type { WorkBuddyModelInfo } from '../../../src/adapters/workbuddy/catalog.js';

function envelope(data: unknown, code = 0, msg = ''): unknown {
  return { code, msg, data };
}

describe('parseWorkBuddyCatalogResponse（/v3/config 真实形状）', () => {
  it('冷启动读到已开始且结束的促销缓存时保留旧免费为 stale，基础倍率不覆盖', () => {
    const now = new Date('2026-10-03T00:00:00Z');
    const metadata = {
      document: { modelPromotions: [{ enabled: true, modelIds: ['m1'], schedule: { validFrom: '2026-09-01T00:00:00Z', validUntil: '2026-10-02T00:00:00Z' }, discount: { discountedCredits: '0x' }, badge: { label: '旧免费活动' } }] },
      reference: 'workbuddy:acc-product-config-v3.json', updatedAt: '2026-10-03T00:00:00Z', region: 'cn',
    };
    const result = parseWorkBuddyCatalogResponse(envelope({
      models: [{ id: 'm1', name: 'M1', maxInputTokens: 128_000, maxOutputTokens: 8_000, credits: 'x1' }],
      agents: [{ name: 'cli', models: ['m1'] }],
    }), { metadata, now });
    expect(result[0]).toMatchObject({ free: true, priceMultiplier: 0, feeFreshness: 'stale', priceSnapshot: { value: 0, current: false }, activityLabels: ['旧免费活动'] });
  });

  it('新基础倍率不覆盖同一模型上次促销证据；保留旧值并标待更新', () => {
    const oldOrigin = { kind: 'platform' as const, reference: 'workbuddy:product-cache', field: 'modelPromotions.discount.discountedCredits', updated_at: '2026-10-02T00:00:00Z', region: 'cn' };
    const newOrigin = { kind: 'platform' as const, reference: 'https://www.workbuddy.cn/v3/config', field: 'models.credits', updated_at: '2026-10-03T00:00:00Z', region: 'cn' };
    const previous: WorkBuddyModelInfo[] = [{ id: 'm', displayName: 'M', priceMultiplier: 0, priceSnapshot: { value: 0, current: false, updated_at: oldOrigin.updated_at, source: oldOrigin }, free: true, freeSource: oldOrigin, activityLabels: ['限时免费'], input: ['text'], output: ['text'], supportVision: false, supportTools: false, status: 'available' }];
    const incoming: WorkBuddyModelInfo[] = [{ id: 'm', displayName: 'M', priceMultiplier: 2, priceSnapshot: { value: 2, current: true, updated_at: newOrigin.updated_at, source: newOrigin }, free: false, freeSource: newOrigin, input: ['text'], output: ['text'], supportVision: false, supportTools: false, status: 'available' }];
    const [merged] = retainWorkBuddyPromotionOnBaseRate(previous, incoming, '2026-10-03T01:00:00Z');
    expect(merged).toMatchObject({ free: true, priceMultiplier: 0, priceSnapshot: { value: 0, source: { updated_at: oldOrigin.updated_at } }, feeFreshness: 'stale', activityLabels: ['限时免费'] });
  });

  it('envelope data 内 models × agents[cli] 交集解析', () => {
    const payload = envelope({
      models: [
        { id: 'glm-5.3', name: 'GLM 5.3', maxInputTokens: 200000, maxOutputTokens: 32000, supportsReasoning: true, reasoning: { supportedEfforts: ['low', 'high'], canDisableThinking: false } },
        { id: 'retired-model', name: 'Retired', maxInputTokens: 100000, maxOutputTokens: 8000 },
      ],
      agents: [{ name: 'cli', models: ['glm-5.3'] }],
    });
    const models = parseWorkBuddyCatalogResponse(payload);
    expect(models.map((m) => m.id)).toEqual(['glm-5.3']);
    const glm = models[0]!;
    expect(glm.displayName).toBe('GLM 5.3');
    expect(glm.contextWindow).toBe(1000000);
    expect(glm.contextSource?.kind).toBe('official-spec');
    expect(glm.maxInput?.value).toBe(200000);
    expect(glm.maxTokens).toBe(32000);
    expect(glm.reasoning?.supportedEfforts).toEqual(['low', 'high']);
    expect(glm.reasoning?.canDisableThinking).toBe(false);
    expect(glm.status).toBe('available');
  });

  it('裸文档形状（无 {code,data} wrapper）也能解', () => {
    const payload = {
      models: [{ id: 'm1', name: 'M1', maxInputTokens: 128000, maxOutputTokens: 4096 }],
      agents: [{ name: 'cli', models: ['m1'] }],
    };
    const models = parseWorkBuddyCatalogResponse(payload);
    expect(models.map((m) => m.id)).toEqual(['m1']);
  });

  it('envelope code !== 0 抛错（msg 透出）', () => {
    expect(() => parseWorkBuddyCatalogResponse(envelope({}, 30001, 'session expired')))
      .toThrow(/code 30001.*session expired/);
  });

  it('cli 名单缺失抛错（上层走 fallback）', () => {
    expect(() => parseWorkBuddyCatalogResponse(envelope({
      models: [{ id: 'm1', maxInputTokens: 1, maxOutputTokens: 1 }],
    }))).toThrow(/no cli agent models/);
  });

  it('cli 名单为空数组同样抛错', () => {
    expect(() => parseWorkBuddyCatalogResponse(envelope({
      models: [], agents: [{ name: 'cli', models: [] }],
    }))).toThrow(/no cli agent models/);
  });

  it('交集为空抛错', () => {
    expect(() => parseWorkBuddyCatalogResponse(envelope({
      models: [{ id: 'other', maxInputTokens: 1, maxOutputTokens: 1 }],
      agents: [{ name: 'cli', models: ['m1'] }],
    }))).toThrow(/empty list/);
  });

  it('disabled 行 / caps 非正行丢弃', () => {
    const payload = envelope({
      models: [
        { id: 'ok-model', maxInputTokens: 100, maxOutputTokens: 100 },
        { id: 'disabled-model', maxInputTokens: 100, maxOutputTokens: 100, disabled: true },
        { id: 'zero-caps', maxInputTokens: 0, maxOutputTokens: 100 },
      ],
      agents: [{ name: 'cli', models: ['ok-model', 'disabled-model', 'zero-caps'] }],
    });
    expect(parseWorkBuddyCatalogResponse(payload).map((m) => m.id)).toEqual(['ok-model']);
  });

  it('supportsImages → input 含 image；disabledMultimodal 抑制', () => {
    const payload = envelope({
      models: [
        { id: 'vision', maxInputTokens: 100, maxOutputTokens: 100, supportsImages: true },
        { id: 'vision-off', maxInputTokens: 100, maxOutputTokens: 100, supportsImages: true, disabledMultimodal: true },
      ],
      agents: [{ name: 'cli', models: ['vision', 'vision-off'] }],
    });
    const models = parseWorkBuddyCatalogResponse(payload);
    expect(models.find((m) => m.id === 'vision')?.input).toEqual(['text', 'image']);
    expect(models.find((m) => m.id === 'vision')?.supportVision).toBe(true);
    expect(models.find((m) => m.id === 'vision-off')?.supportVision).toBe(false);
    expect(models.find((m) => m.id === 'vision-off')?.input).toEqual(['text']);
  });

  it('reasoning 缺省（旧行形状）不写 reasoning 字段', () => {
    const payload = envelope({
      models: [{ id: 'plain', maxInputTokens: 100, maxOutputTokens: 100 }],
      agents: [{ name: 'cli', models: ['plain'] }],
    });
    expect(parseWorkBuddyCatalogResponse(payload)[0]?.reasoning).toBeUndefined();
  });

  it('name 缺省时 displayName 用 id', () => {
    const payload = envelope({
      models: [{ id: 'anon', maxInputTokens: 100, maxOutputTokens: 100 }],
      agents: [{ name: 'cli', models: ['anon'] }],
    });
    expect(parseWorkBuddyCatalogResponse(payload)[0]?.displayName).toBe('anon');
  });

  it('非对象 payload 抛错', () => {
    expect(() => parseWorkBuddyCatalogResponse('nope')).toThrow(/JSON object/);
    expect(() => parseWorkBuddyCatalogResponse([1, 2])).toThrow(/JSON object/);
  });
});
