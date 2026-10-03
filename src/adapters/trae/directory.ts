// get_detail_param 多 function union 拉取（端口 spec §3.2.5 + §4.3.3）。
//
// 每个 region 跑 TRAE_DIRECTORY_FUNCTIONS 里的所有 function；首个列出某
// config_name 的 function "owns" 它；config_name 是 wire id 真值。

import { safeCredentialError } from './credential-store.js';
import type { TraeCredential } from './credential-store.js';
import type { TraeIdentity } from './identity.js';
import { buildTraeHeaders } from './headers.js';
import { TRAE_SOLO_FUNCTION, TRAE_DIRECTORY_FUNCTIONS, buildGetDetailParamBody } from './model-detail.js';
import { REGION_GATEWAYS, regionOfCredential } from './region.js';
import { parseReasoningCapability, type TraeReasoningCapability } from './reasoning.js';
import { traeEndpoint } from './endpoints.js';
import { TRAE_SOLO_MODELS_PATH } from './endpoints.js';
import { source, tokenLimit } from '../qoder/catalog-specs.js';
import type { TraeCatalogMetadata } from './merge-sources.js';

export interface TraeWireModelRow extends TraeCatalogMetadata {
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: TraeReasoningCapability;
  creditMultiplier?: number;
  /** 列出此 config_name 的 directory function。 */
  function: string;
}

export interface TraeDirectoryClientOptions {
  credential(): Promise<TraeCredential>;
  identity(): Promise<TraeIdentity>;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** 单次 fetch 的 timeout（默认 30s）。 */
  timeoutMs?: number;
}

function finitePositive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * 来自 `display_contact_config.consumption_rate.data.rate`：Trae IDE 渲染的
 * post-discount 数字（带限时 1 折促销时差距可达 10x）。`enable !== true` 或
 * 解不出来都返回 undefined，让 merge 阶段落到 remote 的值。
 */
function wireCreditMultiplier(config: Record<string, unknown>): number | undefined {
  const raw = config['display_contact_config'];
  if (typeof raw !== 'string' || raw === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const consumption = (parsed as Record<string, unknown>)['consumption_rate'];
  if (typeof consumption !== 'object' || consumption === null) return undefined;
  const entry = consumption as Record<string, unknown>;
  if (entry['enable'] !== true) return undefined;
  const data = entry['data'];
  if (typeof data !== 'object' || data === null) return undefined;
  const value = (data as Record<string, unknown>)['rate'];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** 收集单个 function 响应里的 config 列表，写入 byId（first wins）。 */
function collectModels(
  list: readonly unknown[],
  directoryFunction: string,
  byId: Map<string, TraeWireModelRow>,
): void {
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue;
    const config = raw as Record<string, unknown>;
    const id = typeof config['config_name'] === 'string' ? config['config_name'] : '';
    if (id === '') continue;
    if (byId.has(id)) continue;
    const display = typeof config['display_config'] === 'object' && config['display_config'] !== null
      ? config['display_config'] as Record<string, unknown>
      : {};
    const details = Array.isArray(config['model_detail_list']) ? config['model_detail_list'] : [];
    const detail = details[0] !== undefined && typeof details[0] === 'object' && details[0] !== null
      ? details[0] as Record<string, unknown>
      : {};
    const contextTokens = typeof config['context_window_tokens'] === 'object' && config['context_window_tokens'] !== null
      ? config['context_window_tokens'] as Record<string, unknown>
      : {};
    const contextWindow = finitePositive(contextTokens['dev']);
    const updatedAt = new Date().toISOString();
    const maxInput = tokenLimit(detail['prompt_max_tokens'], source('trae:/get_detail_param', 'model_detail_list.prompt_max_tokens', updatedAt));
    const maxTokens = finitePositive(detail['max_tokens']);
    const reasoning = parseReasoningCapability({ ...config, ...detail });
    const creditMultiplier = wireCreditMultiplier(config);
    byId.set(id, {
      id,
      name: typeof display['display_name'] === 'string' && display['display_name'] !== '' ? display['display_name'] : id,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(contextWindow === undefined ? {} : { contextSource: source('trae:/get_detail_param', 'context_window_tokens.dev', updatedAt) }),
      ...(maxInput === undefined ? {} : { maxInput }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      ...(reasoning === undefined ? {} : { reasoning }),
      ...(creditMultiplier === undefined ? {} : { creditMultiplier }),
      ...(creditMultiplier === undefined ? {} : { priceSnapshot: { value: creditMultiplier, current: true, updated_at: updatedAt, source: source('trae:/get_detail_param', 'display_contact_config.consumption_rate.data.rate', updatedAt) } }),
      function: directoryFunction,
    });
  }
}

/**
 * Union 多 directory function 的结果。任何一边失败都吞掉（不让一个 500 把整
 * 个 roster 隐藏）；全部为空则抛 `Trae SOLO models response contained no models`
 * 让上层保留静态兜底。
 */
export async function fetchTraeDirectory(
  options: TraeDirectoryClientOptions,
  signal?: AbortSignal,
): Promise<TraeWireModelRow[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const [credential, identity] = await Promise.all([options.credential(), options.identity()]);
  const region = regionOfCredential(credential);
  const base = options.baseUrl ?? REGION_GATEWAYS[region].chat;
  const headers = { ...buildTraeHeaders(credential, identity), Accept: 'application/json' };
  const byId = new Map<string, TraeWireModelRow>();
  const failures: string[] = [];
  const functions = TRAE_DIRECTORY_FUNCTIONS[region];
  for (const directoryFunction of functions) {
    let list: unknown[];
    try {
      const response = await fetchImpl(traeEndpoint(base, TRAE_SOLO_MODELS_PATH), {
        method: 'POST',
        headers,
        body: JSON.stringify(buildGetDetailParamBody(directoryFunction)),
        signal: signal === undefined ? AbortSignal.timeout(options.timeoutMs ?? 30_000) : AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs ?? 30_000)]),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const document = await response.json() as Record<string, unknown>;
      list = Array.isArray(document['config_info_list']) ? document['config_info_list'] : [];
    } catch (error: unknown) {
      failures.push(`${directoryFunction}: ${safeCredentialError(error, credential)}`);
      continue;
    }
    collectModels(list, directoryFunction, byId);
  }
  const models = [...byId.values()];
  if (models.length === 0) {
    throw new Error(`Trae SOLO models response contained no models (${failures.join('; ') || 'empty directory'})`);
  }
  return models;
}

// 重导出，避免外层记住多个入口
export { TRAE_SOLO_FUNCTION };
