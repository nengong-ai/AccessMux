// WorkBuddy 模型目录抽象（端口 spec §4.3.2 + dsh-workbuddy-connect/
// index.ts:945-1019 fetchCatalog / 561-564 invalidate / 1035-1067 syncVariant）。
//
// 与 TraeCatalog 同构：
// - `current()` 返回只读列表（shim 的 GET /v1/models 用）
// - `set()` 替换快照（catalog refresh 后调）；空快照拒绝，避免把 provider
//   整个挂掉
// - `fallbackModels` 给 UI 渲染的静态兜底（首次启动 / refresh 失败）

import type { WorkBuddyVariant } from './variant.js';
import type { MetadataSource, ModelActivity, PriceMultiplier, TokenLimit } from '../../types.js';

export interface WorkBuddyModelInfo {
  id: string;
  displayName: string;
  /** /v3/config 的 credits（如 x0.29 credits），缺失时不推断价格。 */
  priceMultiplier?: number;
  priceSnapshot?: PriceMultiplier;
  free?: boolean;
  freeSource?: MetadataSource;
  freeActivity?: ModelActivity;
  feeFreshness?: 'fresh' | 'stale' | 'failed' | 'unknown';
  feeCheckedAt?: string;
  activityLabels?: readonly string[];
  activities?: readonly ModelActivity[];
  description?: string;
  contextWindow?: number;
  contextSource?: MetadataSource;
  maxInput?: TokenLimit;
  officialContext?: TokenLimit;
  maxTokens?: number;
  supportVision: boolean;
  supportTools: boolean;
  reasoning?: {
    supports: boolean;
    supportedEfforts: readonly string[];
    canDisableThinking: boolean;
  };
  input: readonly string[];
  output: readonly string[];
  status: 'available' | 'unavailable' | 'unknown';
}

/**
 * CN 静态兜底目录——从 WorkBuddy 5.6+ CN 实测拿到的「已确认可调用」模型名单。
 * refresh 失败时至少给用户渲染一张。
 */
export const FALLBACK_WORKBUDDY_MODELS_CN: readonly WorkBuddyModelInfo[] = [
  { id: 'DeepSeek-V4-Flash-Official', displayName: 'DeepSeek-V4-Flash', contextWindow: 200_000, supportVision: false, supportTools: true, input: ['text'], output: ['text'], status: 'available' },
  { id: 'DeepSeek-V4-Pro-Official', displayName: 'DeepSeek-V4-Pro', contextWindow: 200_000, supportVision: false, supportTools: true, input: ['text'], output: ['text'], status: 'available' },
  { id: 'glm-5.3', displayName: 'GLM-5.3', contextWindow: 200_000, supportVision: false, supportTools: true, input: ['text'], output: ['text'], status: 'available' },
  { id: 'kimi-k3', displayName: 'Kimi-K3', contextWindow: 200_000, supportVision: false, supportTools: true, input: ['text'], output: ['text'], status: 'available' },
  { id: 'Hy3', displayName: 'Hy3', contextWindow: 200_000, supportVision: false, supportTools: true, input: ['text'], output: ['text'], status: 'available' },
];

export function fallbackModelsFor(variant: WorkBuddyVariant): readonly WorkBuddyModelInfo[] {
  // MVP 只实装 CN；Global 在 Phase 2+ 加目录。
  return variant === 'global' ? [] : FALLBACK_WORKBUDDY_MODELS_CN;
}

export class WorkBuddyCatalog {
  private models: readonly WorkBuddyModelInfo[];

  constructor(variant: WorkBuddyVariant = 'cn') {
    this.models = fallbackModelsFor(variant);
  }

  current(): readonly WorkBuddyModelInfo[] {
    return this.models;
  }

  set(models: readonly WorkBuddyModelInfo[]): void {
    if (models.length === 0) {
      throw new Error('workbuddy model catalog cannot be empty');
    }
    this.models = models.map((m) => structuredClone(m));
  }
}
