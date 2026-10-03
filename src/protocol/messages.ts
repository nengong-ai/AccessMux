// Anthropic Messages 兼容端点的协议层：zod schema、请求↔内部 ChatMessage 转换、
// 响应组装、错误结构对齐 Anthropic 习惯。
//
// 状态码映射（与 /v1/chat/completions 保持一致）：
//   - 400 invalid_request_error：schema 不匹配、缺 max_tokens、图片归一/上限不合规、
//     非 text/image content block
//   - 404 not_found_error      ：未知模型（pickAdapterForModel 抛 NoProviderAvailable）
//   - 501 api_error            ：stream=true 或 adapter 未实现（AdapterNotImplementedError）
//
// 流式（SSE）实现留待 Phase 2；当前只服务非流式（MVP）。

import { z } from 'zod';
import type { ChatMessage, ImagePart, TurnUsage } from '../types.js';
import { AdapterNotImplementedError } from '../adapters/types.js';
import { NoProviderAvailable } from '../router/index.js';
import { redactLogText } from '../util/redact.js';
import { assertImageCount, imagePartFromBase64, imagePartFromUrl } from './images.js';

/* ---------- 请求 schema ---------- */

// Anthropic content block。T036 起接受 text 与 image（base64 / url 两种 source），
// 其余类型（tool_use / tool_result 等）仍被 zod 拒绝——明确报错不静默丢弃。
const textBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

const imageBlockSchema = z.object({
  type: z.literal('image'),
  source: z.discriminatedUnion('type', [
    z.object({ type: z.literal('base64'), media_type: z.string(), data: z.string() }),
    z.object({ type: z.literal('url'), url: z.string() }),
  ]),
});

const contentBlockSchema = z.discriminatedUnion('type', [
  textBlockSchema,
  imageBlockSchema,
  // 其他类型（tool_use / tool_result）留给 Phase 2；当前会被 zod 拒绝
]);

const messageContentSchema = z.union([z.string(), z.array(contentBlockSchema)]);

const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: messageContentSchema,
});

const systemContentSchema = z.union([z.string(), z.array(textBlockSchema)]);

export const anthropicMessagesRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(messageSchema).min(1),
  max_tokens: z.number().int().positive(),
  system: systemContentSchema.optional(),
  stop_sequences: z.array(z.string()).optional(),
  stream: z.boolean().optional(),
  // 下列字段接收但不在 MVP 中转发：temperature / top_p / top_k / metadata / tools / tool_choice
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  top_k: z.number().optional(),
  metadata: z.unknown().optional(),
  tools: z.array(z.unknown()).optional(),
  tool_choice: z.unknown().optional(),
});

export type AnthropicMessagesRequest = z.infer<typeof anthropicMessagesRequestSchema>;

/* ---------- 响应类型 ---------- */

export interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

export interface AnthropicUsage {
  /** 未命中缓存的输入 token（Anthropic 语义：缓存命中单列） */
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  /** 非标准扩展：true = 本地估算值（上游不计量），标准客户端忽略未知字段 */
  estimated?: true;
}

export interface AnthropicMessagesResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicTextBlock[];
  model: string;
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence';
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

export interface AnthropicErrorBody {
  type: 'error';
  error: {
    type:
      | 'invalid_request_error'
      | 'authentication_error'
      | 'permission_error'
      | 'not_found_error'
      | 'request_too_large'
      | 'rate_limit_error'
      | 'api_error'
      | 'overloaded_error';
    message: string;
  };
}

/* ---------- 转换：Anthropic request → 内部 ChatMessage[] ---------- */

function extractSystem(system: z.infer<typeof systemContentSchema>): string | undefined {
  if (typeof system === 'string') return system;
  const joined = system.map((b) => b.text).join('\n');
  return joined.length > 0 ? joined : undefined;
}

/**
 * 把 Anthropic Messages 请求里的 `system` 字段拼到 messages 数组最前面，
 * 并把每条 message 的 content 归一：text block 折叠为字符串，image block
 * （base64 直接解析 / url 代为下载）归一为 ImagePart 附着在该条消息上。
 * T036 起为 async（URL 图片需要网络拉取）；返回的 messages 适合直接喂给
 * ProviderSession.runTurn({ messages })。
 */
