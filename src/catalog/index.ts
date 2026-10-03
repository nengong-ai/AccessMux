// 目录与凭据层骨架：定时 sweep + 单飞（inflightFetch）+ 代际 abort + invalidate()。
// 参考 dsh 系列 catalog 模式（报告 §12 #1-#3）。
// 凭据约束（D4）：真实凭据只在 daemon 进程内使用；本层只处理目录数据与本地 secret。

import { randomBytes } from 'node:crypto';

/** 进程内随机 secret，用于 shim 双层认证；永不出本进程、不落盘 */
export function generateLocalSecret(): string {
  return randomBytes(32).toString('hex');
}

export type Fetcher<T> = (signal: AbortSignal) => Promise<T>;

/**
 * 单 key 目录缓存：
 * - get() 并发调用只发一次 fetch（单飞）
 * - invalidate() 丢弃快照，下次 get 重建
 * - start() 定时 sweep 重建；stop() 停止并代际 abort 在途请求
 */
export class CatalogCache<T> {
  private snapshot: T | undefined;
  private inflight: Promise<T> | undefined;
  private generation = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private abort: AbortController | undefined;

  constructor(
    private readonly fetcher: Fetcher<T>,
    private readonly sweepMs = 30_000,
  ) {}

  async get(): Promise<T> {
    if (this.snapshot !== undefined) return this.snapshot;
    if (this.inflight) return this.inflight;
    const gen = ++this.generation;
    const controller = new AbortController();
    this.abort = controller;
    this.inflight = this.fetcher(controller.signal).then((value) => {
      if (gen === this.generation) this.snapshot = value;
      return value;
    }).finally(() => {
      if (gen === this.generation) this.inflight = undefined;
    });
    return this.inflight;
  }

  invalidate(): void {
    this.generation++;
    this.snapshot = undefined;
    this.inflight = undefined;
    this.abort?.abort();
    this.abort = undefined;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.invalidate();
      void this.get().catch(() => {});
    }, this.sweepMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.invalidate();
  }
}
