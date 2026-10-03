import { abortable, abortableDelay } from '../../util/abort.js';
// ZCode 直连形态客户端（T019 主形态，D23/R017 §1.3.2 合同）。
//
// POST {origin}/api/v1/zcode-plan/anthropic/v1/messages，最小三头
// （Authorization: Bearer <jwt> / anthropic-version / content-type——其余头
// 全部可省，R017 §5.3）；body.system 首块 = 官方 harness 前缀常量，宿主侧
// system 追加为后续块（前缀后追加任意内容合法，R017 §5.1）。
// 对话历史折叠成单条 user 消息（chat-only MVP，与 opencode/qoder 同语义，
// 宿主每请求带全量 messages，桥接侧不攒上下文）。

import type { ChatCompletionChunk, ChatMessage, ImagePart, TurnUsage } from '../../types.js';
import { normalizeAnthropicUsage } from '../../usage.js';
import { OFFICIAL_HARNESS_PREFIX } from './prefix.js';
import { classifyUpstreamResponse, ZcodeUpstreamError } from './error-classify.js';
import { zcodeMessagesUrl } from './endpoints.js';
import { SseDecoder } from '../../protocol/sse.js';
import { redactLogText } from '../../util/redact.js';

/** 直连请求的默认 max_tokens（R017 §5.5：大值兼容；MVP 固定）。 */
export const DIRECT_MAX_TOKENS = 8192;

export interface DirectTurnDeps {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  /** 取消信号（session.cancel 透传）。 */
  signal?: AbortSignal;
  log?: (line: string) => void;
  /** 429 自动重试次数上限（默认 1；测试可关）。 */
  rateLimitRetries?: number;
  retryDelayMs?: number;
}

export interface DirectTurnInput {
  model: string;
  messages: ChatMessage[];
  stream: boolean;
  jwt: string;
}

/** system 块形状：官方请求也是分块数组（块边界不敏感，拼接字节串才是门槛）。 */
export interface AnthropicSystemBlock {
  type: 'text';
  text: string;
}

/**
 * 折叠宿主消息：system 消息合并为前缀后的追加块，其余折叠成单条 user 文本；
 * T036 起各消息携带的图片（ChatMessage.images）单独收集，由 buildDirectBody
 * 按 Anthropic image block 塑形（文本在前、图片追加在后）。
 */
export function foldForDirect(messages: readonly ChatMessage[]): {
  system: AnthropicSystemBlock[];
  text: string;
  images: ImagePart[];
} {
  const systemParts = messages.filter((m) => m.role === 'system').map((m) => m.content);
  const rest = messages.filter((m) => m.role !== 'system');
  let text: string;
  if (rest.length === 1 && rest[0]?.role === 'user') {
    text = rest[0].content;
  } else if (rest.length === 0) {
    text = '';
  } else {
    text = rest.map((m) => `${m.role}:\n${m.content}`).join('\n\n');
  }
  const images = rest.flatMap((m) => m.images ?? []);
  const system: AnthropicSystemBlock[] = [{ type: 'text', text: OFFICIAL_HARNESS_PREFIX }];
  if (systemParts.length > 0) {
    system.push({ type: 'text', text: systemParts.join('\n\n') });
  }
  return { system, text, images };
}

export function buildDirectBody(input: DirectTurnInput): Record<string, unknown> {
  const folded = foldForDirect(input.messages);
  // 无图请求保持纯字符串 content（与 T019 起直连报文字节一致）；带图请求
  // 升级为标准 Anthropic content blocks——image block 走 base64 source。
  const content = folded.images.length === 0
    ? folded.text
    : [
        ...(folded.text === '' ? [] : [{ type: 'text', text: folded.text }]),
        ...folded.images.map((image) => ({
          type: 'image',
          source: { type: 'base64', media_type: image.mediaType, data: image.data },
        })),
      ];
  return {
    model: input.model,
    max_tokens: DIRECT_MAX_TOKENS,
    system: folded.system,
    messages: [{ role: 'user', content }],
    stream: input.stream,
  };
}

