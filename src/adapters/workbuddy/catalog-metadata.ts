// 第二目录 GET + 客户端产品配置缓存；只读，不调用 billing 领取/刷新接口。
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModelActivity } from '../../types.js';
import type { WorkBuddyModelInfo } from './catalog.js';
import type { WorkBuddyVariant } from './variant.js';
import { officialModelContext, positiveTokens, source } from '../qoder/catalog-specs.js';

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export interface WorkBuddyMetadataDocument {
  document: Record<string, unknown>;
  reference: string;
  updatedAt: string;
  region?: string;
}

/** 只认真实 contextWindow 字段，maxInputTokens/maxOutputTokens 都不参与推算。 */
function context(value: unknown): number | undefined {
  const row = object(value);
  if (row === undefined) return positiveTokens(value);
  const supported = Array.isArray(row['supportedLengths']) ? row['supportedLengths'].map(positiveTokens).filter((v): v is number => v !== undefined) : [];
  return supported.length > 0 ? Math.max(...supported) : positiveTokens(row['defaultLength']);
}

function minute(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return undefined;
  const h = Number(match[1]); const m = Number(match[2]);
  return h < 24 && m < 60 ? h * 60 + m : undefined;
}

export function workBuddyPromotionActive(raw: unknown, now: Date): boolean {
  const row = object(raw);
  if (row?.['enabled'] !== true || !Number.isFinite(now.getTime())) return false;
  const schedule = object(row['schedule']);
  if (!schedule) return false; // enabled 不是正在活动的证据。
  for (const [key, isStart] of [['validFrom', true], ['validUntil', false]] as const) {
    const bound = schedule[key];
    if (bound === undefined) continue;
    const time = typeof bound === 'string' ? Date.parse(bound) : NaN;
    if (!Number.isFinite(time) || (isStart ? now.getTime() < time : now.getTime() >= time)) return false;
  }
  if (schedule['daily'] === undefined) return schedule['validFrom'] !== undefined || schedule['validUntil'] !== undefined;
  if (!Array.isArray(schedule['daily']) || typeof schedule['timezone'] !== 'string') return false;
  let current: number;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: schedule['timezone'], hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    current = Number(parts.find((p) => p.type === 'hour')?.value) * 60 + Number(parts.find((p) => p.type === 'minute')?.value);
  } catch { return false; }
  return schedule['daily'].some((period: unknown) => {
    const p = object(period); const start = minute(p?.['start']); const end = minute(p?.['end']);
    if (start === undefined || end === undefined || start === end) return false;
    return start < end ? current >= start && current < (end === 1439 ? 1440 : end) : current >= start || current < end;
  });
}

function discountedCredits(raw: unknown): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const match = /^(\d+(?:\.\d+)?)x$/i.exec(raw.trim());
  return match === null ? undefined : Number(match[1]);
}

function activity(row: Record<string, unknown>, region?: string, origin?: ModelActivity['source']): ModelActivity {
  const schedule = object(row['schedule']) ?? {};
  const badge = object(row['badge']) ?? {};
  const label = typeof badge['label'] === 'string' ? badge['label'] : '限时活动';
  const daily = Array.isArray(schedule['daily']) ? schedule['daily'].map(object).filter((v): v is Record<string, unknown> => v !== undefined).filter((v) => minute(v['start']) !== undefined && minute(v['end']) !== undefined).map((v) => ({ start: v['start'] as string, end: v['end'] as string })) : [];
  const discount = object(row['discount']);
  const explicitRate = discountedCredits(discount?.['discountedCredits']);
  const kind = /免费|free/i.test(label) ? 'free' : explicitRate !== undefined ? 'discount' : /折扣|discount/i.test(label) ? 'discount' : 'other';
  return { label, kind, scheduleMeaning: explicitRate === undefined ? 'label' : 'benefit',
    ...(typeof schedule['validFrom'] === 'string' ? { starts_at: schedule['validFrom'] } : {}),
    ...(typeof schedule['validUntil'] === 'string' ? { ends_at: schedule['validUntil'] } : {}),
    ...(typeof schedule['timezone'] === 'string' ? { timezone: schedule['timezone'] } : {}),
    ...(daily.length ? { daily } : {}), ...(region === undefined ? {} : { region }), ...(origin ? { source: origin } : {}),
  };
}

