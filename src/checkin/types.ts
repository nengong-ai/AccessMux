// checkin 结果类型与输出标签（T027；docs/source-spec-checkin.md §5.1 产品形态）。
//
// 每个源统一归一到一个 verdict + 一行人类可读消息；CLI 只负责打印与退出码：
// - claimed / already / inactive / skipped / hint 都算"正常的一天"，退出码 0；
// - error 表示意外失败（网络/形状/业务码），退出码非 0；
// - skipped 必须带原因（"配置缺失 → 跳过+原因"是验收标准 4）。
//
// 铁律：message 只写指纹级信息（金额/天数/状态词），任何 token/PAT 原值不进。

import { redactLogText } from '../util/redact.js';

/** 已知凭据先精确替换，公共兜底再处理字段/鉴权回声。 */
export function safeCheckinText(text: unknown, secrets: readonly string[] = []): string {
  return redactLogText(text, 300, secrets);
}

export type CheckinSource = 'workbuddy' | 'qoder' | 'zcode';

export type CheckinVerdict =
  /** 本次真实领取成功 */
  | 'claimed'
  /** 本窗口已领过（幂等路径，不重复发领取请求） */
  | 'already'
  /** 活动未开放/无活动（优雅跳过，不报错） */
  | 'inactive'
  /** 配置缺失或探测不可用（带原因） */
  | 'skipped'
  /** 有可领活动但本工具不自动领（ZCode：提示去官方客户端） */
  | 'hint'
  /** 意外失败 */
  | 'error';

export interface CheckinResult {
  source: CheckinSource;
  verdict: CheckinVerdict;
  /** 人类可读一行（不含敏感原值） */
  message: string;
}

export const CHECKIN_VERDICT_LABEL: Readonly<Record<CheckinVerdict, string>> = {
  claimed: '已领取',
  already: '已领',
  inactive: '活动关闭',
  skipped: '跳过',
  hint: '提示',
  error: '失败',
};

export function checkinResult(source: CheckinSource, verdict: CheckinVerdict, message: string): CheckinResult {
  return { source, verdict, message: safeCheckinText(message) };
}

/** CLI/日志一行：`workbuddy\t活动关闭：本季签到活动未开放`。 */
export function formatCheckinLine(result: CheckinResult): string {
  const label = CHECKIN_VERDICT_LABEL[result.verdict];
  return `${result.source}\t${label}${result.message === '' ? '' : `：${safeCheckinText(result.message)}`}`;
}

/** 宽松取数字（上游字段可能是 number/string/缺失）。 */
export function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/** 错误对象 → 消息文本（不抛二次错）。 */
export function errorText(error: unknown, secrets: readonly string[] = []): string {
  return safeCheckinText(error instanceof Error ? error.message : String(error), secrets);
}
