// 测试桩：注册到 adapter 注册表，提供可控的 runTurn 流。
// 不依赖真实桥接源（T001/T002）；专用于协议层 /v1/messages、/v1/chat/completions 测试。

import type {
  LaunchContext,
  ProbeResult,
  ProviderAdapter,
  ProviderSession,
  TurnInput,
} from '../../src/adapters/types.js';
import type { ChatCompletionChunk, ChatMessage, ModelInfo, QuotaState, TurnUsage } from '../../src/types.js';

export interface FakeAdapterOptions {
  id?: string;
  displayName?: string;
  /** probe 报告的模型清单 */
  modelIds?: string[];
  /** runTurn 逐 chunk 输出的 delta 数组；末尾自动追加 done=true 的空 chunk */
  chunks?: string[];
  /** 终帧上报的用量（T023）；不给 = 模拟"上游没给数"的 adapter */
  usage?: TurnUsage;
  /** launch 阶段抛错（模拟未实现 / 启动失败） */
  launchError?: Error;
  /** T036：模拟图片路径已点亮/未点亮的源 */
  bridgeImages?: boolean;
}

export class FakeAdapter implements ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly sandbox = 'none' as const;
  readonly bridgeImages: boolean | undefined;

  public readonly turnCalls: TurnInput[] = [];
  public readonly launchCalls: LaunchContext[] = [];

  private readonly modelIds: string[];
  private readonly chunks: string[];
  private readonly usage: TurnUsage | undefined;
  private readonly launchError: Error | undefined;

  constructor(opts: FakeAdapterOptions = {}) {
    this.id = opts.id ?? 'fake';
    this.displayName = opts.displayName ?? 'Fake Adapter';
    this.modelIds = opts.modelIds ?? ['fake-model'];
    this.chunks = opts.chunks ?? ['hello', ', ', 'world'];
    this.usage = opts.usage;
    this.launchError = opts.launchError;
    this.bridgeImages = opts.bridgeImages;
  }

  async probe(): Promise<ProbeResult> {
    const models: ModelInfo[] = this.modelIds.map((id) => ({ id, provider: this.id }));
    return { availability: 'available', models, auth: 'unknown' };
  }

  async launch(ctx: LaunchContext): Promise<ProviderSession> {
    this.launchCalls.push(ctx);
    if (this.launchError) throw this.launchError;
    const chunks = this.chunks;
    const turnCalls = this.turnCalls;
    const usage = this.usage;
    const session: ProviderSession = {
      runTurn(input: TurnInput): AsyncIterable<ChatCompletionChunk> {
        turnCalls.push(input);
        return (async function* () {
          for (const delta of chunks) {
            yield { delta, done: false };
          }
          yield { delta: '', done: true, ...(usage === undefined ? {} : { usage }) };
        })();
      },
      async cancel() {
        /* no-op */
      },
    };
    return session;
  }

  async fetchQuota(): Promise<QuotaState> {
    return 'ok';
  }

  async dispose(): Promise<void> {
    /* no-op */
  }
}

/** 取最后一个 runTurn 的入参；测试断言用 */
export function lastTurnInput(adapter: FakeAdapter): TurnInput | undefined {
  return adapter.turnCalls[adapter.turnCalls.length - 1];
}

/** 取最后一条 user 消息的 content；测试断言用 */
export function lastUserContent(adapter: FakeAdapter): string | undefined {
  const msgs: ChatMessage[] = lastTurnInput(adapter)?.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') return msgs[i].content;
  }
  return undefined;
}