function promotionStarted(raw: Record<string, unknown>, now: Date): boolean {
  const schedule = object(raw['schedule']);
  if (!schedule || raw['enabled'] !== true) return false;
  const start = typeof schedule['validFrom'] === 'string' ? Date.parse(schedule['validFrom']) : NaN;
  const end = typeof schedule['validUntil'] === 'string' ? Date.parse(schedule['validUntil']) : NaN;
  return (!Number.isFinite(start) || start <= now.getTime()) && (!Number.isFinite(end) || end > now.getTime() || endedAfterStart(raw, now));
}

function endedAfterStart(raw: Record<string, unknown>, now: Date): boolean {
  const schedule = object(raw['schedule']);
  const start = typeof schedule?.['validFrom'] === 'string' ? Date.parse(schedule['validFrom']) : NaN;
  const end = typeof schedule?.['validUntil'] === 'string' ? Date.parse(schedule['validUntil']) : NaN;
  return Number.isFinite(start) && Number.isFinite(end) && start < end && start <= now.getTime() && end <= now.getTime();
}

export function enrichWorkBuddyModels(models: readonly WorkBuddyModelInfo[], metadata?: WorkBuddyMetadataDocument, now = new Date()): WorkBuddyModelInfo[] {
  const document = metadata?.document ?? {};
  const rows = Array.isArray(document['models']) ? document['models'].map(object).filter((v): v is Record<string, unknown> => v !== undefined) : [];
  const promotions = Array.isArray(document['modelPromotions']) ? document['modelPromotions'].map(object).filter((v): v is Record<string, unknown> => v !== undefined) : [];
  return models.map((model) => {
    const result = { ...model };
    const row = rows.find((r) => r['id'] === model.id);
    const ctx = context(row?.['contextWindow']);
    const official = model.officialContext ?? officialModelContext(model.id);
    if (official) result.officialContext = official;
    if (result.contextWindow === undefined && ctx !== undefined && metadata) {
      result.contextWindow = ctx;
      result.contextSource = source(metadata.reference, 'models.contextWindow.supportedLengths', metadata.updatedAt, metadata.region);
    }
    if (result.contextWindow === undefined && official) { result.contextWindow = official.value; result.contextSource = official.source; }
    const matches = promotions.filter((p) => p['enabled'] === true && Array.isArray(p['modelIds']) && p['modelIds'].includes(model.id));
    const active = matches.filter((p) => workBuddyPromotionActive(p, now));
    const sourceDate = new Date(metadata?.updatedAt ?? now.toISOString());
    const expired = matches.filter((p) => !workBuddyPromotionActive(p, now)
      && (metadata !== undefined && workBuddyPromotionActive(p, sourceDate) || endedAfterStart(p, now)));
    const applicable = active.length ? active : expired;
    const priced = applicable.filter((p) => discountedCredits(object(p['discount'])?.['discountedCredits']) !== undefined)
      .sort((a, b) => (typeof b['priority'] === 'number' ? b['priority'] : 0) - (typeof a['priority'] === 'number' ? a['priority'] : 0))[0];
    const ruleRows = matches.filter((p) => promotionStarted(p, now) || workBuddyPromotionActive(p, sourceDate));
    const byLabel = new Map<string, Record<string, unknown>>();
    for (const promo of ruleRows) {
      const label = String(object(promo['badge'])?.['label'] ?? '限时活动');
      const existing = byLabel.get(label);
      const hasRate = discountedCredits(object(promo['discount'])?.['discountedCredits']) !== undefined;
      const existingHasRate = existing && discountedCredits(object(existing['discount'])?.['discountedCredits']) !== undefined;
      if (!existing || hasRate && !existingHasRate) byLabel.set(label, promo);
    }
    const activities = metadata ? [...byLabel.values()].map((p) => {
      const rate = discountedCredits(object(p['discount'])?.['discountedCredits']);
      const field = rate === undefined ? 'modelPromotions.badge.label' : 'modelPromotions.discount.discountedCredits';
      return activity(p, metadata.region, source(metadata.reference, field, metadata.updatedAt, metadata.region));
    }) : [];
    if (activities.length) {
      result.activities = activities;
      result.activityLabels = [...new Set([...(model.activityLabels ?? []), ...activities.map((item) => item.label)])];
    }
    const labels = (priced ? [object(priced['badge'])?.['label']] : []).filter((v): v is string => typeof v === 'string' && v !== '');
    if (labels.length) result.activityLabels = [...new Set([...(model.activityLabels ?? []), ...labels])];
    if (priced && metadata) {
      const value = discountedCredits(object(priced['discount'])?.['discountedCredits'])!;
      const origin = source(metadata.reference, 'modelPromotions.discount.discountedCredits', metadata.updatedAt, metadata.region);
      const currentActivity = activity(priced, metadata.region, origin);
      result.priceMultiplier = value;
      const current = workBuddyPromotionActive(priced, now);
      result.priceSnapshot = { value, current, updated_at: metadata.updatedAt, source: origin, activity: currentActivity };
      result.free = value === 0; result.freeSource = origin;
      if (value === 0) result.freeActivity = currentActivity;
      result.feeFreshness = current && metadata.reference.startsWith('https://') ? 'fresh' : 'stale';
      result.feeCheckedAt = now.toISOString();
    }
    return result;
  });
}

