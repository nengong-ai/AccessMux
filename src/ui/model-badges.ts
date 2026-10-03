import type { MetadataSource, ModelActivity, ModelInfo, ModelMetadata, PriceMultiplier, TokenLimit } from '../types.js';
import { officialModelContext, tokenValue } from '../adapters/qoder/catalog-specs.js';
import { formatModelActivity } from './public/activity-presentation.js';
import { bridgeReasoningCapability } from '../protocol/reasoning.js';

function text(value: unknown, limit?: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (clean === '') return undefined;
  if (limit === undefined || Array.from(clean).length <= limit) return clean;
  return `${Array.from(clean).slice(0, limit - 1).join('')}…`;
}

function publicSource(value: MetadataSource | undefined): MetadataSource | undefined {
  if (!value || (value.kind !== 'platform' && value.kind !== 'official-spec')) return undefined;
  const field = text(value.field, 160); const reference = text(value.reference, 300);
  if (!field || !reference || !Number.isFinite(Date.parse(value.updated_at))) return undefined;
  if (reference.startsWith('https://')) {
    try { const url = new URL(reference); if (url.search || url.hash || url.username || url.password) return undefined; } catch { return undefined; }
  } else if (!/^(qoder|workbuddy|trae|opencode|zcode):[\w./-]+$/.test(reference)) return undefined;
  return { kind: value.kind, reference, field, updated_at: value.updated_at,
    ...(value.region === 'cn' || value.region === 'ai' || value.region === 'global' ? { region: value.region } : {}),
    ...(value.entitlement === 'personal' || value.entitlement === 'entitlement' ? { entitlement: value.entitlement } : {}),
  };
}

function publicActivity(value: ModelActivity | undefined): ModelActivity | undefined {
  const label = text(value?.label, 100); if (!value || !label) return undefined;
  return { label,
    ...(value.kind === 'free' || value.kind === 'discount' || value.kind === 'other' ? { kind: value.kind } : {}),
    ...(value.scheduleMeaning === 'benefit' || value.scheduleMeaning === 'label' ? { scheduleMeaning: value.scheduleMeaning } : {}),
    ...(typeof value.starts_at === 'string' && Number.isFinite(Date.parse(value.starts_at)) ? { starts_at: value.starts_at } : {}),
    ...(typeof value.ends_at === 'string' && Number.isFinite(Date.parse(value.ends_at)) ? { ends_at: value.ends_at } : {}),
    ...(typeof value.timezone === 'string' && /^[\w/+_-]+$/.test(value.timezone) ? { timezone: value.timezone } : {}),
    ...(Array.isArray(value.daily) ? { daily: value.daily.filter((v) => typeof v.start === 'string' && typeof v.end === 'string' && /^\d{1,2}:\d{2}$/.test(v.start) && /^\d{1,2}:\d{2}$/.test(v.end)).map((v) => ({ start: v.start, end: v.end })) } : {}),
    ...(Array.isArray(value.windows) ? { windows: value.windows.filter((v) => Number.isInteger(v.start_minute) && Number.isInteger(v.end_minute) && v.start_minute >= 0 && v.start_minute < v.end_minute && v.end_minute <= 1440 && Array.isArray(v.weekdays)).map((v) => ({ start_minute: v.start_minute, end_minute: v.end_minute, weekdays: v.weekdays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 7) })) } : {}),
    ...(value.region === 'cn' || value.region === 'ai' || value.region === 'global' ? { region: value.region } : {}),
    ...(value.entitlement === 'personal' || value.entitlement === 'entitlement' ? { entitlement: value.entitlement } : {}),
    ...(publicSource(value.source) ? { source: publicSource(value.source)! } : {}),
  };
}

function publicLimit(value: number | TokenLimit | undefined): number | TokenLimit | undefined {
  const tokens = tokenValue(value); if (tokens === undefined) return undefined;
  if (typeof value === 'number') return tokens;
  const origin = publicSource(value?.source);
  return origin === undefined ? undefined : { value: tokens, source: origin };
}

