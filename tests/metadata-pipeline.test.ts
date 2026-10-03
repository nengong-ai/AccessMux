import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectQoderMetadata, parseQoderFlashOffer, parseQoderRuntimeFiles, parseQoderSettings, parseQoderTextCache } from '../src/adapters/qoder/catalog-metadata.js';
import { modelsFromIds } from '../src/adapters/qoder/catalog.js';
import { officialModelContext, source } from '../src/adapters/qoder/catalog-specs.js';
import { fetchWorkBuddyMetadata, workBuddyPromotionActive } from '../src/adapters/workbuddy/catalog-metadata.js';
import { parseWorkBuddyCatalogResponse } from '../src/adapters/workbuddy/parse-catalog.js';
import { parseTraeRemoteModel } from '../src/adapters/trae/remote-parser.js';
import { mergeTraeModelSources } from '../src/adapters/trae/merge-sources.js';
import { modelDirectoryEntry, publicModelLimits, publicModelMetadata } from '../src/ui/model-badges.js';
import { formatModelActivity } from '../src/ui/public/activity-presentation.js';
import { compactContext, modelBadges, modelVerification } from '../src/ui/public/app.js';
import type { ModelInfo } from '../src/types.js';

const updatedAt = '2026-10-03T04:00:00.000Z';
const origin = source('qoder:runtime/model-policy', 'contextWindow', updatedAt, 'cn');
const temporary: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });

function catalog(id = 'unknown-model', extra: Record<string, unknown> = {}) {
  return { models: [{ id, maxInputTokens: 180_000, maxOutputTokens: 32_000, credits: 'x0.29', ...extra }], agents: [{ name: 'cli', models: [id] }] };
}
function promotion(extra: Record<string, unknown> = {}) {
  return { enabled: true, modelIds: ['hy4-preview'], badge: { label: '夜间免费' }, discount: { discountedCredits: '0.00x', factor: 0 }, priority: 50,
    schedule: { validFrom: '2026-09-11T00:00:00+08:00', validUntil: '2026-11-01T00:00:00+08:00', timezone: 'Asia/Shanghai', daily: [{ start: '23:00', end: '8:00' }] }, ...extra };
}

