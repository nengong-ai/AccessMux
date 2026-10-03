// T020 测试共享桩：全部离线（不 spawn 真 qoderclicn、不连真上游；lessons #2）。
// 事件形状对照 T020 施工前实测捕获（internal development record §2：assistant/result envelope）。

import type { ExitGuardTarget, QoderChild, QoderSpawnFn } from '../../../src/adapters/qoder/client.js';
import type { QoderEvent } from '../../../src/adapters/qoder/protocol.js';

/** 可发射信号的假退出挂载点。 */
export function fakeExitTarget(): {
  target: ExitGuardTarget;
  emit: (event: string) => void;
  kills: Array<{ pid: number; signal: string }>;
} {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const kills: Array<{ pid: number; signal: string }> = [];
  const target: ExitGuardTarget = {
    pid: 4242,
    on(event, listener) {
      const list = listeners.get(event) ?? [];
      list.push(listener as (...args: unknown[]) => void);
      listeners.set(event, list);
      return target;
    },
    removeListener(event, listener) {
      listeners.set(event, (listeners.get(event) ?? []).filter((l) => l !== listener));
      return target;
    },
    kill(pid, signal) {
      kills.push({ pid, signal: String(signal ?? 'SIGTERM') });
      return true;
    },
  };
  return {
    target,
    emit(event) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(event);
    },
    kills,
  };
}

/**
 * 假 qoderclicn 子进程：stdout 事件手动/脚本驱动，stdin 全记录，
 * kill 记录信号并按 dieOnSignals 模拟退出（默认 SIGTERM/SIGKILL 都退；
 * 传 [] 模拟装死进程测 SIGKILL 升级）。
 */
export class FakeQoderChild implements QoderChild {
  exitCode: number | null = null;
  signalCode: string | null = null;
  readonly kills: string[] = [];
  readonly stdinWrites: string[] = [];
  private dataListener: ((chunk: unknown) => void) | undefined;
  private readonly exitListeners: Array<(code: number | null, signal: string | null) => void> = [];
  private readonly errorListeners: Array<(error: Error) => void> = [];
  private readonly dieOnSignals: ReadonlySet<string>;

  /** 每收到一条 stdin 行时的回调（脚本化应答用）。 */
  onStdinLine: ((line: string) => void) | undefined;

  constructor(dieOnSignals: readonly string[] = ['SIGTERM', 'SIGKILL']) {
    this.dieOnSignals = new Set(dieOnSignals);
  }

  readonly stdin = {
    write: (chunk: unknown) => {
      this.stdinWrites.push(String(chunk));
      const line = String(chunk).replace(/\n$/, '');
      if (line !== '') this.onStdinLine?.(line);
      return true;
    },
    end: () => {
      // CLI 正常路径：stdin 关闭即自检退出（实测 EXIT code=0）
      this.exit(0);
    },
  };

  readonly stdout = {
    on: (_event: 'data', listener: (chunk: unknown) => void) => {
      this.dataListener = listener;
    },
  };

  readonly stderr = { pipe: () => undefined };

  on(_event: 'error', listener: (error: Error) => void): void {
    this.errorListeners.push(listener);
  }

  once(_event: 'exit', listener: (code: number | null, signal: string | null) => void): void {
    this.exitListeners.push(listener);
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    this.kills.push(String(signal));
    if (
      this.exitCode === null &&
      this.signalCode === null &&
      this.dieOnSignals.has(String(signal))
    ) {
      this.emitExit(null, String(signal));
    }
    return true;
  }

  exit(code: number): void {
    this.emitExit(code, null);
  }

  fail(error: Error): void {
    for (const listener of [...this.errorListeners]) listener(error);
  }

  /** 模拟 stdout 一行事件（自动补 \n，走真实缓冲路径）。 */
  emitEvent(event: QoderEvent): void {
    this.dataListener?.(`${JSON.stringify(event)}\n`);
  }

  /** 模拟 stdout 半行（测跨 chunk 缓冲拼接）。 */
  emitRaw(chunk: string): void {
    this.dataListener?.(chunk);
  }

  private emitExit(code: number | null, signal: string | null): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    this.signalCode = signal;
    for (const listener of [...this.exitListeners]) listener(code, signal);
  }
}

/** spawn 工厂：按序取假进程，取完报错（防意外多 spawn）。 */
export function scriptedSpawn(children: FakeQoderChild[]): QoderSpawnFn & { calls: number } {
  const fn = (() => {
    const child = children.shift();
    if (child === undefined) throw new Error('测试脚本没有更多假进程');
    fn.calls += 1;
    return child;
  }) as QoderSpawnFn & { calls: number };
  fn.calls = 0;
  return fn;
}

/** 造一个"会说谎的 CLI"：收到 user envelope 就回 thinking+text+result(success)。 */
export function wireResponder(child: FakeQoderChild, replyText = 'AMUX_QODER_OK'): void {
  child.onStdinLine = () => {
    child.emitEvent({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'internal' }] },
    });
    child.emitEvent({
      type: 'assistant',
      message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: replyText }] },
    });
    child.emitEvent({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: replyText,
      stop_reason: 'end_turn',
      duration_ms: 1200,
      usage: { context_usage_ratio: 0.01 },
    });
  };
}

/** 收集 async iterable 的全部 chunk。 */
export async function drainChunks(iterable: AsyncIterable<{ delta: string; done: boolean }>): Promise<
  Array<{ delta: string; done: boolean }>
> {
  const chunks: Array<{ delta: string; done: boolean }> = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}
