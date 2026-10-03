// WorkBuddy reasoning effort 翻译矩阵（端口 spec §2.2.6 + dsh-workbuddy-connect/
// adapter.ts:224-258 + upstream.ts:67-78 / 81 / 192 / 1327-1329）。
//
// 翻译优先级（端口 spec §2.2.6 #1-#5）：
//   1. supports !== true  → reasoning: false
//   2. declared efforts:
//      - 非空 → 用 declared；`off` 仅当 canDisableThinking=true 时填
//      - 空 → 看 observed（validation==='validating' 且 efforts 非空）才用
//   3. minimal 永远是 null（上游词表约束）
//   4. low/medium/high/xhigh/max 按 declared/observed 填
//   5. Global endpoint 对 `off` 删字段（CN 端不删）
//
// AccessMux router 看到的 ReasoningFieldMap 是 adapter 输出；外部传入
// `OpenAI reasoning_effort` 字符串，adapter 内查表映射到上游 wire effort。

export const WORKBUDDY_REASONING_EFFORTS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type WorkBuddyReasoningEffort = typeof WORKBUDDY_REASONING_EFFORTS[number];

/** 在 router 暴露给宿主的档位集合（去掉 minimal：上游词表约束）。 */
export const WORKBUDDY_PUBLIC_EFFORTS: readonly WorkBuddyReasoningEffort[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];

export interface ReasoningCapabilityObservation {
  /** 来自上游模型目录的 declared 字段。 */
  supports: boolean;
  supportedEfforts?: readonly string[];
  canDisableThinking?: boolean;
  /** probe 三段协议观察（端口 spec §4.3.2 + §2.2.6）。 */
  observed?: {
    validation?: 'validating' | 'valid' | 'invalid';
    efforts?: readonly string[];
  };
}

/** router 暴露的统一 ReasoningFieldMap 形状（端口 spec §5.2 Candidate.reasoningFields）。 */
export interface ReasoningFieldMap {
  reasoning: boolean;
  /** 上游词表里可选的 effort；off 仅在 canDisableThinking=true 时填。 */
  supported: readonly WorkBuddyReasoningEffort[];
  /** 默认 effort；可空（让 router 自行挑）。 */
  defaultEffort?: WorkBuddyReasoningEffort;
  /** 当前选中的 effort；getter 由 router 维护，翻译矩阵只填 supported。 */
  effort?: WorkBuddyReasoningEffort;
}

function normaliseEffort(value: unknown): WorkBuddyReasoningEffort | undefined {
  if (typeof value !== 'string') return undefined;
  const lowered = value.trim().toLowerCase();
  return (WORKBUDDY_REASONING_EFFORTS as readonly string[]).includes(lowered)
    ? (lowered as WorkBuddyReasoningEffort)
    : undefined;
}

/**
 * 把 capability 翻译到 router 抽象。`reasoning` 仅在 supports=true 时开。
 */
export function workBuddyReasoningFields(cap: ReasoningCapabilityObservation): ReasoningFieldMap {
  if (cap.supports !== true) return { reasoning: false, supported: [] };
  const declared = Array.isArray(cap.supportedEfforts)
    ? cap.supportedEfforts.map(normaliseEffort).filter((v): v is WorkBuddyReasoningEffort => v !== undefined)
    : [];
  const observed = cap.observed?.validation === 'validating' && Array.isArray(cap.observed.efforts)
    ? cap.observed.efforts.map(normaliseEffort).filter((v): v is WorkBuddyReasoningEffort => v !== undefined)
    : [];
  const source = declared.length > 0 ? declared : observed;
  const allowed = source.filter((effort) => effort !== 'minimal' && (effort !== 'off' || cap.canDisableThinking === true));
  if (cap.canDisableThinking === true && !allowed.includes('off')) {
    return { reasoning: true, supported: ['off', ...allowed] };
  }
  return { reasoning: true, supported: allowed };
}

/**
 * Global endpoint 对 `off` 删字段（端口 spec §2.2.6 #5）。
 * CN 端保留 `off`；调用方按 variant 决定是否跑这一步。
 */
export function dropUnsupportedEffortForInternational(
  body: Record<string, unknown>,
  supported: readonly WorkBuddyReasoningEffort[],
): Record<string, unknown> {
  const effort = body['reasoning_effort'];
  if (typeof effort !== 'string') return body;
  const lowered = effort.toLowerCase() as WorkBuddyReasoningEffort;
  if (lowered === 'off' && !supported.includes('off')) {
    const next = { ...body };
    delete next['reasoning_effort'];
    return next;
  }
  return body;
}
