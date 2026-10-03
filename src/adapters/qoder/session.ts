// Qoder 会话（chat-only MVP）：每请求取全新独占 qoderclicn，发一条折叠
// user 消息，把 assistant 文本块逐块作为 delta 吐出，result 事件收尾。
//
// 关键语义（全部实测定论，回执 §2）：
// - 每轮把宿主全量 messages 折叠成单条 user 消息（与 opencode foldTurn 同语义；
//   新进程/新会话永远从全量折叠恢复，无状态损失）
// - 未知模型名会被上游静默落到 Auto（可能计费）→ 已探明清单非空时客户端拦截
// - control interrupt 被静默忽略 → cancel = 杀进程，进程池下次 acquire 重起
//   （正常回合结束后的协议层 cancel 是 no-op，见 turnInFlight）

import type { ChatCompletionChunk } from '../../types.js';
import type { ProviderSession, TurnInput } from '../types.js';
import type { QoderLease, QoderProcessPool } from './pool.js';
import { estimateTurnUsage } from '../../usage.js';
import { redactLogText } from '../../util/redact.js';
import {
  buildUserEnvelope,
  extractTextDeltas,
  foldTurn,
  normalizeModelId,
  parseTurnResult,
} from './protocol.js';

export interface QoderSessionOptions {
  /**
   * 已探明模型清单（--list-models 解析结果）。非空时未知模型客户端直接拦
   * （防上游静默落到 Auto 烧额度）；空/undefined = 未探明，放行靠上游报错。
   */
  knownModels?: readonly string[];
  /** 含排队/启动的整个回合 deadline；默认 300s。 */
  turnTimeoutMs?: number;
  /** 诊断日志行。 */
  log?: (line: string) => void;
}

export class QoderSession implements ProviderSession {
  private turnInFlight = false;
  private currentLease: QoderLease | undefined;
  private controller: AbortController | undefined;
  private cancelled = false;

  constructor(
    private readonly pool: QoderProcessPool,
    private readonly options: QoderSessionOptions = {},
  ) {}

  async *runTurn(input: TurnInput): AsyncIterable<ChatCompletionChunk> {
    input.signal?.throwIfAborted();
    const model = normalizeModelId(input.model);
    const known = this.options.knownModels;
    if (known !== undefined && known.length > 0 && model !== 'qfmodel' && !known.includes(model)) {
      throw new Error(
        `qoder 未知模型 "${model}"：不在 --list-models 清单里，上游会静默落到 Auto（可能计费），已拦截。可用清单见 GET /v1/models 的 qoder:* 条目`,
      );
    }

    if (this.cancelled) throw new Error('qoder 回合被取消');
    if (this.turnInFlight) throw new Error('qoder 同一 session 不支持并发回合');
    this.turnInFlight = true;
    const controller = new AbortController();
    this.controller = controller;
    const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
    const timeoutMs = this.options.turnTimeoutMs ?? 300_000;
    const timer = setTimeout(() => {
      controller.abort(new Error(`qoder 回合 ${timeoutMs}ms 超时`));
      void this.currentLease?.discard();
    }, timeoutMs);
    let lease: QoderLease | undefined;
    try {
      lease = await this.pool.acquire(model, signal);
      this.currentLease = lease;
      signal.throwIfAborted();
      const turn = foldTurn(input.messages);
      lease.process.send(buildUserEnvelope(turn.text, turn.images));
      // T023：上游零计量面（R015 实证 usage.input_tokens 恒 0）→ 本地分词估算，
      // 结果带 estimated: true；绝不冒充真数。
      let completionText = '';
      while (true) {
        const event = await lease.process.nextEvent();
        signal.throwIfAborted();
        if (event === null) {
          throw new Error(
            'qoderclicn 进程在回合中途退出（崩溃或被断开）；下一句会自动重连新会话，请重试',
          );
        }
        if (event.type === 'assistant') {
          for (const delta of extractTextDeltas(event)) {
            completionText += delta;
            yield { delta, done: false };
          }
          continue;
        }
        if (event.type === 'result') {
          const result = parseTurnResult(event); // is_error / 空 result 在此抛错
          lease.reportTurn({ ok: true, contextRatio: result.contextRatio });
          clearTimeout(timer);
          // 终帧前回收，生产消费者 done-break 也不会留下 CLI 或租约。
          await lease.release();
          yield { delta: '', done: true, usage: estimateTurnUsage(turn.text, completionText) };
          return;
        }
        // 其余事件（system init / hook / artifacts_update 等）与输出无关，跳过
      }
    } catch (error) {
      throw new Error(redactLogText((error as Error).message));
    } finally {
      clearTimeout(timer);
      this.turnInFlight = false;
      this.controller = undefined;
      this.currentLease = undefined;
      await lease?.release();
    }
  }

  async cancel(): Promise<void> {
    // 协议层在每次回合结束（含正常结束）都会调 cancel：不在回合中即 no-op，
    // 保住常驻进程。回合中 cancel = 丢弃进程（interrupt 消息实测被静默忽略；
    // qoderclicn 生成期间还会忽略 SIGTERM → 由租约走 SIGKILL）。
    this.cancelled = true;
    if (!this.turnInFlight) return;
    this.controller?.abort(new Error('qoder 回合被取消（中途退出）'));
    this.log('cancel：丢弃当前请求 CLI，不影响其他租约');
    await this.currentLease?.discard();
  }

  private log(line: string): void {
    this.options.log?.(redactLogText(`[qoder-session] ${line}`));
  }
}