export function publicModelLimits(model: ModelInfo): Pick<ModelInfo, 'minCtx' | 'maxInput' | 'officialContext'> {
  const official = publicLimit(model.officialContext ?? officialModelContext(model.id));
  const context = publicLimit(model.minCtx) ?? official;
  const maxInput = publicLimit(model.maxInput);
  return { ...(context === undefined ? {} : { minCtx: context }),
    ...(typeof maxInput === 'object' ? { maxInput } : {}),
    ...(typeof official === 'object' ? { officialContext: official } : {}),
  };
}

function activityCurrent(activity: ModelActivity | undefined): boolean {
  const now = Date.now();
  if (!activity) return true;
  if (activity.starts_at !== undefined && !(now >= Date.parse(activity.starts_at)) || activity.ends_at !== undefined && !(now < Date.parse(activity.ends_at))) return false;
  if (activity.daily === undefined && activity.windows === undefined) return true;
  if (!activity.timezone) return false;
  let minute: number; let weekday: number;
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: activity.timezone, hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }).formatToParts(now);
    minute = Number(parts.find((p) => p.type === 'hour')?.value) * 60 + Number(parts.find((p) => p.type === 'minute')?.value);
    weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.find((p) => p.type === 'weekday')?.value ?? '') + 1;
  } catch { return false; }
  if (activity.windows !== undefined) return activity.windows.some((w) => w.weekdays.includes(weekday) && minute >= w.start_minute && minute < w.end_minute);
  const parseMinute = (value: string): number | undefined => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value); if (!match) return undefined;
    const h = Number(match[1]); const m = Number(match[2]); return h < 24 && m < 60 ? h * 60 + m : undefined;
  };
  return activity.daily!.some((w) => {
    const start = parseMinute(w.start); const end = parseMinute(w.end);
    if (start === undefined || end === undefined || start === end) return false;
    return start < end ? minute >= start && minute < (end === 1439 ? 1440 : end) : minute >= start || minute < end;
  });
}

