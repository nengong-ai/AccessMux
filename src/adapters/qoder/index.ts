// Qoder 依附型 LockedUsageAdapter（T020，R018 形态 (i) 合同落地）。
//
// 形态：每请求独立 `qoderclicn --input-format stream-json` 子进程驱动 Qoder 账号
// 免费/权益额度。凭据由 qoderclicn 进程内自闭环（D22）：AccessMux 不持有、
// 不截获任何凭据，登录态失效时上游错误原文透出（"Not logged in · Please run
// /login"）。上游零计量面（usage.input_tokens 恒 0）：fetchQuota 只报
// ok/unknown，不编数。
// 单源隔离（D8）：probe/launch/fetchQuota 失败都收敛在自己身上。

import type { LaunchContext, ProbeContext, ProbeResult, ProviderAdapter, ProviderSession } from '../types.js';
import type { QuotaState } from '../../types.js';
import { SharedWork } from '../../util/abort.js';
import { buildQoderEnv } from './client.js';
import { fetchModelIds, modelsFromIds } from './catalog.js';
import { QoderProcessPool, type QoderPoolOptions } from './pool.js';
import { resolveQoderRuntime, type QoderRuntimeDeps } from './runtime.js';
import { QoderSession } from './session.js';
import { collectQoderMetadata, type QoderMetadataDeps, type QoderMetadataMap } from './catalog-metadata.js';

export interface QoderAdapterOptions {
  runtimeDeps?: QoderRuntimeDeps;
  pool?: QoderPoolOptions;
  /** 目录缓存 TTL（默认 5 分钟；权益变化不需要秒级跟随）。 */
  catalogTtlMs?: number;
  turnTimeoutMs?: number;
  now?: () => number;
  metadataDeps?: QoderMetadataDeps;
}

export class QoderAdapter implements ProviderAdapter {
  readonly id = 'qoder';
  readonly displayName = 'Qoder';
  /**
   * 隔离靠 env 白名单 + 工具全禁（--tools ""）+ dont_ask（无工具可执行任何
   * 本地动作），非 OS 级沙箱，如实上报 behavioural。凭据自闭环是 D22 最干净
   * 形态，但进程本身跑在用户账号下，不夸大成 enforced。
   */
  readonly sandbox = 'behavioural' as const;
  /**
   * T036 图片路径已点亮：stream-json 用户 envelope 追加 Anthropic 形 image
   * block（CLI 原生接受），Qwen3.8-Flash 真机图片往返验证过（详见
   * docs/host-integration.md 能力口径与 internal development record）。其余模型未做图片
   * 往返，catalog 不盖 inputModalities，模型级保持灰标。
   */
  readonly bridgeImages = true;

  private readonly pool: QoderProcessPool;
  private readonly catalogTtlMs: number;
  private readonly now: () => number;
  private readonly turnTimeoutMs: number | undefined;
  private catalogCache: { ids: string[]; metadata: QoderMetadataMap; at: number } | undefined;
  private readonly metadataDeps: QoderMetadataDeps;
  private readonly catalogWork = new SharedWork<string[]>();

  constructor(options: QoderAdapterOptions = {}) {
    this.pool = new QoderProcessPool(options.pool);
    this.catalogTtlMs = options.catalogTtlMs ?? 300_000;
    this.now = options.now ?? Date.now;
    this.runtimeDeps = options.runtimeDeps;
    this.turnTimeoutMs = options.turnTimeoutMs;
    // fake CLI 的离线测试不顺带读真实 HOME 或访问活动网页。
    this.metadataDeps = options.metadataDeps ?? (options.runtimeDeps?.execFile === undefined ? {} : { textFiles: [], runtimeFiles: [], settingsFile: null, publicOffer: false });
  }

  private readonly runtimeDeps: QoderRuntimeDeps | undefined;

  /**
   * 探测二进制 + 模型清单。失败（未装 Qoder / CLI 起不来 / 清单为空）→
   * unavailable，不抛错。登录态不在此处验证（验证要烧推理请求；失效会在
   * launch 的上游错误原文里透出）。
   */
  async probe(ctx?: ProbeContext): Promise<ProbeResult> {
    try {
      const wasFreshCache = !ctx?.forceRefresh && this.catalogCache !== undefined && this.now() - this.catalogCache.at < this.catalogTtlMs;
      const ids = await this.cachedModelIds(ctx);
      return {
        availability: ids.length > 0 ? 'available' : 'unavailable',
        models: modelsFromIds(ids, this.catalogCache?.metadata),
        auth: 'unknown',
        catalogSource: wasFreshCache ? 'cache' : 'current',
        reasonCode: ids.length > 0 ? 'login-unverified' : 'catalog-unavailable',
        observedAt: new Date(this.now()).toISOString(),
      };
    } catch (error) {
      if (this.catalogCache && this.catalogCache.ids.length > 0) return {
        availability: 'available', models: modelsFromIds(this.catalogCache.ids, this.catalogCache.metadata),
        auth: 'unknown', catalogSource: 'cache', reasonCode: 'catalog-unavailable',
      };
      const notInstalled = error instanceof Error && error.message.includes('未安装 Qoder');
      return { availability: 'unavailable', models: [], auth: 'unknown', reasonCode: notInstalled ? 'not-installed' : 'catalog-unavailable' };
    }
  }

