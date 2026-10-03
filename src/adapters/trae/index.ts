import { abortable } from '../../util/abort.js';
// Trae LockedUsageAdapter（D11 + 端口 spec §3 + §4.3.3 + 任务包验收标准）。
//
// 行为约定：
// - 双区域（CN / AI）独立 adapter，各自一份 shim / catalog / credential store
// - shim：127.0.0.1 随机端口 + 进程内随机 secret（D4 + §10.2 金标准）
// - 凭据由 daemon 内 store 有界读取；loopback/secret 只保护传输，不是进程隔离
// - 不实现周期性 sweep（D11-1：trae 是 30 分钟 capability TTL + 事件驱动）
// - 不触发 reverse-skill 授权门（D11-5：Trae 自实现 AES-128-CBC，算法自包含）
// - 不模拟设备级反作弊 header（任务包"明确不做"）
//
// 单 region adapter 本身在 router / orchestrator / catalog 层就被识别为
// 'trae-cn' / 'trae-global' 两个独立实例；本文件只描述一份实例的构造与生命周期。

import type {
  LaunchContext,
  ProbeResult,
  ProviderAdapter,
  ProviderSession,
  TurnInput,
} from '../../adapters/types.js';
import { rejectTurnImages } from '../../adapters/types.js';
import type { ChatCompletionChunk, ModelInfo, QuotaState, TurnUsage } from '../../types.js';
import { SseDecoder } from '../../protocol/sse.js';
import { redactLogText } from '../../util/redact.js';
import { normalizeOpenAiUsage } from '../../usage.js';
import type { TraeCredential } from './credential-store.js';
import { TraeCredentialStore, safeCredentialError, traeAccountId } from './credential-store.js';
import { TraeCatalog, fallbackModelsFor } from './catalog.js';
import type { TraeRegion } from './region.js';
import type { TraeEdition } from './paths.js';
import { traeStorageCandidates } from './paths.js';
import { resolveTraeIdentity, type TraeIdentity } from './identity.js';
import { buildTraeHeaders } from './headers.js';
import { REGION_GATEWAYS } from './region.js';
import { traeEndpoint } from './endpoints.js';
import { TRAE_SOLO_CHAT_PATH } from './endpoints.js';
import { createLoopbackShim } from '../../protocol/shim.js';
import { ShimSessionPool, type ShimSessionLease } from '../../protocol/shim-session-pool.js';
import { TraeSoloBridge, type BridgeCatalogEntry } from './bridge.js';
import { refreshTraeCredential } from './refresh.js';
import { dropDeadModels, createWireState, type WireState } from './drop-dead.js';
import { enableRegion, disableRegion, regionIsEnabled, type RegionRegistration } from './region-registration.js';
import { fetchTraeDirectory } from './directory.js';
import { TraeRemoteCatalogClient } from './remote-catalog.js';
import { mergeTraeModelSources } from './merge-sources.js';
import { officialModelContext } from '../qoder/catalog-specs.js';

export type { TraeRegion } from './region.js';
export type { TraeEdition } from './paths.js';

