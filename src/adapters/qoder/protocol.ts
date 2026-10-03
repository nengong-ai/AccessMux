// stream-json ↔ AccessMux 消息/事件的纯翻译层（T020）。
// 全部无 IO，可单测。事件形状来自 T020 施工前实测捕获（本包回执 §2）：
// - 输入：每行一个 JSON：{"type":"user","message":{"role":"user","content":[{"type":"text","text":...}]}}
// - 输出：assistant 事件（content 块 thinking/text，一轮可多个）+ result 事件收尾
//   （is_error/subtype/result/stop_reason/duration_ms；usage.input_tokens 恒 0，host 不计量）
// - 实测定论：control reset / control interrupt 均被静默忽略 → 不支持进程内
//   新会话与优雅打断（cancel = 杀进程，见 session.ts/pool.ts）。

import type { ChatMessage, ImagePart } from '../../types.js';

/** 用户消息内容块（MVP 只有 text；thinking 是 assistant 侧内部推理，不进输出）。 */
export interface QoderContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
}

export interface QoderAssistantMessage {
  role?: string;
  stop_reason?: string | null;
  content?: QoderContentBlock[];
}

export interface QoderEvent {
  type?: string;
  subtype?: string;
  message?: QoderAssistantMessage;
  is_error?: boolean;
  result?: string;
  stop_reason?: string | null;
  duration_ms?: number;
  usage?: { context_usage_ratio?: number };
}

/**
 * 把宿主 OpenAI 形消息折叠成单条 user 文本 + 图片（与 opencode foldTurn 同语义）。
 * T036：images 由 buildUserEnvelope 塑形为 stream-json 的 image content block
 * （Anthropic block 形状；CLI 是否真吃待真机验证，未点亮前协议层已拦截）。
 */
export function foldTurn(messages: readonly ChatMessage[]): { text: string; images: ImagePart[] } {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content);
  const rest = messages.filter((m) => m.role !== 'system');
  let text: string;
  if (rest.length === 1 && rest[0]?.role === 'user') {
    text = rest[0].content;
  } else {
    text = rest.map((m) => `${m.role}:\n${m.content}`).join('\n\n');
  }
  return {
    text: system.length === 0 ? text : `${system.join('\n\n')}\n\n${text}`,
    images: rest.flatMap((m) => m.images ?? []),
  };
}

/** 折叠后的文本 + 图片 → stream-json 用户消息 envelope（单行 JSON）。 */
export function buildUserEnvelope(text: string, images: readonly ImagePart[] = []): string {
  const content: Array<Record<string, unknown>> = text === '' ? [] : [{ type: 'text', text }];
  for (const image of images) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: image.mediaType, data: image.data },
    });
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content },
  });
}

/** 从 assistant 事件提取文本块（thinking 块丢弃：内部推理不进宿主输出）。 */
export function extractTextDeltas(event: QoderEvent): string[] {
  if (event.type !== 'assistant') return [];
  const blocks = event.message?.content;
  if (!Array.isArray(blocks)) return [];
  return blocks
    .filter((b) => b?.type === 'text' && typeof b.text === 'string' && b.text !== '')
    .map((b) => b.text as string);
}

/** result 事件里上报的上下文占用比（0..1），进程池用来决策回收。无则 undefined。 */
export function extractContextRatio(event: QoderEvent): number | undefined {
  const ratio = event.usage?.context_usage_ratio;
  return typeof ratio === 'number' && Number.isFinite(ratio) ? ratio : undefined;
}

export interface QoderTurnResult {
  text: string;
  stopReason: string | null;
  durationMs: number | undefined;
  contextRatio: number | undefined;
}

/**
 * 解析 result 事件。is_error=true → 抛错（message 用上游 result 原文，已脱敏：
 * qoderclicn 的 result 只含模型输出/错误描述，不含凭据）。
 */
export function parseTurnResult(event: QoderEvent): QoderTurnResult {
  if (event.is_error === true) {
    throw new Error(event.result ?? 'qoder 模型请求失败（result is_error）');
  }
  const text = typeof event.result === 'string' ? event.result : '';
  if (text.trim() === '') {
    throw new Error('模型没有返回文本（空 result）');
  }
  return {
    text,
    stopReason: event.stop_reason ?? null,
    durationMs: event.duration_ms,
    contextRatio: extractContextRatio(event),
  };
}

/** 宿主可能把上游全名 `qoder/<model>` 原样塞回来；wire 只收裸 modelID。 */
export function normalizeModelId(modelId: string): string {
  return modelId.startsWith('qoder/') ? modelId.slice('qoder/'.length) : modelId;
}

/**
 * `--list-models` 表格 → 模型 id 清单。行形态两种：
 *   Qwen3.8-Flash                      → id = 整行
 *   OpenCode Go Qwen3.8-Max (opencode-go/qwen3.8-max) → id = 括号内 modelID
 * "Auto" 是自动选择伪模型（未知模型名会静默落到 Auto 烧额度），不进清单。
 */
export function parseListModels(stdout: string): string[] {
  const ids: string[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || /^model\b/i.test(line)) continue;
    if (line.toLowerCase() === 'auto') continue;
    const paren = /\(([^()]+)\)\s*$/.exec(line);
    ids.push(paren !== null ? (paren[1]?.trim() ?? line) : line);
  }
  return [...new Set(ids)];
}
