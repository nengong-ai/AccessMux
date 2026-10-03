// T013 测试共享桩：全部离线（不 spawn 真进程、不连真上游；lessons #2）。
// fixture 形状对照 T012 实测捕获的 /provider 与 /session/:id/message 响应
//（<isolated temporary directory>/oc-providers.json、oc-msg2.json，条目逐字段核对）。

import type { ExitGuardTarget, ServeChild } from '../../../src/adapters/opencode/isolate.js';

/** 可发射事件的假进程（退出联动测试用）。 */
export function fakeProcess(): {
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
      // Node 信号监听器收到的首个参数就是事件名
      for (const listener of [...(listeners.get(event) ?? [])]) listener(event);
    },
    kills,
  };
}

/** 可控假子进程：收到 exitSignals 里的信号才退出（默认 SIGTERM 即退；传 ['SIGKILL'] 模拟装死进程）。 */
export class FakeChild implements ServeChild {
  exitCode: number | null = null;
  signalCode: string | null = null;
  readonly kills: string[] = [];
  private readonly exitListeners: Array<(code: number | null, signal: string | null) => void> = [];
  private readonly errorListeners: Array<(error: Error) => void> = [];
  private readonly exitSignals: ReadonlySet<string>;
  readonly stdout = { pipe: () => undefined };
  readonly stderr = { pipe: () => undefined };

  constructor(exitSignals: readonly string[] = ['SIGTERM', 'SIGKILL']) {
    this.exitSignals = new Set(exitSignals);
  }

  on(_event: 'error', listener: (error: Error) => void): void {
    this.errorListeners.push(listener);
  }

  once(_event: 'exit', listener: (code: number | null, signal: string | null) => void): void {
    this.exitListeners.push(listener);
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    this.kills.push(String(signal));
    if (this.exitCode === null && this.signalCode === null && this.exitSignals.has(String(signal))) {
      this.signalCode = String(signal);
      for (const listener of [...this.exitListeners]) listener(this.exitCode, this.signalCode);
    }
    return true;
  }

  /** 模拟进程自然退出。 */
  exit(code: number): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    this.exitCode = code;
    for (const listener of [...this.exitListeners]) listener(code, null);
  }

  /** 模拟 spawn error 事件。 */
  fail(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }
}

export interface RecordedCall {
  method: string;
  url: string;
  body: unknown;
  signal: AbortSignal | undefined;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** 挂起直到请求被 abort（模拟长推理中被取消）。 */
export function hangUntilAbort(call: RecordedCall): Promise<Response> {
  return new Promise((_resolve, reject) => {
    call.signal?.addEventListener('abort', () => {
      reject(new DOMException('This operation was aborted', 'AbortError'));
    });
  });
}

/** 记录全部调用并交给 handler 路由的假 fetch。 */
export function fakeFetch(
  handler: (call: RecordedCall) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const bodyText = init?.body;
    calls.push({
      method: init?.method ?? 'GET',
      url,
      body: typeof bodyText === 'string' ? (JSON.parse(bodyText) as unknown) : undefined,
      signal: init?.signal instanceof AbortSignal ? init.signal : undefined,
    });
    return handler(calls[calls.length - 1]!);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

export function pathOf(url: string): string {
  return new URL(url).pathname;
}

/** /provider 响应 fixture：覆盖免费/非免费/deprecated/无文本输出/无 cost 各形态。 */
export const providerDirectoryFixture = {
  all: [
    {
      id: 'deepinfra',
      models: {
        'deep-free': {
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          capabilities: { output: { text: true } },
        },
      },
    },
    {
      id: 'opencode',
      models: {
        'mimo-v2.6-flash-free': {
          name: 'MiMo-V2.6-Flash Free',
          status: 'active',
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          capabilities: {
            toolcall: true,
            reasoning: true,
            input: { image: true },
            output: { text: true },
          },
          limit: { context: 200000, output: 32000 },
        },
        'space-bunny-free': {
          status: 'active',
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          capabilities: { toolcall: true, input: { image: false }, output: { text: true } },
          limit: { context: 1000000 },
        },
        'glm-5.3-flash': {
          status: 'active',
          cost: { input: 1, output: 2, cache: { read: 0, write: 0 } },
          capabilities: { output: { text: true } },
        },
        'paid-cache-free-shape': {
          status: 'active',
          cost: { input: 0, output: 0, cache: { read: 0.1, write: 0 } },
          capabilities: { output: { text: true } },
        },
        'retired-free': {
          status: 'deprecated',
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          capabilities: { output: { text: true } },
        },
        'voice-only-free': {
          status: 'active',
          cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
          capabilities: { output: { text: false } },
        },
        'no-cost-entry': {
          status: 'active',
          capabilities: { output: { text: true } },
        },
      },
    },
  ],
};

/** /session/:id/message 成功响应 fixture（含 step-start/step-finish 真实形状）。 */
export const messageResponseFixture = {
  info: {
    role: 'assistant',
    finish: 'stop',
    modelID: 'mimo-v2.6-flash-free',
    providerID: 'opencode',
    tokens: { input: 1933, output: 5 },
  },
  parts: [
    { type: 'step-start' },
    { type: 'text', text: 'OCFREE_OK' },
    { type: 'step-finish' },
  ],
};
