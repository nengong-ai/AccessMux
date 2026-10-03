// WorkBuddy 季性签到（T027；docs/source-spec-checkin.md §2 合同）。
//
// - 查状态：POST {origin}/v2/billing/meter/checkin-status，body {}
// - 领取：  POST {origin}/v2/billing/meter/daily-checkin，body {}（服务端幂等）
// - 必需头：Authorization / X-User-Id / Accept / Content-Type 基础四头
// - 铁律：不带任何 Turing/设备头（X-Device-Token 实测可省，R026）；active=false
//   → "活动关闭" 优雅跳过，不报错、不发 claim。
// - 签到域是 www.workbuddy.cn（与 chat/catalog 域的 copilot.tencent.com 不同），
//   同账号同 token（R026 §2 双重印证），endpoint 常量单独放这里。

import type { CheckinResult } from './types.js';
import { asNumber, checkinResult, errorText, safeCheckinText } from './types.js';

export const WORKBUDDY_CHECKIN_ORIGIN_ENV = 'ACCESSMUX_WORKBUDDY_CHECKIN_ORIGIN';
export const DEFAULT_WORKBUDDY_CHECKIN_ORIGIN = 'https://www.workbuddy.cn';
export const WORKBUDDY_CHECKIN_TIMEOUT_MS = 20_000;

export function workBuddyCheckinOrigin(env: Record<string, string | undefined> = process.env): string {
  const override = env[WORKBUDDY_CHECKIN_ORIGIN_ENV]?.trim();
  return override !== undefined && override !== '' ? override : DEFAULT_WORKBUDDY_CHECKIN_ORIGIN;
}

export interface WorkBuddyCheckinCredential {
  accessToken: string;
  userId: string;
}

export interface WorkBuddyCheckinDeps {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  log?: (line: string) => void;
}

/** 基础四头（§2.2 最小请求合同）；刻意不含任何设备/Turing 头。 */
function basicHeaders(credential: WorkBuddyCheckinCredential): Record<string, string> {
  return {
    'Authorization': `Bearer ${credential.accessToken}`,
    'X-User-Id': credential.userId,
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  };
}

interface Envelope {
  code: number;
  msg: string;
  data: Record<string, unknown>;
}

async function readEnvelope(response: Response): Promise<Envelope> {
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`响应不是 JSON（HTTP ${response.status}）`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`响应形状不符（HTTP ${response.status}）`);
  }
  const record = parsed as Record<string, unknown>;
  const data = typeof record['data'] === 'object' && record['data'] !== null && !Array.isArray(record['data'])
    ? record['data'] as Record<string, unknown>
    : {};
  return {
    code: asNumber(record['code']) ?? 0,
    msg: typeof record['msg'] === 'string' ? record['msg'] : (typeof record['message'] === 'string' ? record['message'] : ''),
    data,
  };
}

/** 第三方脚本 DEAD_MARKERS：登录态彻底失效的两类信号（R026 §2.2）。 */
function looksDeadSession(msg: string): boolean {
  return /offline user session not found/i.test(msg) || msg.includes('12153');
}

export type WorkBuddyStatusOutcome =
  | { kind: 'active'; todayCheckedIn: boolean; todayCredit?: number; streakDays?: number }
  | { kind: 'inactive' }
  | { kind: 'error'; message: string };

export type WorkBuddyClaimOutcome =
  | { kind: 'claimed'; credit?: number; streakDays?: number }
  | { kind: 'already' }
  | { kind: 'error'; message: string };

export async function fetchWorkBuddyCheckinStatus(
  credential: WorkBuddyCheckinCredential,
  deps: WorkBuddyCheckinDeps = {},
): Promise<WorkBuddyStatusOutcome> {
  const doFetch = deps.fetchImpl ?? fetch;
  const origin = workBuddyCheckinOrigin(deps.env);
  let response: Response;
  try {
    response = await doFetch(`${origin}/v2/billing/meter/checkin-status`, {
      method: 'POST',
      headers: basicHeaders(credential),
      body: '{}',
      signal: AbortSignal.timeout(deps.timeoutMs ?? WORKBUDDY_CHECKIN_TIMEOUT_MS),
    });
  } catch (error) {
    return { kind: 'error', message: `网络失败：${errorText(error, [credential.accessToken])}` };
  }
  if (response.status === 401 || response.status === 403) {
    return { kind: 'error', message: '登录态失效，请在 WorkBuddy 重新登录' };
  }
  let envelope: Envelope;
  try {
    envelope = await readEnvelope(response);
  } catch (error) {
    return { kind: 'error', message: errorText(error, [credential.accessToken]) };
  }
  if (envelope.code !== 0) {
    return {
      kind: 'error',
      message: looksDeadSession(envelope.msg)
        ? '登录态失效，请在 WorkBuddy 重新登录'
        : `签到状态查询失败：${envelope.msg === '' ? `code=${envelope.code}` : safeCheckinText(envelope.msg, [credential.accessToken])}`,
    };
  }
  if (envelope.data['active'] !== true) return { kind: 'inactive' };
  const todayCredit = asNumber(envelope.data['today_credit']) ?? asNumber(envelope.data['daily_credit']);
  const streakDays = asNumber(envelope.data['streak_days']);
  return {
    kind: 'active',
    todayCheckedIn: envelope.data['today_checked_in'] === true,
    ...(todayCredit === undefined ? {} : { todayCredit }),
    ...(streakDays === undefined ? {} : { streakDays }),
  };
}