describe('Qoder 有来源的两列与公开规格', () => {
  it('实际日志形状关联 session：1M 上下文与 180K 输入分别保留来源和观察时间', () => {
    const meta = parseQoderRuntimeFiles([
      { reference: 'qoder:runtime/model-config', updatedAt, contents: '[2026-10-03T04:00:00Z] info {"session_id":"fixture-session","model_config":{"key":"qfmodel","display_name":"Qwen3.8-Flash","max_input_tokens":180000,"api_key":"SYNTHETIC-PRIVATE"}}' },
      { reference: 'qoder:runtime/model-policy', updatedAt, contents: '[2026-10-03T04:01:00Z] frozen {"sessionId":"fixture-session","contextWindow":1000000}' },
    ], { qfmodel: 'Qwen3.8-Flash' });
    expect(meta['Qwen3.8-Flash']).toMatchObject({ minCtx: { value: 1_000_000, source: { field: 'contextWindow', updated_at: '2026-10-03T04:01:00Z' } }, maxInput: { value: 180_000, source: { field: 'model_config.max_input_tokens' } } });
    expect(JSON.stringify(meta)).not.toMatch(/SYNTHETIC-PRIVATE|fixture-session|api_key/);
  });
  it('未绑定的 session 上下文不能串到上一模型；输入上限不能代替 ctx', () => {
    const meta = parseQoderRuntimeFiles([{ reference: 'qoder:runtime/model-config', updatedAt, contents: [
      '{"session_id":"one","model_config":{"display_name":"Unknown","max_input_tokens":180000}}',
      '{"sessionId":"another","contextWindow":1000000}',
    ].join('\n') }]);
    expect(meta['Unknown']?.maxInput?.value).toBe(180_000);
    expect(meta['Unknown']?.minCtx).toBeUndefined();
  });
  it('较旧的观察不能覆盖较新的窗口', () => {
    const meta = parseQoderRuntimeFiles([{ reference: 'qoder:runtime/model-policy', updatedAt, contents: [
      '[2026-10-03T04:01:00Z] {"model":"Qwen3.8-Flash","contextWindow":400000}',
      '[2026-10-02T04:00:00Z] {"model":"Qwen3.8-Flash","contextWindow":1000000}',
    ].join('\n') }]);
    expect(meta['Qwen3.8-Flash']?.minCtx).toMatchObject({ value: 400_000 });
  });
  it('平台窗口优先；厂商理论窗口单独保存，不冒充实測来源', () => {
    const [model] = modelsFromIds(['Qwen3.8-Flash'], { 'Qwen3.8-Flash': { minCtx: { value: 200_000, source: origin }, maxInput: { value: 180_000, source: { ...origin, field: 'max_input_tokens' } } } });
    expect(model?.minCtx).toMatchObject({ value: 200_000, source: { kind: 'platform' } });
    expect(model?.officialContext).toMatchObject({ value: 1_000_000, source: { kind: 'official-spec' } });
    expect(model?.maxInput?.value).toBe(180_000);
  });
  it('模型参数缓存按 selector 关联；自定义 provider 独立，不读取/回传 key', () => {
    const metadata = parseQoderSettings({ model: { preferences: { qfmodel: { contextWindow: 400_000 }, unknown: { contextWindow: 1_000_000 } } }, providers: { 'opencode-go': { apiKey: 'SYNTHETIC-PRIVATE', models: [{ id: 'qwen3.8-flash', contextWindow: 262_144 }] } } }, { qfmodel: 'Qwen3.8-Flash' }, updatedAt);
    expect(metadata['Qwen3.8-Flash']?.minCtx).toMatchObject({ value: 400_000, source: { kind: 'platform' } });
    expect(modelsFromIds(['opencode-go/qwen3.8-flash'], metadata)[0]?.minCtx).toMatchObject({ value: 262_144 });
    expect(metadata.unknown).toBeUndefined(); expect(JSON.stringify(metadata)).not.toContain('SYNTHETIC-PRIVATE');
  });
  it('Kimi K2.8 使用厂商独立规格，不继承上一版本 256K', () => {
    expect(officialModelContext('Kimi-K2.8-Preview')).toMatchObject({ value: 1_048_576, source: { kind: 'official-spec', reference: 'https://www.kimi.com/code/docs/kimi-code/models.html' } });
  });
  it('只有模型名也可补官方规格；名称、verified 列都不是免费证据', () => {
    const [known, unknown] = modelsFromIds(['Qwen3.8-Max', 'Qwen-New-Unpublished']);
    expect(known?.minCtx).toMatchObject({ value: 1_000_000, source: { kind: 'official-spec' } });
    expect(known?.free).toBeUndefined(); expect(known?.priceMultiplier).toBeUndefined();
    expect(unknown?.minCtx).toBeUndefined(); expect(unknown?.maxInput).toBeUndefined();
    expect(officialModelContext('other-provider/qwen3.8-max')).toBeUndefined();
  });
  it('缓存用模型 selector 的明确名称做 join；描述里的 1M 归窗口', () => {
    const { aliases, models } = parseQoderTextCache({ content: { zh: {
      'modelSelector.item.qfmodel': 'Qwen3.8-Flash',
      'modelSelector.item.qfmodel.markdownDescription': '1M 上下文，限时免费畅用，[查看详情](https://docs.qoder.cn/events/flashoffer)',
    } } }, updatedAt);
    expect(aliases).toEqual({ qfmodel: 'Qwen3.8-Flash' });
    expect(models['Qwen3.8-Flash']?.minCtx).toMatchObject({ value: 1_000_000, source: { kind: 'platform' } });
    expect(models['Qwen3.8-Flash']?.maxInput).toBeUndefined();
    expect(models['Qwen3.8-Flash']?.free).toBeUndefined(); // 旧文案不能证明当前活动。
    expect(modelsFromIds(['opencode-go/qwen3.8-flash'], models)[0]?.free).toBeUndefined();
  });
  it('活动当前延期才能写免费；Markdown 中真零倍率仍可解析', () => {
    const fields = parseQoderFlashOffer('Qwen3.8-Flash 免费期现已延长，10 月 1 日起继续免费。计费系数由 **0.1×** 降至 **0.0×**。', updatedAt);
    expect(fields).toMatchObject({ free: true, priceMultiplier: { value: 0, current: true, updated_at: updatedAt, source: { entitlement: 'personal' } } });
    expect(parseQoderFlashOffer('Qwen3.8-Flash 限时免费', updatedAt).free).toBeUndefined();
    expect(parseQoderFlashOffer('Qwen3.8-Flash 免费活动已结束', updatedAt).free).toBe(false);
  });
  it('免费确有来源但倍率未给：仍写免费，倍率留空', () => {
    const fields = parseQoderFlashOffer('Qwen3.8-Flash 活动正在进行，继续免费。', updatedAt);
    expect(fields.free).toBe(true); expect(fields.priceMultiplier).toBeUndefined();
    expect(modelBadges({ id: 'Qwen3.8-Flash', ...fields })).toContain('免费');
  });
  it('默认全程只有活动 GET，不读取 PAT、不 exchange、不 claim', async () => {
    const fetchImpl = vi.fn(async () => new Response('Qwen3.8-Flash 继续免费', { status: 200 }));
    await collectQoderMetadata({ textFiles: [], runtimeFiles: [], homeDir: '/synthetic/no-home', fetchImpl: fetchImpl as typeof fetch, now: () => new Date(updatedAt) });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://docs.qoder.cn/events/flashoffer.md');
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ method: 'GET' });
  });
  it('campaign 的奖励 amount 不能当模型倍率；过期或未绑定模型的活动不标免费', async () => {
    const result = await collectQoderMetadata({ textFiles: [], runtimeFiles: [], homeDir: '/synthetic/no-home', publicOffer: false, now: () => new Date(updatedAt), campaignToken: () => 'SYNTHETIC-PRIVATE', fetchCampaignMetadata: async () => ({ campaigns: [
      { active: true, benefit: { amount: 0 } },
      { active: true, modelIds: ['Qwen3.8-Flash'], creditMultiplier: 0, endTime: '2026-10-01T00:00:00Z' },
    ] }) });
    expect(result).toEqual({});
  });
  it('已有内存 token 的 campaign 仍只 GET，倍率动态保存时间', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ campaigns: [{ campaignId: 'fixture', modelIds: ['Qwen3.8-Flash'], creditMultiplier: 0.5, active: true }] }));
    const result = await collectQoderMetadata({ textFiles: [], runtimeFiles: [], homeDir: '/synthetic/no-home', publicOffer: false, now: () => new Date(updatedAt), campaignToken: () => 'SYNTHETIC-PRIVATE', fetchImpl: fetchImpl as typeof fetch });
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ method: 'GET' });
    expect(result['Qwen3.8-Flash']).toMatchObject({ priceMultiplier: { value: 0.5, current: true, updated_at: updatedAt }, free: false });
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC-PRIVATE');
  });
});

