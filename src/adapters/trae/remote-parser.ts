// SOLO Remote `/models` 响应的安全子集解析（端口 spec §3.3 + §4.3.3）。
//
// Remote 列表只暴露到骨架粒度——display id / display name / 上下文窗口 /
// credit multiplier / multimodal / reasoning。Wire id 由 get_detail_param
// 提供，通过 mergeTraeModelSources 与本集合 join。

import type { TraeDiscoveredModel } from './merge-sources.js';
import { officialModelContext, source, tokenLimit } from '../qoder/catalog-specs.js';

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

interface RemoteModelRow {
  id?: unknown;
  name?: unknown;
  context_window?: unknown;
  max_context_window?: unknown;
  consumption_rate?: unknown;
  metadata?: unknown;
  capabilities?: unknown;
  reasoning?: unknown;
  contextWindow?: unknown;
  maxInputTokens?: unknown;
  max_input_tokens?: unknown;
  creditMultiplier?: unknown;
  activityLabels?: unknown;
  free?: unknown;
  display_name?: unknown;
  context_window_tokens?: unknown;
  features?: unknown;
  multimodal?: unknown;
  reasoning_effort_config?: unknown;
}

function finiteContext(value: unknown): number | undefined {
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return positive(record['total']) ?? positive(record['value']) ?? positive(record['tokens']);
  }
  return positive(value);
}

function parseConsumptionRate(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  return multiplier(record['rate']) ?? multiplier(record['value']);
}

