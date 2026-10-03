// WorkBuddy 上游错误分类（端口 spec §4.3.2 + dsh-workbuddy-connect/
// upstream.ts:302-322 classifyUpstreamError）。
//
// 与通用 protocol/error-map.ts 的 UpstreamErrorKind 完全对齐（status
// 映射也直接复用 STATUS_BY_KIND）。本文件只是命名 WorkBuddy 专属的错
// 误分类场景，方便 adapter 引用 + 单元测试。

import type { UpstreamErrorKind } from '../../protocol/error-map.js';

export interface ClassifyUpstreamErrorInput {
  status: number;
  body?: string;
}

export interface ClassifiedUpstreamError {
  kind: UpstreamErrorKind;
  message: string;
}

/**
 * 把 HTTP status + body 文本分类为 UpstreamErrorKind。
 * - 401/403 → authentication
 * - 402 → hard_credit
 * - 429 → soft_rate
 * - 404 → not_found
 * - 5xx → server
 * - 其它 4xx → client
 *
 * WorkBuddy body 习惯：包含 `error.code` 字符串时挑出来作为 message，
 * 避免把整段 HTML / 长 JSON 当 message 用。
 */
export function classifyWorkBuddyUpstreamError(input: ClassifyUpstreamErrorInput): ClassifiedUpstreamError {
  const kind = statusToKind(input.status);
  const message = extractWorkBuddyErrorMessage(input.body, input.status);
  return { kind, message };
}

export function statusToKind(status: number): UpstreamErrorKind {
  if (status === 401 || status === 403) return 'authentication';
  if (status === 402) return 'hard_credit';
  if (status === 429) return 'soft_rate';
  if (status === 404) return 'not_found';
  if (status >= 500) return 'server';
  if (status >= 400) return 'client';
  return 'unconfigured';
}

function extractWorkBuddyErrorMessage(body: string | undefined, status: number): string {
  if (body === undefined || body.trim() === '') return `WorkBuddy upstream returned HTTP ${status}`;
  const trimmed = body.trim();
  if (trimmed.length > 1024) return trimmed.slice(0, 1024);
  return trimmed;
}