describe('WorkBuddy 两个目录、活动时钟与列语义', () => {
  it('maxInputTokens 独立保存，未知模型不能靠输入/输出相加捏上下文', () => {
    const [model] = parseWorkBuddyCatalogResponse(catalog(), { updatedAt });
    expect(model?.contextWindow).toBeUndefined(); expect(model?.maxInput).toMatchObject({ value: 180_000, source: { field: 'models.maxInputTokens' } });
  });
  it('公开规格兜底，与最大输入保持不同数字', () => {
    const [model] = parseWorkBuddyCatalogResponse(catalog('glm-5.3'), { updatedAt });
    expect(model?.contextWindow).toBe(1_000_000); expect(model?.contextSource?.kind).toBe('official-spec');
    expect(model?.maxInput?.value).toBe(180_000);
  });
  it('第二目录的 supportedLengths 优先官方规格，并保留实际输入', () => {
    const [model] = parseWorkBuddyCatalogResponse(catalog('minimax-m3'), { updatedAt, metadata: { document: { models: [{ id: 'minimax-m3', contextWindow: { defaultLength: 300_000, supportedLengths: [300_000, 512_000] } }] }, reference: 'workbuddy:acc-product-config-v3.json', updatedAt } });
    expect(model).toMatchObject({ contextWindow: 512_000, contextSource: { kind: 'platform' }, officialContext: { value: 1_000_000 }, maxInput: { value: 180_000 } });
  });
  it.each([
    ['2026-10-03T14:59:59Z', false], ['2026-10-03T15:00:00Z', true], ['2026-10-03T23:59:59Z', true], ['2026-10-04T00:00:00Z', false], ['2026-11-01T15:00:00Z', false],
  ])('Asia/Shanghai 跨午夜 %s 的当前活动为 %s', (time, active) => {
    expect(workBuddyPromotionActive(promotion(), new Date(time))).toBe(active);
  });
  it('白天“夜间免费”的提示不能当免费；刷新到夜间写零倍率，结束再恢复', () => {
    const metadata = { document: { modelPromotions: [promotion()] }, reference: 'workbuddy:acc-product-config-v3.json', updatedAt };
    const day = parseWorkBuddyCatalogResponse(catalog('hy4-preview'), { metadata, updatedAt, now: new Date('2026-10-03T04:00:00Z') })[0]!;
    const night = parseWorkBuddyCatalogResponse(catalog('hy4-preview'), { metadata, updatedAt, now: new Date('2026-10-03T15:00:00Z') })[0]!;
    expect(day).toMatchObject({ free: false, priceMultiplier: 0.29 });
    expect(night).toMatchObject({ free: true, priceMultiplier: 0, priceSnapshot: { value: 0, current: true, activity: { timezone: 'Asia/Shanghai', label: '夜间免费' } } });
    expect(parseWorkBuddyCatalogResponse(catalog('hy4-preview'), { metadata, updatedAt, now: new Date('2026-10-04T00:00:00Z') })[0]?.free).toBe(false);
  });
  it('同活动label优先使用明确折扣记录的权益时段；badge-only记录只保留标签', () => {
    const daylight = promotion({ discount: undefined, schedule: { validFrom: '2026-09-11T00:00:00+08:00', validUntil: '2026-11-01T00:00:00+08:00', timezone: 'Asia/Shanghai', daily: [{ start: '08:00', end: '23:00' }] } });
    const night = promotion();
    const metadata = { document: { modelPromotions: [daylight, night] }, reference: 'workbuddy:acc-product-config-v3.json', updatedAt };
    const day = parseWorkBuddyCatalogResponse(catalog('hy4-preview'), { metadata, updatedAt, now: new Date('2026-10-03T04:00:00Z') })[0]!;
    expect(day).toMatchObject({ free: false, activities: [{ label: '夜间免费', kind: 'free', scheduleMeaning: 'benefit', daily: [{ start: '23:00', end: '8:00' }] }] });
    expect(day.activities?.[0]?.daily).not.toEqual([{ start: '08:00', end: '23:00' }]);
    const entry = modelDirectoryEntry('workbuddy', { id: day.id, provider: 'workbuddy', name: day.displayName, free: day.free, freeSource: day.freeSource, priceMultiplier: day.priceSnapshot ?? day.priceMultiplier, feeFreshness: day.feeFreshness, activities: day.activities, activityLabels: day.activityLabels });
    expect(entry.id).toBe('workbuddy:hy4-preview');
    expect(entry.display_name).toContain('夜间免费');
    expect(entry.display_name).toContain('23:00');
  });
  it('badge-only夜间折扣保留标签和公开时间，但不推断折扣倍率或免费', () => {
    const badgeOnly = promotion({ modelIds: ['deepseek-v4-flash'], discount: undefined, schedule: { timezone: 'Asia/Shanghai', daily: [{ start: '00:00', end: '23:59' }] } });
    const metadata = { document: { modelPromotions: [badgeOnly] }, reference: 'workbuddy:acc-product-config-v3.json', updatedAt };
    const [model] = parseWorkBuddyCatalogResponse(catalog('deepseek-v4-flash'), { metadata, updatedAt, now: new Date('2026-10-03T04:00:00Z') });
    expect(model?.free).toBe(false);
    expect(model?.priceMultiplier).toBe(0.29);
    expect(model?.activities?.[0]).toMatchObject({ label: '夜间免费', scheduleMeaning: 'label', daily: [{ start: '00:00', end: '23:59' }] });
    const entry = modelDirectoryEntry('workbuddy', { id: model!.id, provider: 'workbuddy', name: model!.displayName, free: model!.free, freeSource: model!.freeSource, priceMultiplier: model!.priceSnapshot ?? model!.priceMultiplier, feeFreshness: model!.feeFreshness, activities: model!.activities });
    expect(entry.display_name).toContain('优惠时段待确认');
    expect(entry.display_name).toContain('0.29x');
    expect(entry.id).toBe('workbuddy:deepseek-v4-flash');
  });
  it('夜间23:59到次日00:00连续，展示合并跨日时段并包含最后一分钟', () => {
    const activity = { label: '夜间免费', kind: 'free' as const, scheduleMeaning: 'benefit' as const, timezone: 'Asia/Shanghai', daily: [{ start: '23:00', end: '23:59' }, { start: '00:00', end: '08:00' }] };
    expect(formatModelActivity(activity, { now: new Date('2026-10-03T15:59:00Z'), detailed: true })).toBe('夜间免费（23:00—次日08:00 北京时间） · 优惠时段内');
    expect(formatModelActivity({ ...activity, scheduleMeaning: 'label' }, { now: new Date(updatedAt), detailed: true })).toBe('夜间免费 · 优惠时段待确认');
  });
  it('徽标活动保留来源本地截止时刻；到期只提示待更新，不断言权益已结束', () => {
    const activity = { label: '限时免费', scheduleMeaning: 'label' as const, timezone: 'Asia/Shanghai', starts_at: '2026-10-01T00:00:00+08:00', ends_at: '2026-11-01T00:00:00+08:00' };
    const text = formatModelActivity(activity, { now: new Date('2026-10-31T16:00:00.000Z'), detailed: true });
    expect(text).toContain('2026/11/1 00:00');
    expect(text).toContain('活动信息待更新');
    expect(text).not.toContain('活动已结束');
  });
  it('enabled、活动文案、factor 均不能凭空造零倍率', () => {
    const metadata = { document: { modelPromotions: [promotion({ schedule: undefined, discount: { factor: 0 } })] }, reference: 'workbuddy:acc-product-config-v3.json', updatedAt };
    expect(parseWorkBuddyCatalogResponse(catalog('hy4-preview'), { metadata, updatedAt })[0]).toMatchObject({ free: false, priceMultiplier: 0.29 });
  });
  it('缺倍率的目录仍可保留明确免费活动的零倍率', () => {
    const metadata = { document: { modelPromotions: [promotion()] }, reference: 'workbuddy:acc-product-config-v3.json', updatedAt };
    expect(parseWorkBuddyCatalogResponse(catalog('hy4-preview', { credits: undefined }), { metadata, updatedAt, now: new Date('2026-10-03T15:00:00Z') })[0]).toMatchObject({ free: true, priceMultiplier: 0 });
  });
  it('第二接口 GET 失败可读缓存；显式空活动数组会清掉旧活动，缓存字节不变', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'accessmux-t038-test-')); temporary.push(dir);
    const path = join(dir, 'product.json'); const raw = JSON.stringify({ modelPromotions: [promotion()] }); writeFileSync(path, raw);
    const fetchImpl = vi.fn(async () => new Response(null, { status: 503 }));
    const options = { variant: 'cn' as const, cachePath: path, headers: {}, signal: AbortSignal.timeout(1000), now: new Date(updatedAt), fetchImpl: fetchImpl as typeof fetch };
    expect((await fetchWorkBuddyMetadata(options))?.document.modelPromotions).toHaveLength(1);
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ method: 'GET' });
    const cleared = await fetchWorkBuddyMetadata({ ...options, fetchImpl: async () => Response.json({ modelPromotions: [] }) });
    expect(cleared?.document.modelPromotions).toEqual([]);
    const { readFileSync } = await import('node:fs'); expect(readFileSync(path, 'utf8')).toBe(raw);
  });
});