/** 单 region 的 TraeAdapter。router 把 'trae-cn' / 'trae-global' 注册为两个独立实例。 */
export class TraeAdapter implements ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly sandbox = 'behavioural' as const;
  readonly region: TraeRegion;
  private readonly edition: TraeEdition;

  private readonly credentialStore: TraeCredentialStore;
  private readonly catalog: TraeCatalog;
  private readonly fetchImpl: typeof fetch;
  private readonly catalogTimeoutMs: number;
  private readonly identityResolver: ((credential: TraeCredential) => Promise<TraeIdentity>) | undefined;
  private readonly wireState: WireState = createWireState();
  private readonly registrations: Map<TraeRegion, RegionRegistration> = new Map();

  /** shim 会话池：并发 launch 串行排队 + 复用，不再抛 already-running（T010）。 */
  private readonly sessionPool = new ShimSessionPool();
  private catalogTimer: ReturnType<typeof setInterval> | undefined;

  constructor(region: TraeRegion = 'cn', options: TraeAdapterOptions = {}) {
    this.region = region;
    // adapter id 对外暴露 'trae-cn' / 'trae-global'（与任务包、看板、TASKS.md 一致）；
    // 内部路由仍用 'cn' | 'ai'。
    this.id = region === 'cn' ? 'trae-cn' : 'trae-global';
    this.displayName = region === 'cn' ? 'Trae CN' : 'Trae AI (Global)';
    // CN 默认装 Trae CN 桌面；AI 默认装 Trae (sg)。本字段只影响 candidate 扫描顺序。
    this.edition = options.edition ?? (region === 'cn' ? 'cn' : 'sg');
    this.catalogTimeoutMs = options.catalogTimeoutMs ?? 30_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.identityResolver = options.identityResolver;
    this.credentialStore = options.credentialStore ?? new TraeCredentialStore({
      region,
      edition: options.edition ?? 'auto',
      refresh: (c, signal) => refreshTraeCredential(c, options.fetchImpl ?? fetch, signal),
      refreshMarginMs: options.refreshMarginMs,
      fs: options.fs,
      ownPath: options.ownPath,
      legacyOwnPath: options.legacyOwnPath,
    });
    this.catalog = new TraeCatalog(region);
    enableRegion(this.registrations, region);
  }

  /**
   * probe：探测登录态与模型清单。best-effort——拿不到 token 时返回 unverified
   * + 空 models；不抛错（让 UI 仍能渲染 adapter 卡片）。
   */
  async probe(ctx?: { signal?: AbortSignal }): Promise<ProbeResult> {
    const signal = ctx?.signal;
    signal?.throwIfAborted();
    if (!this.isEnabled()) return { availability: 'unavailable', models: [] };
    const status = await this.credentialStore.status();
    signal?.throwIfAborted();
    if (status.state === 'signed-out') {
      return { availability: 'unavailable', models: [], auth: 'logged-out', reasonCode: 'not-logged-in' };
    }
    if (status.state === 'unknown') {
      return { availability: 'unverified', models: [], auth: 'unknown', reasonCode: 'credential-unavailable' };
    }
    try {
      await this.refreshCatalog({ force: true, signal });
      const models = dropDeadModels(this.catalog.current(), this.wireState);
      return {
        availability: 'available',
        auth: 'logged-in',
        catalogSource: 'current',
        reasonCode: 'directory-ready',
        observedAt: new Date().toISOString(),
        models: models.map((m) => toModelInfo(m, this.id)),
      };
    } catch (error) {
      return { availability: error instanceof Error && error.message.includes('identity') ? 'unavailable' : 'unverified', models: [], auth: 'logged-in', reasonCode: 'catalog-unavailable' };
    }
  }

  /**
   * launch：起 shim + 返回 ProviderSession。session.runTurn 调用 shim 的
   * `/v1/chat/completions`（带 bearer），shim 内部解真实 token、调上游。
   *
   * ctx.localSecret 来自 protocol/server.ts 的进程内随机 secret——目前未在
   * 端到端验证中使用（shim 自身已经认证 adapter 调用方），保留接口以备后续
   * 双层认证（金标准）。
   */
  async launch(ctx: LaunchContext): Promise<ProviderSession> {
    // T010：shim 生命周期移交 ShimSessionPool（与 workbuddy 同语义）；凭据与
    // identity 解析在池外，不阻塞 shim 复用判定。
    const credential = await this.credentialStore.resolve(ctx.signal);
    await this.identityFor(credential);
    const accountId = traeAccountId(credential);
    const baseUrl = REGION_GATEWAYS[this.region].chat;
    ctx.signal?.throwIfAborted();
    const leaseWork = this.sessionPool.acquire(async () => {
      ctx.signal?.throwIfAborted();
      const catalogSource: { current(): readonly BridgeCatalogEntry[] } = {
        current: () => this.catalog.current().map((m) => ({
          id: m.id,
          ...(m.name === undefined ? {} : { name: m.name }),
          ...(m.wireConfigName === undefined ? {} : { wireConfigName: m.wireConfigName }),
          ...(m.wireFunction === undefined ? {} : { wireFunction: m.wireFunction }),
        })),
      };
      const bridge = new TraeSoloBridge(
        async (body, signal) => {
          const current = await this.credentialStore.resolve(signal);
          if (traeAccountId(current) !== accountId) throw new Error('Trae active account changed; launch a new session');
          const identity = await this.identityFor(current);
          signal?.throwIfAborted();
          return this.callUpstream(body, signal ?? new AbortController().signal, current, identity, baseUrl);
        },
        catalogSource,
      );
      const ownedBy = 'trae';
      return createLoopbackShim({
        catalog: {
          current: () => dropDeadModels(this.catalog.current(), this.wireState).map((m) => ({
            id: m.id,
            object: 'model' as const,
            owned_by: ownedBy,
            created: 0,
          })),
        },
        chat: async (body, signal) => {
          const result = await bridge.chatStream({ bodyJson: body, signal });
          if (!result.ok || result.response === undefined) {
            return { ok: false, status: result.status, kind: result.kind, message: result.message };
          }
          return { ok: true, status: 200, kind: 'unconfigured', message: '', response: result.response };
        },
        routePrefix: '/v1',
        ownedBy,
      });
    });
    void leaseWork.then(lease => { if (ctx.signal?.aborted) lease.release(); }, () => undefined);
    const lease = await abortable(leaseWork, ctx.signal);
    ctx.signal?.throwIfAborted();
    return new TraeSession(lease);
  }

  /**
   * 调上游真实接口（adapter 自己持有，给 bridge 用。
   * shim 实际拿不到这两个；bridge 才是 consumer。）
   */
  private async callUpstream(
    body: string,
    signal: AbortSignal,
    credential: TraeCredential,
    identity: TraeIdentity,
    baseUrl: string,
  ): Promise<import('./bridge.js').TraeChatResult> {
    const fetchImpl = this.fetchImpl;
    let response: Response;
    try {
      const headers = { ...buildTraeHeaders(credential, identity, { profile: 'agent-task' }) };
      response = await fetchImpl(traeEndpoint(baseUrl, TRAE_SOLO_CHAT_PATH), {
        method: 'POST',
        headers,
        body,
        signal,
      });
    } catch (error: unknown) {
      return { ok: false, status: 502, kind: 'server', message: `transport error: ${safeCredentialError(error, credential)}` };
    }
    if (response.ok) return { ok: true, status: 200, kind: 'unconfigured', message: '', response };
    try {
    const text = await response.text();
    const status = response.status;
    const kind: 'authentication' | 'hard_credit' | 'soft_rate' | 'not_found' | 'server' | 'client' | 'unconfigured' =
      status === 401 || status === 403 ? 'authentication'
      : status === 402 ? 'hard_credit'
      : status === 429 ? 'soft_rate'
      : status === 404 ? 'not_found'
      : status >= 500 ? 'server'
      : 'client';
    // 4001 是 trae 自己的 param-invalid 错误：模型 dead。标记后下一轮才复活。
    if (text.includes('4001') || text.includes('param is invalid')) {
      this.markAllDead();
    }
    return { ok: false, status, kind, message: safeCredentialError(text || `Trae SOLO returned HTTP ${status}`, credential) };
    } catch (error) { return { ok: false, status: 502, kind: 'server', message: safeCredentialError(error, credential) }; }
  }

  /** 用 credential 自带的 candidate 路径顺序解析 identity。 */
  private async identityFor(credential: TraeCredential): Promise<TraeIdentity> {
    if (this.identityResolver !== undefined) return this.identityResolver(credential);
    const edition = credential.edition;
    const candidates = traeStorageCandidates().filter((c) => c.edition === edition);
    return resolveTraeIdentity(candidates, edition);
  }

  /** 把该 catalog 中所有 model 标记 dead（收到 4001 后整体重置）。 */
  private markAllDead(): void {
    for (const m of this.catalog.current()) this.wireState.dead.add(m.id);
  }

  /**
   * 主动 refresh 目录：union remote + wire，merge 出 final catalog 并 set。
   * 任一 source 失败都吞掉（保留另一 source 的信息）；都失败抛。
   */
  async refreshCatalog(opts: { force?: boolean; signal?: AbortSignal } = {}): Promise<void> {
    const signal = opts.signal === undefined ? AbortSignal.timeout(this.catalogTimeoutMs) : AbortSignal.any([opts.signal, AbortSignal.timeout(this.catalogTimeoutMs)]);
    const credential = await this.credentialStore.resolve(signal);
    signal.throwIfAborted();
    const identity = await this.identityFor(credential);
    const fetchImpl = this.fetchImpl;
    const [wire, remote] = await Promise.all([
      fetchTraeDirectory({ credential: () => Promise.resolve(credential), identity: () => Promise.resolve(identity), fetchImpl }, signal).catch(() => []),
      new TraeRemoteCatalogClient({ credential: () => Promise.resolve(credential), fetchImpl }).fetchModels(signal).catch(() => []),
    ]);
    if (wire.length === 0 && remote.length === 0) {
      if (opts.force) {
        throw new Error('trae: live catalog fetch returned no models from any source');
      }
      return;
    }
    signal.throwIfAborted();
    const merged = mergeTraeModelSources(remote, wire);
    if (merged.length === 0) return;
    const seenIds = new Set<string>();
    const finalModels = merged.filter((m) => {
      if (seenIds.has(m.id)) return false;
      seenIds.add(m.id);
      return true;
    });
    this.catalog.set(finalModels);
    // 记录新一轮的 wire ids（first wins：wire 中已包含 config_name）
    const wireIds = wire.map((w) => w.id);
    for (const id of wireIds) this.wireState.dead.delete(id);
  }

  /**
   * 30 分钟 capability TTL（端口 spec §3.2.5）：trae 不需要高频 sweep，但
   * launch 后或 enable toggle 后调用一次 refresh 比较合理。
   * 为避免日志噪音，start 默认 no-op；调用方可显式 scheduleRefresh()。
   */
  scheduleRefresh(intervalMs = 30 * 60_000): void {
    if (this.catalogTimer !== undefined) return;
    this.catalogTimer = setInterval(() => {
      void this.refreshCatalog().catch(() => undefined);
    }, intervalMs);
    this.catalogTimer.unref?.();
  }

  async fetchQuota(ctx?: { signal?: AbortSignal }): Promise<QuotaState> {
    ctx?.signal?.throwIfAborted();
    const status = await this.credentialStore.status();
    ctx?.signal?.throwIfAborted();
    return status.state === 'signed-in' ? 'ok' : 'unknown';
  }

  async dispose(): Promise<void> {
    if (this.catalogTimer !== undefined) {
      clearInterval(this.catalogTimer);
      this.catalogTimer = undefined;
    }
    try { await this.sessionPool.dispose(); } finally { this.credentialStore.dispose(); }
    disableRegion(this.registrations, this.region);
  }

  /** 给 UI 卡片暴露当前是否启用（被切掉时不发请求）。 */
  isEnabled(): boolean {
    return regionIsEnabled(this.registrations, this.region);
  }

  /**
   * T021：UI 启停联动 region 注册原语（端口 spec §3.2.4：toggle 不停 shim、
   * 不停 sweep，只改注册态——"关闭时不会再回来（除非重启）"是 spec 对
   * disable 的描述；本方法让 enable 可恢复，供配置热应用）。
   */
  setEnabled(enabled: boolean): void {
    if (enabled) enableRegion(this.registrations, this.region);
    else disableRegion(this.registrations, this.region);
  }

  /** 给 UI 卡片暴露静态兜底（refresh 失败时也至少显示）。 */
  fallbackModels(): readonly import('./catalog.js').TraeModelInfo[] {
    return fallbackModelsFor(this.region);
  }
}

