import { abortable, abortableDelay } from '../../util/abort.js';
// ZCode Start Plan 额度查询（T019，R014 §1.3.1 结论 2 合同）。
//
// GET {origin}/api/v1/zcode-plan/billing/balance，最小两头
// （Authorization: Bearer <jwt> + X-Device-Mid<非空即可>）。响应
// `{code:0,data:{balances[]}}`：balances[].{total_units,used_units,
// remaining_units,expires_at,capabilities}。语义如实映射 QuotaState：
// - 有权益余额且未过期 → ok
// - 余额为 0、或已过 expires_at（Start Plan 按日发放、当日过期）→ exhausted
// - 查不到/形状不符/429 重试后仍失败 → unknown（不编数）
//
// 另：balances[].capabilities 形如 ["model:glm-5.3-flash"]，是**权益粒度的
// 模型门**（T019 真机实证：GLM-5.2/GLM-5-Turbo 在 builtin 目录但被上游
// 400/3006 "model not allowed" 拒）。probe 据此过滤模型清单（用户裁决：
// 不虚标——挂两个点不动的模型，小白点进去吃 3006 就是无谓 BUG）。
//
// 注意 expires_at 是"当日 00:00（北京时间）"型日界：过期后新一日额度按需
// 重新发放，期间查到的 balances 可能为空——这属于 unknown，不是 exhausted。

import type { QuotaState } from '../../types.js';
import { zcodeBalanceUrl } from './endpoints.js';
import { ZcodeUpstreamError } from './error-classify.js';
import { START_PLAN_MODELS } from './catalog.js';
import { redactLogText } from '../../util/redact.js';

export interface QuotaDeps {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  retryDelayMs?: number;
  /** 整个查询（fetch/body/429等待）预算，默认 10s。 */
  timeoutMs?: number;
  signal?: AbortSignal;
  log?: (line: string) => void;
}

export interface QuotaInput {
  jwt: string;
  deviceMid: string;
}

interface BalanceEntry {
  total_units?: number;
  used_units?: number;
  remaining_units?: number;
  expires_at?: string | number;
  capabilities?: unknown;
}

interface BalanceResponse {
  code?: number;
  data?: { balances?: BalanceEntry[] };
}

/** balance 查询的完整结果（probe 用；fetchQuota 只取 state）。 */
export interface BalanceOutcome {
  state: QuotaState;
  detail: string;
  /**
   * 权益覆盖的模型 id（capabilities `model:<id>` 与固定清单不区分大小写匹配）。
   * 匹配不到任何模型 capability 时为 undefined——调用方退回固定清单。
   */
  entitledModels?: string[];
}

/** expires_at 宽松解析（ISO 字符串 / epoch 秒 / epoch 毫秒）；解析不了返回 undefined。 */
export function parseExpiry(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? undefined : ms;
  }
  if (!Number.isFinite(value)) return undefined;
  return value > 1e12 ? value : value * 1000;
}

/**
 * 从全部 balances 条目汇总 `model:*` capability，映射回固定清单模型 id。
 * `model:glm-5.3-flash` ↔ `GLM-5.3-Flash`（不区分大小写精确相等，不猜前缀）。
 */
export function entitledModelsFromCapabilities(
  balances: readonly BalanceEntry[],
  catalog: readonly string[] = START_PLAN_MODELS,
): string[] | undefined {
  const granted = new Set<string>();
  for (const entry of balances) {
    if (!Array.isArray(entry.capabilities)) continue;
    for (const capability of entry.capabilities) {
      if (typeof capability !== 'string') continue;
      if (!capability.toLowerCase().startsWith('model:')) continue;
      granted.add(capability.slice('model:'.length).toLowerCase());
    }
  }
  if (granted.size === 0) return undefined;
  const matched = catalog.filter((id) => granted.has(id.toLowerCase()));
  return matched.length > 0 ? matched : undefined;
}

