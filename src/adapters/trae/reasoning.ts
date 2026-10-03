// Trae 推理 effort 词汇表与解析（端口 spec §3.3 + 端口 spec §2.2.6 通用）。
//
// Trae 上游 `reasoning_effort_options` 限定 5 档；外层（OpenAI/Anthropic）也
// 用同一份词表，bridge.ts 处理 OpenAI ↔ Trae 档位映射。

export const TRAE_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type TraeReasoningEffort = typeof TRAE_REASONING_EFFORTS[number];

export interface TraeReasoningCapability {
  supported: readonly TraeReasoningEffort[];
  defaultEffort?: TraeReasoningEffort;
}

/**
 * 从上游 `config_info_list[].reasoning_effort_options` + `default_reasoning_effort`
 * 解析能力。仅保留词表内的 effort；default 仅当也支持时才填。
 */
export function parseReasoningCapability(value: unknown): TraeReasoningCapability | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const rawOptions = Array.isArray(record['reasoning_effort_options']) ? record['reasoning_effort_options'] : [];
  const supported = rawOptions.filter(
    (item): item is TraeReasoningEffort =>
      typeof item === 'string' && (TRAE_REASONING_EFFORTS as readonly string[]).includes(item),
  );
  const rawDefault = record['default_reasoning_effort'];
  const defaultEffort = typeof rawDefault === 'string' && supported.includes(rawDefault as TraeReasoningEffort)
    ? rawDefault as TraeReasoningEffort
    : undefined;
  if (supported.length === 0 && defaultEffort === undefined) return undefined;
  return { supported, ...(defaultEffort === undefined ? {} : { defaultEffort }) };
}

/**
 * 把 effort 写入请求体；只在能力表里包含该 effort 时写。否则抛
 * `Trae model does not advertise reasoning effort <effort>` 让上层在收到
 * 400 之前就短路。
 */
export function applyReasoningEffort<T extends Record<string, unknown>>(
  body: T,
  effort: TraeReasoningEffort | undefined,
  capability: TraeReasoningCapability | undefined,
): T & { reasoning_effort?: TraeReasoningEffort } {
  if (effort === undefined) return body;
  if (capability === undefined || !capability.supported.includes(effort)) {
    throw new Error(`Trae model does not advertise reasoning effort ${effort}`);
  }
  return { ...body, reasoning_effort: effort };
}