export interface TraeAdapterOptions {
  /** Catalog/credential resolution budget; aborts the actual fetch. */
  catalogTimeoutMs?: number;
  /** Synthetic test seams; default production resolver only reads official fields. */
  credentialStore?: TraeCredentialStore;
  identityResolver?: (credential: TraeCredential) => Promise<TraeIdentity>;
  /** candidate 扫描的 edition 过滤；默认 CN→cn / AI→sg。 */
  edition?: TraeEdition;
  /** fetch 实现注入（测试用）。默认 undici fetch。 */
  fetchImpl?: typeof fetch;
  /** own copy path 注入（测试用）。 */
  ownPath?: string;
  /** legacy own copy path 注入（测试用）。 */
  legacyOwnPath?: string;
  /** 到期前多久 refresh（默认 5 分钟）。 */
  refreshMarginMs?: number;
  /** 文件系统钩子（测试用）。 */
  fs?: NonNullable<ConstructorParameters<typeof TraeCredentialStore>[0]['fs']>;
}

/** 把内部 TraeModelInfo 拍平为 router 需要的 ModelInfo。 */
function toModelInfo(model: import('./catalog.js').TraeModelInfo, providerId: string): ModelInfo {
  const multiplier = model.creditMultiplier;
  const hasPrice = typeof multiplier === 'number' && Number.isFinite(multiplier) && multiplier >= 0;
  const supportedEfforts = model.reasoning?.supported;
  const hasReasoning = model.reasoningSupported !== undefined || (supportedEfforts?.length ?? 0) > 0;
  const official = model.officialContext ?? officialModelContext(model.id);
  const context = model.contextWindow === undefined ? official : model.contextSource === undefined ? model.contextWindow : { value: model.contextWindow, source: model.contextSource };
  return {
    id: model.id,
    provider: providerId,
    name: model.name,
    ...(hasPrice ? { priceMultiplier: model.priceSnapshot ?? multiplier, free: multiplier === 0, priceScope: 'model' } : {}),
    ...(!hasPrice && model.free !== undefined ? { free: model.free } : {}),
    ...(model.freeSource === undefined ? {} : { freeSource: model.freeSource }),
    ...(model.freeActivity === undefined ? {} : { freeActivity: model.freeActivity }),
    ...(model.activityLabels === undefined ? {} : { activityLabels: [...model.activityLabels] }),
    callVerified: false,
    ...(hasReasoning ? {
      reasoning: {
        ...(model.reasoningSupported === undefined ? {} : { supported: model.reasoningSupported }),
        ...(supportedEfforts === undefined || supportedEfforts.length === 0 ? {} : { supportedEfforts: [...supportedEfforts] }),
      },
    } : {}),
    // inputModalities 是上游能力；原有 tags 仍反映桥接实际开放的 input。
    ...(model.multimodal === undefined
      ? (model.input === undefined ? {} : { inputModalities: [...model.input] })
      : { inputModalities: model.multimodal ? ['text', 'image'] : ['text'] }),
    tags: model.input,
    ...(context === undefined ? {} : { minCtx: context }),
    ...(model.maxInput === undefined ? {} : { maxInput: model.maxInput }),
    ...(official === undefined ? {} : { officialContext: official }),
  };
}

