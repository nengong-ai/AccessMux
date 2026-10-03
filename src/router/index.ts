// 核心路由层骨架：模型名 → adapter。
// Phase 2 再补 canonical group、tag/min_ctx DSL、QoS 评分与显式 queue（报告 §3.2）。

import { getAdapter, listAdapters } from '../adapters/registry.js';
import type { ProviderAdapter } from '../adapters/types.js';

export class NoProviderAvailable extends Error {
  constructor(model: string) {
    super(`没有可用的 adapter 提供模型: ${model}（已注册: ${listAdapters().map((a) => a.id).join(', ') || '无'}）`);
    this.name = 'NoProviderAvailable';
  }
}

/**
 * MVP 路由约定：`<adapterId>:<展示模型名>` 显式指定来源，如 `workbuddy:GLM-5.3`。
 * 裸模型名留待 Phase 2 canonical group 解析。
 */
export function pickAdapterForModel(model: string): { adapter: ProviderAdapter; modelId: string } {
  const sep = model.indexOf(':');
  if (sep > 0) {
    const adapterId = model.slice(0, sep);
    const modelId = model.slice(sep + 1);
    const adapter = getAdapter(adapterId);
    if (adapter && modelId) return { adapter, modelId };
  }
  throw new NoProviderAvailable(model);
}
