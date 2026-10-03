// T019 测试公桩：脚本化 app-server 子进程（NDJSON 帧级伪造，离线）。

import { createHash } from 'node:crypto';
import type {
  AppServerChild,
  AppServerPaths,
  WireMessageLike,
} from './wire-types.js';

export interface FakeAppServerScript {
  /** 各方法的 result（默认覆盖 R016 合同的标准回合序列）。 */
  results?: Record<string, unknown>;
  /** 收到 session/send 后要发的通知序列（帧级伪造：turn.completed 等）。 */
  notificationsAfterSend?: object[];
  /** 收到 send 前的延迟（ms），模拟首回合模型延迟。 */
  sendDelayMs?: number;
}

/** 伪造的 app-server 子进程：解析宿主请求 → 按脚本回 result/通知。 */
export class FakeAppServerChild implements AppServerChild {
  exitCode: number | null = null;
  signalCode: string | null = null;
  readonly written: string[] = [];
  readonly kills: string[] = [];
  readonly errorListeners: Array<(error: Error) => void> = [];
  private readonly dataListeners: Array<(chunk: unknown) => void> = [];
  private readonly exitListeners: Array<() => void> = [];
  private readonly script: FakeAppServerScript;
  private nextFakeId = 9000;

  constructor(script: FakeAppServerScript = {}) {
    this.script = script;
  }

  on(event: 'error', listener: (error: Error) => void): void {
    if (event === 'error') this.errorListeners.push(listener);
  }

  once(event: 'exit', listener: () => void): void {
    if (event === 'exit') this.exitListeners.push(listener);
  }

  private fireExit(): void {
    for (const listener of this.exitListeners.splice(0)) listener();
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.kills.push(String(signal ?? 'SIGTERM'));
    this.signalCode = typeof signal === 'string' ? signal : null;
    this.exitCode = this.signalCode === null ? 0 : null;
    this.fireExit();
    return true;
  }

  readonly stdin = {
    write: (chunk: string): void => {
      for (const line of String(chunk).split('\n')) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        this.written.push(trimmed);
        this.onHostLine(trimmed);
      }
    },
    end: (): void => {
      // 真实 CLI 收 stdin 关闭会自检退出（code 0）；fake 同语义，dispose 快速收口
      this.exitCode = 0;
      this.fireExit();
    },
  };

  readonly stdout = {
    on: (event: 'data', listener: (chunk: unknown) => void): void => {
      if (event === 'data') this.dataListeners.push(listener);
    },
  };

  readonly stderr = {
    pipe: (): undefined => undefined,
  };

  /** 测试侧主动发一帧（模拟 CLI → 宿主方向）。 */
  emit(message: object): void {
    const text = `${JSON.stringify(message)}\n`;
    for (const listener of [...this.dataListeners]) listener(text);
  }

  /** 取宿主已写行中某方法的请求帧。 */
  requestsOf(method: string): WireMessageLike[] {
    return this.written
      .map((line) => JSON.parse(line) as WireMessageLike)
      .filter((message) => message.method === method);
  }

  private onHostLine(line: string): void {
    let message: WireMessageLike;
    try {
      message = JSON.parse(line) as WireMessageLike;
    } catch {
      return;
    }
    if (message.method === undefined || message.id === undefined) return;
    const respond = (result: unknown): void => {
      this.emit({ id: message.id, result });
    };
    const respondError = (code: number, errorMessage: string): void => {
      this.emit({ id: message.id, error: { code, message: errorMessage } });
    };
    switch (message.method) {
      case 'runtime/capabilities':
        respond(this.script.results?.['runtime/capabilities'] ?? { independentPlanState: true });
        return;
      case 'provider/updateAccountConfig':
        respond(this.script.results?.['provider/updateAccountConfig'] ?? { receivedRevision: 'r', providerCount: 1, status: 'received' });
        return;
      case 'session/create': {
        const sessionId = 'fake-session-1';
        this.currentSessionId = sessionId;
        respond(this.script.results?.['session/create'] ?? { session: { sessionId } });
        return;
      }
      case 'session/subscribe':
        respond(this.script.results?.['session/subscribe'] ?? { sessionId: this.currentSessionId, eventSeq: 0, events: [] });
        return;
      case 'session/send': {
        respond(this.script.results?.['session/send'] ?? { sessionId: this.currentSessionId, accepted: true, stateRevision: 1 });
        const delay = this.script.sendDelayMs ?? 0;
        const fire = (): void => {
          for (const notification of this.script.notificationsAfterSend ?? [
            { method: 'session/event', params: { sessionId: this.currentSessionId, type: 'turn.completed', payload: { response: 'FAKE-APP-SERVER-OK', resultType: 'success' } } },
          ]) {
            this.emit(notification);
          }
        };
        if (delay > 0) setTimeout(fire, delay);
        else fire();
        return;
      }
      case 'session/close':
        respond(this.script.results?.['session/close'] ?? {});
        return;
      default:
        respondError(-32601, `fake 不实现 ${message.method}`);
    }
  }

  private currentSessionId = 'fake-session-1';

  /** 下一个反向 RPC 的伪 id。 */
  get nextReverseId(): string {
    this.nextFakeId += 1;
    return `rev-${this.nextFakeId}`;
  }
}

/** 测试用路径集（全部指向临时文件）。 */
export function fakePaths(dir: string, builtinRevision: number): AppServerPaths {
  return {
    electron: `${dir}/fake-electron`,
    cliCjs: `${dir}/fake-zcode.cjs`,
    builtinConfig: `${dir}/zcode-builtin.json`,
    personalConfig: `${dir}/provider_config.json`,
  };
}

/** R016 §3.2 门禁式的独立复算（与实现互证）。 */
export function expectedBuiltinRevision(absolutePath: string, revision: number): string {
  return `zcode-builtin:${revision}:${createHash('sha256').update(absolutePath).digest('hex')}`;
}