/** 导出仅为单测：runTurn 的 shim SSE → ChatCompletionChunk（含 T023 usage）解析。 */
class TraeStreamError extends Error {}

export class TraeSession implements ProviderSession {
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
    rejectTurnImages('trae', input.messages);
    const body = JSON.stringify({
      model: input.model,
      messages: input.messages,
      stream: true,
    });
    const url = `${this.lease.shim.baseUrl()}/v1/chat/completions`;
    // T010：共享 shim 后，cancel 不再关整个 shim（会误杀并发会话）——
    // 只断本 session 的连接，shim 侧 handler 随客户端断开 abort 上游。
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
        throw new TraeStreamError(`trae shim rejected request: HTTP ${response.status} ${detail}`);
      }
      if (response.body === null) throw new TraeStreamError('trae shim returned no body');
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      const sse = new SseDecoder();
      let usage: TurnUsage | undefined;
      let sawDone = false;
      const consume = (event: ReturnType<SseDecoder['push']>[number]): string => {
        if (event.event === 'error') throw new TraeStreamError('trae upstream SSE error');
        if (event.data.trim() === '[DONE]') { sawDone = true; return ''; }
        let parsed: unknown;
        try { parsed = JSON.parse(event.data); } catch { throw new TraeStreamError('trae upstream sent malformed SSE JSON'); }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new TraeStreamError('trae upstream sent invalid SSE payload');
        const record = parsed as Record<string, unknown>;
        // Raw frames may echo credentials; expose an actionable constant, never payload.
        if (record['error'] !== undefined && record['error'] !== null) throw new TraeStreamError('trae upstream SSE error');
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
      if (!sawDone) throw new TraeStreamError('trae upstream stream ended without [DONE]');
      yield { delta: '', done: true, ...(usage === undefined ? {} : { usage }) };
    } catch (error) {
      // Transport exception text is not a trusted diagnostic channel.
      if (signal.aborted) throw new TraeStreamError('trae request cancelled');
      if (error instanceof TraeStreamError) throw error;
      throw new TraeStreamError('trae upstream stream transport failed');
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