  async launch(ctx: LaunchContext): Promise<ProviderSession> {
    const ids = await this.cachedModelIds({ signal: ctx.signal }).catch(() => [] as string[]);
    ctx.signal?.throwIfAborted();
    return new QoderSession(this.pool, { knownModels: ids, turnTimeoutMs: this.turnTimeoutMs });
  }

  /** 上游无计量面：能列出模型 → ok；否则 unknown。不编造数字。 */
  async fetchQuota(ctx?: Pick<ProbeContext, 'signal'>): Promise<QuotaState> {
    try {
      return (await this.cachedModelIds(ctx)).length > 0 ? 'ok' : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /** 停全部常驻 CLI 子进程并回收；幂等。 */
  async dispose(): Promise<void> {
    this.catalogWork.cancel();
    await this.pool.dispose();
  }

  private async cachedModelIds(ctx?: ProbeContext): Promise<string[]> {
    ctx?.signal?.throwIfAborted();
    const cached = this.catalogCache;
    if (!ctx?.forceRefresh && cached !== undefined && this.now() - cached.at < this.catalogTtlMs) {
      return cached.ids;
    }
    return this.catalogWork.run(signal => this.collectCatalog({ ...ctx, signal }), ctx?.signal);
  }

  private async collectCatalog(ctx?: ProbeContext): Promise<string[]> {
    ctx?.signal?.throwIfAborted();
    const runtime = await resolveQoderRuntime({ ...this.runtimeDeps, signal: ctx?.signal });
    ctx?.signal?.throwIfAborted();
    const ids = await fetchModelIds(runtime.path, {
      env: buildQoderEnv(this.runtimeDeps?.env ?? process.env),
      execFile: this.runtimeDeps?.execFile,
      signal: ctx?.signal,
    });
    const collected = await collectQoderMetadata({ ...this.metadataDeps, signal: ctx?.signal }).catch(() => ({}));
    const metadata = mergeQoderFees(this.catalogCache?.metadata ?? {}, collected, new Date(this.now()).toISOString());
    ctx?.signal?.throwIfAborted();
    this.catalogCache = { ids, metadata, at: this.now() };
    return ids;
  }
}

function qoderFeeTime(model: QoderMetadataMap[string] | undefined): number {
  const price = model?.priceMultiplier;
  const at = typeof price === 'object' ? price.updated_at : model?.freeSource?.updated_at;
  return at ? Date.parse(at) : 0;
}

/** A missing or older fee observation keeps the exact model's last evidence and marks it stale. */
function mergeQoderFees(previous: QoderMetadataMap, incoming: QoderMetadataMap, checkedAt: string): QoderMetadataMap {
  const merged: QoderMetadataMap = { ...incoming };
  for (const [id, old] of Object.entries(previous)) {
    const next = incoming[id];
    const oldHasFee = old.freeSource !== undefined || old.priceSnapshot !== undefined || typeof old.priceMultiplier === 'object';
    if (!oldHasFee) { if (!next) merged[id] = old; continue; }
    const nextHasFee = next?.freeSource !== undefined || next?.priceSnapshot !== undefined || typeof next?.priceMultiplier === 'object';
    const oldAt = qoderFeeTime(old); const nextAt = qoderFeeTime(next);
    if (!nextHasFee || next?.feeFreshness === 'failed' || next?.feeFreshness === 'stale' || oldAt > nextAt) {
      const freshness = next?.feeFreshness === 'stale' || next?.feeFreshness === 'unknown' ? 'stale' as const : 'failed' as const;
      const value = { ...(next ?? {}), ...old, feeFreshness: freshness, feeCheckedAt: checkedAt };
      merged[id] = value;
      continue;
    }
    const value = { ...old, ...next };
    if (next?.freeSource && typeof next.free === 'boolean' && next.priceMultiplier === undefined && next.priceSnapshot === undefined) {
      delete value.priceMultiplier; delete value.priceSnapshot;
    }
    merged[id] = value;
  }
  return merged;
}
