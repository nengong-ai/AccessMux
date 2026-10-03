// WorkBuddy 模型目录解析（四轮返工按 dsh-workbuddy-connect 原文重写：
// upstream.ts:534-553 readEnvelope + 694-730 fetchModels + 1100-1153 parseModelCatalog
// + 198-232 resolveUpstreamReasoning）。
//
// 真实协议（GET /v3/config，CN copilot.tencent.com）：
//   响应是 `{code, msg, data}` envelope；`data`（或裸文档形状）里：
//   - `models`: [{id, name, maxInputTokens, maxOutputTokens, supportsImages,
//     disabledMultimodal, disabled, supportsReasoning, onlyReasoning,
//     reasoning: {supportedEfforts, defaultEffort|effort, canDisableThinking}}]
//   - `agents`: [{name: 'cli', models: [<modelId>...]}]
//   可用模型 = cli agent 名单 ∩ 未禁用且 caps 为正的行。
//   旧实现按 `/api/v1/models` + `modelId/displayName/abilities` 字段解析——
//   那套字段不在真实协议里（/v1/models 列表一直来自静态兜底）。
//
// 宽松解析：未知字段忽略；但 cli 名单缺失 / 交集为空按 dsh 语义抛错，
// 让上层走 fallbackModelsFor 而非静默渲染空目录。

import type { WorkBuddyModelInfo } from './catalog.js';
import { officialModelContext, source, tokenLimit } from '../qoder/catalog-specs.js';
import { enrichWorkBuddyModels, type WorkBuddyMetadataDocument } from './catalog-metadata.js';
export type { WorkBuddyModelInfo } from './catalog.js';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** 只认已观测的 credits 字符串，零值有效；未知/负数不生成价格徽标。 */
function parsePriceMultiplier(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^x(\d+(?:\.\d+)?)(?:\s+credits?)?$/i.exec(value.trim());
  if (match === null) return undefined;
  const multiplier = Number(match[1]);
  return Number.isFinite(multiplier) && multiplier >= 0 ? multiplier : undefined;
}

/** 标签只取同一目录行已给出的 badge 文案，不新增活动查询或改写标签。 */
function parseActivityLabels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const labels: string[] = [];
  for (const tag of value) {
    if (typeof tag !== 'string' || !/^badge:/i.test(tag)) continue;
    const label = tag.slice('badge:'.length).split(':')[0] ?? '';
    if (label !== '' && !labels.includes(label)) labels.push(label);
  }
  return labels;
}

/** 真机 /v3/config 使用 descriptionZh / descriptionEn，优先上游中文。 */
function parseDescription(row: Record<string, unknown>): string | undefined {
  for (const key of ['descriptionZh', 'descriptionEn']) {
    const value = row[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return Array.from(value).slice(0, 180).join('');
    }
  }
  return undefined;
}

/** dsh upstream.ts:534-553 readEnvelope：code 非 0 或非 JSON 都是可诊断失败。 */
function unwrapCatalogDocument(payload: unknown): Record<string, unknown> {
  if (!isObject(payload)) {
    throw new Error('WorkBuddy catalog response must be a JSON object');
  }
  const code = typeof payload['code'] === 'number' ? payload['code'] : 0;
  if (code !== 0) {
    const msg = typeof payload['msg'] === 'string' ? payload['msg'] : '';
    throw new Error(`WorkBuddy catalog fetch failed (code ${code}): ${msg}`);
  }
  // `/v3/config` 也观测到过裸产品文档形状（无 wrapper）：body 自带
  // models/agents 就当答案（对齐 dsh fetchModels 的双形状处理）。
  const data = isObject(payload['data']) ? payload['data'] : undefined;
  if (data !== undefined) return data;
  if ('models' in payload || 'agents' in payload) return payload;
  return {};
}

/** dsh upstream.ts:198-232 resolveUpstreamReasoning 的形状收窄。 */
function parseReasoning(row: Record<string, unknown>): NonNullable<WorkBuddyModelInfo['reasoning']> {
  const supports = row['supportsReasoning'] === true;
  const onlyReasoning = row['onlyReasoning'] === true;
  const raw = row['reasoning'];
  let supportedEfforts: readonly string[] = [];
  let canDisableThinking = false;
  if (isObject(raw)) {
    if (Array.isArray(raw['supportedEfforts'])) {
      supportedEfforts = raw['supportedEfforts'].filter((v): v is string => typeof v === 'string');
    }
    // 只有显式 canDisableThinking: true 才提供"关思考"；旧行省略该字段
    // 且部分会在 wire 上拒掉 off（对齐 dsh 的保守默认）。
    canDisableThinking = raw['canDisableThinking'] === true;
  }
  return { supports: supports || onlyReasoning, supportedEfforts, canDisableThinking };
}

