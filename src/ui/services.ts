// 本地 UI 的只读宿主检测与进程内签到状态；不接入宿主、不写领取历史。
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProviderAdapter } from '../adapters/types.js';
import type { Config, ConfigStore } from '../config/index.js';
import { runCheckinAll, type CheckinOptions } from '../checkin/index.js';
import { readQoderPat } from '../checkin/pat-store.js';
import type { CheckinResult } from '../checkin/types.js';
import { allHosts, type HostContext, type HostDef } from '../onboard/hosts.js';
import type { ModelInfo, QuotaState } from '../types.js';
import { adapterEnabled, probeWithBudgetDetailed } from '../protocol/control-plane.js';
import { redactLogText } from '../util/redact.js';
import { modelDirectoryEntry, publicModelLimits, publicModelMetadata } from './model-badges.js';

export interface UiTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
}

/** 所有可能触及本机/上游的依赖均可替换，测试不用真实 HOME、PAT 或领取链。 */
export interface UiServicesOptions {
  homeDir?: string;
  repoRoot?: string;
  allHosts?: () => readonly HostDef[];
  runCheckin?: (options: CheckinOptions) => Promise<CheckinResult[]>;
  readPat?: () => string | undefined;
  now?: () => Date;
  timers?: UiTimers;
  adapterTimeoutMs?: number;
  autoIntervalMs?: number;
  env?: Record<string, string | undefined>;
}

export type UiSourceState = 'not-installed' | 'logged-out' | 'disabled' | 'environment-disabled' | 'probing' | 'failed' | 'ready' | 'unconfirmed';

export interface UiAdapterInfo {
  id: string;
  displayName: string;
  sandbox: ProviderAdapter['sandbox'];
  enabled: boolean;
  form?: 'direct' | 'app-server' | 'unavailable';
  reason?: string;
  fallbackAvailable?: boolean;
  tools?: 'disabled';
  auth: 'logged-in' | 'logged-out' | 'unknown';
  availability: string;
  sourceState: UiSourceState;
  sourceMessage: string;
  nextAction: string;
  directoryReady: boolean;
  checkedAt?: string;
  catalogSource?: 'current' | 'cache' | 'fallback';
  reasonCode?: string;
  quota: QuotaState;
  quotaMessage: string;
  models: Array<ModelInfo & { bridgeInputModalities: ['text'] | ['text', 'image'] }>;
}