/** 目录只开放公开模型字段；不能把上游对象整体发给浏览器或宿主。 */
export function publicModelMetadata(model: ModelMetadata): ModelMetadata {
  const out: ModelMetadata = {};
  const name = text(model.name, 120);
  if (name !== undefined) out.name = name;
  if (typeof model.priceMultiplier === 'number' && Number.isFinite(model.priceMultiplier) && model.priceMultiplier >= 0) {
    out.priceMultiplier = model.priceMultiplier;
  }
  const snapshot = typeof model.priceMultiplier === 'object' ? model.priceMultiplier : model.priceSnapshot;
  if (snapshot && typeof snapshot.value === 'number' && Number.isFinite(snapshot.value) && snapshot.value >= 0 && typeof snapshot.current === 'boolean' && Number.isFinite(Date.parse(snapshot.updated_at))) {
    const origin = publicSource(snapshot.source); const activity = publicActivity(snapshot.activity);
    if (origin) {
      // 活动日期经过只能让证据变旧，不能把它改写成明确收费。
      const current = snapshot.current && activityCurrent(activity);
      const clean: PriceMultiplier = { value: snapshot.value, current, updated_at: snapshot.updated_at, source: origin, ...(activity === undefined ? {} : { activity }) };
      out.priceSnapshot = clean;
      out.priceMultiplier = clean.value;
      if (!current && model.feeFreshness !== 'failed') out.feeFreshness = 'stale';
    }
  }
  if (typeof model.free === 'boolean') {
    out.free = model.free;
    if (!activityCurrent(model.freeActivity) && model.feeFreshness !== 'failed') out.feeFreshness = 'stale';
  }
  if (model.feeFreshness !== undefined) out.feeFreshness = model.feeFreshness;
  if (typeof model.feeCheckedAt === 'string' && Number.isFinite(Date.parse(model.feeCheckedAt))) out.feeCheckedAt = model.feeCheckedAt;
  if (model.feeErrorCode === 'timeout' || model.feeErrorCode === 'unavailable' || model.feeErrorCode === 'fetch-failed' || model.feeErrorCode === 'not-confirmed') out.feeErrorCode = model.feeErrorCode;
  if (model.feeFreshness !== 'failed' && (out.priceSnapshot?.current === false || model.freeActivity !== undefined && !activityCurrent(publicActivity(model.freeActivity)))) out.feeFreshness = 'stale';
  const freeSource = publicSource(model.freeSource); if (freeSource) out.freeSource = freeSource;
  const freeActivity = publicActivity(model.freeActivity); if (freeActivity) out.freeActivity = freeActivity;
  if (typeof model.free === 'boolean' && (freeSource || out.priceSnapshot)) out.free = model.free;
  else if (typeof model.free === 'boolean') { delete out.free; out.feeFreshness = model.feeFreshness === 'failed' ? 'failed' : 'unknown'; }
  const numericPrice = typeof model.priceMultiplier === 'number' && Number.isFinite(model.priceMultiplier) && model.priceMultiplier >= 0;
  if (out.feeFreshness === undefined && (typeof model.free === 'boolean' || numericPrice) && !freeSource && !out.priceSnapshot) out.feeFreshness = 'unknown';
  if (typeof model.callVerified === 'boolean') out.callVerified = model.callVerified;
  if (model.priceScope === 'model' || model.priceScope === 'entitlement') out.priceScope = model.priceScope;
  const labels = Array.isArray(model.activityLabels)
    ? [...new Set(model.activityLabels.map((label) => text(label)).filter((label): label is string => label !== undefined))]
    : [];
  if (labels.length > 0) out.activityLabels = labels;
  const activities = Array.isArray(model.activities) ? model.activities.map(publicActivity).filter((v): v is ModelActivity => v !== undefined) : [];
  if (activities.length) out.activities = activities;
  const description = text(model.description, 180);
  if (description !== undefined) out.description = description;
  if (model.reasoning !== undefined) {
    const reasoning: NonNullable<ModelMetadata['reasoning']> = {};
    if (typeof model.reasoning.supported === 'boolean') reasoning.supported = model.reasoning.supported;
    if (typeof model.reasoning.canDisableThinking === 'boolean') reasoning.canDisableThinking = model.reasoning.canDisableThinking;
    const efforts = Array.isArray(model.reasoning.supportedEfforts)
      ? model.reasoning.supportedEfforts.map((effort) => text(effort)).filter((effort): effort is string => effort !== undefined)
      : [];
    if (efforts.length > 0) reasoning.supportedEfforts = [...new Set(efforts)];
    if (Object.keys(reasoning).length > 0) out.reasoning = reasoning;
  }
  if (Array.isArray(model.inputModalities)) {
    const input = [...new Set(model.inputModalities.filter((modality) => modality === 'text' || modality === 'image'))];
    if (input.length > 0) out.inputModalities = input;
  }
  if (typeof model.iconUrl === 'string') {
    try {
      const url = new URL(model.iconUrl);
      if (url.protocol === 'https:' && url.username === '' && url.password === '' && url.search === '') out.iconUrl = url.href;
    } catch { /* 非 URL 的图标位不开放。 */ }
  }
  return out;
}