/**
 * 把 /v3/config 响应 JSON 解析为 WorkBuddyModelInfo 列表。cli 名单缺失、
 * 交集为空、code != 0 时抛错（上层走 fallback）。
 */
export function parseWorkBuddyCatalogResponse(payload: unknown, options: {
  updatedAt?: string;
  region?: string;
  metadata?: WorkBuddyMetadataDocument;
  now?: Date;
} = {}): readonly WorkBuddyModelInfo[] {
  const updatedAt = options.updatedAt ?? new Date().toISOString();
  const document = unwrapCatalogDocument(payload);
  const rawModels = Array.isArray(document['models']) ? document['models'] : [];
  const agents = Array.isArray(document['agents']) ? document['agents'] : [];
  let cliIds: readonly string[] | undefined;
  for (const agent of agents) {
    if (isObject(agent) && agent['name'] === 'cli' && Array.isArray(agent['models'])) {
      cliIds = agent['models'].filter((id): id is string => typeof id === 'string');
      break;
    }
  }
  if (cliIds === undefined || cliIds.length === 0) {
    throw new Error('WorkBuddy model catalog lists no cli agent models');
  }
  const byId = new Map<string, WorkBuddyModelInfo>();
  for (const model of rawModels) {
    if (!isObject(model)) continue;
    const id = typeof model['id'] === 'string' ? model['id'] : '';
    if (id === '' || model['disabled'] === true) continue;
    const input = positive(model['maxInputTokens']) ? model['maxInputTokens'] : 0;
    const output = positive(model['maxOutputTokens']) ? model['maxOutputTokens'] : 0;
    if (input <= 0 || output <= 0) continue;
    const supportsImages = model['supportsImages'] === true && model['disabledMultimodal'] !== true;
    const reasoning = parseReasoning(model);
    const hasReasoning = reasoning.supports || reasoning.supportedEfforts.length > 0;
    const priceMultiplier = parsePriceMultiplier(model['credits']);
    const activityLabels = parseActivityLabels(model['tags']);
    const description = parseDescription(model);
    byId.set(id, {
      id,
      displayName: typeof model['name'] === 'string' && model['name'] !== '' ? model['name'] : id,
      ...(priceMultiplier === undefined ? {} : {
        priceMultiplier, free: priceMultiplier === 0,
        priceSnapshot: { value: priceMultiplier, current: true, updated_at: updatedAt, source: source('workbuddy:/v3/config', 'models.credits', updatedAt, options.region) },
        freeSource: source('workbuddy:/v3/config', 'models.credits', updatedAt, options.region),
      }),
      ...(activityLabels.length === 0 ? {} : { activityLabels }),
      ...(description === undefined ? {} : { description }),
      maxInput: tokenLimit(input, source('workbuddy:/v3/config', 'models.maxInputTokens', updatedAt, options.region)),
      ...(positive(model['contextWindow']) ? {
        contextWindow: model['contextWindow'],
        contextSource: source('workbuddy:/v3/config', 'models.contextWindow', updatedAt, options.region),
      } : {}),
      ...(officialModelContext(id) === undefined ? {} : { officialContext: officialModelContext(id) }),
      maxTokens: output,
      supportVision: supportsImages,
      // 真实协议无工具支持位；cli agent 名单内的行按可用处理，保守标 false
      supportTools: false,
      ...(hasReasoning ? { reasoning } : {}),
      input: supportsImages ? ['text', 'image'] : ['text'],
      output: ['text'],
      status: 'available',
    });
  }
  const models = cliIds
    .map((id) => byId.get(id))
    .filter((m): m is WorkBuddyModelInfo => m !== undefined);
  if (models.length === 0) {
    throw new Error('WorkBuddy model catalog resolved to an empty list');
  }
  return enrichWorkBuddyModels(models, options.metadata, options.now ?? new Date(updatedAt));
}
