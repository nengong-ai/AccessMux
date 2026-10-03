import { abortable } from '../../util/abort.js';
// WorkBuddy LockedUsageAdapter 全链路实装（D11 + 端口 spec §1.3 + §2 + §7）。
//
// 行为约定：
// - 单 variant CN（D11-4）。Global 留 Phase 2+；当前 router 仍按 'workbuddy' id 注册。
// - shim：复用 src/protocol/shim.ts 的 LoopbackShim 通用工厂（D11-3）
// - 30s sweep（spec §2.2.4）走 src/catalog/sweeper.ts 的通用 CatalogCache
// - 凭据由 daemon 内 store 有界读取；loopback/secret 只保护传输，不是进程隔离
// - WorkBuddy 5.6+ 凭据解密 spawn Electron helper（端口 spec §7.2 + D11-5）；
//   实施已通过 reverse-skill 授权门（自有设备/自有账号/个人使用）
// - 不模拟设备级反作弊 header（任务包"明确不做"）
//
// router 通过 'workbuddy:<modelId>' 命中本 adapter；wire id 与 display id 同名
// （端口 spec §2.2.3），所以 catalog 给 router 的 modelId 即上游能吃的 id。

import type {
  LaunchContext,
  ProbeContext,
  ProbeResult,
  ProviderAdapter,
  ProviderSession,
  TurnInput,
} from '../../adapters/types.js';
import { rejectTurnImages } from '../../adapters/types.js';
import type { ChatCompletionChunk, ModelInfo, QuotaState, TurnUsage } from '../../types.js';
import { normalizeOpenAiUsage } from '../../usage.js';
import { createLoopbackShim } from '../../protocol/shim.js';
import { ShimSessionPool, type ShimSessionLease } from '../../protocol/shim-session-pool.js';
import { redactLogText } from '../../util/redact.js';
import { SseDecoder } from '../../protocol/sse.js';
import { classifyWorkBuddyUpstreamError } from './error-classify.js';
import { WorkBuddyCatalog, fallbackModelsFor, type WorkBuddyModelInfo } from './catalog.js';
import { parseWorkBuddyCatalogResponse } from './parse-catalog.js';
import { fetchWorkBuddyMetadata, retainWorkBuddyPromotionOnBaseRate } from './catalog-metadata.js';
import { officialModelContext } from '../qoder/catalog-specs.js';
import { prepareWorkBuddyChatBody } from './body-shaper.js';
import { workBuddyReasoningFields } from './reasoning-fields.js';
import { buildWorkBuddyCatalogHeaders, buildWorkBuddyChatHeaders } from './headers.js';
import {
  WorkBuddyCredentialStore,
  safeCredentialError,
  workBuddyAccountId,
  type WorkBuddyCredential,
} from './credential-store.js';
import { REGION_GATEWAYS } from './region.js';
import type { WorkBuddyKeyProvider } from './key-provider.js';
import {
  createSpawnKeyProvider,
  fakeKeyProvider,
} from './key-provider.js';
import { resolveWorkBuddyClientVersion } from './app-version.js';
import type { WorkBuddyVariant } from './variant.js';
import { DEFAULT_WORKBUDDY_VARIANT } from './variant.js';

/** 30s sweep 默认值（端口 spec §2.2.4 + D11-1）；测试可覆盖。 */
export const DEFAULT_WORKBUDDY_SWEEP_MS = 30_000;

export interface WorkBuddyAdapterOptions {
  /** variant 选择；MVP 默认 CN。 */
  variant?: WorkBuddyVariant;
  /** atRest key provider；测试可注入 fake。生产默认走 spawn。 */
  keyProvider?: WorkBuddyKeyProvider;
  /** Catalog/credential resolution budget; aborts the actual fetch. */
  catalogTimeoutMs?: number;
  /** sweep 间隔（ms）。默认 30s。 */
  sweepMs?: number;
  /** fetch 实现（chat/refresh 都用；测试可注入）。 */
  fetchImpl?: typeof fetch;
  /** credential store 注入（测试用）。 */
  credentialStore?: WorkBuddyCredentialStore;
  /** clientVersion 解析（测试注入；默认 Info.plist → fallback）。 */
  resolveClientVersion?: (variant: WorkBuddyVariant, signal?: AbortSignal) => Promise<string>;
  /** 产品活动缓存只读；null 禁用本机读取（离线测试）。 */
  metadataCachePath?: string | null;
}

