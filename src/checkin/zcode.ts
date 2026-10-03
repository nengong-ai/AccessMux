// ZCode 活动面探测（T027；docs/source-spec-checkin.md §1.2/§1.3 合同）。
//
// GET {origin}/api/v1/zcode-plan/billing/preview，最小两头
// （Authorization: Bearer <jwt> + X-Device-Mid；与 quota.ts 同一合同）。
// plans 非空 → 提示"有可领活动，去官方客户端领取"；空 → 静默跳过。
// **不做自动 claim**：ZCode 的 claim 可能要求验证码（X-Aliyun-Captcha-Verify-Param），
// 静默绕验证码超出边界（D27 红线）——本模块只探测不领取。
//
// 复用生产凭据链：loadZcodeCredential（credential-store.ts）与 zcodeOrigin。

import type { CheckinResult } from './types.js';
import { checkinResult, errorText, safeCheckinText } from './types.js';
import { zcodeOrigin } from '../adapters/zcode/endpoints.js';

export interface ZcodeCheckinCredential {
  jwt: string;
  deviceMid: string;
}

export interface ZcodeCheckinDeps {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  log?: (line: string) => void;
}

export const ZCODE_PREVIEW_TIMEOUT_MS = 15_000;

export type ZcodePreviewOutcome =
  | { kind: 'empty' }
  | { kind: 'plans'; planNames: string[] }
  | { kind: 'error'; message: string };

interface PreviewPlan {
  plan_id?: unknown;
  planId?: unknown;
  name?: unknown;
}

function parsePlanNames(payload: unknown): string[] | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  const code = record['code'];
  if (code !== undefined && code !== 0 && code !== '0') return undefined;
  const data = record['data'];
  if (typeof data !== 'object' || data === null) return undefined;
  const plans = (data as Record<string, unknown>)['plans'];
  if (!Array.isArray(plans)) return undefined;
  return plans.map((raw): string => {
    if (typeof raw !== 'object' || raw === null) return '未命名活动';
    const plan = raw as PreviewPlan;
    if (typeof plan.name === 'string' && plan.name.trim() !== '') return plan.name.trim();
    if (typeof plan.plan_id === 'string' && plan.plan_id.trim() !== '') return plan.plan_id.trim();
    if (typeof plan.planId === 'string' && plan.planId.trim() !== '') return plan.planId.trim();
    return '未命名活动';
  });
}

/** 探测可领活动（只读）。 */
export async function fetchZcodePreview(
  credential: ZcodeCheckinCredential,
  deps: ZcodeCheckinDeps = {},
): Promise<ZcodePreviewOutcome> {
  const doFetch = deps.fetchImpl ?? fetch;
  const url = `${zcodeOrigin(deps.env)}/api/v1/zcode-plan/billing/preview`;
  let response: Response;
  try {
    response = await doFetch(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${credential.jwt}`,
        'x-device-mid': credential.deviceMid,
      },
      signal: AbortSignal.timeout(deps.timeoutMs ?? ZCODE_PREVIEW_TIMEOUT_MS),
    });
  } catch (error) {
    return { kind: 'error', message: `网络失败：${errorText(error, [credential.jwt])}` };
  }
  if (response.status === 401) {
    return { kind: 'error', message: '登录态失效（401），请在 ZCode 客户端重新登录' };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(await response.text()) as unknown;
  } catch {
    return { kind: 'error', message: `响应不是 JSON（HTTP ${response.status}）` };
  }
  const names = parsePlanNames(payload);
  if (names === undefined) return { kind: 'error', message: `响应形状不符（HTTP ${response.status}）` };
  return names.length === 0 ? { kind: 'empty' } : { kind: 'plans', planNames: names.map((name) => safeCheckinText(name, [credential.jwt])) };
}

export interface ZcodeCheckinRunOptions extends ZcodeCheckinDeps {
  /** 凭据解析（生产复用 adapters/zcode credential-store）；不可用 → 跳过。 */
  loadCredential: () => ZcodeCheckinCredential;
}

/**
 * 一次 ZCode 活动探测：
 * - 无活动（plans=[]，当前常态）→ skipped（"免费额度每日自动发放，无签到；当前无可领活动"）
 * - 有活动 → hint（提示去官方客户端领取；不自动 claim）
 * 注意：不把"无可领活动"当失败——Start Plan 本就自动发放（R026 §1）。
 */
export async function runZcodeCheckin(options: ZcodeCheckinRunOptions): Promise<CheckinResult> {
  let credential: ZcodeCheckinCredential;
  try {
    credential = options.loadCredential();
  } catch (error) {
    return checkinResult('zcode', 'skipped', `未检测到 ZCode 登录态（先打开 ZCode 登录一次）：${errorText(error)}`);
  }
  const preview = await fetchZcodePreview(credential, options);
  if (preview.kind === 'error') return checkinResult('zcode', 'error', preview.message);
  if (preview.kind === 'empty') {
    return checkinResult('zcode', 'skipped', '免费额度每日自动发放，无需签到；当前无可领活动');
  }
  return checkinResult(
    'zcode',
    'hint',
    `有可领活动（${preview.planNames.join(' / ')}），请去 ZCode 官方客户端领取`,
  );
}
