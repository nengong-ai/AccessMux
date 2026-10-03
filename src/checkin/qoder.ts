// Qoder CN 每日活动领取（T027；docs/source-spec-checkin.md §3 合同）。
//
// 链路（两个参考实现逐行核对：sunp-1/qoder-checkin v1.2.0 + masknull/
// dsh-qoder-connect src/qoder/transport）：
//   1. POST {base}/api/v1/jobToken/exchange  body {"personal_token": <PAT>}
//      → {"token": <jobToken>}          （PAT 换业务 token，PAT 只是入口）
//   2. GET  {base}/sash/api/v1/me/campaigns          （头必须带 Cosy-ClientType: 10）
//   3. POST {base}/sash/api/v1/me/campaigns/{id}/claim（幂等）
//
// 软门：Cosy-ClientType=10 缺省时服务端 200 但 campaigns 恒空（dsh 实测注释）。
// 设备头：macOS 一律不带 Cosy-Machine*（脚本非 Windows 即"按普通请求继续"；
// 红线：不模拟/不伪造设备指纹）。若上游对无设备头不下发活动，本模块如实报
// "活动未下发/不可用"，不升级手段（任务包中途回报条件）。
//
// 安全：PAT 只被读到进程内、只用于换 token；任何日志/错误消息不回显原值。

import type { CheckinResult } from './types.js';
import { asNumber, checkinResult, errorText, safeCheckinText } from './types.js';

export const QODER_CHECKIN_BASE_ENV = 'ACCESSMUX_QODER_CHECKIN_BASE';
/** 国内版 base（本机 Qoder CN 登录态对应；国际版是 openapi.qoder.sh）。 */
export const DEFAULT_QODER_CHECKIN_BASE = 'https://openapi.qoder.com.cn';
export const QODER_CHECKIN_TIMEOUT_MS = 20_000;
/** 桌面客户端标识；campaigns/claim 缺它就 200 空列表（软门，R026 §3.1）。 */
export const QODER_DESKTOP_CLIENT_TYPE = '10';
/** 通用客户端标识；exchange 走它（dsh-qoder-connect 默认头实测可用）。 */
export const QODER_GENERIC_CLIENT_TYPE = '5';
/** UA：两个参考实现都带（dsh-qoder-connect 的验证值）。 */
export const QODER_USER_AGENT = 'qoder/1.1.47';

export function qoderCheckinBase(env: Record<string, string | undefined> = process.env): string {
  const override = env[QODER_CHECKIN_BASE_ENV]?.trim();
  return override !== undefined && override !== '' ? override.replace(/\/+$/, '') : DEFAULT_QODER_CHECKIN_BASE;
}

export interface QoderCheckinDeps {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  log?: (line: string) => void;
}

function jsonHeaders(clientType: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': QODER_USER_AGENT,
    'Cosy-ClientType': clientType,
    ...extra,
  };
}

export interface QoderCampaign {
  campaignId: string;
  campaignKey?: string;
  actionType?: string;
  claimStatus?: string;
  benefitAmount?: number;
  /** T038：只有模型绑定明确的活动才可影响模型倍率；签到奖励金额不能代替倍率。 */
  modelIds?: string[];
  creditMultiplier?: number;
  active?: boolean;
  startTime?: string;
  endTime?: string;
}

interface QoderCampaignsPayload {
  campaigns?: unknown;
}

function parseCampaigns(payload: unknown): QoderCampaign[] | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined;
  const list = (payload as QoderCampaignsPayload).campaigns;
  if (!Array.isArray(list)) return undefined;
  const out: QoderCampaign[] = [];
  for (const raw of list) {
    if (typeof raw !== 'object' || raw === null) continue;
    const record = raw as Record<string, unknown>;
    const campaignId = record['campaignId'];
    if (typeof campaignId !== 'string' || campaignId === '') continue;
    const benefit = typeof record['benefit'] === 'object' && record['benefit'] !== null
      ? record['benefit'] as Record<string, unknown>
      : undefined;
    out.push({
      campaignId,
      ...(typeof record['campaignKey'] === 'string' ? { campaignKey: record['campaignKey'] } : {}),
      ...(typeof record['actionType'] === 'string' ? { actionType: record['actionType'] } : {}),
      ...(typeof record['claimStatus'] === 'string' ? { claimStatus: record['claimStatus'] } : {}),
      ...(benefit === undefined || asNumber(benefit['amount']) === undefined ? {} : { benefitAmount: asNumber(benefit['amount']) as number }),
      ...(Array.isArray(record['modelIds']) ? { modelIds: record['modelIds'].filter((v): v is string => typeof v === 'string') } : {}),
      ...(typeof record['creditMultiplier'] === 'number' && Number.isFinite(record['creditMultiplier']) && record['creditMultiplier'] >= 0 ? { creditMultiplier: record['creditMultiplier'] } : {}),
      ...(typeof record['active'] === 'boolean' ? { active: record['active'] } : {}),
      ...(typeof record['startTime'] === 'string' ? { startTime: record['startTime'] } : {}),
      ...(typeof record['endTime'] === 'string' ? { endTime: record['endTime'] } : {}),
    });
  }
  return out;
}

