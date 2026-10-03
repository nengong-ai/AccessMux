// SSE 解码器测试：覆盖 chunk 切分、CRLF、注释行 / dispatch / [DONE]。

import { describe, expect, it } from 'vitest';
import { SseDecoder, decodeTraeEvent } from '../../src/protocol/sse.js';

describe('SseDecoder', () => {
  it('空输入不产出事件', () => {
    const d = new SseDecoder();
    expect(d.push('')).toEqual([]);
    expect(d.finish()).toEqual([]);
  });

  it('单事件 data:foo', () => {
    const d = new SseDecoder();
    expect(d.push('data: foo\n\n')).toEqual([{ data: 'foo' }]);
  });

  it('CRLF 行结束正常', () => {
    const d = new SseDecoder();
    expect(d.push('data: foo\r\n\r\n')).toEqual([{ data: 'foo' }]);
  });

  it('注释行（首字符为 :）忽略', () => {
    const d = new SseDecoder();
    expect(d.push(': comment\ndata: foo\n\n')).toEqual([{ data: 'foo' }]);
  });

  it('多行 data 用 \\n 拼接', () => {
    const d = new SseDecoder();
    expect(d.push('data: line1\ndata: line2\n\n')).toEqual([{ data: 'line1\nline2' }]);
  });

  it('event/data/id/retry 全部拼装', () => {
    const d = new SseDecoder();
    expect(d.push('event: progress\ndata: payload\nid: 42\nretry: 1000\n\n')).toEqual([
      { event: 'progress', data: 'payload', id: '42', retry: 1000 },
    ]);
  });

  it('chunk 切到事件中间仍正确', () => {
    const d = new SseDecoder();
    const a = d.push('data: hel');
    expect(a).toEqual([]);
    const b = d.push('lo\n\n');
    expect(b).toEqual([{ data: 'hello' }]);
  });

  it('空 data 字段（仅 event）不发射', () => {
    const d = new SseDecoder();
    expect(d.push('event: only\n\n')).toEqual([]);
  });

  it('finish() 在 buffer 残余时仍产出', () => {
    const d = new SseDecoder();
    d.push('data: tail');
    expect(d.finish()).toEqual([{ data: 'tail' }]);
  });

  it('finish() 也 dispatch 当前累积的 data', () => {
    const d = new SseDecoder();
    d.push('data: a\ndata: b');
    expect(d.finish()).toEqual([{ data: 'a\nb' }]);
  });

  it('id 字段含 \\0 时丢弃', () => {
    const d = new SseDecoder();
    expect(d.push('data: x\nid: bad\0id\n\n')).toEqual([{ data: 'x' }]);
  });

  it('retry 非数字丢弃', () => {
    const d = new SseDecoder();
    expect(d.push('data: x\nretry: notnum\n\n')).toEqual([{ data: 'x' }]);
  });
});

describe('decodeTraeEvent', () => {
  it('[DONE] sentinel → done / stop', () => {
    expect(decodeTraeEvent({ data: '[DONE]' })).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('progress_notice → progress', () => {
    const evt = decodeTraeEvent({ event: 'progress_notice', data: '{"notice":"hi"}' });
    expect(evt.type).toBe('progress');
  });

  it('output → delta text', () => {
    const evt = decodeTraeEvent({ event: 'output', data: '{"response":"hi"}' });
    expect(evt).toEqual({ type: 'delta', text: 'hi' });
  });

  it('output 含 reasoning_content → reasoning 字段', () => {
    const evt = decodeTraeEvent({ event: 'output', data: '{"response":"hi","reasoning_content":"thinking"}' });
    expect(evt).toEqual({ type: 'delta', text: 'hi', reasoning: 'thinking' });
  });

  it('token_usage → usage 字段', () => {
    const evt = decodeTraeEvent({ event: 'token_usage', data: '{"prompt_tokens":10,"completion_tokens":5,"cache_read_input_tokens":7}' });
    expect(evt).toMatchObject({ type: 'usage', inputTokens: 10, outputTokens: 5, cacheReadTokens: 7 });
  });

  it('done event → finishReason stop', () => {
    expect(decodeTraeEvent({ event: 'done', data: '{"finish_reason":"stop"}' })).toEqual({ type: 'done', finishReason: 'stop' });
  });

  it('无法解析的 JSON → unknown', () => {
    expect(decodeTraeEvent({ data: 'not json' })).toMatchObject({ type: 'unknown' });
  });

  it('请求排队 → queue / position', () => {
    expect(decodeTraeEvent({ event: 'request_wait_in_queue', data: '{"position":3}' })).toEqual({ type: 'queue', position: 3 });
  });
});