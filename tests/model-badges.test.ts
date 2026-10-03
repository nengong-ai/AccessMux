import { afterEach, describe, expect, it } from 'vitest';
import { clearRegistry, registerAdapter } from '../src/adapters/registry.js';
import { buildServer } from '../src/protocol/server.js';
import { ConfigStore, buildDefaultConfig } from '../src/config/index.js';
import type { ModelInfo } from '../src/types.js';
import { modelBadgeSuffix, modelDirectoryEntry, modelDisplayName, publicModelMetadata } from '../src/ui/model-badges.js';
import { FakeAdapter } from './protocol/fake-adapter.js';

const oldBadges = process.env['ACCESSMUX_MODEL_BADGES'];
const feeSource = { kind: 'platform' as const, reference: 'qoder:test', field: 'fee', updated_at: '2026-10-03T00:00:00Z' };
afterEach(() => {
  clearRegistry();
  if (oldBadges === undefined) delete process.env['ACCESSMUX_MODEL_BADGES'];
  else process.env['ACCESSMUX_MODEL_BADGES'] = oldBadges;
});

describe('模型徽标只消费公开元数据', () => {
  it('上游缺字段时没有任何价格/免费/活动徽标', () => {
    const model = { id: 'plain-model', provider: 'fake' };
    expect(publicModelMetadata(model)).toEqual({});
    expect(modelBadgeSuffix(model)).toBeUndefined();
    expect(modelDisplayName(model)).toBe('plain-model');
    expect(modelDirectoryEntry('fake', model)).not.toHaveProperty('free');
  });
  it('优先免费原文，然后倍率，然后活动；完整元数据不丢标签', () => {
    const model: ModelInfo = { id: 'm', provider: 'fake', name: 'Model', free: true, freeSource: feeSource, feeFreshness: 'fresh', priceMultiplier: 0, activityLabels: ['夜间免费', '限时优惠'] };
    expect(modelDisplayName(model)).toBe('Model·夜间免费');
    expect(publicModelMetadata(model).activityLabels).toEqual(['夜间免费', '限时优惠']);
    expect(modelBadgeSuffix({ priceSnapshot: { value: 0.29, current: true, updated_at: feeSource.updated_at, source: feeSource }, activityLabels: ['会员5折'] })).toBe('会员5折 · 0.29x');
    expect(modelBadgeSuffix({ activityLabels: ['会员5折'] })).toBe('会员5折');
  });
  it('账号权益不被改写成模型本身免费', () => {
    const model: ModelInfo = { id: 'm', provider: 'fake', free: true, freeSource: feeSource, priceScope: 'entitlement' };
    expect(modelDisplayName(model)).toBe('m·权益内免费');
    expect(modelDirectoryEntry('fake', model)).toMatchObject({ free: true, priceScope: 'entitlement' });
  });
  it('纯净开关只影响普通名称；宿主公开名称保留费用和来源，canonical id与元数据不变', () => {
    const model: ModelInfo = { id: 'm', provider: 'fake', name: 'Model', free: true, freeSource: feeSource };
    process.env['ACCESSMUX_MODEL_BADGES'] = '0';
    expect(modelDisplayName(model)).toBe('Model');
    expect(modelDirectoryEntry('fake', model)).toMatchObject({ id: 'fake:m', name: 'Model · 免费 · fake', display_name: 'Model · 免费 · fake', free: true });
    process.env['ACCESSMUX_MODEL_BADGES'] = '1';
    expect(modelDisplayName(model)).toBe('Model·免费');
    expect(modelDirectoryEntry('fake', model)).toMatchObject({ id: 'fake:m', name: 'Model · 免费 · fake' });
  });
  it('拒绝无效倍率、私有字段和带凭据的图标URL；描述最多180个字符', () => {
    const raw = { priceMultiplier: -1, description: '文'.repeat(240), iconUrl: 'https://example.com/icon.svg?token=secret', accessToken: 'synthetic-secret', reasoning: { supported: true, supportedEfforts: ['low', 'high'] } };
    const metadata = publicModelMetadata(raw);
    expect(metadata.priceMultiplier).toBeUndefined();
    expect(metadata.iconUrl).toBeUndefined();
    expect(Array.from(metadata.description ?? '')).toHaveLength(180);
    expect(JSON.stringify(metadata)).not.toContain('synthetic-secret');
    expect(metadata.reasoning).toEqual({ supported: true, supportedEfforts: ['low', 'high'] });
    expect(publicModelMetadata({ priceMultiplier: Number.NaN })).toEqual({});
    expect(publicModelMetadata({ iconUrl: 'https://example.com/icon.svg' }).iconUrl).toBe('https://example.com/icon.svg');
  });
  it('上游视觉元数据不夸大桥接输入能力', () => {
    expect(modelDirectoryEntry('fake', { id: 'm', provider: 'fake', inputModalities: ['text', 'image'] })).toMatchObject({ inputModalities: ['text', 'image'], bridgeInputModalities: ['text'], supportsImages: false });
  });
  it('T036 亮标 = 源 bridgeImages && 模型 inputModalities 含 image，缺一保持灰', () => {
    const visionModel = { id: 'm', provider: 'fake', inputModalities: ['text', 'image'] as Array<'text' | 'image'> };
    // 源点亮 + 模型有视觉 → 亮
    expect(modelDirectoryEntry('fake', visionModel, { bridgeImages: true })).toMatchObject({ bridgeInputModalities: ['text', 'image'], supportsImages: true });
    // 源没点亮（默认）→ 灰（旧行为不变）
    expect(modelDirectoryEntry('fake', visionModel)).toMatchObject({ supportsImages: false });
    // 源点亮但模型无视觉 → 灰，不虚标
    expect(modelDirectoryEntry('fake', { id: 'm', provider: 'fake' }, { bridgeImages: true })).toMatchObject({ bridgeInputModalities: ['text'], supportsImages: false });
  });
});

describe('/v1/models公开元数据和路由稳定性', () => {
  it('原始id不变，徽标显示名不影响原有路由和allowlist', async () => {
    class MetadataAdapter extends FakeAdapter {
      override async probe() {
        return { availability: 'available' as const, models: [{ id: 'm', provider: this.id, name: 'Model', priceMultiplier: { value: 0, current: true, updated_at: feeSource.updated_at, source: feeSource }, free: true, freeSource: feeSource }] };
      }
    }
    const adapter = new MetadataAdapter({ id: 'fake', modelIds: ['m'] });
    registerAdapter(adapter);
    const store = new ConfigStore(buildDefaultConfig());
    // 不挂 UI，保证测试不读取用户HOME或产生后台领取。
    const app = buildServer({ store });
    try {
      const models = await app.inject({ method: 'GET', url: '/v1/models' });
      expect(models.statusCode).toBe(200);
      expect(models.json().data[0]).toMatchObject({ id: 'fake:m', name: 'Model · 免费 · fake', priceMultiplier: 0, free: true });
      const chat = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: { model: 'fake:m', messages: [{ role: 'user', content: 'hi' }] } });
      expect(chat.statusCode).toBe(200);
      expect(adapter.turnCalls[0]?.model).toBe('m');
      store.set({ ...store.get(), models: { allow: { fake: { m: false } } } });
      expect((await app.inject({ method: 'GET', url: '/v1/models' })).json().data).toEqual([]);
      expect((await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: { model: 'fake:m', messages: [{ role: 'user', content: 'hi' }] } })).statusCode).toBe(404);
    } finally { await app.close(); }
  });
});