export async function toInternalMessages(
  req: AnthropicMessagesRequest,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<ChatMessage[]> {
  const out: ChatMessage[] = [];
  const sys = req.system ? extractSystem(req.system) : undefined;
  if (sys) out.push({ role: 'system', content: sys });
  for (const m of req.messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    let text = '';
    const images: ImagePart[] = [];
    for (const block of m.content) {
      if (block.type === 'text') {
        text += block.text;
        continue;
      }
      images.push(block.source.type === 'base64'
        ? imagePartFromBase64(block.source.data)
        : await imagePartFromUrl(block.source.url, { fetchImpl: opts.fetchImpl }));
    }
    out.push({ role: m.role, content: text, ...(images.length > 0 ? { images } : {}) });
  }
  assertImageCount(out.flatMap((m) => m.images ?? []));
  return out;
}

/* ---------- 响应组装 ---------- */

/**
 * TurnUsage（OpenAI 口径：prompt 含缓存命中）→ Anthropic usage 形状（T023）。
 * Anthropic 把缓存读/写单列且不计入 input_tokens，这里按同一语义拆回去，
 * 两边相加仍等于上游总量；估算标识 estimated 原样带出。
 */
export function toAnthropicUsage(usage: TurnUsage): AnthropicUsage {
  const cacheRead = usage.prompt_tokens_details?.['cached_tokens'] ?? 0;
  const cacheCreation = usage.prompt_tokens_details?.['cache_write_tokens'] ?? 0;
  return {
    input_tokens: Math.max(0, usage.prompt_tokens - cacheRead - cacheCreation),
    output_tokens: usage.completion_tokens,
    ...(cacheRead > 0 ? { cache_read_input_tokens: cacheRead } : {}),
    ...(cacheCreation > 0 ? { cache_creation_input_tokens: cacheCreation } : {}),
    ...(usage.estimated === true ? { estimated: true as const } : {}),
  };
}

export function buildAnthropicResponse(args: {
  model: string;
  text: string;
  stopReason?: AnthropicMessagesResponse['stop_reason'];
  usage?: TurnUsage;
}): AnthropicMessagesResponse {
  return {
    id: `msg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    type: 'message',
    role: 'assistant',
    content: args.text.length > 0 ? [{ type: 'text', text: args.text }] : [],
    model: args.model,
    stop_reason: args.stopReason ?? 'end_turn',
    stop_sequence: null,
    usage: args.usage === undefined
      ? { input_tokens: 0, output_tokens: 0 }
      : toAnthropicUsage(args.usage),
  };
}

/* ---------- 错误映射 ---------- */

export interface AnthropicErrorMapping {
  statusCode: number;
  body: AnthropicErrorBody;
}

/** 把 zod 校验失败统一映射为 400 invalid_request_error。 */
export function mapZodError(issues: z.ZodIssue[]): AnthropicErrorMapping {
  return {
    statusCode: 400,
    body: {
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: issues.map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`).join('; '),
      },
    },
  };
}

/** 把路由 / adapter 抛出的错误映射成 Anthropic 错误体。 */
export function mapInternalError(err: unknown, knownSecrets: readonly string[] = []): AnthropicErrorMapping {
  if (err instanceof NoProviderAvailable) {
    return {
      statusCode: 404,
      body: {
        type: 'error',
        error: { type: 'not_found_error', message: redactLogText(err.message, 300, knownSecrets) },
      },
    };
  }
  if (err instanceof AdapterNotImplementedError) {
    return {
      statusCode: 501,
      body: {
        type: 'error',
        error: {
          type: 'api_error',
          message: redactLogText(err.message, 300, knownSecrets),
        },
      },
    };
  }
  const message = redactLogText(err instanceof Error ? err.message : err, 300, knownSecrets);
  return {
    statusCode: 500,
    body: {
      type: 'error',
      error: { type: 'api_error', message },
    },
  };
}
