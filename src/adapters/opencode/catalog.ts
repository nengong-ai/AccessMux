// 免费模型目录过滤（T013）。免费 = cost（input/output/cache.read/cache.write）全 0
// 且 text 输出、未 deprecated——全部以 GET /provider 的实时目录为准，不缓存死清单
//（§3.1 事实 3：big-pickle 匿名被上游禁用、glm-5.3-flash 非免费，都是过滤规则
// 而非名单问题）。条目形状对照 T012 实测捕获的 /provider 响应。

import type { ModelInfo } from '../../types.js';
import { source } from '../qoder/catalog-specs.js';

/** /provider 条目里模型元数据的最小面（只声明过滤与 ModelInfo 需要的字段）。 */
export interface OpencodeModelEntry {
  id?: string;
  name?: string;
  status?: string;
  cost?: {
    input?: number;
    output?: number;
    cache?: { read?: number; write?: number };
  };
  capabilities?: {
    toolcall?: boolean;
    reasoning?: boolean;
    input?: { text?: boolean; image?: boolean };
    output?: { text?: boolean };
  };
  variants?: Record<string, { reasoningEffort?: string }>;
  limit?: { context?: number };
}

/** GET /provider 响应形状（all/default/connected 三键里只用 all）。 */
export interface ProviderDirectory {
  all?: Array<{ id?: string; models?: Record<string, OpencodeModelEntry> }>;
}

/** cost 全 0 + text 输出 + 未 deprecated。锚点（官方源码
 * packages/opencode/src/provider/provider.ts）：:1075-1092（Model schema：
 * cost{input,output,cache.read/write}/limit/status/capabilities/variants）、
 * :1095-1102（provider.models = Record<id, Model>）；官方为自建免费模型即用
 * cost 全 0 构造（:703-704），零成本=免费是官方语义；GET /provider 响应
 * {all,default,connected} 见 :1108-1112。过滤规则本身是 AccessMux 对该
 * 语义的推导（叠加 text 输出与未弃用两个可用性条件）。 */
export function isFreeModel(model: OpencodeModelEntry): boolean {
  const cost = model.cost;
  if (cost === undefined) return false;
  if (cost.input !== 0 || cost.output !== 0) return false;
  if ((cost.cache?.read ?? 0) !== 0 || (cost.cache?.write ?? 0) !== 0) return false;
  if (model.capabilities?.output?.text === false) return false;
  return model.status !== 'deprecated';
}

export class OpencodeProviderMissingError extends Error {
  constructor(providerId: string) {
    super(`opencode 模型目录里没有 ${providerId} provider`);
    this.name = 'OpencodeProviderMissingError';
  }
}

/**
 * 从 /provider 目录提取免费模型清单 → ModelInfo。
 * id 用上游裸 modelID（宿主侧全名 = `opencode:<modelId>`）；ctx/toolcall/image
 * 元数据进 tags 与 minCtx。目录里没有 opencode provider 时抛错（probe 捕获后
 * 如实标 unavailable）。
 */
export function freeModelsFromDirectory(directory: ProviderDirectory, providerId = 'opencode', observedAt = new Date().toISOString()): ModelInfo[] {
  const provider = directory.all?.find((p) => p.id === providerId);
  if (provider === undefined) throw new OpencodeProviderMissingError(providerId);
  return Object.entries(provider.models ?? {})
    .filter(([, model]) => isFreeModel(model))
    .map(([id, model]) => {
      const tags: string[] = ['chat'];
      if (model.capabilities?.toolcall === true) tags.push('toolcall');
      if (model.capabilities?.input?.image === true) tags.push('image');
      if (model.capabilities?.reasoning === true) tags.push('reasoning');
      const supportedEfforts = [...new Set(Object.values(model.variants ?? {})
        .map((variant) => variant.reasoningEffort)
        .filter((effort): effort is string => typeof effort === 'string' && effort !== ''))];
      const input = model.capabilities?.input;
      const inputModalities: Array<'text' | 'image'> = [];
      if (input?.text === true) inputModalities.push('text');
      if (input?.image === true) inputModalities.push('image');
      return {
        id,
        provider: providerId,
        ...(typeof model.name === 'string' && model.name !== '' ? { name: model.name } : {}),
        // cost 已经通过原有全零过滤；货币 cost 不是 credits 倍率，故不造 0x。
        free: true,
        freeSource: source('opencode:provider-directory', `all.${providerId}.models.${id}.cost`, observedAt),
        feeFreshness: 'fresh' as const,
        feeCheckedAt: observedAt,
        priceScope: 'model' as const,
        ...(model.capabilities?.reasoning === undefined && supportedEfforts.length === 0 ? {} : {
          reasoning: {
            ...(model.capabilities?.reasoning === undefined ? {} : { supported: model.capabilities.reasoning }),
            ...(supportedEfforts.length === 0 ? {} : { supportedEfforts }),
          },
        }),
        ...(inputModalities.length === 0 ? {} : { inputModalities }),
        tags,
        ...(typeof model.limit?.context === 'number' ? { minCtx: model.limit.context } : {}),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}