/** 错误对象里可能带 HTTP 状态；不抛二次错。 */
class QoderHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`响应不是 JSON（HTTP ${response.status}）`);
  }
}

/**
 * PAT → jobToken（exchange）。失败抛错（带 HTTP 状态，不含原值）。
 * exchange 用通用 clientType（campaigns/claim 才需要桌面标识 10）。
 */
export async function exchangeQoderPat(
  pat: string,
  deps: QoderCheckinDeps = {},
): Promise<{ token: string; expiresAtMs?: number }> {
  const doFetch = deps.fetchImpl ?? fetch;
  const base = qoderCheckinBase(deps.env);
  const response = await doFetch(`${base}/api/v1/jobToken/exchange`, {
    method: 'POST',
    headers: jsonHeaders(QODER_GENERIC_CLIENT_TYPE),
    body: JSON.stringify({ personal_token: pat }),
    signal: AbortSignal.timeout(deps.timeoutMs ?? QODER_CHECKIN_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new QoderHttpError(`PAT 换 token 失败（HTTP ${response.status}）`, response.status);
  }
  const payload = await readJson(response);
  if (typeof payload !== 'object' || payload === null) throw new Error('exchange 响应形状不符');
  const record = payload as Record<string, unknown>;
  const token = record['token'] ?? record['accessToken'] ?? record['access_token'];
  if (typeof token !== 'string' || token === '') {
    throw new QoderHttpError('PAT 换 token 失败（响应无 token，PAT 可能无效）', 0);
  }
  const expiresAtMs = (() => {
    const fromAt = typeof record['expires_at'] === 'string' ? Date.parse(record['expires_at']) : NaN;
    if (!Number.isNaN(fromAt)) return fromAt;
    const expiresIn = asNumber(record['expires_in']);
    return expiresIn === undefined || expiresIn <= 0 ? undefined : Date.now() + expiresIn * 1000;
  })();
  return { token, ...(expiresAtMs === undefined ? {} : { expiresAtMs }) };
}

/** 拉活动列表（Cosy-ClientType=10 软门）。 */
export async function fetchQoderCampaigns(
  jobToken: string,
  deps: QoderCheckinDeps = {},
): Promise<QoderCampaign[]> {
  const doFetch = deps.fetchImpl ?? fetch;
  const base = qoderCheckinBase(deps.env);
  const response = await doFetch(`${base}/sash/api/v1/me/campaigns`, {
    method: 'GET',
    headers: jsonHeaders(QODER_DESKTOP_CLIENT_TYPE, { 'Authorization': `Bearer ${jobToken}` }),
    signal: AbortSignal.timeout(deps.timeoutMs ?? QODER_CHECKIN_TIMEOUT_MS),
  });
  if (!response.ok) throw new QoderHttpError(`活动列表查询失败（HTTP ${response.status}）`, response.status);
  const campaigns = parseCampaigns(await readJson(response));
  if (campaigns === undefined) throw new Error('活动列表响应形状不符');
  return campaigns;
}

export type QoderClaimOutcome =
  | { kind: 'claimed'; credits?: number; replayed: boolean }
  | { kind: 'error'; message: string };

/** 领取（幂等：replayed=true 表示服务端判定重复领）。 */
export async function claimQoderCampaign(
  jobToken: string,
  campaignId: string,
  deps: QoderCheckinDeps = {},
): Promise<QoderClaimOutcome> {
  const doFetch = deps.fetchImpl ?? fetch;
  const base = qoderCheckinBase(deps.env);
  let response: Response;
  try {
    response = await doFetch(`${base}/sash/api/v1/me/campaigns/${encodeURIComponent(campaignId)}/claim`, {
      method: 'POST',
      headers: jsonHeaders(QODER_DESKTOP_CLIENT_TYPE, {
        'Authorization': `Bearer ${jobToken}`,
        // dsh-qoder-connect 的 claim 参考头：origin = openApiUrl
        'Origin': base,
      }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? QODER_CHECKIN_TIMEOUT_MS),
    });
  } catch (error) {
    return { kind: 'error', message: `网络失败：${errorText(error, [jobToken])}` };
  }
  if (!response.ok) return { kind: 'error', message: `领取失败（HTTP ${response.status}）` };
  let payload: unknown;
  try {
    payload = await readJson(response);
  } catch (error) {
    return { kind: 'error', message: errorText(error, [jobToken]) };
  }
  const data = (() => {
    if (typeof payload !== 'object' || payload === null) return undefined;
    const record = payload as Record<string, unknown>;
    return typeof record['data'] === 'object' && record['data'] !== null
      ? record['data'] as Record<string, unknown>
      : record;
  })();
  if (data === undefined) return { kind: 'error', message: '领取响应形状不符' };
  const status = data['status'];
  const benefit = typeof data['benefit'] === 'object' && data['benefit'] !== null
    ? data['benefit'] as Record<string, unknown>
    : undefined;
  const credits = benefit === undefined ? undefined : asNumber(benefit['amount']);
  if (status === 'CLAIMED') {
    return {
      kind: 'claimed',
      replayed: data['replayed'] === true,
      ...(credits === undefined ? {} : { credits }),
    };
  }
  return { kind: 'error', message: `领取返回状态异常（${typeof status === 'string' ? safeCheckinText(status, [jobToken]) : '未知'}）` };
}

export interface QoderCheckinRunOptions extends QoderCheckinDeps {
  /** PAT 解析（生产从配置读；测试注入）。空/缺失 → 跳过+原因。 */
  resolvePat: () => string | undefined;
}

function pickBenefitCampaign(campaigns: readonly QoderCampaign[]): QoderCampaign | undefined {
  // 只处理"领福利"类活动（actionType=CLAIM_BENEFIT），优先可领的
  const benefits = campaigns.filter((c) => c.actionType === undefined || c.actionType === 'CLAIM_BENEFIT');
  return benefits.find((c) => c.claimStatus === 'CLAIMABLE') ?? benefits[0];
}

/**
 * 一次 Qoder 签到：PAT → token → campaigns → claim。
 * - 未配 PAT → skipped（原因=未配置，指引已打印在 onboard/文档）
 * - campaigns 为空 → inactive（"今日无活动下发"如实报告，不猜）
 * - claimStatus=CLAIMED → already（不重复 claim）
 */
export async function runQoderCheckin(options: QoderCheckinRunOptions): Promise<CheckinResult> {
  const pat = options.resolvePat();
  if (pat === undefined || pat.trim() === '') {
    return checkinResult('qoder', 'skipped', '未配置 PAT（在 qoder.com.cn 账号设置生成，见 onboard 指引）');
  }
  let jobToken: string;
  try {
    jobToken = (await exchangeQoderPat(pat.trim(), options)).token;
  } catch (error) {
    // 换 token 的 4xx（400/401/403…）都意味着 PAT 不可用（真机实测无效 PAT → HTTP 400）
    if (error instanceof QoderHttpError && error.status >= 400 && error.status < 500) {
      return checkinResult('qoder', 'skipped', `PAT 无效或已过期（HTTP ${error.status}），请重新生成`);
    }
    return checkinResult('qoder', 'error', `PAT 换 token 失败：${errorText(error, [pat.trim()])}`);
  }
  let campaigns: QoderCampaign[];
  try {
    campaigns = await fetchQoderCampaigns(jobToken, options);
  } catch (error) {
    if (error instanceof QoderHttpError && (error.status === 401 || error.status === 403)) {
      return checkinResult('qoder', 'skipped', 'token 被拒（可能 PAT 已轮换），请重新生成 PAT');
    }
    return checkinResult('qoder', 'error', `活动列表查询失败：${errorText(error, [pat.trim(), jobToken])}`);
  }
  const campaign = pickBenefitCampaign(campaigns);
  if (campaign === undefined) {
    return checkinResult('qoder', 'inactive', '今日无活动下发（活动未开始/已结束，或服务端未对账号开放）');
  }
  if (campaign.claimStatus === 'CLAIMED') {
    return checkinResult('qoder', 'already', `今日已领${campaign.benefitAmount === undefined ? '' : `（+${campaign.benefitAmount} Credits）`}`);
  }
  const claim = await claimQoderCampaign(jobToken, campaign.campaignId, options);
  if (claim.kind === 'error') return checkinResult('qoder', 'error', safeCheckinText(claim.message, [pat.trim(), jobToken]));
  if (claim.replayed) {
    return checkinResult('qoder', 'already', `今日已领${claim.credits === undefined ? '' : `（+${claim.credits} Credits，服务端幂等回执）`}`);
  }
  return checkinResult('qoder', 'claimed', claim.credits === undefined ? '领取成功' : `领取成功（+${claim.credits} Credits）`);
}
