// SSE 解码器：从上游 text/event-stream 流里抽出事件。
// 通用实现，T002（T005 后续也会用）按 dsh-connect-trae/src/sse.ts 直接移植。
//
// 行为要点（与上游 dsh 对齐）：
// - 同时容忍 \n 与 \r\n 行结束
// - chunk 切到事件中间也正确处理（buffer 累积直到一行结束）
// - data 多行用 '\n' 拼成单个字符串
// - 注释行（首字符为 ':'）忽略
// - 事件之间 dispatch；data 为空的事件不发射

export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}

export type TraeStreamEvent =
  | { type: 'queue'; position?: number }
  | { type: 'progress'; notice: unknown }
  | { type: 'delta'; text: string; reasoning?: string; toolCalls?: unknown }
  | {
      type: 'usage';
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      reasoningTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    }
  | { type: 'done'; finishReason: string }
  | { type: 'unknown'; event?: string; data: unknown };

/** 增量 SSE 解码器，可被上游 fetch body 的 ReadableStream 多次 push(chunk) 喂入。 */
export class SseDecoder {
  private buffer = '';
  private event: string | undefined;
  private id: string | undefined;
  private retry: number | undefined;
  private data: string[] = [];

  push(chunk: string): SseEvent[] {
    this.buffer += chunk;
    const events: SseEvent[] = [];
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const match = /\r?\n/.exec(this.buffer);
      if (match === null || match.index === undefined) break;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const emitted = this.consumeLine(line);
      if (emitted !== undefined) events.push(emitted);
    }
    return events;
  }

  finish(): SseEvent[] {
    const events: SseEvent[] = [];
    if (this.buffer !== '') {
      const emitted = this.consumeLine(this.buffer);
      this.buffer = '';
      if (emitted !== undefined) events.push(emitted);
    }
    const final = this.dispatch();
    if (final !== undefined) events.push(final);
    return events;
  }

  private consumeLine(line: string): SseEvent | undefined {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
    else if (field === 'id' && !value.includes('\0')) this.id = value;
    else if (field === 'retry' && /^\d+$/.test(value)) this.retry = Number(value);
    return undefined;
  }

  private dispatch(): SseEvent | undefined {
    if (this.data.length === 0) {
      this.event = undefined;
      this.retry = undefined;
      return undefined;
    }
    const result: SseEvent = {
      ...(this.event === undefined || this.event === '' ? {} : { event: this.event }),
      data: this.data.join('\n'),
      ...(this.id === undefined ? {} : { id: this.id }),
      ...(this.retry === undefined ? {} : { retry: this.retry }),
    };
    this.event = undefined;
    this.retry = undefined;
    this.data = [];
    return result;
  }
}

/**
 * 把单个 SSE event 解码为 Trae 上游的语义事件。
 * 通用（Trae 协议事实）放这里，其他 adapter / 协议变体可复用相同 shape。
 */
export function decodeTraeEvent(event: SseEvent): TraeStreamEvent {
  if (event.data === '[DONE]') return { type: 'done', finishReason: 'stop' };
  let payload: unknown;
  try {
    payload = JSON.parse(event.data) as unknown;
  } catch {
    return { type: 'unknown', ...(event.event === undefined ? {} : { event: event.event }), data: event.data };
  }
  const record = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {};
  if (event.event === 'request_wait_in_queue') {
    return { type: 'queue', ...(typeof record['position'] === 'number' ? { position: record['position'] } : {}) };
  }
  if (event.event === 'progress_notice') return { type: 'progress', notice: payload };
  if (event.event === 'token_usage') {
    return {
      type: 'usage',
      ...(typeof record['prompt_tokens'] === 'number' ? { inputTokens: record['prompt_tokens'] } : {}),
      ...(typeof record['completion_tokens'] === 'number' ? { outputTokens: record['completion_tokens'] } : {}),
      ...(typeof record['total_tokens'] === 'number' ? { totalTokens: record['total_tokens'] } : {}),
      ...(typeof record['reasoning_tokens'] === 'number' ? { reasoningTokens: record['reasoning_tokens'] } : {}),
      ...(typeof record['cache_read_input_tokens'] === 'number' ? { cacheReadTokens: record['cache_read_input_tokens'] } : {}),
      ...(typeof record['cache_creation_input_tokens'] === 'number' ? { cacheWriteTokens: record['cache_creation_input_tokens'] } : {}),
    };
  }
  if (event.event === 'done' || (typeof record['finish_reason'] === 'string' && record['response'] === undefined)) {
    return { type: 'done', finishReason: typeof record['finish_reason'] === 'string' ? record['finish_reason'] : 'stop' };
  }
  if (event.event === 'output' || record['response'] !== undefined || record['reasoning_content'] !== undefined) {
    return {
      type: 'delta',
      text: typeof record['response'] === 'string' ? record['response'] : '',
      ...(typeof record['reasoning_content'] === 'string' ? { reasoning: record['reasoning_content'] } : {}),
      ...(record['tool_calls'] === undefined || record['tool_calls'] === null ? {} : { toolCalls: record['tool_calls'] }),
    };
  }
  return { type: 'unknown', ...(event.event === undefined ? {} : { event: event.event }), data: payload };
}