export class WorkBuddyAdapter implements ProviderAdapter {
  readonly id = 'workbuddy';
  readonly displayName = 'WorkBuddy';
  readonly sandbox = 'behavioural' as const;
  readonly bridgeReasoning = true;
  readonly variant: WorkBuddyVariant;

  private readonly catalog: WorkBuddyCatalog;
  private readonly credentialStore: WorkBuddyCredentialStore;
  private readonly fetchImpl: typeof fetch;
  private readonly sweepMs: number;
  private readonly catalogTimeoutMs: number;
  private readonly resolveClientVersion: (variant: WorkBuddyVariant, signal?: AbortSignal) => Promise<string>;
  private readonly metadataCachePath: string | null | undefined;
  private hasSuccessfulCatalog = false;
  /** shim 会话池：并发 launch 串行排队 + 复用，不再抛 already-running（T010）。 */
  private readonly sessionPool = new ShimSessionPool();
  private catalogTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: WorkBuddyAdapterOptions = {}) {
    this.variant = options.variant ?? DEFAULT_WORKBUDDY_VARIANT;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.catalogTimeoutMs = options.catalogTimeoutMs ?? 30_000;
    this.sweepMs = options.sweepMs ?? DEFAULT_WORKBUDDY_SWEEP_MS;
    this.resolveClientVersion = options.resolveClientVersion ?? ((variant, signal) => resolveWorkBuddyClientVersion(variant, { signal }));
    this.metadataCachePath = options.metadataCachePath ?? (options.fetchImpl === undefined ? undefined : null);
    this.catalog = new WorkBuddyCatalog(this.variant);
    if (options.credentialStore !== undefined) {
      this.credentialStore = options.credentialStore;
    } else {
      const keyProvider = options.keyProvider ?? createSpawnKeyProvider(this.variant);
      this.credentialStore = new WorkBuddyCredentialStore({
        variant: this.variant,
        keyProvider,
        refresh: (c, signal) => import('./refresh.js').then(({ refreshWorkBuddyCredential }) => refreshWorkBuddyCredential(c, this.fetchImpl, signal)),
        fetchImpl: this.fetchImpl,
      });
    }
  }

  /** 测试钩子：注入一段 fake atRest key 解密，绕开 spawn。 */
  static withFakeKey(atRestSecretKey: string, options: Omit<WorkBuddyAdapterOptions, 'keyProvider'> = {}): WorkBuddyAdapter {
    return new WorkBuddyAdapter({
      ...options,
      keyProvider: fakeKeyProvider(atRestSecretKey),
    });
  }

  /**
   * probe：探测登录态与模型清单。best-effort——拿不到 token 时返回 unverified
   * + 静态兜底；不抛错（让 UI 仍能渲染 adapter 卡片）。
   */
  async probe(ctx?: ProbeContext): Promise<ProbeResult> {
    const signal = ctx?.signal;
    signal?.throwIfAborted();
    const status = await this.credentialStore.status(signal);
    signal?.throwIfAborted();
    if (status.state === 'signed-out') {
      return { availability: 'unavailable', models: fallbackModelsFor(this.variant).map((m) => toModelInfo(m, this.id)), auth: 'logged-out', catalogSource: 'fallback', reasonCode: 'not-logged-in' };
    }
    if (status.state === 'unknown') {
      return { availability: 'unverified', models: [], auth: 'unknown', reasonCode: 'credential-unavailable' };
    }
    try {
      await this.refreshCatalog({ force: true, signal });
      const models = this.catalog.current();
      return {
        availability: 'available',
        auth: 'logged-in',
        catalogSource: 'current',
        reasonCode: 'directory-ready',
        observedAt: new Date().toISOString(),
        models: models.map((m) => toModelInfo(m, this.id)),
      };
    } catch {
      const cached = this.catalog.current();
      if (this.hasSuccessfulCatalog && cached.length > 0) return {
        availability: 'available', auth: 'logged-in', catalogSource: 'cache', reasonCode: 'catalog-unavailable',
        models: cached.map((m) => ({ ...toModelInfo(m, this.id), feeFreshness: 'failed' as const })),
      };
      return {
        availability: 'unverified',
        auth: 'logged-in',
        catalogSource: 'fallback',
        reasonCode: 'catalog-fallback',
        models: fallbackModelsFor(this.variant).map((m) => toModelInfo(m, this.id)),
      };
    }
  }

  /**
   * launch：起 shim + 返回 ProviderSession。session.runTurn 调用 shim 的
   * `/v1/chat/completions`（带 bearer），shim 内部解真实 token、调上游。
   *
   * T010：shim 生命周期移交 ShimSessionPool——并发 launch 串行排队、活动 shim
   * 被并发会话复用（引用计数），不再抛 "shim is already running"；最后一个
   * 会话 cancel 才关 shim。凭据解析在池外（credential store 内部单飞去重），
   * 不阻塞 shim 复用判定。
   */
  async launch(ctx: LaunchContext): Promise<ProviderSession> {
    const accountId = workBuddyAccountId(await this.credentialStore.resolve(ctx.signal));
    const baseUrl = REGION_GATEWAYS[this.variant].chat;
    const ownedBy = 'workbuddy';
    ctx.signal?.throwIfAborted();
    const leaseWork = this.sessionPool.acquire(async () => {
      ctx.signal?.throwIfAborted();
      return createLoopbackShim({
        catalog: {
          current: () => this.catalog.current().map((m) => ({
            id: m.id,
            object: 'model' as const,
            owned_by: ownedBy,
            created: 0,
          })),
        },
        chat: async (body, signal) => {
          const credential = await this.credentialStore.resolve(signal);
          if (workBuddyAccountId(credential) !== accountId) throw new Error('WorkBuddy active account changed; launch a new session');
          signal.throwIfAborted();
          return this.callUpstream(body, signal, credential, baseUrl);
        },
        routePrefix: '/v1',
        ownedBy,
      });
    });
    void leaseWork.then(lease => { if (ctx.signal?.aborted) lease.release(); }, () => undefined);
    const lease = await abortable(leaseWork, ctx.signal);
    ctx.signal?.throwIfAborted();
    return new WorkBuddySession(lease);
  }

  /** 上游 chat 调用：把 OpenAI 形状 body 翻译给 WorkBuddy，再 fetch。 */
  private async callUpstream(
    bodyJson: string,
    signal: AbortSignal,
    credential: WorkBuddyCredential,
    baseUrl: string,
  ): Promise<{ ok: boolean; status: number; kind: 'authentication' | 'hard_credit' | 'soft_rate' | 'not_found' | 'server' | 'client' | 'unconfigured'; message: string; response?: Response }> {
    let prepared: string;
    try {
      const modelId = (() => {
        try { return (JSON.parse(bodyJson) as { model?: unknown }).model as string; } catch { return ''; }
      })();
      // T010：共享 shim 下不再用 launch 时刻的快照，按调用时活目录查 reasoning 能力
      const entry = this.catalog.current().find((m) => m.id === modelId);
      prepared = prepareWorkBuddyChatBody(bodyJson, {
        variant: this.variant,
        reasoningSupported: entry?.reasoning ? workBuddyReasoningFields(entry.reasoning).supported : [],
        strictReasoning: true,
      });
    } catch (error: unknown) {
      const message = safeCredentialError(error, credential);
      return { ok: false, status: 400, kind: 'client', message };
    }
    // header 组装（含 clientVersion 解析）整体包进 try：任何一步抛错都归类为
    // 可诊断的 client 失败回给 shim，而不是逃逸成 shim 的 500 "Internal shim error"
    // （T010 观测性：请求日志要能看到真原因，而不是一句 internal）
    let headers: Record<string, string>;
    try {
      headers = buildWorkBuddyChatHeaders(
        {
          accessToken: credential.accessToken,
          userId: credential.userId,
          ...(credential.enterpriseId === undefined ? {} : { enterpriseId: credential.enterpriseId }),
          ...(credential.host === undefined ? {} : { domain: credential.host }),
        },
        { clientVersion: await abortable(this.resolveClientVersion(this.variant, signal), signal) },
        this.variant,
      );
    } catch (error: unknown) {
      return { ok: false, status: 400, kind: 'client', message: safeCredentialError(error, credential) };
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${baseUrl.replace(/\/$/, '')}/v2/chat/completions`, {
        method: 'POST',
        headers,
        body: prepared,
        signal,
      });
    } catch (error: unknown) {
      return { ok: false, status: 502, kind: 'server', message: `transport error: ${safeCredentialError(error, credential)}` };
    }
    if (response.ok) return { ok: true, status: 200, kind: 'unconfigured', message: '', response };
    try {
    const text = await response.text();
    const classified = classifyWorkBuddyUpstreamError({ status: response.status, body: text });
    return { ok: false, status: classified.kind === 'unconfigured' ? 502 : response.status, kind: classified.kind, message: safeCredentialError(classified.message, credential) };
    } catch (error) { return { ok: false, status: 502, kind: 'server', message: safeCredentialError(error, credential) }; }
  }

  /**
   * 主动 refresh 目录：fetch upstream catalog JSON → parse → set。
   * fetch 失败抛错；调用方决定是否吞。
   */
  async refreshCatalog(opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<void> {
    const signal = opts.signal === undefined ? AbortSignal.timeout(this.catalogTimeoutMs) : AbortSignal.any([opts.signal, AbortSignal.timeout(this.catalogTimeoutMs)]);
    const credential = await this.credentialStore.resolve(signal);
    signal.throwIfAborted();
    const base = REGION_GATEWAYS[this.variant].catalog;
    const url = `${base.replace(/\/$/, '')}/v3/config`;
    const headers = buildWorkBuddyCatalogHeaders(
      {
        accessToken: credential.accessToken,
        userId: credential.userId,
        ...(credential.enterpriseId === undefined ? {} : { enterpriseId: credential.enterpriseId }),
        ...(credential.host === undefined ? {} : { domain: credential.host }),
      },
      this.variant,
    );
    try {
      signal.throwIfAborted();
      const response = await this.fetchImpl(url, { method: 'GET', headers, signal });
      if (!response.ok) {
        throw new Error(`WorkBuddy catalog fetch failed (http ${response.status}): ${await response.text()}`);
      }
      const payload = await response.json() as unknown;
      const metadata = await fetchWorkBuddyMetadata({ variant: this.variant, headers, signal, fetchImpl: this.fetchImpl, cachePath: this.metadataCachePath });
      signal.throwIfAborted();
      const models = parseWorkBuddyCatalogResponse(payload, { metadata, region: this.variant });
      this.catalog.set(retainWorkBuddyPromotionOnBaseRate(this.catalog.current(), models, new Date().toISOString()));
      this.hasSuccessfulCatalog = true;
    } catch (error) { throw new Error(safeCredentialError(error, credential)); }
    void opts; // force 标志已用在 status 探测，refresh 总是强制刷新最新
  }

  /** 30s sweep（端口 spec §2.2.4）：未读 catalog 时不贡献错误日志。 */
  startCatalogSweep(): void {
    if (this.catalogTimer !== undefined) return;
    this.catalogTimer = setInterval(() => {
      void this.refreshCatalog().catch(() => undefined);
    }, this.sweepMs);
    this.catalogTimer.unref?.();
  }

  async fetchQuota(ctx?: { signal?: AbortSignal }): Promise<QuotaState> {
    ctx?.signal?.throwIfAborted();
    const status = await this.credentialStore.status(ctx?.signal);
    ctx?.signal?.throwIfAborted();
    return status.state === 'signed-in' ? 'ok' : 'unknown';
  }

  async dispose(): Promise<void> {
    if (this.catalogTimer !== undefined) {
      clearInterval(this.catalogTimer);
      this.catalogTimer = undefined;
    }
    try { await this.sessionPool.dispose(); } finally { this.credentialStore.dispose(); }
  }

  /** 给 UI 卡片暴露当前 sweep 间隔（调试用）。 */
  getSweepMs(): number {
    return this.sweepMs;
  }

  /** 给测试 hook：暴露 catalog 实例。 */
  getCatalog(): WorkBuddyCatalog {
    return this.catalog;
  }

}

/** 把内部 WorkBuddyModelInfo 拍平为 router 需要的 ModelInfo。 */
function toModelInfo(model: WorkBuddyModelInfo, providerId: string): ModelInfo {
  const official = model.officialContext ?? officialModelContext(model.id);
  const context = model.contextWindow === undefined ? official : model.contextSource === undefined ? model.contextWindow : { value: model.contextWindow, source: model.contextSource };
  return {
    id: model.id,
    provider: providerId,
    name: model.displayName,
    ...(model.priceMultiplier === undefined ? {} : { priceMultiplier: model.priceSnapshot ?? model.priceMultiplier, priceScope: 'model' }),
    ...(model.free === undefined ? {} : { free: model.free }),
    ...(model.freeSource === undefined ? {} : { freeSource: model.freeSource }),
    ...(model.freeActivity === undefined ? {} : { freeActivity: model.freeActivity }),
    ...(model.feeFreshness === undefined ? {} : { feeFreshness: model.feeFreshness }),
    ...(model.feeCheckedAt === undefined ? {} : { feeCheckedAt: model.feeCheckedAt }),
    callVerified: false,
    ...(model.activityLabels === undefined ? {} : { activityLabels: [...model.activityLabels] }),
    ...(model.activities === undefined ? {} : { activities: model.activities.map((activity) => structuredClone(activity)) }),
    ...(model.description === undefined ? {} : { description: model.description }),
    ...(model.reasoning === undefined ? {} : {
      reasoning: {
        supported: model.reasoning.supports,
        ...(model.reasoning.supportedEfforts.length === 0 ? {} : { supportedEfforts: [...model.reasoning.supportedEfforts] }),
        canDisableThinking: model.reasoning.canDisableThinking,
      },
    }),
    inputModalities: model.input.filter((v): v is 'text' | 'image' => v === 'text' || v === 'image'),
    ...(model.input.length > 0 ? { tags: [...model.input] } : {}),
    ...(context === undefined ? {} : { minCtx: context }),
    ...(model.maxInput === undefined ? {} : { maxInput: model.maxInput }),
    ...(official === undefined ? {} : { officialContext: official }),
  };
}

class WorkBuddyStreamError extends Error {}

export class WorkBuddySession implements ProviderSession {
  /** 当前 turn 的 daemon→shim 连接中止器；cancel() 用它打断进行中的 runTurn。 */
  private abortTurn: (() => void) | undefined;

  constructor(private readonly lease: ShimSessionLease) {}

  /**
   * 走 shim：`POST /v1/chat/completions` + `Authorization: Bearer <token>`。
   * 把上游 SSE 解码成 ChatCompletionChunk（adapter.runTurn 的 delta/done）。
   */
  async *runTurn(input: TurnInput): AsyncIterable<ChatCompletionChunk> {
    input.signal?.throwIfAborted();
    // T036 兜底：未点亮图片的源明确报错，防 images 字段被静默序列化后上游丢弃。
    rejectTurnImages('workbuddy', input.messages);
    const body = JSON.stringify({
      model: input.model,
      messages: input.messages,
      stream: true,
      ...(input.reasoning_effort === undefined ? {} : { reasoning_effort: input.reasoning_effort }),
    });
    const url = `${this.lease.shim.baseUrl()}/v1/chat/completions`;
    // T010：共享 shim 后，cancel 不能再关整个 shim（会误杀并发会话）——
    // 改为只断本 session 的连接，shim 侧 handler 随客户端断开 abort 上游。
    const controller = new AbortController();
    this.abortTurn = () => controller.abort();
    const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.lease.shim.token()}` },
        body,
        signal,
      });
      if (!response.ok) {
        const detail = redactLogText(await response.text().catch(() => ''));
        throw Object.assign(new WorkBuddyStreamError(`workbuddy shim rejected request: HTTP ${response.status} ${detail}`),
          response.status === 400 ? { statusCode: 400 } : {});
      }
      if (response.body === null) throw new WorkBuddyStreamError('workbuddy shim returned no body');
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      const sse = new SseDecoder();
      let usage: TurnUsage | undefined;
      let sawDone = false;
      const consume = (event: ReturnType<SseDecoder['push']>[number]): string => {
        if (event.event === 'error') throw new WorkBuddyStreamError('workbuddy upstream SSE error');
        if (event.data.trim() === '[DONE]') { sawDone = true; return ''; }
        let parsed: unknown;
        try { parsed = JSON.parse(event.data); } catch { throw new WorkBuddyStreamError('workbuddy upstream sent malformed SSE JSON'); }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new WorkBuddyStreamError('workbuddy upstream sent invalid SSE payload');
        const record = parsed as Record<string, unknown>;
        // Raw frames may echo credentials; expose an actionable constant, never payload.
        if (record['error'] !== undefined && record['error'] !== null) throw new WorkBuddyStreamError('workbuddy upstream SSE error');
        usage = normalizeOpenAiUsage(record['usage']) ?? usage;
        let content = '';
        for (const raw of Array.isArray(record['choices']) ? record['choices'] : []) {
          const choice = raw as { delta?: { content?: unknown } } | null;
          if (typeof choice?.delta?.content === 'string') content += choice.delta.content;
        }
        return content;
      };
      while (!sawDone) {
        const next = await reader.read();
        if (next.done) {
          for (const event of [...sse.push(decoder.decode()), ...sse.finish()]) {
            const content = consume(event);
            if (content !== '') yield { delta: content, done: false };
          }
          break;
        }
        for (const event of sse.push(decoder.decode(next.value, { stream: true }))) {
          const content = consume(event);
          if (content !== '') yield { delta: content, done: false };
        }
      }
      signal.throwIfAborted();
      if (!sawDone) throw new WorkBuddyStreamError('workbuddy upstream stream ended without [DONE]');
      yield { delta: '', done: true, ...(usage === undefined ? {} : { usage }) };
    } catch (error) {
      // Transport exception text is not a trusted diagnostic channel.
      if (signal.aborted) throw new WorkBuddyStreamError('workbuddy request cancelled');
      if (error instanceof WorkBuddyStreamError) throw error;
      throw new WorkBuddyStreamError('workbuddy upstream stream transport failed');
    } finally {
      controller.abort();
      await reader?.cancel().catch(() => undefined);
      reader?.releaseLock();
      this.abortTurn = undefined;
    }
  }

  async cancel(): Promise<void> {
    // 先断本 session 的连接，再还租约；租约引用计数归 0 时池才会关 shim。
    // 幂等：server 层 close/abort 双通道会重复 cancel 同一 session。
    this.abortTurn?.();
    this.lease.release();
  }
}