export async function claimWorkBuddyDaily(
  credential: WorkBuddyCheckinCredential,
  deps: WorkBuddyCheckinDeps = {},
): Promise<WorkBuddyClaimOutcome> {
  const doFetch = deps.fetchImpl ?? fetch;
  const origin = workBuddyCheckinOrigin(deps.env);
  let response: Response;
  try {
    response = await doFetch(`${origin}/v2/billing/meter/daily-checkin`, {
      method: 'POST',
      headers: basicHeaders(credential),
      body: '{}',
      signal: AbortSignal.timeout(deps.timeoutMs ?? WORKBUDDY_CHECKIN_TIMEOUT_MS),
    });
  } catch (error) {
    return { kind: 'error', message: `网络失败：${errorText(error, [credential.accessToken])}` };
  }
  if (response.status === 401 || response.status === 403) {
    return { kind: 'error', message: '登录态失效，请在 WorkBuddy 重新登录' };
  }
  let envelope: Envelope;
  try {
    envelope = await readEnvelope(response);
  } catch (error) {
    return { kind: 'error', message: errorText(error, [credential.accessToken]) };
  }
  if (envelope.code !== 0) {
    if (looksDeadSession(envelope.msg)) {
      return { kind: 'error', message: '登录态失效，请在 WorkBuddy 重新登录' };
    }
    // 幂等语义：竞态下重复 claim 由服务端拒绝，按"已领"处理而非报错
    if (/already|已领/i.test(envelope.msg)) return { kind: 'already' };
    return { kind: 'error', message: `领取失败：${envelope.msg === '' ? `code=${envelope.code}` : safeCheckinText(envelope.msg, [credential.accessToken])}` };
  }
  const credit = asNumber(envelope.data['credit']);
  const streakDays = asNumber(envelope.data['streak_days']);
  return {
    kind: 'claimed',
    ...(credit === undefined ? {} : { credit }),
    ...(streakDays === undefined ? {} : { streakDays }),
  };
}

function creditSummary(credit: number | undefined, streakDays: number | undefined): string {
  const parts: string[] = [];
  if (credit !== undefined) parts.push(`+${credit} credits`);
  if (streakDays !== undefined) parts.push(`连签 ${streakDays} 天`);
  return parts.join('，');
}

export interface WorkBuddyCheckinRunOptions extends WorkBuddyCheckinDeps {
  /** 凭据解析（生产默认复用 workbuddy adapter 的 credential store resolve）。 */
  resolveCredential: () => Promise<WorkBuddyCheckinCredential>;
}

/**
 * 一次 WorkBuddy 签到：先查状态 → active 且未签才 claim。
 * 幂等的关键：today_checked_in=true 时绝不发 claim 请求（验收标准 4）。
 */
export async function runWorkBuddyCheckin(options: WorkBuddyCheckinRunOptions): Promise<CheckinResult> {
  let credential: WorkBuddyCheckinCredential;
  try {
    credential = await options.resolveCredential();
  } catch (error) {
    return checkinResult('workbuddy', 'skipped', `未检测到 WorkBuddy 登录态（先打开 WorkBuddy 登录一次）：${errorText(error)}`);
  }
  const status = await fetchWorkBuddyCheckinStatus(credential, options);
  if (status.kind === 'error') return checkinResult('workbuddy', 'error', status.message);
  if (status.kind === 'inactive') return checkinResult('workbuddy', 'inactive', '本季签到活动未开放');
  if (status.todayCheckedIn) {
    const summary = creditSummary(status.todayCredit, status.streakDays);
    return checkinResult('workbuddy', 'already', summary === '' ? '今日已领' : `今日已领（${summary}）`);
  }
  const claim = await claimWorkBuddyDaily(credential, options);
  if (claim.kind === 'error') return checkinResult('workbuddy', 'error', claim.message);
  if (claim.kind === 'already') return checkinResult('workbuddy', 'already', '今日已领（服务端幂等回执）');
  const summary = creditSummary(claim.credit, claim.streakDays);
  return checkinResult('workbuddy', 'claimed', summary === '' ? '领取成功' : `领取成功（${summary}）`);
}
