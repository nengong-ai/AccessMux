import { SharedWork } from '../../util/abort.js';
// OpenCode 免费档 FreeTierAdapter（T013，docs/source-spec-new-sources.md §3）。
//
// 形态：常驻一个隔离的 `opencode serve --pure` 子进程（懒启动、单飞），probe/
// launch/fetchQuota 共用；上游零凭据（匿名免费档），隔离细节见 isolate.ts。
// 上游额度无计量面：fetchQuota 只报 ok/unknown，不编造数字（验收标准 4）。
// 单源隔离（D8）：本 adapter 任何失败都收敛在自己身上——probe 失败标
// unavailable，不影响注册表里其他 adapter。

import { join } from 'node:path';
import { accessmuxConfigHome } from '../../config/paths.js';
import type {
  LaunchContext,
  ProbeResult,
  ProviderAdapter,
  ProviderSession,
} from '../types.js';
import type { QuotaState } from '../../types.js';
import { freeModelsFromDirectory, type ProviderDirectory } from './catalog.js';
import type { ExecFn, ExitGuardTarget, ServeHandle, SpawnFn, StartServeOptions } from './isolate.js';
import { startIsolatedServe } from './isolate.js';
import { OpenCodeSession } from './session.js';
import { resolveOpencodeRuntime, type ResolvedRuntime, type RuntimeDeps } from './runtime.js';

export interface OpenCodeAdapterOptions {
  /** XDG 隔离根目录（测试注入）；默认 ~/.accessmux/opencode-runtime。 */
  xdgRoot?: string;
  /** env 来源（测试注入）；默认 process.env。 */
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  spawnImpl?: SpawnFn;
  execImpl?: ExecFn;
  /** 二进制定位注入（测试用）；默认 resolveOpencodeRuntime。 */
  resolveRuntime?: (signal?: AbortSignal) => Promise<ResolvedRuntime>;
  /** RuntimeDeps 直传（exists/execFile/candidates 等）。 */
  runtimeDeps?: RuntimeDeps;
  refreshOnStart?: boolean;
  healthAttempts?: number;
  healthIntervalMs?: number;
  stopGraceMs?: number;
  /** 退出联动挂载点（测试注入；默认 process）。 */
  exitTarget?: ExitGuardTarget;
}

export class OpenCodeAdapter implements ProviderAdapter {
  readonly id = 'opencode';
  readonly displayName = 'OpenCode Free';
  /** 隔离靠 env 白名单 + 配置级权限门（非 OS 级沙箱），如实上报 behavioural。 */
  readonly sandbox = 'behavioural' as const;
  /**
   * T036 图片路径已点亮：官方 FilePartInput（data URI）塑形，真机图片往返
   * 验证过（详见 docs/host-integration.md 能力口径与 internal development record）。
   * 模型级以 catalog 的 inputModalities（上游 provider 目录 image 标）为准。
   */
  readonly bridgeImages = true;

  private readonly options: OpenCodeAdapterOptions;
  private handle: ServeHandle | undefined;
  private readonly startup = new SharedWork<ServeHandle>();
  private generation = 0;

  constructor(options: OpenCodeAdapterOptions = {}) {
    this.options = options;
  }

  /** 探测免费模型清单。失败（无二进制/起不来/目录异常）→ unavailable，不抛错。 */
  async probe(ctx?: { signal?: AbortSignal }): Promise<ProbeResult> {
    try {
      const { client } = await this.ensureServe(ctx?.signal);
      const models = freeModelsFromDirectory(
        await client.request<ProviderDirectory>('/provider', 'GET', undefined, { signal: ctx?.signal, timeoutMs: 5_000 }),
        this.id,
      );
      return { availability: models.length > 0 ? 'available' : 'unavailable', models, catalogSource: 'current', reasonCode: models.length > 0 ? 'directory-ready' : 'catalog-unavailable', observedAt: new Date().toISOString() };
    } catch {
      return { availability: 'unavailable', models: [] };
    }
  }

  /**
   * 会话即轻量包装（隔离 serve 已常驻，无需按请求起停）。ctx.localSecret
   * 保留给后续双层认证；本地 loopback + 随机隔离密码已覆盖 MVP 攻击面。
   */
  async launch(ctx: LaunchContext): Promise<ProviderSession> {
    const { client } = await this.ensureServe(ctx?.signal);
    return new OpenCodeSession(client);
  }

  /** 免费档无计量面：能列出免费模型 → ok；否则 unknown。不编造数字。 */
  async fetchQuota(ctx?: { signal?: AbortSignal }): Promise<QuotaState> {
    try {
      const { client } = await this.ensureServe(ctx?.signal);
      const models = freeModelsFromDirectory(
        await client.request<ProviderDirectory>('/provider', 'GET', undefined, { signal: ctx?.signal, timeoutMs: 5_000 }),
        this.id,
      );
      return models.length > 0 ? 'ok' : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /** 停止隔离 serve 并回收子进程。幂等；dispose 后再 probe/launch 会重新拉起。 */
  async dispose(): Promise<void> {
    this.generation++;
    this.startup.cancel();
    const handle = this.handle;
    this.handle = undefined;
    await handle?.stop();
  }

  private ensureServe(signal?: AbortSignal): Promise<ServeHandle> {
    signal?.throwIfAborted();
    if (this.handle !== undefined) return Promise.resolve(this.handle);
    const generation = this.generation;
    return this.startup.run(async ownedSignal => {
      const handle = await this.startServe(ownedSignal);
      if (ownedSignal.aborted || this.generation !== generation) {
        await handle.stop();
        throw new Error('opencode startup cancelled');
      }
      this.handle = handle;
      return handle;
    }, signal);
  }

  private async startServe(signal: AbortSignal): Promise<ServeHandle> {
    const runtime = this.options.resolveRuntime !== undefined
      ? await this.options.resolveRuntime(signal)
      : await resolveOpencodeRuntime({ env: this.options.env, ...this.options.runtimeDeps, signal });
    signal.throwIfAborted();
    const serveOptions: StartServeOptions = {
      signal,
      binary: runtime.path,
      version: runtime.version,
      root: this.options.xdgRoot ?? join(accessmuxConfigHome(), 'opencode-runtime'),
      env: this.options.env,
      fetchImpl: this.options.fetchImpl,
      spawnImpl: this.options.spawnImpl,
      execImpl: this.options.execImpl,
      refreshOnStart: this.options.refreshOnStart,
      healthAttempts: this.options.healthAttempts,
      healthIntervalMs: this.options.healthIntervalMs,
      stopGraceMs: this.options.stopGraceMs,
      exitTarget: this.options.exitTarget,
    };
    return startIsolatedServe(serveOptions);
  }
}