export function modelBadgeSuffix(model: ModelMetadata): string | undefined {
  const metadata = publicModelMetadata(model);
  const activityLabel = metadata.activities?.[0]?.label ?? metadata.activityLabels?.[0];
  if (metadata.feeFreshness === 'unknown') return activityLabel ? `${activityLabel} · 费用未确认` : '费用未确认';
  if (metadata.feeFreshness === 'stale' || metadata.feeFreshness === 'failed') {
    const historical = metadata.free === true ? '上次免费' : metadata.free === false ? '上次不免费' : undefined;
    const prior = typeof metadata.priceMultiplier === 'number' ? metadata.priceMultiplier : metadata.priceSnapshot?.value;
    const fee = historical ?? (prior === undefined ? '费用待更新' : `上次${prior}x·待更新`);
    return activityLabel ? `${activityLabel} · ${fee}·待更新` : `${fee}${historical ? '·待更新' : ''}`;
  }
  const freeLabel = metadata.activityLabels?.find((label) => /免费|free/i.test(label));
  const fee = metadata.free === true ? freeLabel ?? (metadata.priceScope === 'entitlement' ? '权益内免费' : '免费')
    : metadata.priceMultiplier !== undefined ? `${metadata.priceMultiplier}x` : undefined;
  if (activityLabel && activityLabel !== fee) return fee ? `${activityLabel} · ${fee}` : activityLabel;
  return fee ?? metadata.activityLabels?.find((label) => !/免费|free/i.test(label));
}

export function modelDisplayName(model: ModelInfo, badges = process.env['ACCESSMUX_MODEL_BADGES'] !== '0'): string {
  const name = publicModelMetadata(model).name ?? model.id;
  const suffix = badges ? modelBadgeSuffix(model) : undefined;
  return suffix === undefined ? name : `${name}·${suffix}`;
}

export interface BridgeModalityOptions {
  bridgeReasoning?: boolean;
  /**
   * T036：源的桥接图片路径是否已点亮（adapter.bridgeImages，真机往返验证过
   * 才为 true）。模型级还须 inputModalities 含 image 才亮 supportsImages——
   * 源通了但模型无视觉，或模型有视觉但源没打通，都保持灰标不虚标。
   */
  bridgeImages?: boolean;
}

export function modelDirectoryEntry(
  adapterId: string,
  model: ModelInfo,
  opts: BridgeModalityOptions = {},
): Record<string, unknown> {
  const metadata = publicModelMetadata(model);
  const staleFee = metadata.feeFreshness === 'stale' || metadata.feeFreshness === 'failed' || metadata.feeFreshness === 'unknown';
  if (staleFee) { delete metadata.free; delete metadata.priceMultiplier; }
  const limits = publicModelLimits(model);
  const imagesOn = opts.bridgeImages === true && (metadata.inputModalities?.includes('image') ?? false);
  const baseName = metadata.name ?? model.id;
  const suffix = modelBadgeSuffix(metadata);
  const source = adapterId === 'workbuddy' ? 'WorkBuddy' : adapterId === 'trae-cn' ? 'Trae CN' : adapterId === 'trae-global' ? 'Trae Global' : adapterId;
  const activity = metadata.activities?.[0];
  const named = activity ? formatModelActivity(activity, { detailed: false }) : metadata.activityLabels?.[0];
  const fee = activity && suffix?.startsWith(activity.label) ? suffix.slice(activity.label.length).replace(/^\s*·\s*/, '') : suffix;
  const displayWithSource = [baseName, named, fee, source].filter((part): part is string => Boolean(part)).join(' · ');
  return {
    id: `${adapterId}:${model.id}`,
    object: 'model',
    owned_by: adapterId,
    ...metadata,
    name: displayWithSource,
    display_name: displayWithSource,
    ...(model.tags === undefined ? {} : { tags: [...model.tags] }),
    ...limits,
    ...(limits.minCtx === undefined ? {} : { context_window: tokenValue(limits.minCtx) }),
    ...(limits.maxInput === undefined ? {} : { max_input_tokens: limits.maxInput.value }),
    // 上游视觉标签不等于桥接已经能传图；亮标 = 源路径点亮 && 模型有视觉。
    bridgeInputModalities: imagesOn ? ['text', 'image'] : ['text'],
    supportsImages: imagesOn,
    bridgeReasoning: bridgeReasoningCapability(metadata, opts.bridgeReasoning, adapterId),
  };
}
