// 常驻 qoderclicn 子进程包装（T020，依附型形态 (i)）。
// - spawn：--input-format stream-json --output-format stream-json --tools ""
//   --permission-mode dont_ask -m <model>；凭据进程内自闭环（D22），env 白名单只给
//   OS/网络变量（HOME 必需：读 ~/.qoder-cn 登录态；绝不带其他 provider 的 key）
// - 输出：stdout 逐行 JSON 事件进队列；消费方（session）一轮一个消费者，
//   进程退出给等待中的消费者发 null（→ 抛错/重连）
// - 回收：stop = stdin 关闭（CLI 自检退出，实测 code 0）→ SIGTERM → 宽限 → SIGKILL
// - 父进程退出联动（沿 T013 exit-guard 经验，opencode isolate.ts 同款模式、
//   本目录自持实现）：信号先完整 stop 再原信号重发；exit 同步补 SIGTERM。
//   kill -9 daemon 无法拦截（任何进程级方案都做不到），文档给手动清理。

import { spawn } from 'node:child_process';
import { Writable } from 'node:stream';
// 不持久化原始 stdout/stderr：CLI 回声可能包含凭据及私人对话。
import type { QoderEvent } from './protocol.js';

/** env 白名单：OS/网络必需项，其余全部丢弃（不透传任何第三方 key）。 */
const ENV_WHITELIST = [
  'PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'SHELL', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS',
  'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATHEXT', 'COMSPEC',
] as const;

export function buildQoderEnv(source: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_WHITELIST) {
    const value = source[key];
    if (typeof value === 'string' && value !== '') env[key] = value;
  }
  return env;
}

/** 常驻 CLI 子进程的最小面（真实 ChildProcess 的子集；测试可全伪）。 */
export interface QoderChild {
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  on(event: 'error', listener: (error: Error) => void): void;
  once(event: 'exit', listener: (code: number | null, signal: string | null) => void): void;
  kill(signal?: NodeJS.Signals | number): boolean;
  stdin: { write(chunk: string): unknown; end(): void };
  stdout: { on(event: 'data', listener: (chunk: unknown) => void): void };
  stderr: { pipe(destination: { write(chunk: unknown): void }, options?: { end?: boolean }): unknown };
}

export type QoderSpawnFn = (
  file: string,
  args: readonly string[],
  options: { cwd: string; env: Record<string, string> },
) => QoderChild;

const realSpawn: QoderSpawnFn = (file, args, options) => {
  const child = spawn(file, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (child.stdin === null || child.stdout === null || child.stderr === null) {
    child.kill('SIGKILL');
    throw new Error('qoderclicn: stdio pipe 不可用');
  }
  return child as unknown as QoderChild;
};

// —— 父进程退出联动 ——

export interface ExitGuardTarget {
  readonly pid: number;
  // eslint 未配置；any[] 是刻意的：兼容 Node Process 的宽松监听器签名
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
  kill(pid: number, signal?: NodeJS.Signals): unknown;
}

interface LiveProcess {
  stop(): Promise<void>;
  /** 同步路径：只发 SIGTERM，不等回收（exit 钩子必须同步）。 */
  syncKill(): void;
}

const liveProcesses = new Set<LiveProcess>();
const boundTargets = new WeakSet<object>();

export function bindExitGuards(target: ExitGuardTarget = process): void {
  if (boundTargets.has(target)) return;
  boundTargets.add(target);
  target.on('exit', () => {
    for (const proc of liveProcesses) proc.syncKill();
  });
  const onSignal = (signal: NodeJS.Signals): void => {
    void Promise.allSettled([...liveProcesses].map((proc) => proc.stop())).then(() => {
      target.removeListener(signal, onSignal);
      // 摘掉自己的监听后原信号重发，交给系统默认处置（退出码语义保持 128+n）
      target.kill(target.pid, signal);
    });
  };
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    target.on(signal, onSignal);
  }
}

export interface StartQoderCliOptions {
  binary: string;
  model: string;
  cwd: string;
  env?: Record<string, string | undefined>;
  logPath?: string;
  spawnImpl?: QoderSpawnFn;
  stopGraceMs?: number;
  exitTarget?: ExitGuardTarget;
}

