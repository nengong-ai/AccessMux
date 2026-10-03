// ZCode Start Plan adapter：直连；B09 app-server 兜底硬禁用，失效时报 unavailable。
//
// 直连（D23）：读 `~/.zcode/v2/credentials.json` 解密 zcodejwttoken，直打官方
// messages 端点，body.system 首块携带官方开源 harness 前缀（sha256 自检）。
// 兜底（D21）：常驻 `zcode app-server` 协议依附，前缀门变化/直连失效时自动切换。
// 单源隔离（D8）：probe/launch/fetchQuota 失败都收敛在自己身上。
// 铁律：JWT 无 refresh（401 = 需重新登录，不做刷新）；429 限流可重试；
// 405/3012 = 前缀门（降级兜底，不改写前缀）；token 原值不落日志。

import type { LaunchContext, ProbeResult, ProviderAdapter, ProviderSession } from '../types.js';
import type { QuotaState } from '../../types.js';
import { startPlanModelInfos, modelInfosFor } from './catalog.js';
import { loadZcodeCredential, ZcodeCredentialError } from './credential-store.js';
import { fetchZcodeBalance, fetchZcodeQuota } from './quota.js';
import { ZcodeUpstreamError } from './error-classify.js';
import { verifyOfficialPrefix } from './prefix.js';
import { APP_SERVER_DISABLED_REASON, ZcodeAppServerHost, type ExitGuardTarget, type ZcodeSpawnFn } from './app-server.js';
import { redactLogText } from '../../util/redact.js';
import { ZcodeSession, type ZcodeForm, type ZcodeFormState } from './session.js';

/** 手动指定形态（默认 direct=自动降级；app-server=只用兜底，D23 被否决时用）。 */
export const ZCODE_FORM_ENV = 'ACCESSMUX_ZCODE_FORM';

export interface ZcodeAdapterOptions {
  env?: Record<string, string | undefined>;
  home?: string;
  username?: string;
  fetchImpl?: typeof fetch;
  spawnImpl?: ZcodeSpawnFn;
  exitTarget?: ExitGuardTarget;
  /** app-server 运行根目录；默认 <configHome>/zcode-runtime。 */
  root?: string;
  log?: (line: string) => void;
  form?: ZcodeForm;
  idleMs?: number;
  quotaTimeoutMs?: number;
}

export class ZcodeAdapter implements ProviderAdapter {
  readonly id = 'zcode';
  readonly displayName = 'ZCode Start Plan';
  /**
   * 直连形态无本地执行；兜底形态的官方 agent 跑在 HOME 沙箱 + 专用 workspace
   * （行为级隔离，非 OS 级），如实上报 behavioural 不夸大 enforced。
   */
  readonly sandbox = 'behavioural' as const;
  /**
   * T036 图片路径已点亮：直连形态按标准 Anthropic image block（base64 source）
   * 塑形，GLM-5.3-Flash 真机图片往返验证过（详见 docs/host-integration.md
   * 能力口径与 receipts/R036）。GLM-5.2 / GLM-5-Turbo 未验证，catalog 不盖
   * inputModalities，模型级保持灰标。
   */
  readonly bridgeImages = true;

  private readonly formState: ZcodeFormState;
  private readonly options: ZcodeAdapterOptions;
  private host: ZcodeAppServerHost | undefined;

  constructor(options: ZcodeAdapterOptions = {}) {
    this.options = options;
    if (options.log === undefined) {
      // 默认日志出口：形态切换/进程回收等一次性事件落 stderr（与请求日志同
      // 管道；ACCESSMUX_REQUEST_LOG=0 一并静音），否则切换原因在 daemon 侧无痕
      const source = options.env ?? process.env;
      if (source['ACCESSMUX_REQUEST_LOG'] !== '0') {
        this.defaultLog = (line) => console.error(line);
      }
    }
    // 生产 daemon 不注入 env：回退 process.env 让 ACCESSMUX_ZCODE_FORM 的文档
    // 承诺真正生效（R021 反证修复）；注入优先，保测试隔离不被宿主环境污染。
    const fromEnv = (options.env ?? process.env)[ZCODE_FORM_ENV]?.trim();
    const form: ZcodeForm =
      options.form
      ?? (fromEnv === 'app-server' || fromEnv === 'direct' ? fromEnv : 'direct');
    this.formState = form === 'direct' ? { form } : { form: 'unavailable', reason: APP_SERVER_DISABLED_REASON };
  }