/** 新目录只有基础费率时，不能覆盖同一模型先前明确的促销证据。 */
export function retainWorkBuddyPromotionOnBaseRate(
  previous: readonly WorkBuddyModelInfo[],
  incoming: readonly WorkBuddyModelInfo[],
  checkedAt = new Date().toISOString(),
): WorkBuddyModelInfo[] {
  const oldById = new Map(previous.map((model) => [model.id, model]));
  return incoming.map((model) => {
    const old = oldById.get(model.id);
    const oldSource = old?.priceSnapshot?.source.field ?? old?.freeSource?.field;
    const newSource = model.priceSnapshot?.source.field ?? model.freeSource?.field;
    const previousWasPromotion = oldSource?.startsWith('modelPromotions.') === true;
    const onlyBaseRateArrived = newSource === 'models.credits';
    if (!old || !previousWasPromotion || !onlyBaseRateArrived) return model;
    return {
      ...model,
      ...(old.priceMultiplier === undefined ? {} : { priceMultiplier: old.priceMultiplier }),
      ...(old.priceSnapshot === undefined ? {} : { priceSnapshot: structuredClone(old.priceSnapshot) }),
      ...(old.free === undefined ? {} : { free: old.free }),
      ...(old.freeSource === undefined ? {} : { freeSource: { ...old.freeSource } }),
      ...(old.freeActivity === undefined ? {} : { freeActivity: structuredClone(old.freeActivity) }),
      ...(old.activityLabels === undefined ? {} : { activityLabels: [...old.activityLabels] }),
      feeFreshness: 'stale',
      feeCheckedAt: checkedAt,
    };
  });
}

/** 缓存只为第二接口缺失的字段兜底；接口显式清空的活动数组不能被旧缓存覆盖。 */
export async function fetchWorkBuddyMetadata(options: {
  variant: WorkBuddyVariant; headers: Record<string, string>; signal: AbortSignal;
  fetchImpl?: typeof fetch; cachePath?: string | null; now?: Date;
}): Promise<WorkBuddyMetadataDocument | undefined> {
  const updatedAt = (options.now ?? new Date()).toISOString();
  const cachePath = options.cachePath === undefined ? (options.variant === 'cn' ? join(homedir(), '.workbuddy/cache/acc-product-config-v3.json') : undefined) : options.cachePath ?? undefined;
  let cached: WorkBuddyMetadataDocument | undefined;
  if (cachePath) {
    try { const [raw, info] = await Promise.all([readFile(cachePath, 'utf8'), stat(cachePath)]); const document = object(JSON.parse(raw)); if (document) cached = { document, reference: 'workbuddy:acc-product-config-v3.json', updatedAt: info.mtime.toISOString(), region: options.variant }; } catch { /* 缺缓存不拖住主目录。 */ }
  }
  try {
    const base = options.variant === 'cn' ? 'https://www.workbuddy.cn' : 'https://www.workbuddy.ai';
    const response = await (options.fetchImpl ?? fetch)(`${base}/v3/config`, { method: 'GET', headers: options.headers, signal: options.signal });
    if (!response.ok) return cached;
    const payload = object(await response.json());
    if (typeof payload?.['code'] === 'number' && payload['code'] !== 0) return cached;
    const document = object(payload?.['data']) ?? payload;
    if (!document) return cached;
    // 当前 /v3/config 不下发 modelPromotions；保留产品缓存的明确字段和时间。
    if (!('modelPromotions' in document) && !Array.isArray(document['models'])) return cached;
    if (!('modelPromotions' in document) && cached) return cached;
    return { document, reference: `${base}/v3/config`, updatedAt, region: options.variant };
  } catch { return cached; }
}
