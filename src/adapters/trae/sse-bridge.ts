// 把 Trae 上游的 named SSE 翻译成 OpenAI chat-completion SSE chunk（端口 spec §3.3）。
//
// Trae 命名事件（progress_notice / output / token_usage / done / [DONE]）→
// OpenAI 命名（chat.completion.chunk with delta content / reasoning_content / usage）。
//
// 特殊语义：
// - reasoning → reasoning_content（OpenAI 风格外露在 delta 里）
// - tool_calls[].function → tool_calls[].function_call（命名同 request-shaper）
// - cache_read_input_tokens / cache_creation_input_tokens →
//   prompt_tokens_details.cached_tokens / cache_write_tokens（OpenAI 约定）
// - 收到 400x 错误事件时立刻 error() controller，而不是继续走完形成空响应
// - [DONE] 与 done 事件可能都来，只发一次 finish chunk（pi-ai 要非 null finish_reason）
// - 缺少明确 done 的 EOF 是截断失败，绝不合成成功终帧

import { SseDecoder, decodeTraeEvent } from '../../protocol/sse.js';

class TraeStreamError extends Error {}

interface OpenAIToolCallDelta {
  index: number;
  id?: string;
  type?: 'function';
  function?: { name?: string; arguments?: string };
}

function normalizeToolCalls(value: unknown): OpenAIToolCallDelta[] {
  if (!Array.isArray(value)) return [];
  const calls: OpenAIToolCallDelta[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const rawFunction = typeof record['function_call'] === 'object' && record['function_call'] !== null
      ? record['function_call'] as Record<string, unknown>
      : typeof record['function'] === 'object' && record['function'] !== null
        ? record['function'] as Record<string, unknown>
        : {};
    const fn = {
      ...(typeof rawFunction['name'] === 'string' ? { name: rawFunction['name'] } : {}),
      ...(typeof rawFunction['arguments'] === 'string' ? { arguments: rawFunction['arguments'] } : {}),
    };
    calls.push({
      index: typeof record['index'] === 'number' ? record['index'] : calls.length,
      ...(typeof record['id'] === 'string' ? { id: record['id'] } : {}),
      ...(record['type'] === 'function' ? { type: 'function' as const } : {}),
      ...(Object.keys(fn).length === 0 ? {} : { function: fn }),
    });
  }
  return calls;
}

/** 把 Trae 上游 Response 转成 OpenAI 形状的 SSE Response。 */
export function bridgeTraeSoloStream(response: Response, model: string): Response {
  const source = response.body;
  if (source === null) return new Response(null, { status: 502 });
  const id = `chatcmpl-${Math.random().toString(36).slice(2, 14)}`;
  const created = Math.floor(Date.now() / 1000);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const sse = new SseDecoder();
  let sawToolCalls = false;
  let emittedFinishReason = false;
  let finishReason = 'stop';
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelled = false;
  let usage: Record<string, number | Record<string, number>> | undefined;

  const chunk = (delta: Record<string, unknown>, finishReason: string | null = null): Uint8Array =>
    encoder.encode(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
        ...(usage === undefined ? {} : { usage }),
      })}\n\n`,
    );

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      reader = source.getReader();
      const consume = (event: ReturnType<SseDecoder['push']>[number]): void => {
        let payload: unknown;
        if (event.data.trim() !== '[DONE]') {
          try { payload = JSON.parse(event.data); } catch { throw new TraeStreamError('Trae upstream sent malformed SSE JSON'); }
        }
        const record = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : undefined;
        const code = record?.['code'];
        if (event.event === 'error' || (record?.['error'] !== undefined && record['error'] !== null) || (typeof code === 'number' && code >= 4000)) {
          throw new TraeStreamError('Trae upstream SSE error');
        }
        const decoded = decodeTraeEvent(event);
        if (decoded.type === 'unknown') return;
        if (decoded.type === 'delta') {
          const delta: Record<string, unknown> = {};
          if (decoded.text !== '') delta['content'] = decoded.text;
          if (decoded.reasoning !== undefined && decoded.reasoning !== '') delta['reasoning_content'] = decoded.reasoning;
          const toolCalls = normalizeToolCalls(decoded.toolCalls);
          if (toolCalls.length > 0) {
            sawToolCalls = true;
            delta['tool_calls'] = toolCalls;
          }
          if (Object.keys(delta).length > 0) controller.enqueue(chunk(delta));
        } else if (decoded.type === 'usage') {
          const cacheRead = decoded.cacheReadTokens;
          const cacheWrite = decoded.cacheWriteTokens;
          const details = {
            ...(cacheRead === undefined ? {} : { cached_tokens: cacheRead }),
            ...(cacheWrite === undefined ? {} : { cache_write_tokens: cacheWrite }),
          };
          usage = {
            ...(decoded.inputTokens === undefined ? {} : { prompt_tokens: decoded.inputTokens }),
            ...(decoded.outputTokens === undefined ? {} : { completion_tokens: decoded.outputTokens }),
            ...(decoded.totalTokens === undefined ? {} : { total_tokens: decoded.totalTokens }),
            ...(Object.keys(details).length === 0 ? {} : { prompt_tokens_details: details }),
          };
        } else if (decoded.type === 'done') {
          emittedFinishReason = true;
          finishReason = decoded.finishReason || 'stop';
        }
      };
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          for (const event of sse.push(decoder.decode(next.value, { stream: true }))) consume(event);
        }
        for (const event of [...sse.push(decoder.decode()), ...sse.finish()]) consume(event);
        if (cancelled) return;
        if (!emittedFinishReason) throw new TraeStreamError('Trae upstream stream ended without done');
        controller.enqueue(chunk({}, sawToolCalls ? 'tool_calls' : finishReason));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (error) {
        if (!cancelled) controller.error(new Error(error instanceof TraeStreamError ? error.message : 'Trae upstream stream transport failed'));
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    },
    cancel(reason) {
      cancelled = true;
      return reader?.cancel(reason);
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}