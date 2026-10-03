// T020 协议翻译单测：全部纯函数、离线。

import { describe, expect, it } from 'vitest';
import {
  buildUserEnvelope,
  extractTextDeltas,
  foldTurn,
  normalizeModelId,
  parseListModels,
  parseTurnResult,
} from '../../../src/adapters/qoder/protocol.js';

describe('foldTurn', () => {
  it('单条 user 消息原样直发（零损耗路径）', () => {
    expect(foldTurn([{ role: 'user', content: '你好' }])).toEqual({ text: '你好', images: [] });
  });

  it('多条消息渲染成带角色标签的转录', () => {
    const turn = foldTurn([
      { role: 'user', content: 'A' },
      { role: 'assistant', content: 'B' },
      { role: 'user', content: 'C' },
    ]);
    expect(turn.text).toBe('user:\nA\n\nassistant:\nB\n\nuser:\nC');
    expect(turn.images).toEqual([]);
  });

  it('system 消息独立拼在最前', () => {
    const turn = foldTurn([
      { role: 'system', content: 'S1' },
      { role: 'user', content: 'U' },
    ]);
    expect(turn.text).toBe('S1\n\nU');
  });

  it('多条 system 用空行拼接', () => {
    const turn = foldTurn([
      { role: 'system', content: 'S1' },
      { role: 'system', content: 'S2' },
      { role: 'user', content: 'U' },
    ]);
    expect(turn.text).toBe('S1\n\nS2\n\nU');
  });
});

describe('buildUserEnvelope T036 图片', () => {
  it('带图：content 追加 Anthropic 形 image block（base64 source）', () => {
    const env = JSON.parse(buildUserEnvelope('看图', [
      { type: 'image', mediaType: 'image/png', data: 'QUFB' },
    ])) as { message: { content: Array<Record<string, unknown>> } };
    expect(env.message.content).toEqual([
      { type: 'text', text: '看图' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUFB' } },
    ]);
  });

  it('纯文本无图时报文与旧形态一致；空文本兜底单 text 块', () => {
    const plain = JSON.parse(buildUserEnvelope('hi')) as { message: { content: unknown[] } };
    expect(plain.message.content).toEqual([{ type: 'text', text: 'hi' }]);
    const empty = JSON.parse(buildUserEnvelope('', [])) as { message: { content: unknown[] } };
    expect(empty.message.content).toEqual([{ type: 'text', text: '' }]);
  });
});

describe('buildUserEnvelope', () => {
  it('输出实测形状的 user envelope', () => {
    const env = JSON.parse(buildUserEnvelope('hi')) as Record<string, unknown>;
    expect(env['type']).toBe('user');
    const message = env['message'] as { role: string; content: Array<{ type: string; text: string }> };
    expect(message.role).toBe('user');
    expect(message.content).toEqual([{ type: 'text', text: 'hi' }]);
  });
});

describe('extractTextDeltas', () => {
  it('提取 text 块；thinking 块丢弃', () => {
    expect(
      extractTextDeltas({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'internal reasoning' },
            { type: 'text', text: 'Hello' },
          ],
        },
      }),
    ).toEqual(['Hello']);
  });

  it('非 assistant 事件返回空', () => {
    expect(extractTextDeltas({ type: 'result', result: 'x' })).toEqual([]);
  });

  it('空 text 块被跳过', () => {
    expect(
      extractTextDeltas({
        type: 'assistant',
        message: { content: [{ type: 'text', text: '' }] },
      }),
    ).toEqual([]);
  });
});

describe('parseTurnResult', () => {
  it('成功 result 解析出文本与上下文占用比', () => {
    const r = parseTurnResult({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'QPROBE-OK',
      stop_reason: 'end_turn',
      duration_ms: 3305,
      usage: { context_usage_ratio: 0.0028 },
    });
    expect(r.text).toBe('QPROBE-OK');
    expect(r.stopReason).toBe('end_turn');
    expect(r.durationMs).toBe(3305);
    expect(r.contextRatio).toBeCloseTo(0.0028);
  });

  it('is_error=true 抛错（消息用上游 result 原文）', () => {
    expect(() =>
      parseTurnResult({ type: 'result', subtype: 'error', is_error: true, result: 'boom' }),
    ).toThrow('boom');
  });

  it('空 result 抛错', () => {
    expect(() => parseTurnResult({ type: 'result', is_error: false, result: '  ' })).toThrow(
      '模型没有返回文本',
    );
  });
});

describe('parseListModels', () => {
  it('解析实测 --list-models 表格（含 provider 括号形态与 Auto 剔除）', () => {
    const stdout = [
      'MODEL',
      'Auto',
      'Qwen3.8-Max',
      'Qwen3.8-Flash',
      'GLM-5.3-Flash',
      'OpenCode Go Qwen3.8-Max (opencode-go/qwen3.8-max)',
      '',
    ].join('\n');
    expect(parseListModels(stdout)).toEqual([
      'Qwen3.8-Max',
      'Qwen3.8-Flash',
      'GLM-5.3-Flash',
      'opencode-go/qwen3.8-max',
    ]);
  });

  it('表头大小写不敏感；重复行去重', () => {
    expect(parseListModels('Model\nA\nA\n')).toEqual(['A']);
  });
});

describe('normalizeModelId', () => {
  it('剥 qoder/ 前缀；裸 id 原样', () => {
    expect(normalizeModelId('qoder/Qwen3.8-Flash')).toBe('Qwen3.8-Flash');
    expect(normalizeModelId('Qwen3.8-Flash')).toBe('Qwen3.8-Flash');
    expect(normalizeModelId('qfmodel')).toBe('qfmodel');
  });
});