export function balanceResponseToOutcome(body: unknown, nowMs: number): BalanceOutcome {
  if (body === null || typeof body !== 'object') {
    return { state: 'unknown', detail: 'balance 响应形状不符' };
  }
  const parsed = body as BalanceResponse;
  if (parsed.code !== 0) {
    return { state: 'unknown', detail: `balance 业务码 ${String(parsed.code)}` };
  }
  const balances = parsed.data?.balances;
  if (!Array.isArray(balances)) {
    return { state: 'unknown', detail: 'balance 无 balances 数组' };
  }
  if (balances.length === 0) {
    return { state: 'unknown', detail: 'balances 为空（当日额度可能尚未发放）' };
  }
  const entitledModels = entitledModelsFromCapabilities(balances);
  // 取剩余量最大的条目当 Start Plan 主权益（多条并存时保守取大）
  let best: BalanceEntry | undefined;
  for (const entry of balances) {
    if (best === undefined || (entry.remaining_units ?? 0) > (best.remaining_units ?? 0)) {
      best = entry;
    }
  }
  const main = best as BalanceEntry;
  const remaining = main.remaining_units;
  const expiry = parseExpiry(main.expires_at);
  const withEntitlement = (outcome: { state: QuotaState; detail: string }): BalanceOutcome =>
    entitledModels === undefined ? outcome : { ...outcome, entitledModels };
  if (expiry !== undefined && nowMs >= expiry) {
    return withEntitlement({
      state: 'exhausted',
      detail: `Start Plan 权益已过当日有效期（expires_at 已过）`,
    });
  }
  if (remaining === undefined) {
    return { state: 'unknown', detail: 'balance 条目缺 remaining_units' };
  }
  return withEntitlement(
    remaining > 0
      ? { state: 'ok', detail: `剩余 ${remaining} units` }
      : { state: 'exhausted', detail: 'remaining_units = 0' },
  );
}

export async function fetchZcodeBalance(input: QuotaInput, deps: QuotaDeps = {}): Promise<BalanceOutcome> {
  const doFetch = deps.fetchImpl ?? fetch;
  const url = zcodeBalanceUrl(deps.env);
  const retryDelayMs = deps.retryDelayMs ?? 1200;

  const controller = new AbortController();
  const signal = deps.signal === undefined ? controller.signal : AbortSignal.any([deps.signal, controller.signal]);
  const timer = setTimeout(() => controller.abort(new Error('balance 查询超时')), deps.timeoutMs ?? 10_000);
  const bounded = <T>(work: Promise<T>) => abortable(work, signal);
  try {
  signal.throwIfAborted();
  for (let attempt = 0; ; attempt += 1) {
    signal.throwIfAborted();
    let response: Response;
    try {
      response = await bounded(doFetch(url, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${input.jwt}`,
          'x-device-mid': input.deviceMid,
        },
        signal,
      }));
    } catch (error) {
      deps.log?.(redactLogText(`[zcode-quota] balance 请求失败：${(error as Error).message}`, 300, [input.jwt]));
      return { state: 'unknown', detail: '网络失败' };
    }
    if (response.status === 429 && attempt === 0) {
      // 限流间歇出现（R014 §4.5）：歇一下重试一次，别把限流当不可用
      deps.log?.(`[zcode-quota] HTTP 429，${retryDelayMs}ms 后重试`);
      await abortableDelay(retryDelayMs, signal);
      continue;
    }
    if (response.status === 401) {
      throw new ZcodeUpstreamError('relogin', ZcodeUpstreamReloginMessage, { status: 401 });
    }
    let body: unknown = undefined;
    try {
      body = JSON.parse(await bounded(response.text())) as unknown;
    } catch {
      body = undefined;
    }
    return balanceResponseToOutcome(body, Date.now());
  }
  } catch (error) {
    if (error instanceof ZcodeUpstreamError) throw error;
    return { state: 'unknown', detail: signal.aborted ? '查询超时或取消' : '网络失败' };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/** QuotaState 薄包装（adapter fetchQuota 用）。 */
export async function fetchZcodeQuota(input: QuotaInput, deps: QuotaDeps = {}): Promise<QuotaState> {
  return (await fetchZcodeBalance(input, deps)).state;
}

export const ZcodeUpstreamReloginMessage =
  'ZCode 登录态已失效（balance 401）：JWT 无 refresh 流程，请在 ZCode 客户端重新登录后重试';
