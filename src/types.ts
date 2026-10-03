// 共享领域类型。接口与分层约定见 docs/architecture.md。

/** 配额状态（FeiZhuLulu Quota 注册表口径） */
export type QuotaState = 'ok' | 'exhausted' | 'unknown';

/** 元数据来源只供刷新比对和数据检查，卡片不渲染来源标注。 */
export interface MetadataSource {
  kind: 'platform' | 'official-spec';
  reference: string;
  field: string;
  updated_at: string;
  region?: string;
  entitlement?: string;
}

export interface TokenLimit {
  value: number;
  source: MetadataSource;
}

export interface ModelActivity {
  label: string;
  kind?: 'free' | 'discount' | 'other';
  scheduleMeaning?: 'benefit' | 'label';
  starts_at?: string;
  ends_at?: string;
  timezone?: string;
  daily?: Array<{ start: string; end: string }>;
  windows?: Array<{ weekdays: number[]; start_minute: number; end_minute: number }>;
  region?: string;
  entitlement?: string;
  source?: MetadataSource;
}

/** 上游额度倍率的动态快照，不是货币价格或永久免费承诺。 */
export interface PriceMultiplier {
  value: number;
  current: boolean;
  updated_at: string;
  source: MetadataSource;
  activity?: ModelActivity;
}

export interface ModelMetadata {
  /** 上游展示名；不作为请求路由键。 */
  name?: string;
  /** 上游额度消耗倍率，不是货币价格。 */
  priceMultiplier?: number | PriceMultiplier;
  /** 公开目录保留旧的数字字段，同时用此列携带快照。 */
  priceSnapshot?: PriceMultiplier;
  free?: boolean;
  freeSource?: MetadataSource;
  freeActivity?: ModelActivity;
  /** 费用字段的采集新鲜度；与模型目录、登录态分开。 */
  feeFreshness?: 'fresh' | 'stale' | 'failed' | 'unknown';
  feeCheckedAt?: string;
  feeErrorCode?: 'timeout' | 'unavailable' | 'fetch-failed' | 'not-confirmed';
  /** 只代表调用已验证，与费用、目录可用性无关。 */
  callVerified?: boolean;
  /** entitlement 表示当前账号权益内免费，而非模型永久免费。 */
  priceScope?: 'model' | 'entitlement';
  activityLabels?: string[];
  activities?: ModelActivity[];
  description?: string;
  reasoning?: {
    supported?: boolean;
    supportedEfforts?: string[];
    canDisableThinking?: boolean;
  };
  /** 上游能力；桥接协议实际开放的模态另行标注。 */
  inputModalities?: Array<'text' | 'image'>;
  iconUrl?: string;
}

export interface ModelInfo extends ModelMetadata {
  /** 展示 id：宿主在 /v1/models 与请求里看到的模型名 */
  id: string;
  /** 所属 adapter id */
  provider: string;
  /** 能力标签，如 ['coding','chat'] */
  tags?: string[];
  /** 上下文窗口（token），未知不填 */
  minCtx?: number | TokenLimit;
  /** 最大输入长度独立保存，不能代替上下文窗口。 */
  maxInput?: TokenLimit;
  /** 厂商公布规格独立保存；平台窗口优先用于 minCtx。 */
  officialContext?: TokenLimit;
}

/**
 * 桥接内图片部件（T036）。协议层把 OpenAI image_url / Anthropic image block
 * 归一成这个形态：mediaType 限四种 Anthropic 兼容类型，data 为不带 data: 前缀的
 * 纯 base64。上限与校验在 src/protocol/images.ts（入口处拦截，不进 adapter）。
 */
export interface ImagePart {
  type: 'image';
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  data: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /**
   * T036：本条消息携带的图片（语义上追加在文本之后）。仅图片路径已点亮的
   * adapter 消费；协议层在进入 adapter 前按源能力门禁，未点亮源的 adapter
   * 侧还有显式拒绝兜底（宁可报错不静默丢图）。
   */
  images?: ImagePart[];
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
}

/**
 * 一个回合的 token 用量（T023）。
 * 口径：能拿上游真数就原样透传；上游不计量时本地估算，且必须带 `estimated: true`。
 * 绝不用估算冒充真数（协议层据此决定是否加标识）。
 */
export interface TurnUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** 非标准扩展字段：true = 本地分词估算值，不是上游真数。标准宿主忽略未知字段。 */
  estimated?: true;
  /** 上游附带的输入侧明细（如 cached_tokens），原样透传，不做二次解释。 */
  prompt_tokens_details?: Record<string, number>;
  /** 上游附带的生成侧明细（如 reasoning_tokens），原样透传。 */
  completion_tokens_details?: Record<string, number>;
}

/** runTurn 的流式增量 */
export interface ChatCompletionChunk {
  delta: string;
  done: boolean;
  /**
   * 本回合用量；adapter 拿到后挂在终帧（done=true）上。
   * 缺省 = 本回合没采集到（不伪造 0，由协议层决定是否回落估算）。
   */
  usage?: TurnUsage;
}