describe('Trae 真字段和零倍率', () => {
  it('合成两个区域目录：CN 16 行和 Global 10 行全部保留窗口', () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/synthetic-trae-catalog.json', import.meta.url), 'utf8')) as Record<string, { observed_at: string; models: unknown[] }>;
    for (const [region, count] of [['cn', 16], ['ai', 10]] as const) {
      const parsed = fixture[region]!.models.map((row) => parseTraeRemoteModel(row, { region, updatedAt: fixture[region]!.observed_at }));
      expect(parsed).toHaveLength(count); expect(parsed.every((model) => (model?.contextWindow ?? 0) > 0)).toBe(true);
      expect(new Set(parsed.map((model) => model?.id)).size).toBe(count);
      if (region === 'cn') expect(parsed.every((model) => model?.creditMultiplier !== undefined)).toBe(true);
      else expect(parsed.every((model) => model?.creditMultiplier === undefined)).toBe(true);
    }
  });
  it('真机 name/display_name + context_window_tokens + features JSON 不再整批丢失', () => {
    const model = parseTraeRemoteModel({ name: 'Doubao-Seed-2.1-Turbo', display_name: 'Seed-2.1-Turbo', multimodal: true, context_window_tokens: { dev: 256_000, max: 0 }, features: JSON.stringify({
      consumption_rate: { enable: true, data: { rate: 0.4 } },
      activity_discount: { enable: true, data: { current: { discount_type: 'subsidy', consumption_rate: 0.2 }, member: { after_consumption_rate: 0.1 } } },
      reasoning: { enable: true },
    }) }, { updatedAt, region: 'cn' });
    expect(model).toMatchObject({ id: 'Doubao-Seed-2.1-Turbo', name: 'Seed-2.1-Turbo', contextWindow: 256_000, creditMultiplier: 0.2, multimodal: true, reasoningSupported: true, activityLabels: ['补贴优惠'], priceSnapshot: { source: { field: 'features.activity_discount.data.current.consumption_rate' } } });
    expect(model?.maxInput).toBeUndefined(); expect(model?.maxContextWindow).toBeUndefined();
  });
  it('没有正在折扣的 current 不套用 member/off_peak 的未来值；Global manual_usage 不是额度倍率', () => {
    const cn = parseTraeRemoteModel({ name: 'deepseek-v4.1-flash', context_window_tokens: { dev: 200_000, max: 1_000_000 }, features: JSON.stringify({ consumption_rate: { enable: true, data: { rate: 0.15 } }, activity_discount: { enable: true, data: { current: { discount_type: 'none', consumption_rate: 0.15 }, off_peak: { after_consumption_rate: 0.08 } } } }) }, { updatedAt });
    expect(cn).toMatchObject({ creditMultiplier: 0.15, free: false }); expect(cn?.priceSnapshot?.activity).toBeUndefined();
    const global = parseTraeRemoteModel({ name: 'gpt-6-sol', display_name: 'GPT-6-Sol', context_window_tokens: { dev: 272_000 }, features: JSON.stringify({ cost: { enable: true, data: { manual_usage: 1 } } }) }, { updatedAt, region: 'ai' });
    expect(global).toMatchObject({ id: 'gpt-6-sol', contextWindow: 272_000 }); expect(global?.creditMultiplier).toBeUndefined();
  });
  it('features 真零有效，disabled 消耗项和损坏 JSON 不捏倍率', () => {
    expect(parseTraeRemoteModel({ name: 'm', features: '{"consumption_rate":{"enable":true,"data":{"rate":0}}}' }, { updatedAt })?.free).toBe(true);
    expect(parseTraeRemoteModel({ name: 'm', features: '{"consumption_rate":{"enable":false,"data":{"rate":0}}}' }, { updatedAt })?.creditMultiplier).toBeUndefined();
    expect(parseTraeRemoteModel({ name: 'm', features: '{malformed' }, { updatedAt })?.creditMultiplier).toBeUndefined();
  });
  it('camelCase creditMultiplier / activityLabels 透传，0 不被正数判据吞掉', () => {
    const model = parseTraeRemoteModel({ id: 'glm-5.3', contextWindow: 200_000, maxInputTokens: 180_000, creditMultiplier: 0, activityLabels: ['限时免费'] }, { updatedAt, region: 'cn' });
    expect(model).toMatchObject({ contextWindow: 200_000, maxInput: { value: 180_000 }, creditMultiplier: 0, free: true, priceSnapshot: { current: true, updated_at: updatedAt }, activityLabels: ['限时免费'] });
  });
  it('旧 consumption_rate 真零仍有效；活动名字本身不把付费模型变免费', () => {
    expect(parseTraeRemoteModel({ id: 'm', consumption_rate: { rate: 0 } }, { updatedAt })?.creditMultiplier).toBe(0);
    expect(parseTraeRemoteModel({ id: 'm', activityLabels: ['夜间免费'] }, { updatedAt })?.free).toBeUndefined();
  });
  it.each([-1, NaN, Infinity])('无效 creditMultiplier %s 留空', (value) => {
    const model = parseTraeRemoteModel({ id: 'm', creditMultiplier: value }, { updatedAt });
    expect(model?.creditMultiplier).toBeUndefined(); expect(model?.free).toBeUndefined();
  });
  it('wire 输入上限与 remote ctx 分列；wire 真零优先 remote 付费', () => {
    const remote = parseTraeRemoteModel({ id: 'm', context_window: 1_000_000, creditMultiplier: 0.8 }, { updatedAt })!;
    const [model] = mergeTraeModelSources([remote], [{ id: 'm', name: 'm', creditMultiplier: 0, priceSnapshot: { value: 0, current: true, updated_at: updatedAt, source: source('trae:/get_detail_param', 'consumption_rate.rate', updatedAt) }, maxInput: { value: 180_000, source: origin } }]);
    expect(model).toMatchObject({ contextWindow: 1_000_000, creditMultiplier: 0, maxInput: { value: 180_000 }, priceSnapshot: { value: 0, source: { reference: 'trae:/get_detail_param' } } });
  });
  it('wire 付费档不能沿用 remote 的免费快照、免费活动或来源', () => {
    const remote = parseTraeRemoteModel({ id: 'm', creditMultiplier: 0 }, { updatedAt })!;
    remote.freeActivity = { label: '免费活动' };
    const [model] = mergeTraeModelSources([remote], [{ id: 'm', name: 'm', creditMultiplier: 0.5 }]);
    expect(model?.free).toBe(false); expect(model?.priceSnapshot).toBeUndefined(); expect(model?.freeActivity).toBeUndefined(); expect(model?.freeSource).toBeUndefined();
  });
});