  /**
   * 探测：前缀常量自检 + 凭据解密 + balance（R014 合同）。模型清单按 balance
   * 的 capabilities 动态过滤（用户裁决"不虚标"：builtin 目录三名是 provider
   * 级清单，权益粒度可能只放行其一，T019 真机实证 GLM-5.2/GLM-5-Turbo 吃
   * 400/3006）；balance 拿不到（unknown）或匹配不到模型 capability 时退回
   * 固定三名 + unverified——权益以 balance 为准，拿不到就不下结论。
   * 直连门槛（前缀门）不在此处烧模型请求验证——真回合里 405 会自动降级兜底形态。
   */
  async probe(ctx?: { signal?: AbortSignal }): Promise<ProbeResult> {
    ctx?.signal?.throwIfAborted();
    if (this.formState.form !== 'direct') return { availability: 'unavailable', models: [], auth: 'unknown' };
    if (!verifyOfficialPrefix().ok) {
      // 常量被改坏：不硬闯（验收标准 2），直接 unavailable
      this.log('probe：官方前缀常量 sha256 自检失配');
      return { availability: 'unavailable', models: [], auth: 'unknown' };
    }
    let credential;
    try {
      credential = this.loadCredential();
    } catch (error) {
      ctx?.signal?.throwIfAborted();
      this.log('probe：本地登录信息暂无法读取');
      if (error instanceof ZcodeCredentialError && error.reason === 'missing') {
        return { availability: 'unavailable', models: [], auth: 'logged-out' };
      }
      return { availability: 'unverified', models: [], auth: 'unknown', reasonCode: 'credential-unavailable' };
    }
    let outcome;
    try {
      outcome = await fetchZcodeBalance(
        { jwt: credential.jwt, deviceMid: credential.deviceMid },
        { fetchImpl: this.options.fetchImpl, env: this.options.env, log: this.rawLog, timeoutMs: this.options.quotaTimeoutMs, signal: ctx?.signal },
      );
    } catch (error) {
      ctx?.signal?.throwIfAborted();
      if (error instanceof ZcodeUpstreamError && error.kind === 'relogin' && error.status === 401) {
        // 明确 401 才能证明 JWT 被上游拒绝。
        return { availability: 'unavailable', models: [], auth: 'logged-out' };
      }
      return { availability: 'unverified', models: [], auth: 'logged-in', reasonCode: 'catalog-unavailable' };
    }
    ctx?.signal?.throwIfAborted();
    if (outcome.entitledModels !== undefined) {
      // ok/exhausted 都证明"解密成功 + balance 200"，且拿到了权益模型清单
      this.log(`probe：权益模型 = ${outcome.entitledModels.join(' / ')}（以 balance 为准）`);
      return {
        availability: 'available',
        models: modelInfosFor(outcome.entitledModels),
        auth: 'logged-in',
      };
    }
    if (outcome.state === 'unknown') {
      // balance 拿不到有效形状：退回固定清单（unverified，不虚标也不误杀）
      return { availability: 'unverified', models: startPlanModelInfos(), auth: 'logged-in', catalogSource: 'fallback', reasonCode: 'catalog-fallback' };
    }
    // balance 正常但没有可识别的模型 capability：同退固定清单（availability 以 adapter 健康为准）
    return { availability: 'unverified', models: startPlanModelInfos(), auth: 'logged-in', catalogSource: 'fallback', reasonCode: 'catalog-fallback' };
  }

  async launch(ctx: LaunchContext): Promise<ProviderSession> {
    ctx.signal?.throwIfAborted();
    return new ZcodeSession({
      env: this.options.env,
      fetchImpl: this.options.fetchImpl,
      loadCredential: () => this.loadCredential(),
      formState: this.formState,
      appServer: this.appServerHost(),
      // session/host 自带 [zcode]… 前缀，这里给未加前缀的原始 sink
      log: this.rawLog,
    });
  }

  /** balance → QuotaState（remaining/当日过期语义见 quota.ts；不编数）。 */
  async fetchQuota(ctx?: { signal?: AbortSignal }): Promise<QuotaState> {
    ctx?.signal?.throwIfAborted();
    try {
      const credential = this.loadCredential();
      return await fetchZcodeQuota(
        { jwt: credential.jwt, deviceMid: credential.deviceMid },
        { fetchImpl: this.options.fetchImpl, env: this.options.env, log: this.rawLog, timeoutMs: this.options.quotaTimeoutMs, signal: ctx?.signal },
      );
    } catch {
      return 'unknown';
    }
  }

  /** 停掉常驻 app-server 子进程（若已起）；幂等。 */
  async dispose(): Promise<void> {
    const host = this.host;
    this.host = undefined;
    if (host !== undefined) await host.dispose();
  }

  /** 形态诊断：当前生效形态与切换原因（排障/文档用）。 */
  formSnapshot(): { form: ZcodeForm; reason?: string; fallbackAvailable: false; tools: 'disabled' } {
    return { form: this.formState.form, fallbackAvailable: false, tools: 'disabled', ...(this.formState.reason === undefined ? {} : { reason: redactLogText(this.formState.reason) }) };
  }

  private loadCredential() {
    return loadZcodeCredential({
      home: this.options.home,
      env: this.options.env,
      username: this.options.username,
    });
  }

  private appServerHost(): ZcodeAppServerHost {
    if (this.host === undefined) {
      this.host = new ZcodeAppServerHost({
        env: this.options.env,
        home: this.options.home,
        root: this.options.root,
        spawnImpl: this.options.spawnImpl,
        exitTarget: this.options.exitTarget,
        idleMs: this.options.idleMs,
        getJwt: () => this.loadCredential().jwt,
        log: this.rawLog,
      });
    }
    return this.host;
  }

  /** 未加前缀的日志 sink：注入优先，默认 stderr（session/host 自带前缀）。 */
  private readonly rawLog = (line: string): void => {
    (this.options.log ?? this.defaultLog)?.(redactLogText(line));
  };

  private defaultLog: ((line: string) => void) | undefined;

  private log(line: string): void {
    this.rawLog(`[zcode] ${line}`);
  }
}