/** 构造常驻 CLI 的 spawn 参数（与 R018/T020 实测命令行一致）。 */
export function qoderCliArgs(model: string): string[] {
  return [
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--tools', '""',
    '--permission-mode', 'dont_ask',
    '-m', model,
  ];
}

export class QoderCliProcess {
  private readonly queue: QoderEvent[] = [];
  private readonly waiters: Array<(event: QoderEvent | null) => void> = [];
  private buffer = '';
  private ended = false;
  private stopping: Promise<void> | undefined;
  private spawnFailure: Error | undefined;
  private readonly stderrSink = new Writable({ write(_chunk, _encoding, callback) { callback(); } });

  private constructor(
    private readonly child: QoderChild,
    private readonly options: StartQoderCliOptions,
  ) {
    child.stderr?.pipe(this.stderrSink, { end: false });
    child.stdout.on('data', (chunk: unknown) => {
      this.buffer += String(chunk);
      let newline: number;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        this.pushLine(line);
      }
    });
    child.on('error', (error) => {
      this.spawnFailure = error;
      this.terminateQueue();
    });
    child.once('exit', () => {
      this.terminateQueue();
    });
  }

  /** 起进程并装配；任何后续失败路径由调用方/池回收（构造函数不抛）。 */
  static start(options: StartQoderCliOptions): QoderCliProcess {
    const spawnImpl = options.spawnImpl ?? realSpawn;
    const child = spawnImpl(options.binary, qoderCliArgs(options.model), {
      cwd: options.cwd,
      env: buildQoderEnv(options.env ?? process.env),
    });
    const proc = new QoderCliProcess(child, options);
    liveProcesses.add(proc.liveHandle);
    bindExitGuards(options.exitTarget);
    return proc;
  }

  get alive(): boolean {
    if (this.spawnFailure !== undefined) return false;
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  /** 写一条 user envelope 到 stdin（行尾 \n）。进程已死时抛错。 */
  send(envelopeJson: string): void {
    if (!this.alive) {
      throw new Error(
        `qoderclicn 进程已退出（code=${this.child.exitCode} signal=${this.child.signalCode}）`,
      );
    }
    this.child.stdin.write(`${envelopeJson}\n`);
  }

  /**
   * 取下一个事件；进程退出且队列排空后返回 null。
   * 一轮只允许一个消费者（进程池串行保证）。
   */
  nextEvent(): Promise<QoderEvent | null> {
    const next = this.queue.shift();
    if (next !== undefined) return Promise.resolve(next);
    if (!this.alive || this.ended) return Promise.resolve(null);
    return new Promise<QoderEvent | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /** 杀掉进程（cancel 链路用）；进程池会在下次 acquire 时重起。 */
  kill(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.alive) this.child.kill(signal);
    // 不依赖异步 exit 才唤醒消费者；SIGKILL 已进入底层终止路径。
    if (signal === 'SIGKILL') this.terminateQueue();
  }

  /** 幂等回收：stdin 关闭（CLI 自检退出）→ 等宽限 → SIGTERM → 等 → SIGKILL。 */
  async stop(): Promise<void> {
    if (this.stopping !== undefined) return this.stopping;
    this.stopping = (async () => {
      liveProcesses.delete(this.liveHandle);
      if (this.alive) {
        try {
          this.child.stdin.end();
        } catch {
          // stdin 已坏不影响后续信号路径
        }
        await this.waitExit(5000);
      }
      if (this.alive) {
        this.child.kill('SIGTERM');
        await this.waitExit(this.options.stopGraceMs ?? 4000);
      }
      if (this.alive) this.child.kill('SIGKILL');
      this.terminateQueue();
      this.stderrSink.destroy();
    })();
    return this.stopping;
  }

  private readonly liveHandle: LiveProcess = {
    stop: () => this.stop(),
    syncKill: () => {
      if (this.alive) this.child.kill('SIGTERM');
    },
  };

  private waitExit(timeoutMs: number): Promise<void> {
    if (!this.alive) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      this.child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private pushLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let event: QoderEvent;
    try {
      event = JSON.parse(trimmed) as QoderEvent;
    } catch {
      return; // 非 JSON 行（banner 之类）直接丢
    }
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter(event);
    else this.queue.push(event);
  }

  private terminateQueue(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter(null);
  }
}
