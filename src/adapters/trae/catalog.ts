// Trae 模型目录抽象（端口 spec §3.2.6 + §4.3.3）。
//
// 每 region 独立的 in-memory 快照；首次构造时填入"区域静态兜底"（来自 live
// `coresg-normal.trae.ai/api/remote/v1/models` 与 solo.trae.cn 的实测），首
// 次 live refresh 命中后由 set() 替换。空目录被拒绝（防止把 provider 整个
// 弄下线）。

import type { TraeRegion } from './region.js';
import type { TraeCatalogMetadata, TraeInputModality } from './merge-sources.js';

export interface TraeModelInfo extends TraeCatalogMetadata {
  id: string;
  name: string;
  contextWindow?: number;
  maxTokens?: number;
  input?: TraeInputModality[];
  creditMultiplier?: number;
  reasoningSupported?: boolean;
  reasoning?: { supported: readonly string[] };
  /**
   * `llm_utils_chat` 真正接受的 wire id。undefined 表示 id 本身就是 wire id。
   */
  wireConfigName?: string;
  /** 列出此 model 的 directory function；chat 时需回放。 */
  wireFunction?: string;
  /**
   * Trae 自己声明的多模态能力（来自 remote 目录）。`input` 是最终开放给宿主
   * 的形态，由 applyImageSelection 合并 user opt-in 后决定。
   */
  multimodal?: boolean;
  maxContextWindow?: number;
}

/**
 * CN 静态兜底目录——来自 solo.trae.cn 实测 2026-09-15。
 * 每个 model 必须带 positive contextWindow，否则 router 会拒绝整 provider。
 */
export const FALLBACK_TRAE_MODELS_CN: readonly TraeModelInfo[] = [
  { id: 'DeepSeek-V4-Flash-Official', name: 'DeepSeek-V4-Flash', contextWindow: 200_000 },
  { id: 'DeepSeek-V4-Pro-Official', name: 'DeepSeek-V4-Pro', contextWindow: 200_000 },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 200_000 },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 200_000 },
];

/**
 * AI 静态兜底目录——来自 coresg-normal.trae.ai/api/remote/v1/models 实测。
 * 两 roster 几乎不重叠，国际账号不能 seed CN 列表，反之亦然。
 */
export const FALLBACK_TRAE_MODELS_AI: readonly TraeModelInfo[] = [
  { id: 'gemini-3.1-pro', name: 'Gemini-3.1-Pro-Preview', contextWindow: 200_000 },
  { id: 'gemini-3-flash-solo', name: 'Gemini-3-Flash-Preview', contextWindow: 200_000 },
  { id: 'minimax-m3', name: 'MiniMax-M3', contextWindow: 200_000 },
  { id: 'minimax-m2.7', name: 'MiniMax-M2.7', contextWindow: 200_000 },
  { id: 'kimi-k2.5', name: 'Kimi-K2.5', contextWindow: 200_000 },
  { id: 'gpt-5.4', name: 'GPT-5.4', contextWindow: 272_000 },
  { id: 'gpt-5.2', name: 'GPT-5.2', contextWindow: 272_000 },
];

export function fallbackModelsFor(region: TraeRegion): readonly TraeModelInfo[] {
  return region === 'ai' ? FALLBACK_TRAE_MODELS_AI : FALLBACK_TRAE_MODELS_CN;
}

/**
 * Trae 的 in-memory catalog 快照。
 * - `current()` 返回只读列表（shim 的 GET /v1/models 用）
 * - `set()` 替换快照（catalog refresh 后调）；空快照拒绝，避免把 provider
 *   整个挂掉
 * - `region` 只决定首构造时的静态兜底，不影响后续 set 的内容
 */
export class TraeCatalog {
  private models: readonly TraeModelInfo[];

  constructor(region: TraeRegion = 'cn') {
    this.models = fallbackModelsFor(region);
  }

  current(): readonly TraeModelInfo[] {
    return this.models;
  }

  set(models: readonly TraeModelInfo[]): void {
    if (models.length === 0) {
      throw new Error('trae model catalog cannot be empty');
    }
    this.models = models.map((m) => structuredClone(m));
  }
}
