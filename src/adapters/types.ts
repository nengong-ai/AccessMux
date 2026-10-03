// Upstream Adapter 核心接口（is-bo ProviderAdapter 4 元 + FeiZhuLulu Quota，报告 §12 #6/#17）。
// 每个桥接源一个目录实现本接口；凭据处理不得离开该 adapter 目录（D4）。

import type { ChatCompletionChunk, ChatMessage, ModelInfo, QuotaState } from '../types.js';

/** 沙箱等级如实上报，不夸大 */
export type SandboxKind = 'enforced' | 'behavioural' | 'none';

export type ModelAvailability = 'available' | 'unavailable' | 'unverified';

export interface ProbeResult {
  availability: ModelAvailability;
  models: ModelInfo[];
  /** 登录态描述；严禁包含凭据本体 */
  auth?: 'logged-in' | 'logged-out' | 'unknown';
  /** 目录来处；fallback 不代表可用清单。 */
  catalogSource?: 'current' | 'cache' | 'fallback';
  /** 本次检测的公开原因码，不得包含原始错误或凭据。 */
  reasonCode?: 'not-installed' | 'not-logged-in' | 'credential-unavailable' | 'catalog-unavailable' | 'catalog-fallback' | 'directory-ready' | 'login-unverified';
  observedAt?: string;
}

export interface LaunchContext {
  signal?: AbortSignal;
  /** 进程内随机 secret（shim 双层认证用），永不出本进程 */
  localSecret: string;
}

/** 只控制目录采集；不改变模型启用、宿主配置、签到或推理。 */
export interface ProbeContext {
  signal?: AbortSignal;
  forceRefresh?: boolean;
}

export interface TurnInput {
  signal?: AbortSignal;
  model: string;
  messages: ChatMessage[];
  stream: boolean;
}

export interface ProviderSession {
  runTurn(input: TurnInput): AsyncIterable<ChatCompletionChunk>;
  cancel(): Promise<void>;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly sandbox: SandboxKind;
  /**
   * T036：该源的桥接图片路径是否已点亮（协议层收图归一 → 源报文塑形 →
   * 真机图片往返验证，答出图中标记才算）。未声明/undefined = 未点亮，
   * 带图请求在协议层被 400 拒绝；UI/模型目录据此亮 supportsImages。
   * 模型级还须 catalog 的 inputModalities 含 image 才亮标，不虚标。
   */
  readonly bridgeImages?: boolean;

  /** 探测登录态与模型清单（catalog 层会缓存结果） */
  probe(ctx?: ProbeContext): Promise<ProbeResult>;
  /** 建立会话；LockedUsage 适配器在此启动/连接自己的 shim */
  launch(ctx: LaunchContext): Promise<ProviderSession>;
  fetchQuota(ctx?: Pick<ProbeContext, 'signal'>): Promise<QuotaState>;
  dispose(): Promise<void>;
}

/**
 * T036 兜底：未点亮图片的源在 adapter 侧收到带图消息时明确抛错，
 * 防止内部调用绕过协议层门禁后把 images 字段静默序列化丢给上游。
 */
export function rejectTurnImages(adapterId: string, messages: readonly import('../types.js').ChatMessage[]): void {
  if (messages.some((m) => (m.images?.length ?? 0) > 0)) {
    throw new Error(`${adapterId} 源暂不支持图片输入（T036 未点亮）：拒绝带图请求以避免静默丢图`);
  }
}

/** adapter 尚未实现时抛出；协议层映射为 501 */
export class AdapterNotImplementedError extends Error {
  constructor(adapterId: string, taskId: string) {
    super(`adapter ${adapterId} 尚未实现，实现任务见 tasks/${taskId}.md`);
    this.name = 'AdapterNotImplementedError';
  }
}
