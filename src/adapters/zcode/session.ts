// ZCode 直连会话：B09 无已验证工具全拒配置，app-server 兜底硬禁用。
// 405/3012 后共享状态变 unavailable，后续不再消费；重建 adapter 才恢复 direct。
// 不猜参数、不改前缀、不把纯文本端点静默升级为本地 agent。

import type { ChatCompletionChunk } from '../../types.js';
import type { ProviderSession, TurnInput } from '../types.js';
import { isStartPlanModel, START_PLAN_MODELS } from './catalog.js';
import { directTurn, type DirectTurnDeps } from './direct-client.js';
import { APP_SERVER_DISABLED_REASON, type ZcodeAppServerHost } from './app-server.js';
import { redactLogText } from '../../util/redact.js';
import { ZcodeUpstreamError } from './error-classify.js';
import { verifyOfficialPrefix } from './prefix.js';
import type { ZcodeCredential } from './credential-store.js';

export type ZcodeForm = 'direct' | 'app-server' | 'unavailable';

/** adapter 级共享形态状态：直连撞前缀门后一次性切换，跨会话生效。 */
export interface ZcodeFormState {
  form: ZcodeForm;
  /** 切换原因（诊断/文档用）。 */
  reason?: string;
}

export type ZcodeCredentialLoader = () => ZcodeCredential;

export interface ZcodeSessionOptions {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  loadCredential: ZcodeCredentialLoader;
  formState: ZcodeFormState;
  appServer: ZcodeAppServerHost;
  log?: (line: string) => void;
  /** 直连实现注入（测试用；默认 directTurn）。 */
  directTurnImpl?: typeof directTurn;
  /** app-server 回合实现注入（测试用；默认 host.runTurn）。 */
  appServerTurnImpl?: ZcodeAppServerHost['runTurn'];
}

export class ZcodeSession implements ProviderSession {
  private turnInFlight = false;
  private abortDirect: (() => void) | undefined;
  private cancelled = false;

  constructor(private readonly options: ZcodeSessionOptions) {}

  async *runTurn(input: TurnInput): AsyncIterable<ChatCompletionChunk> {
    input.signal?.throwIfAborted();
    if (!isStartPlanModel(input.model)) {
      throw new Error(
        `zcode 未知模型 "${input.model}"：Start Plan 固定清单为 ${START_PLAN_MODELS.join(' / ')}`,
      );
    }
    if (this.cancelled) throw new Error('zcode 回合被取消');
    if (this.turnInFlight) throw new Error('zcode 同一 session 不支持并发回合');
    if (this.options.formState.form !== 'direct') {
      this.switchToAppServer(APP_SERVER_DISABLED_REASON);
      throw new Error(APP_SERVER_DISABLED_REASON);
    }
    const credential = this.options.loadCredential();

    this.turnInFlight = true;
    try {
      if (this.options.formState.form === 'direct') {
        const prefixCheck = verifyOfficialPrefix();
        if (!prefixCheck.ok) {
          this.switchToAppServer(
            `前缀常量自检失配（sha256 ${prefixCheck.sha256.slice(0, 8)}… ≠ 预期 ${prefixCheck.expected.slice(0, 8)}…），不改写不硬闯`,
          );
        } else {
          try {
            const controller = new AbortController();
            this.abortDirect = () => controller.abort();
            const deps: DirectTurnDeps = {
              fetchImpl: this.options.fetchImpl,
              env: this.options.env,
              signal: input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal,
              log: this.options.log,
            };
            try {
              for await (const chunk of (this.options.directTurnImpl ?? directTurn)(
                { model: input.model, messages: input.messages, stream: input.stream, jwt: credential.jwt },
                deps,
              )) {
                yield chunk;
              }
              return;
            } finally {
              controller.abort();
              this.abortDirect = undefined;
            }
          } catch (error) {
            if (error instanceof ZcodeUpstreamError && error.kind === 'prefixGate') {
              this.switchToAppServer(`直连前缀门失效；${APP_SERVER_DISABLED_REASON}`);
            } else {
              throw error;
            }
          }
        }
      }

      throw new Error(APP_SERVER_DISABLED_REASON);
    } catch (error) {
      // 仅安全投影错误，不处理正常模型正文；保留上层错误分类。
      if (error instanceof Error) error.message = redactLogText(error.message, 300, [credential.jwt]);
      throw error;
    } finally {
      this.turnInFlight = false;
    }
  }

  async cancel(): Promise<void> {
    // 协议层在每回合结束后也调 cancel：不在回合中即 no-op（保住常驻 app-server）
    this.cancelled = true;
    if (!this.turnInFlight) return;
    this.abortDirect?.();
  }

  private switchToAppServer(reason: string): void {
    this.options.formState.form = 'unavailable';
    this.options.formState.reason = redactLogText(reason);
    this.options.log?.(redactLogText(`[zcode] 形态切换 → unavailable：${reason}`));
  }
}