async function readResponseAsJson(response: Response, signal?: AbortSignal): Promise<unknown> {
  const text = await abortable(response.text(), signal);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

interface SseEvent {
  event?: string;
  data: string;
}

/** 极简 SSE 帧解析：只取 data: 行（anthropic 事件类型在 data JSON 的 type 字段里）。 */
export function parseSseFrame(block: string): SseEvent | undefined {
  let data = '';
  let eventName: string | undefined;
  let sawData = false;
  for (const line of block.split('\n')) {
    if (line.startsWith('data:')) {
      data += (sawData ? '\n' : '') + line.slice(5).trimStart();
      sawData = true;
    } else if (line.startsWith('event:')) {
      eventName = line.slice(6).trim();
    }
  }
  if (!sawData) return undefined;
  return { event: eventName, data };
}

/** 从流式/非流式响应提取文本增量（流式）或整段文本（非流式）。 */
export async function* directTurn(
  input: DirectTurnInput,
  deps: DirectTurnDeps = {},
): AsyncGenerator<ChatCompletionChunk> {
  const doFetch = deps.fetchImpl ?? fetch;
  const url = zcodeMessagesUrl(deps.env);
  const body = JSON.stringify(buildDirectBody(input));
  const maxRetries = deps.rateLimitRetries ?? 1;
  const retryDelayMs = deps.retryDelayMs ?? 1200;

  let response: Response | undefined;
  for (let attempt = 0; ; attempt += 1) {
    deps.signal?.throwIfAborted();
    response = await abortable(doFetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.jwt}`,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body,
      signal: deps.signal,
    }), deps.signal);
    // 只在零输出的前提下自动重试 429（限流是间歇性的，R014 §4.5）
    if (response.status === 429 && attempt < maxRetries) {
      deps.log?.(`[zcode-direct] HTTP 429，${retryDelayMs}ms 后重试（${attempt + 1}/${maxRetries}）`);
      await abortableDelay(retryDelayMs, deps.signal);
      continue;
    }
    break;
  }

  const finalResponse = response as Response;
  if (!finalResponse.ok) {
    throw classifyUpstreamResponse({
      status: finalResponse.status,
      body: await readResponseAsJson(finalResponse, deps.signal),
    });
  }

  if (!input.stream) {
    const json = (await readResponseAsJson(finalResponse, deps.signal)) as {
      content?: Array<{ type?: string; text?: string }>;
      type?: string;
      usage?: unknown;
      error?: { message?: string };
    };
    if (json !== null && typeof json === 'object' && json.type === 'error') {
      throw new ZcodeUpstreamError(
        'upstream',
        `ZCode 上游流内错误：${redactLogText(json.error?.message ?? '未知', 300, [input.jwt])}`,
      );
    }
    const text = (json.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');
    if (text === '') throw new Error('zcode 直连：模型没有返回文本');
    const usage = normalizeAnthropicUsage(json.usage);
    yield { delta: text, done: false };
    yield { delta: '', done: true, ...(usage === undefined ? {} : { usage }) };
    return;
  }

  if (finalResponse.body === null) {
    throw new Error('zcode 直连：流式响应无 body');
  }
  const reader = finalResponse.body.getReader();
  const decoder = new TextDecoder();
  const sse = new SseDecoder();
  let sawText = false;
  let sawStop = false;
  // T023：Anthropic 形状的用量——输入在 message_start.message.usage，
  // 输出在收尾的 message_delta.usage（累计值），两处合起来才是一条完整回合用量。
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;
  let details: Record<string, number> = {};
  const mergeUsage = (raw: unknown): void => {
    if (typeof raw !== 'object' || raw === null) return;
    const record = raw as Record<string, unknown>;
    const input = record['input_tokens'];
    const output = record['output_tokens'];
    if (typeof input === 'number' && Number.isFinite(input)) promptTokens = input;
    if (typeof output === 'number' && Number.isFinite(output)) completionTokens = output;
    const parsed = normalizeAnthropicUsage(raw);
    if (parsed?.prompt_tokens_details !== undefined) {
      details = { ...details, ...parsed.prompt_tokens_details };
    }
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      const frames = done
        ? [...sse.push(decoder.decode()), ...sse.finish()]
        : sse.push(decoder.decode(value, { stream: true }));
      for (const frame of frames) {
        if (frame.data === '[DONE]') continue;
        let event: {
          type?: string;
          delta?: { type?: string; text?: string };
          usage?: unknown;
          message?: { usage?: unknown };
          error?: { message?: string };
        };
        try {
          event = JSON.parse(frame.data) as typeof event;
        } catch {
          throw new Error('zcode 直连：SSE data 不是合法 JSON（截断或协议错误）');
        }
        if (event === null || typeof event !== 'object') throw new Error('zcode 直连：SSE 事件形状错误');
        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          const text = event.delta.text ?? '';
          if (text !== '') {
            sawText = true;
            yield { delta: text, done: false };
          }
        } else if (event.type === 'message_start') {
          mergeUsage(event.message?.usage);
        } else if (event.type === 'message_delta') {
          mergeUsage(event.usage);
        } else if (event.type === 'message_stop') {
          sawStop = true;
        } else if (event.type === 'error' || frame.event === 'error') {
          throw new ZcodeUpstreamError(
            'upstream',
            `ZCode 上游流内错误：${redactLogText(event.error?.message ?? '未知', 300, [input.jwt])}`,
          );
        }
      }
      if (sawStop || done) break;
    }
  } finally {
    // 错误、取消或提前完成均关闭底层流，不能只 releaseLock 留网络工作。
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  if (!sawStop) throw new Error('zcode 直连：SSE 在 message_stop 前结束（响应截断）');
  if (!sawText) throw new Error('zcode 直连：流式响应没有文本增量');
  const usage: TurnUsage | undefined =
    promptTokens === undefined && completionTokens === undefined
      ? undefined
      : {
          prompt_tokens: promptTokens ?? 0,
          completion_tokens: completionTokens ?? 0,
          total_tokens: (promptTokens ?? 0) + (completionTokens ?? 0),
          ...(Object.keys(details).length === 0 ? {} : { prompt_tokens_details: details }),
        };
  yield { delta: '', done: true, ...(usage === undefined ? {} : { usage }) };
}