function multiplier(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function features(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') { try { return record(JSON.parse(value)) ?? {}; } catch { return {}; } }
  return record(value) ?? {};
}

function parseCapabilities(value: unknown): { multimodal?: boolean; reasoningSupported?: boolean; reasoning?: { supported: readonly string[] } } {
  if (typeof value !== 'object' || value === null) return {};
  const record = value as Record<string, unknown>;
  const out: { multimodal?: boolean; reasoningSupported?: boolean; reasoning?: { supported: readonly string[] } } = {};
  if (record['vision'] === true || record['multimodal'] === true) out.multimodal = true;
  if (record['reasoning'] === true || record['thinking'] === true) out.reasoningSupported = true;
  if (Array.isArray(record['reasoning_effort_options'])) {
    out.reasoning = { supported: (record['reasoning_effort_options'] as unknown[]).filter((s): s is string => typeof s === 'string') };
  }
  return out;
}

/**
 * 解析单行 SOLO Remote model；缺关键字段返回 undefined 让上层跳过。
 */
export function parseTraeRemoteModel(raw: unknown, options: { updatedAt?: string; region?: string } = {}): TraeDiscoveredModel | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const row = raw as RemoteModelRow;
  // 当前真实目录没有 id：name 是目录/路由键，display_name 是展示名。
  const id = nonEmpty(row.id) ?? nonEmpty(row.name);
  const name = nonEmpty(row.display_name) ?? nonEmpty(row.name) ?? id;
  if (id === undefined) return undefined;
  const finalName = name === undefined || name === '' ? id : name;
  const caps = parseCapabilities(row.capabilities ?? row.metadata);
  const feature = features(row.features);
  if (row.multimodal === true || record(feature['multimodal'])?.['enable'] === true) caps.multimodal = true;
  if (record(feature['reasoning'])?.['enable'] === true) caps.reasoningSupported = true;
  const effort = record(row.reasoning_effort_config);
  if (effort?.['support_thinking'] === true && Array.isArray(effort['options'])) {
    const supported = effort['options'].map((v: unknown) => typeof v === 'string' ? v : nonEmpty(record(v)?.['value'])).filter((v): v is string => v !== undefined);
    if (supported.length) caps.reasoning = { supported };
  }
  const updatedAt = options.updatedAt ?? new Date().toISOString();
  const contextTokens = record(row.context_window_tokens);
  const ctx = finiteContext(row.contextWindow) ?? finiteContext(row.context_window) ?? positive(contextTokens?.['dev']);
  const official = officialModelContext(id);
  const discount = record(feature['activity_discount']);
  const discountData = record(discount?.['data']);
  const currentDiscount = discount?.['enable'] === true ? record(discountData?.['current']) : undefined;
  const discountRate = multiplier(currentDiscount?.['consumption_rate']);
  const consumption = record(feature['consumption_rate']);
  const featureRate = consumption?.['enable'] === true ? multiplier(record(consumption['data'])?.['rate']) : undefined;
  const rate = multiplier(row.creditMultiplier) ?? discountRate ?? featureRate ?? parseConsumptionRate(row.consumption_rate);
  const rateField = multiplier(row.creditMultiplier) !== undefined ? 'creditMultiplier' : discountRate !== undefined ? 'features.activity_discount.data.current.consumption_rate' : featureRate !== undefined ? 'features.consumption_rate.data.rate' : 'consumption_rate.rate';
  const origin = source('trae:/remote/v1/models', rateField, updatedAt, options.region);
  const discountType = currentDiscount?.['discount_type'];
  const discountLabel = discountType === 'subsidy' ? '补贴优惠' : discountType === 'member' ? '会员优惠' : discountType === 'off_peak' ? '闲时优惠' : undefined;
  const timeWindows = record(discountData?.['off_peak'])?.['time_windows'];
  const windows = Array.isArray(timeWindows) ? timeWindows.map(record).filter((v): v is Record<string, unknown> => v !== undefined).filter((v) => Array.isArray(v['weekdays']) && typeof v['start_minute'] === 'number' && typeof v['end_minute'] === 'number' && v['start_minute'] >= 0 && v['end_minute'] <= 1440).map((v) => ({ weekdays: (v['weekdays'] as unknown[]).filter((d): d is number => typeof d === 'number' && Number.isInteger(d) && d >= 0 && d <= 7), start_minute: v['start_minute'] as number, end_minute: v['end_minute'] as number })) : [];
  const currentActivity = discountLabel === undefined ? undefined : { label: discountLabel, ...(options.region === undefined ? {} : { region: options.region }), ...(discountType === 'member' ? { entitlement: 'entitlement' } : {}), ...(discountType === 'off_peak' && windows.length ? { windows, ...(options.region === 'cn' ? { timezone: 'Asia/Shanghai' } : {}) } : {}) };
  const maxInput = tokenLimit(row.maxInputTokens ?? row.max_input_tokens, source('trae:/remote/v1/models', row.maxInputTokens === undefined ? 'max_input_tokens' : 'maxInputTokens', updatedAt, options.region));
  const labels = [...(Array.isArray(row.activityLabels) ? row.activityLabels.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : []), ...(discountLabel ? [discountLabel] : [])];
  return {
    id,
    name: finalName,
    ...(ctx === undefined ? {} : { contextWindow: ctx, contextSource: source('trae:/remote/v1/models', row.contextWindow !== undefined ? 'contextWindow' : row.context_window !== undefined ? 'context_window' : 'context_window_tokens.dev', updatedAt, options.region) }),
    ...(maxInput === undefined ? {} : { maxInput }),
    ...(official === undefined ? {} : { officialContext: official }),
    ...(finiteContext(row.max_context_window) ?? positive(contextTokens?.['max']) ? { maxContextWindow: finiteContext(row.max_context_window) ?? positive(contextTokens?.['max']) } : {}),
    ...(rate === undefined ? {} : { creditMultiplier: rate, priceSnapshot: { value: rate, current: true, updated_at: updatedAt, source: origin, ...(currentActivity ? { activity: currentActivity } : {}) }, free: rate === 0, freeSource: origin, ...(rate === 0 && currentActivity ? { freeActivity: currentActivity } : {}) }),
    ...(row.free === true && rate === undefined ? { free: true, freeSource: source('trae:/remote/v1/models', 'free', updatedAt, options.region) } : {}),
    ...(labels.length ? { activityLabels: [...new Set(labels)] } : {}),
    ...(caps.multimodal === undefined ? {} : { multimodal: caps.multimodal }),
    ...(caps.reasoningSupported === undefined ? {} : { reasoningSupported: caps.reasoningSupported }),
    ...(caps.reasoning === undefined ? {} : { reasoning: caps.reasoning }),
  };
}
