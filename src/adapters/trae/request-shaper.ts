// 把 OpenAI 形状的 chat completion 请求体转成 Trae `llm_utils_chat` envelope。
// （端口 spec §3.3 + 协议事实）。
//
// llm_utils_chat 不是 OpenAI 兼容端点。证据化的 envelope 必须显式构造，
// 防止 OpenAI 客户端的 temperature / max_tokens / tool_choice / response_format
// 等可选字段在任意 model 下都触发 400。
//
// 关键转换：
// - developer role → system（DSH/某些客户端把 system prompt 写成 developer）
// - message.content 字符串 → content: [{type:'text', text}] 数组
// - tool_calls[].function → tool_calls[].function_call（Trae 命名）
// - tools[].function.parameters JSON.stringify
// - 默认 stream: true / function: solo_work_lite（可选被 bridge 覆写）
// - 默认 model & config_name 一致；用户期望 display id 与 wire id 同名时

const DEFAULT_MODEL = 'glm-5.2';

export interface PrepareSoloBodyOptions {
  /** directory function 覆写（来自 bridge 的 wire map）。 */
  functionName?: string;
  /** 默认 model。 */
  defaultModel?: string;
}

/**
 * 把 OpenAI 形状的请求 JSON 字符串转成 Trae envelope JSON 字符串。
 * 输入不是合法 JSON 时直接抛错（shim 已经先做过 JSON.parse）。
 */
export function prepareSoloBody(source: string, options: PrepareSoloBodyOptions = {}): string {
  const input = JSON.parse(source) as Record<string, unknown>;
  const defaultModel = options.defaultModel ?? DEFAULT_MODEL;
  const requestedModel = typeof input['model'] === 'string' && input['model'].trim() !== ''
    ? input['model'].trim()
    : defaultModel;
  const body: Record<string, unknown> = {
    ...(Array.isArray(input['messages']) ? { messages: input['messages'] } : {}),
    model: requestedModel,
    config_name: requestedModel,
    function: typeof input['function'] === 'string' && input['function'] !== ''
      ? input['function']
      : (options.functionName ?? 'solo_work_lite'),
    stream: true,
    ...(Array.isArray(input['tools']) ? { tools: input['tools'] } : {}),
    ...(typeof input['reasoning_effort'] === 'string' ? { reasoning_effort: input['reasoning_effort'] } : {}),
  };
  if (Array.isArray(body['messages'])) {
    for (const raw of body['messages']) {
      if (typeof raw !== 'object' || raw === null) continue;
      const m = raw as Record<string, unknown>;
      if (m['role'] === 'developer') m['role'] = 'system';
      if (typeof m['content'] === 'string') m['content'] = [{ type: 'text', text: m['content'] }];
      if (m['role'] === 'assistant' && Array.isArray(m['tool_calls'])) {
        for (const rawCall of m['tool_calls']) {
          if (typeof rawCall !== 'object' || rawCall === null) continue;
          const call = rawCall as Record<string, unknown>;
          if (typeof call['function'] === 'object' && call['function'] !== null) {
            call['function_call'] = call['function'];
            delete call['function'];
          }
        }
      }
      if (m['role'] === 'tool') {
        if (typeof m['tool_call_id'] !== 'string' || m['tool_call_id'] === '') {
          throw new Error('Trae SOLO tool message requires tool_call_id');
        }
      }
    }
  }
  if (Array.isArray(body['tools'])) {
    for (const raw of body['tools']) {
      if (typeof raw !== 'object' || raw === null) continue;
      const fn = (raw as Record<string, unknown>)['function'];
      if (typeof fn !== 'object' || fn === null) continue;
      const record = fn as Record<string, unknown>;
      if (typeof record['parameters'] === 'object' && record['parameters'] !== null) {
        record['parameters'] = JSON.stringify(record['parameters']);
      }
    }
  }
  return JSON.stringify(body);
}