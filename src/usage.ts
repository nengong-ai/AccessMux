// T023 · usage 归一与本地估算。
//
// 分工：
// - 上游有计量面的 adapter（trae / workbuddy / opencode / zcode）→ normalize*Usage 真数透传；
// - 上游无计量面的 adapter（qoder，R015 实证 host 侧恒 0）→ estimateTurnUsage 本地估算，
//   结果一律带 `estimated: true`（铁律：估算必须带标识，绝不用估算冒充真数）。
//
// 归一函数对缺失/异常一律返回 undefined（不伪造 0）：拿不到就是拿不到，由调用方决定。

import type { TurnUsage } from './types.js';

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function detailsOf(value: unknown): Record<string, number> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const parsed = num(raw);
    if (parsed !== undefined) out[key] = parsed;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

function assemble(
  prompt: number | undefined,
  completion: number | undefined,
  total: number | undefined,
  promptDetails: Record<string, number> | undefined,
  completionDetails: Record<string, number> | undefined,
): TurnUsage | undefined {
  if (prompt === undefined && completion === undefined && total === undefined) return undefined;
  const p = prompt ?? 0;
  const c = completion ?? 0;
  return {
    prompt_tokens: p,
    completion_tokens: c,
    total_tokens: total ?? p + c,
    ...(promptDetails === undefined ? {} : { prompt_tokens_details: promptDetails }),
    ...(completionDetails === undefined ? {} : { completion_tokens_details: completionDetails }),
  };
}

/** OpenAI 形状：{ prompt_tokens, completion_tokens, total_tokens, *_tokens_details }。 */
export function normalizeOpenAiUsage(raw: unknown): TurnUsage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  return assemble(
    num(record['prompt_tokens']),
    num(record['completion_tokens']),
    num(record['total_tokens']),
    detailsOf(record['prompt_tokens_details']),
    detailsOf(record['completion_tokens_details']),
  );
}

/**
 * Anthropic 形状：{ input_tokens, output_tokens, cache_read_input_tokens?, cache_creation_input_tokens? }。
 * 缓存读写归到 prompt_tokens_details（沿用 OpenAI 的 cached_tokens 命名习惯）。
 */
export function normalizeAnthropicUsage(raw: unknown): TurnUsage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const cacheRead = num(record['cache_read_input_tokens']);
  const cacheWrite = num(record['cache_creation_input_tokens']);
  const details = {
    ...(cacheRead === undefined ? {} : { cached_tokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cache_write_tokens: cacheWrite }),
  };
  return assemble(
    num(record['input_tokens']),
    num(record['output_tokens']),
    undefined,
    Object.keys(details).length === 0 ? undefined : details,
    undefined,
  );
}

/**
 * 分桶式 token 计数 → TurnUsage（opencode 与 zcode app-server 同款形状）。
 *
 * 上游把生成侧分桶（output / reasoning），输入侧也把「缓存命中」单列。
 * 但 **input 是否已包含缓存，两派上游口径相反**（都经实测与上游自身代码确认）：
 * - opencode：`input` 不含缓存（其 total = input+output+reasoning+cache.read+cache.write）
 * - ZCode app-server：`input` 含缓存（CLI 自身 DB 的 computed_total = input+output，
 *   且包内 `ras()`/`GV()` 都把 input 当总量、缓存只在 input 缺失时兜底）
 *
 * 所以这里不猜，用上游自报的 total 做最近邻比对消歧——与 ZCode 包内 `oas()`
 * 同一判据（`|total-(input+out)|` vs `|total-(input+cache+out)|`，取更近者）。
 * 归桶后 total 恒等于上游 total；原始分桶全部留在 prompt_tokens_details 供核对。
 */
export function usageFromTokenBreakdown(raw: {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
}): TurnUsage | undefined {
  const values = [raw.input, raw.output, raw.reasoning, raw.cacheRead, raw.cacheWrite];
  if (values.every((v) => v === undefined)) return undefined;
  const input = raw.input ?? 0;
  const cache = (raw.cacheRead ?? 0) + (raw.cacheWrite ?? 0);
  const completion = (raw.output ?? 0) + (raw.reasoning ?? 0);

  let prompt: number;
  if (input <= 0) {
    prompt = cache;
  } else if (cache <= 0 || raw.total === undefined) {
    prompt = input;
  } else {
    const cacheIsSubset = Math.abs(raw.total - (input + completion));
    const cacheIsAdditional = Math.abs(raw.total - (input + cache + completion));
    prompt = cacheIsAdditional < cacheIsSubset ? input + cache : input;
  }

  const promptDetails: Record<string, number> = {
    ...(raw.cacheRead === undefined ? {} : { cached_tokens: raw.cacheRead }),
    ...(raw.cacheWrite === undefined ? {} : { cache_write_tokens: raw.cacheWrite }),
  };
  const completionDetails: Record<string, number> = {
    ...(raw.reasoning === undefined ? {} : { reasoning_tokens: raw.reasoning }),
  };
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    ...(Object.keys(promptDetails).length === 0 ? {} : { prompt_tokens_details: promptDetails }),
    ...(Object.keys(completionDetails).length === 0 ? {} : { completion_tokens_details: completionDetails }),
  };
}

/**
 * 本地分词估算（仅用于上游零计量面的源，如 qoder）。
 *
 * 口径（业界通用经验值，非精确分词器）：
 * - CJK 汉字/假名/谚文、全角标点：≈1 token/字
 * - 其余（拉丁字母、数字、半角标点、空白）：≈1 token/4 字符
 *
 * 估算值必然有偏差（尤其代码与长英文标识符），所以结果强制带 `estimated: true`，
 * 文档与 README FAQ 同步公示，宿主可据此区分。
 */
export function estimateTokens(text: string): number {
  let wide = 0;
  let narrow = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (isWideCodePoint(code)) wide += 1;
    else narrow += 1;
  }
  return wide + Math.ceil(narrow / 4);
}

function isWideCodePoint(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) || // 谚文字母
    (code >= 0x2e80 && code <= 0x303e) || // CJK 部首 / 标点
    (code >= 0x3041 && code <= 0x33ff) || // 假名 / CJK 兼容
    (code >= 0x3400 && code <= 0x4dbf) || // CJK 扩展 A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK 基本区
    (code >= 0xa000 && code <= 0xa4cf) || // 彝文
    (code >= 0xac00 && code <= 0xd7a3) || // 谚文音节
    (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容表意
    (code >= 0xfe30 && code <= 0xfe4f) || // CJK 兼容形式
    (code >= 0xff00 && code <= 0xff60) || // 全角形式
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) || // emoji（按整字计）
    (code >= 0x20000 && code <= 0x3ffff) // CJK 扩展 B+
  );
}

/** 用 prompt/completion 原文产出估算用量（estimated 标识由本函数统一打上）。 */
export function estimateTurnUsage(promptText: string, completionText: string): TurnUsage {
  const prompt = estimateTokens(promptText);
  const completion = estimateTokens(completionText);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    estimated: true,
  };
}