// 与 probeWithBudget 同口径：挂起 quota 未退出前，不因浏览器刷新无限启动上游工作。
const pendingQuota = new WeakMap<ProviderAdapter, Promise<QuotaState>>();
async function quotaWithBudget(adapter: ProviderAdapter, timeoutMs: number): Promise<QuotaState | undefined> {
  if (pendingQuota.has(adapter)) return undefined;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = Promise.resolve().then(() =>
    adapter.fetchQuota({ signal: controller.signal }),
  );
  pendingQuota.set(adapter, work);
  void work.then(() => pendingQuota.delete(adapter), () => pendingQuota.delete(adapter));
  try {
    return await Promise.race([
      work,
      new Promise<undefined>((done) => {
        timer = setTimeout(() => {
          controller.abort();
          done(undefined);
        }, timeoutMs);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** probe / quota 分别限时，单源失败不能拖住其它源，也不透传异常内容。 */
const LAST_MODELS = new WeakMap<ProviderAdapter, ModelInfo[]>();
const ADAPTER_DISPLAY_NAMES: Record<string, string> = {
  workbuddy: 'WorkBuddy', 'trae-cn': 'Trae CN', 'trae-global': 'Trae Global',
  opencode: 'OpenCode', qoder: 'Qoder', zcode: 'ZCode Start Plan',
};

export async function snapshotAdapterInfo(
  adapters: ProviderAdapter[],
  config: Config,
  timeoutMs = 5_000,
  options: { forceRefresh?: boolean; env?: Record<string, string | undefined> } = {},
): Promise<UiAdapterInfo[]> {
  const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5_000;
  const registered = new Set(adapters.map((a) => a.id));
  const knownDisabled = new Set((options.env ?? process.env).ACCESSMUX_DISABLE_ADAPTERS?.split(',').map((v) => v.trim()).filter(Boolean) ?? []);
  const snapshots = await Promise.all(adapters.map(async (adapter) => {
    const enabled = adapterEnabled(adapter.id, config, options.env ?? process.env);
    const [attempt, rawQuota] = enabled ? await Promise.all([
      probeWithBudgetDetailed(adapter, budget, { forceRefresh: options.forceRefresh }),
      quotaWithBudget(adapter, budget),
    ]) : [undefined, undefined];
    const probe = attempt?.result;
    const checkedAt = attempt?.checkedAt;
    const previous = LAST_MODELS.get(adapter) ?? [];
    const readyDirectory = enabled && attempt?.status === 'ready' && probe?.availability === 'available' && probe.reasonCode !== 'catalog-unavailable'
      && probe.catalogSource !== 'fallback' && probe.models.length > 0 && probe.auth !== 'logged-out';
    if (readyDirectory && probe) {
      const merged = mergeCatalogFees(LAST_MODELS.get(adapter) ?? [], probe.models, checkedAt);
      LAST_MODELS.set(adapter, merged);
    }
    const quota: QuotaState = rawQuota === 'ok' || rawQuota === 'exhausted' ? rawQuota : 'unknown';
    let models: UiAdapterInfo['models'] = [];
    try {
      const availableModels = probe?.catalogSource === 'fallback' || probe?.auth === 'logged-out'
        ? [] : readyDirectory ? LAST_MODELS.get(adapter) ?? probe!.models : attempt?.status === 'ready' ? [] : previous;
      models = availableModels.map((rawModel) => {
        const model = readyDirectory ? rawModel : {
          ...rawModel, feeFreshness: rawModel.feeFreshness === 'unknown' ? 'unknown' as const : 'failed' as const,
          feeErrorCode: attempt?.status === 'timeout' ? 'timeout' as const : 'fetch-failed' as const,
        };
        // T036：亮标 = 源图片路径点亮（adapter.bridgeImages）&& 模型有视觉
        // （inputModalities 含 image）；其余组合保持纯文本灰标，不虚标。
        return projectUiModel(adapter, model);
      });
    } catch {
      // 目录形状异常仍隔离到这一源；其它源及此源的额度状态保留。
    }
    let formInfo: Pick<UiAdapterInfo, 'form' | 'reason' | 'fallbackAvailable' | 'tools'> = {};
    if (enabled) {
      try {
        const snapshot = (adapter as ProviderAdapter & { formSnapshot?: () => { form: unknown; reason?: unknown; fallbackAvailable?: unknown; tools?: unknown } }).formSnapshot?.();
        if (snapshot?.form === 'direct' || snapshot?.form === 'app-server' || snapshot?.form === 'unavailable') formInfo = {
          form: snapshot.form,
          ...(typeof snapshot.reason === 'string' ? { reason: redactLogText(snapshot.reason, 300, [config.qoder?.pat ?? '']) } : {}),
          ...(typeof snapshot.fallbackAvailable === 'boolean' ? { fallbackAvailable: snapshot.fallbackAvailable } : {}),
          ...(snapshot.tools === 'disabled' ? { tools: 'disabled' as const } : {}),
        };
      } catch { /* 保留 T031 状态灯，失败仍不拖垮控制面。 */ }
    }
    let sourceState: UiSourceState;
    let sourceMessage: string;
    let nextAction: string;
    if (!enabled) { sourceState = knownDisabled.has(adapter.id) ? 'environment-disabled' : 'disabled'; sourceMessage = sourceState === 'environment-disabled' ? '被启动环境禁用' : '配置中已关闭'; nextAction = sourceState === 'environment-disabled' ? '移除禁用设置后重启 AccessMux' : '在此启用后刷新'; }
    else if (probe?.reasonCode === 'not-installed') { sourceState = 'not-installed'; sourceMessage = '没有找到对应客户端'; nextAction = '安装对应官方客户端后刷新'; }
    else if (probe?.reasonCode === 'credential-unavailable') { sourceState = 'failed'; sourceMessage = '登录信息暂无法读取'; nextAction = '检查官方客户端安装位置与本地访问是否正常，再刷新；无需提供密钥'; }
    else if (probe?.auth === 'logged-out') { sourceState = 'logged-out'; sourceMessage = '未登录或登录已失效'; nextAction = '在对应应用重新登录，再刷新状态'; }
    else if (readyDirectory) { sourceState = 'ready'; sourceMessage = adapter.id === 'opencode' ? '目录就绪，无需登录' : probe?.auth === 'unknown' ? '目录已取得，登录态未确认' : '目录已取得'; nextAction = probe?.auth === 'unknown' && adapter.id !== 'opencode' ? '使用前请在对应应用确认登录；此状态不代表调用已验证' : '可查看并选择已取得的模型'; }
    else if (attempt?.status === 'pending') { sourceState = 'probing'; sourceMessage = '已有探测仍在进行'; nextAction = '等待当前探测结束后再刷新'; }
    else if (probe?.reasonCode === 'catalog-unavailable' || attempt?.status === 'timeout' || attempt?.status === 'failed') { sourceState = 'failed'; sourceMessage = attempt?.status === 'timeout' ? '探测超时' : '本次目录或元数据未更新'; nextAction = '稍后重试；保留上次目录与费用结果'; }
    else if (probe?.catalogSource === 'fallback' || probe?.availability === 'unverified') { sourceState = 'unconfirmed'; sourceMessage = probe?.reasonCode === 'catalog-fallback' ? '当前只有候选目录，尚未取得实时目录' : '目录或访问条件未确认'; nextAction = probe?.auth === 'logged-in' ? '检查网络和来源服务后刷新' : '按提示检查对应应用或登录状态'; }
    else { sourceState = 'unconfirmed'; sourceMessage = '目录与访问状态未确认'; nextAction = '检查对应应用状态后刷新'; }
    return {
      id: adapter.id,
      displayName: adapter.displayName,
      sandbox: adapter.sandbox,
      enabled,
      ...formInfo,
      auth: probe?.auth ?? 'unknown',
      availability: enabled ? (probe?.availability ?? 'unverified') : 'disabled',
      sourceState, sourceMessage, nextAction, directoryReady: readyDirectory,
      ...(checkedAt === undefined ? {} : { checkedAt }),
      ...(probe?.catalogSource === undefined ? {} : { catalogSource: probe.catalogSource }),
      ...(probe?.reasonCode === undefined ? {} : { reasonCode: probe.reasonCode }),
      ...(!readyDirectory && (previous.length || probe?.catalogSource === 'cache' && probe.reasonCode === 'catalog-unavailable') ? { historyModels: (previous.length ? previous : probe!.models).map((model) => projectUiModel(adapter, { ...model, feeFreshness: 'failed', feeErrorCode: attempt?.status === 'timeout' ? 'timeout' : 'fetch-failed' })) } : {}),
      quota,
      quotaMessage: `${quota === 'ok' ? '额度可用' : quota === 'exhausted' ? '额度已用尽' : '额度状态未知'}；上游未提供具体余量`,
      models,
    };
  }));
  const missing = [...knownDisabled].filter((id) => !registered.has(id) && ADAPTER_DISPLAY_NAMES[id]).map((id) => ({
    id, displayName: ADAPTER_DISPLAY_NAMES[id]!, sandbox: 'none' as const, enabled: false, auth: 'unknown' as const,
    availability: 'disabled', sourceState: 'environment-disabled' as const, sourceMessage: '被启动环境禁用',
    nextAction: '调整服务启动环境后重启', directoryReady: false, quota: 'unknown' as const,
    quotaMessage: '禁用状态下未查询额度', models: [],
  }));
  return [...snapshots, ...missing].sort((a, b) => (Object.keys(ADAPTER_DISPLAY_NAMES).indexOf(a.id) - Object.keys(ADAPTER_DISPLAY_NAMES).indexOf(b.id)));
}

function projectUiModel(adapter: ProviderAdapter, model: ModelInfo): UiAdapterInfo['models'][number] {
  const imagesOn = adapter.bridgeImages === true && Array.isArray(model.inputModalities) && model.inputModalities.includes('image');
  return {
    id: model.id, provider: model.provider,
    ...(Array.isArray(model.tags) ? { tags: model.tags.filter((tag) => typeof tag === 'string') } : {}),
    ...publicModelLimits(model), ...publicModelMetadata(model),
    bridgeInputModalities: imagesOn ? ['text', 'image'] as const : ['text'] as const,
  };
}

const feeKeys = ['priceMultiplier', 'priceSnapshot', 'free', 'freeSource', 'freeActivity', 'feeFreshness', 'feeCheckedAt', 'feeErrorCode'] as const;
function feeOrigin(model: ModelInfo): string | undefined {
  const price = typeof model.priceMultiplier === 'object' ? model.priceMultiplier.source.updated_at : model.priceSnapshot?.source.updated_at;
  return model.freeSource?.updated_at ?? price;
}
function hasFeeEvidence(model: ModelInfo): boolean {
  return model.freeSource !== undefined || model.priceSnapshot !== undefined || typeof model.priceMultiplier === 'object';
}
/** 以完整路由模型为边界合并；未知字段沿用旧值并标旧，明确相反证据会清掉旧倍率。 */
export function mergeCatalogFees(previous: ModelInfo[], incoming: ModelInfo[], checkedAt = new Date().toISOString()): ModelInfo[] {
  const oldById = new Map(previous.map((model) => [`${model.provider}\0${model.id}`, model]));
  return incoming.map((next) => {
    const old = oldById.get(`${next.provider}\0${next.id}`);
    if (!old) return { ...next, feeFreshness: next.feeFreshness ?? (hasFeeEvidence(next) ? 'fresh' : 'unknown'), ...(hasFeeEvidence(next) ? { feeCheckedAt: checkedAt } : {}) };
    const oldTime = feeOrigin(old); const newTime = feeOrigin(next);
    if (!hasFeeEvidence(next) || next.feeFreshness === 'failed' || next.feeFreshness === 'stale' || oldTime && newTime && Date.parse(newTime) < Date.parse(oldTime)) {
      const merged = { ...next } as ModelInfo & Record<string, unknown>;
      for (const key of feeKeys) delete merged[key];
      const mergedFields = merged as Record<string, unknown>;
      for (const key of feeKeys) if (old[key] !== undefined) mergedFields[key] = old[key];
      merged.feeFreshness = next.feeFreshness === 'failed' ? 'failed' : 'stale'; merged.feeCheckedAt = checkedAt;
      return merged;
    }
    const merged = { ...next } as ModelInfo & Record<string, unknown>;
    // A sourced change in free status is authoritative even when its multiplier is omitted.
    if (next.freeSource && typeof next.free === 'boolean' && next.priceMultiplier === undefined && next.priceSnapshot === undefined) {
      delete merged.priceMultiplier; delete merged.priceSnapshot;
    }
    // A newly evidenced free value without a rate must not inherit a previous paid multiplier.
    if (next.free === true && next.freeSource && next.priceMultiplier === undefined && next.priceSnapshot === undefined) {
      delete merged.priceMultiplier; delete merged.priceSnapshot;
    }
    if (next.feeFreshness === undefined) merged.feeFreshness = 'fresh';
    merged.feeCheckedAt = checkedAt;
    return merged;
  });
}

/** 配置返回必须重新组装公开字段，不能用删掉 pat 后的浅拷贝。 */
export function publicUiConfig(config: Config): Omit<Config, 'qoder'> {
  const sources = config.checkin?.sources;
  return {
    version: config.version,
    output: {
      port: config.output.port,
      host: config.output.host,
      protocol: config.output.protocol,
      exposeAnthropic: config.output.exposeAnthropic,
    },
    adapters: Object.fromEntries(Object.entries(config.adapters).map(([id, entry]) => [id, { enabled: entry.enabled }])),
    models: {
      allow: Object.fromEntries(Object.entries(config.models.allow).map(([id, models]) => [
        id, Object.fromEntries(Object.entries(models).filter(([, enabled]) => typeof enabled === 'boolean')),
      ])),
    },
    ...(config.checkin === undefined ? {} : {
      checkin: {
        ...(sources === undefined ? {} : {
          sources: {
            ...(typeof sources.workbuddy === 'boolean' ? { workbuddy: sources.workbuddy } : {}),
            ...(typeof sources.qoder === 'boolean' ? { qoder: sources.qoder } : {}),
            ...(typeof sources.zcode === 'boolean' ? { zcode: sources.zcode } : {}),
          },
        }),
      },
    }),
  };
}

/** 防 DNS rebinding / CSRF：Host 为 loopback，浏览器 Origin 必须同源。 */
export function safeUiMutation(headers: {
  host?: string;
  origin?: string;
  fetchSite?: string;
}, protocol: string, ip: string): boolean {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip)) return false;
  if (headers.fetchSite === 'cross-site') return false;
  if (headers.host === undefined || !/^(localhost|127\.0\.0\.1|\[::1\])(?::[1-9]\d{0,4})?$/i.test(headers.host)) return false;
  try {
    const expected = new URL(`${protocol}://${headers.host}`);
    if (expected.protocol !== 'http:' && expected.protocol !== 'https:') return false;
    if (headers.origin === undefined) return true; // 本地 CLI / 离线 inject，无浏览器 Origin。
    const origin = new URL(headers.origin);
    return origin.origin === headers.origin && origin.origin === expected.origin;
  } catch {
    return false;
  }
}

export interface UiHostInfo {
  id: string;
  name: string;
  kind: HostDef['kind'];
  status: 'onboarded' | 'not-onboarded' | 'unknown';
  statusLabel: string;
  message?: string;
}

export type UiCheckinSource = 'workbuddy' | 'qoder' | 'trae-cn' | 'zcode';
type OperableSource = 'workbuddy' | 'qoder';
type SafeVerdict = 'claimed' | 'already' | 'inactive' | 'skipped' | 'error';

export interface UiCheckinResult {
  source: OperableSource;
  verdict: SafeVerdict;
  message: string;
  checkedAt: string;
}

export interface UiCheckinState {
  sources: Array<{
    source: UiCheckinSource;
    name: string;
    supported: boolean;
    enabled: boolean;
    status: 'unqueried' | 'running' | SafeVerdict;
    message: string;
    checkedAt?: string;
  }>;
}

export class UiServiceError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

const OPERABLE = ['workbuddy', 'qoder'] as const;
const CHECKIN_SOURCE_NAMES = { workbuddy: 'WorkBuddy', qoder: 'Qoder', 'trae-cn': 'Trae CN', zcode: 'ZCode' } as const;
const UNSUPPORTED = {
  'trae-cn': '不支持：需设备身份校验，本项目不提供',
  zcode: '免费额度每日自动发放，无需签到',
} as const;
const DEFAULT_TIMERS: UiTimers = {
  setTimeout(callback, delayMs) { return setTimeout(callback, delayMs).unref(); },
  clearTimeout(timer) { clearTimeout(timer as ReturnType<typeof setTimeout>); },
};

/** 两个可领源都是国内活动，日界按北京时间；不保存到文件、不跨进程记账。 */
function checkinDay(now: Date): string {
  return new Date(now.getTime() + 8 * 60 * 60 * 1_000).toISOString().slice(0, 10);
}

function safeCheckinResult(source: OperableSource, result: CheckinResult | undefined, now: Date): UiCheckinResult {
  const verdict: SafeVerdict = result !== undefined && ['claimed', 'already', 'inactive', 'skipped', 'error'].includes(result.verdict)
    ? result.verdict as SafeVerdict : 'error';
  const defaults: Record<SafeVerdict, string> = {
    claimed: '领取成功', already: '今日已领', inactive: '活动未开放或未下发',
    skipped: '未能领取，请检查该源登录状态或本地领取配置', error: '领取失败，请稍后重试',
  };
  let message = defaults[verdict];
  // 只接受原模块固定的金额/连签模板；任何上游 msg、异常/路径/凭据都不能混进来。
  if ((verdict === 'claimed' || verdict === 'already') && typeof result?.message === 'string') {
    const number = '\\d{1,9}(?:\\.\\d{1,6})?';
    const details = `(?:\\+${number} [Cc]redits(?:，连签 ${number} 天|，服务端幂等回执)?|连签 ${number} 天|服务端幂等回执)`;
    if (new RegExp(`^(?:领取成功|今日已领)(?:（${details}）)?$`).test(result.message)) message = result.message;
  }
  return { source, verdict, message, checkedAt: now.toISOString() };
}

interface AutoAttempt {
  day: string;
  attempts: number;
  done: boolean;
  retryAt: number;
}

export function createUiServices(store: ConfigStore, options: UiServicesOptions = {}) {
  const homeDir = options.homeDir ?? homedir();
  const repoRoot = options.repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const hostDefs = options.allHosts ?? allHosts;
  const runCheckin = options.runCheckin ?? runCheckinAll;
  const readPat = options.readPat ?? readQoderPat;
  const now = options.now ?? (() => new Date());
  const timers = options.timers ?? DEFAULT_TIMERS;
  const interval = options.autoIntervalMs !== undefined && options.autoIntervalMs > 0 ? options.autoIntervalMs : 60_000;
  const results = new Map<OperableSource, UiCheckinResult>();
  const inflight = new Map<OperableSource, Promise<UiCheckinResult>>();
  const attempts = new Map<OperableSource, AutoAttempt>();
  const knownInstalled = new Set<string>();
  let started = false;
  let closed = false;
  let timer: unknown;

  function enabled(source: OperableSource): boolean {
    // CLI 的缺省全开不适用于常驻服务：只有用户显式勾选才允许后台领取。
    return store.get().checkin?.sources?.[source] === true;
  }

  function hostContext(modelIds: string[] = [], modelDescriptions?: Record<string, { name: string }>): HostContext {
    const port = store.get().output.port;
    return {
      homeDir, repoRoot, port, baseURL: `http://127.0.0.1:${port}`, modelIds,
      ...(modelDescriptions === undefined ? {} : { modelDescriptions }),
      fetchFn: async () => { throw new Error('UI 宿主检测和引导不执行请求'); },
      now,
    };
  }

  function hosts(): { hosts: UiHostInfo[]; message?: string } {
    const out: UiHostInfo[] = [];
    let failed = false;
    for (const def of hostDefs()) {
      try {
        const detected = def.detect(hostContext());
        if (!detected.installed) { knownInstalled.delete(def.id); continue; }
        knownInstalled.add(def.id);
        // 当前 guide 定义只会检测安装目录，不会检测是否已接入。
        const status = def.kind === 'guide' || detected.onboarded === undefined ? 'unknown'
          : detected.onboarded ? 'onboarded' : 'not-onboarded';
        out.push({
          id: def.id, name: def.name, kind: def.kind, status,
          statusLabel: status === 'onboarded' ? '已接入' : status === 'not-onboarded' ? '未接入' : '未确认',
          ...(status === 'unknown' ? { message: '未确认：此宿主的接入状态暂不能确定' } : {}),
        });
      } catch {
        failed = true;
        // 异常不等于已安装；只有此前确认过安装才保留未知行。
        if (knownInstalled.has(def.id)) out.push({
          id: def.id, name: def.name, kind: def.kind, status: 'unknown', statusLabel: '未确认',
          message: '宿主检测未完成，请检查本机配置后重试',
        });
      }
    }
    return { hosts: out, ...(failed ? { message: '部分宿主检测未完成，请检查本机配置后重试' } : {}) };
  }

  function onboardGuide(id: string, modelIds: string[] = []) {
    const def = hostDefs().find((host) => host.id === id);
    if (def === undefined) throw new UiServiceError(404, '宿主不存在');
    try {
      return {
        host: { id: def.id, name: def.name, kind: def.kind },
        commands: ['accessmux onboard'],
        guideLines: def.guideLines(hostContext(modelIds)),
      };
    } catch {
      throw new UiServiceError(400, '接入引导暂不可用，请在本机运行 accessmux onboard');
    }
  }

  async function refreshWorkBuddyDisplayNames(entries: readonly { adapterId: string; model: ModelInfo }[]): Promise<'updated' | 'current' | 'skipped' | 'failed'> {
    const def = hostDefs().find((host) => host.id === 'workbuddy');
    if (!def?.refresh || entries.length === 0) return 'skipped';
    try {
      const ids = entries.map(({ adapterId, model }) => `${adapterId}:${model.id}`);
      const ctx = hostContext(ids, Object.fromEntries(entries.map(({ adapterId, model }) => {
        const entry = modelDirectoryEntry(adapterId, model);
        return [`${adapterId}:${model.id}`, { name: String(entry.display_name ?? entry.name ?? model.name ?? model.id) }];
      })));
      const detected = def.detect(ctx);
      if (!detected.installed || detected.onboarded !== true) return 'skipped';
      return await def.refresh(ctx) ? 'updated' : 'current';
    } catch {
      return 'failed';
    }
  }

  function checkin(): UiCheckinState {
    const day = checkinDay(now());
    return { sources: (['workbuddy', 'qoder', 'trae-cn', 'zcode'] as const).map((source) => {
      if (source === 'trae-cn' || source === 'zcode') return {
        source, name: CHECKIN_SOURCE_NAMES[source], supported: false, enabled: false,
        status: 'unqueried', message: UNSUPPORTED[source],
      };
      const result = results.get(source);
      const current = result !== undefined && checkinDay(new Date(result.checkedAt)) === day ? result : undefined;
      const running = inflight.has(source);
      return {
        source, name: CHECKIN_SOURCE_NAMES[source], supported: true, enabled: enabled(source),
        status: running ? 'running' : current?.verdict ?? 'unqueried',
        message: running ? '正在领取，请稍候' : current?.message ?? '尚未查询领取状态',
        ...(current === undefined ? {} : { checkedAt: current.checkedAt }),
      };
    }) };
  }

  function autoAttempt(source: OperableSource): AutoAttempt {
    const day = checkinDay(now());
    let attempt = attempts.get(source);
    if (attempt?.day !== day) {
      attempt = { day, attempts: 0, done: false, retryAt: 0 };
      attempts.set(source, attempt);
    }
    return attempt;
  }

  function execute(source: OperableSource): Promise<UiCheckinResult> {
    const attempt = autoAttempt(source);
    attempt.attempts++;
    const promise = Promise.resolve().then(async () => {
      try {
        // 关闭服务/取消勾选可能发生在请求被接受到实际启动之间。
        if (closed || !enabled(source)) return safeCheckinResult(source, {
          source, verdict: 'skipped', message: '',
        }, now());
        const pat = source === 'qoder' ? readPat() ?? store.get().qoder?.pat : undefined;
        const raw = await runCheckin({
          sources: { workbuddy: source === 'workbuddy', qoder: source === 'qoder', zcode: false },
          ...(pat === undefined ? {} : { qoderPat: pat }),
          log: () => {},
        });
        return safeCheckinResult(source, raw.find((result) => result.source === source), now());
      } catch {
        return safeCheckinResult(source, undefined, now());
      }
    }).then((result) => {
      results.set(source, result);
      // 成功/已领/活动关闭每日只跑一次；缺登录/PAT 也不无限轮询。
      attempt.done = result.verdict !== 'error' || attempt.attempts >= 3;
      attempt.retryAt = now().getTime() + (attempt.attempts <= 1 ? 5 : 15) * 60_000;
      return result;
    }).finally(() => { inflight.delete(source); });
    inflight.set(source, promise);
    return promise;
  }

  async function claim(source: string): Promise<UiCheckinResult> {
    if (source !== 'workbuddy' && source !== 'qoder') {
      throw new UiServiceError(400, source === 'trae-cn' || source === 'zcode' ? UNSUPPORTED[source] : '请选择支持领取的源');
    }
    if (closed) throw new UiServiceError(409, '服务正在关闭，请稍后重试');
    if (!enabled(source)) throw new UiServiceError(409, '请先启用此源的签到开关');
    if (inflight.has(source)) throw new UiServiceError(409, '此源正在领取，请稍候');
    return execute(source);
  }

  function clearTimer(): void {
    if (timer !== undefined) { timers.clearTimeout(timer); timer = undefined; }
  }

  function schedule(delayMs: number): void {
    if (!started || closed || timer !== undefined || !OPERABLE.some(enabled)) return;
    timer = timers.setTimeout(() => {
      timer = undefined;
      if (closed) return;
      for (const source of OPERABLE) {
        if (!enabled(source) || inflight.has(source)) continue;
        const attempt = autoAttempt(source);
        if (!attempt.done && now().getTime() >= attempt.retryAt) void execute(source);
      }
      schedule(interval);
    }, delayMs);
  }

  const unsubscribe = store.onChange(() => {
    if (!OPERABLE.some(enabled)) clearTimer();
    else schedule(1_000);
  });

  return {
    hosts, onboardGuide, refreshWorkBuddyDisplayNames, checkin, claim,
    start(): void { if (!closed) { started = true; schedule(1_000); } },
    close(): void { closed = true; clearTimer(); unsubscribe(); },
  };
}
