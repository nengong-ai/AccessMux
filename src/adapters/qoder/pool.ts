import { abortable } from '../../util/abort.js';
// Qoder stream-json 没有可靠 reset：每个请求独占一个全新 CLI，上下文绝不按模型复用。
// 同模型仍串行限流；释放时关闭进程并删除临时 workspace，取消/失败直接 SIGKILL。
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { accessmuxConfigHome } from '../../config/paths.js';
import { QoderCliProcess, type ExitGuardTarget, type QoderSpawnFn } from './client.js';
import { resolveQoderRuntime, type ResolvedQoderRuntime } from './runtime.js';

export interface QoderPoolOptions {
  resolveRuntime?: (signal?: AbortSignal) => Promise<ResolvedQoderRuntime>;
  root?: string;
  env?: Record<string, string | undefined>;
  spawnImpl?: QoderSpawnFn;
  exitTarget?: ExitGuardTarget;
  /** 兼容旧配置；不再跨请求保暖。 */
  idleMs?: number;
  maxTurnsPerProcess?: number;
  contextRatioThreshold?: number;
  log?: (line: string) => void;
}
export interface TurnReport { ok: boolean; contextRatio?: number }
export interface QoderLease {
  readonly process: QoderCliProcess;
  reportTurn(report: TurnReport): void;
  release(): Promise<void>;
  discard(): Promise<void>;
}

export class QoderProcessPool {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly active = new Set<QoderLease>();
  private readonly shutdown = new AbortController();
  private disposed = false;
  private stopping: Promise<void> | undefined;

  constructor(private readonly options: QoderPoolOptions = {}) {}

  async acquire(model: string, signal?: AbortSignal): Promise<QoderLease> {
    if (this.disposed) throw new Error('qoder 进程池已 dispose');
    const combined = signal === undefined ? this.shutdown.signal : AbortSignal.any([signal, this.shutdown.signal]);
    combined.throwIfAborted();
    const previous = this.queues.get(model) ?? Promise.resolve();
    let unlock!: () => void;
    const current = new Promise<void>((resolve) => { unlock = resolve; });
    this.queues.set(model, current);
    const unlockWhenReady = () => {
      void previous.finally(() => {
        unlock();
        if (this.queues.get(model) === current) this.queues.delete(model);
      });
    };
    let workspace: string | undefined;
    try {
      await abortable(previous, combined);
      combined.throwIfAborted();
      const runtime = await abortable(this.options.resolveRuntime ? this.options.resolveRuntime(combined) : resolveQoderRuntime({ env: this.options.env, signal: combined }), combined);
      combined.throwIfAborted();
      const root = this.options.root ?? join(accessmuxConfigHome(), 'qoder-runtime');
      await mkdir(root, { recursive: true, mode: 0o700 });
      combined.throwIfAborted();
      workspace = await mkdtemp(join(root, 'request-'));
      combined.throwIfAborted();
      const proc = QoderCliProcess.start({
        binary: runtime.path, model, cwd: workspace, env: this.options.env,
        spawnImpl: this.options.spawnImpl, exitTarget: this.options.exitTarget,
        // 原始 CLI stderr 不落盘（可能含凭据或请求正文）。
      });
      const ownedWorkspace = workspace;
      let cleanup: Promise<void> | undefined;
      let successful = false;
      const finish = (discard: boolean): Promise<void> => {
        if (discard) proc.kill('SIGKILL');
        if (cleanup !== undefined) return cleanup;
        combined.removeEventListener('abort', onAbort);
        cleanup = proc.stop().finally(async () => {
          this.active.delete(lease);
          await rm(ownedWorkspace, { recursive: true, force: true }).catch(() => undefined);
          unlockWhenReady();
        });
        return cleanup;
      };
      const onAbort = () => { void finish(true); };
      const lease: QoderLease = {
        process: proc,
        reportTurn: (report) => { successful = report.ok; },
        release: () => finish(!successful),
        discard: () => finish(true),
      };
      this.active.add(lease);
      combined.addEventListener('abort', onAbort, { once: true });
      if (combined.aborted) {
        await lease.discard();
        combined.throwIfAborted();
      }
      return lease;
    } catch (error) {
      if (workspace !== undefined) await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
      unlockWhenReady();
      throw error;
    }
  }

  dispose(): Promise<void> {
    if (this.stopping !== undefined) return this.stopping;
    this.disposed = true;
    this.shutdown.abort(new Error('qoder 进程池已 dispose'));
    this.stopping = Promise.allSettled([...this.active].map((lease) => lease.discard())).then(() => undefined);
    return this.stopping;
  }

  liveCount(): number {
    return [...this.active].filter((lease) => lease.process.alive).length;
  }
}