describe('公开投影与卡片值', () => {
  it('同一目录保留三列；传统数字字段仍给宿主，不把输入冒充窗口', () => {
    const model: ModelInfo = { id: 'Qwen3.8-Flash', provider: 'qoder', minCtx: { value: 1_000_000, source: origin }, maxInput: { value: 180_000, source: { ...origin, field: 'max_input_tokens' } }, priceMultiplier: { value: 0, current: true, updated_at: updatedAt, source: origin }, free: true, callVerified: false };
    expect(modelDirectoryEntry('qoder', model)).toMatchObject({ context_window: 1_000_000, max_input_tokens: 180_000, priceMultiplier: 0, priceSnapshot: { value: 0 }, callVerified: false, officialContext: { value: 1_000_000 } });
    expect(publicModelLimits({ id: 'unknown', provider: 'qoder', maxInput: model.maxInput }).minCtx).toBeUndefined();
  });
  it('过期或 current=false 只把旧费用标 stale，不推断收费', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date(updatedAt));
    const base = { free: true, priceMultiplier: { value: 0, current: false, updated_at: updatedAt, source: origin } };
    expect(publicModelMetadata(base)).toMatchObject({ free: true, feeFreshness: 'stale', priceMultiplier: 0, priceSnapshot: { value: 0, current: false } });
    const directory = modelDirectoryEntry('qoder', { id: 'm', provider: 'qoder', ...base });
    expect(directory).not.toHaveProperty('free'); expect(directory).not.toHaveProperty('priceMultiplier');
    expect(directory.name).toContain('待更新');
    expect(publicModelMetadata({ ...base, priceMultiplier: { ...base.priceMultiplier, current: true, activity: { label: '活动', ends_at: '2026-10-02T00:00:00Z' } } })).toMatchObject({ free: true, feeFreshness: 'stale' });
  });
  it('跨过夜间结束点时保留上次免费/零倍率并标待更新', () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-04T00:00:00Z'));
    expect(publicModelMetadata({ free: true, priceMultiplier: { value: 0, current: true, updated_at: updatedAt, source: origin, activity: { label: '夜间免费', timezone: 'Asia/Shanghai', daily: [{ start: '23:00', end: '8:00' }] } } })).toMatchObject({ free: true, feeFreshness: 'stale', priceMultiplier: 0 });
  });
  it('活动标签中的免费字样不能在显示名里绕过 current 判断', () => {
    const model: ModelInfo = { id: 'm', provider: 'qoder', free: true, activityLabels: ['限时免费'], priceMultiplier: { value: 0, current: false, updated_at: updatedAt, source: origin } };
    expect(modelDirectoryEntry('qoder', model).name).toContain('待更新');
  });
  it('快照只开放白名单，拒绝来源 URL 中的凭据，丢弃原始上游对象', () => {
    const metadata = publicModelMetadata({ free: true, priceMultiplier: { value: 0, current: true, updated_at: updatedAt, source: { ...origin, reference: 'https://example.com/?token=SYNTHETIC-PRIVATE' }, accessToken: 'SYNTHETIC-PRIVATE' } } as never);
    expect(metadata.priceMultiplier).toBeUndefined(); expect(metadata.free).toBeUndefined(); expect(JSON.stringify(metadata)).not.toContain('SYNTHETIC-PRIVATE');
  });
  it('卡片直接写值零来源标注；调用待验证不进费用区；缺倍率仍显示免费', () => {
    const model = { id: 'glm-5.3', minCtx: { value: 1_000_000, source: origin }, free: true, freeSource: origin, feeFreshness: 'fresh' as const, callVerified: false };
    expect(compactContext(model.minCtx).label).toBe('1M');
    const fees = modelBadges(model);
    expect(fees).toContain('免费'); expect(fees).not.toMatch(/调用待验证|官方|实测|更新时间|未提供|来源/);
    expect(modelVerification(model)).toContain('调用待验证');
    expect(modelBadges({ id: 'm', priceMultiplier: { value: 0.5, current: true, updated_at: updatedAt, source: origin } })).toContain('0.5×');
    expect(modelBadges({ id: 'm', priceMultiplier: { value: 0, current: true, updated_at: updatedAt, source: origin }, free: true, freeSource: origin })).toContain('0×');
    expect(modelBadges({ id: 'm' })).toContain('费用未确认');
  });
});
