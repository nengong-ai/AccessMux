// daemon 请求日志（T010 #1）：消掉"宿主侧报错、daemon 侧无痕"的观测盲区。
// 每个 /v1/chat/completions 与 /v1/messages 请求落一行：
//   [accessmux-req] path=/v1/chat/completions model=workbuddy:hy4-preview adapter=workbuddy
//                   status=200 duration_ms=1234 stream=true ttft_ms=456
//
// - 默认开启（写到 stderr，与 stdout 的正常输出分流）；ACCESSMUX_REQUEST_LOG=0 关闭。
// - ACCESSMUX_DEBUG=1 追加诊断字段（msg_count / prompt_chars 等，仍不含正文与凭据）。
// - error 字段一律经 redactLogText 脱敏：token 只留形状（红线 D4 兜底）。

import { redactLogText } from '../util/redact.js';

const LINE_PREFIX = '[accessmux-req]';

function enabled(): boolean {
  return process.env['ACCESSMUX_REQUEST_LOG'] !== '0';
}

function debugEnabled(): boolean {
  return process.env['ACCESSMUX_DEBUG'] === '1';
}

function formatValue(key: string, value: unknown): string {
  const text = redactLogText(value, key === 'error' ? 300 : 1000);
  // 含空白/引号的值加引号，保证一行一条、可 grep
  return /[\s"']/.test(text) ? JSON.stringify(text) : text;
}

/** 请求日志（默认开）：一次请求一行。error 字段自动脱敏。 */
export function requestLog(fields: Record<string, unknown>): void {
  if (!enabled()) return;
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === '') continue;
    parts.push(`${key}=${formatValue(key, value)}`);
  }
  console.error(`${LINE_PREFIX} ${parts.join(' ')}`);
}

/** 调试日志（ACCESSMUX_DEBUG=1 才输出）；与请求日志同格式同管道。 */
export function requestDebug(fields: Record<string, unknown>): void {
  if (!debugEnabled()) return;
  requestLog({ debug: true, ...fields });
}
