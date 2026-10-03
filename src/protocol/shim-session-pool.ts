// LockedUsage adapter 的 shim 会话池（T010 #2）。
//
// 背景：MVP 期 launch() 用 "shim is already running" 守卫实现单 session，
// 宿主侧并发（模型选择器探测/刷新与聊天请求同时到达）撞上守卫就是 500，
// 表现为"翻模型时发消息必失败、重试就过"——ZCode turn_usage 实证：失败回合
// ttft 为空（请求建立期失败）、零重试。
//
// 语义：
// - 同 adapter 的并发 acquire 串行排队：创建临界区互斥，不会起第二个 shim；
// - 活动 shim 被并发会话复用（引用计数），不再抛 already-running 类错误；
// - 最后一个会话 release 才异步关 shim；关期内新的 acquire 等关完再建，
//   杜绝"launch 撞正在关闭的 shim"的窗口；
// - release 幂等：server 层 close/abort 双通道会对同一 session 重复 cancel；
// - shim 关闭不进临界区：关得慢（sockets 强杀）不阻塞新会话复用判定之外的路径。
//
// WorkBuddy（T010）与 Trae 共用本池；shim 本体仍是无状态的 LoopbackShim。

import type { LoopbackShim } from './shim.js';

export interface ShimSessionLease {
  readonly shim: LoopbackShim;
  /** 归还租约；引用计数归 0 时异步关闭 shim。重复调用无副作用。 */
  release(): void;
}

export interface ShimSessionPoolStats {
  sessions: number;
  hasShim: boolean;
  closing: boolean;
}

export class ShimSessionPool {
  private shim: LoopbackShim | undefined;
  private sessions = 0;
  private closing: Promise<void> | undefined;
  private mutex: Promise<void> = Promise.resolve();

  /**
   * 取 shim 租约。createShim 只在"无活动 shim 且不在关闭窗口"时被调用，
   * 且调用之间互斥——并发 acquire 要么复用同一 shim，要么排队等新的建好。
   * 本方法永不抛 already-running 类错误；createShim 自身的异常原样上抛。
   */
  async acquire(createShim: () => Promise<LoopbackShim>): Promise<ShimSessionLease> {
    return this.withLock(async () => {
      if (this.closing !== undefined) {
        // 旧 shim 还在关闭：等它彻底关完再建新的（T010 竞态窗口在此关闭）
        const closing = this.closing;
        this.closing = undefined;
        await closing;
      }
      if (this.shim === undefined) {
        const shim = await createShim();
        try {
          await shim.ready;
        } catch (error) {
          await shim.close().catch(() => undefined);
          throw error;
        }
        this.shim = shim;
      }
      this.sessions += 1;
      const shim = this.shim;
      let released = false;
      return {
        shim,
        release: () => {
          if (released) return;
          released = true;
          this.releaseOne(shim);
        },
      };
    });
  }

  /** 诊断/测试钩子：当前池状态。 */
  stats(): ShimSessionPoolStats {
    return {
      sessions: this.sessions,
      hasShim: this.shim !== undefined,
      closing: this.closing !== undefined,
    };
  }

  /** adapter dispose：强制关掉活动 shim（无视引用计数；daemon 退出用）。 */
  async dispose(): Promise<void> {
    await this.withLock(async () => {
      const shim = this.shim;
      this.shim = undefined;
      this.sessions = 0;
      if (shim !== undefined) {
        await shim.close().catch(() => undefined);
      }
    });
  }

  private releaseOne(shim: LoopbackShim): void {
    if (this.sessions > 0) this.sessions -= 1;
    if (this.sessions > 0) return; // 还有并发会话在用，shim 保留
    if (this.shim !== shim) return; // 已被 dispose/替换，双保险
    this.shim = undefined;
    const closing = shim.close().then(
      () => undefined,
      () => undefined, // close 失败不阻塞后续 launch（listen 端口由 OS 回收兜底）
    );
    this.closing = closing;
    void closing.then(() => {
      if (this.closing === closing) this.closing = undefined;
    });
  }

  /** 简单互斥：整个临界区（含 await createShim()）串行执行。 */
  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.mutex;
    let release!: () => void;
    this.mutex = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prev.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
