// T021 · 客户端中途断开 → session.cancel 被调用（cancel 缺口单测）。
//
// 背景（T020 实测）：旧实现挂 req（IncomingMessage）的 close，事件在 body
// 读完即已发出，listener 挂上时已错过——客户端真断开收不到，被掐请求照跑
// 整轮。本测试用真 socket 验证：流式响应中途 destroy 客户端连接，daemon 侧
// 必须对 adapter session 调 cancel（上游挂住不结束，只有断开侦测能触发）。

import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearRegistry, registerAdapter } from '../../src/adapters/registry.js';
import type {
  LaunchContext,
  ProbeResult,
  ProviderAdapter,
  ProviderSession,
  TurnInput,
} from '../../src/adapters/types.js';
import type { ChatCompletionChunk, ModelInfo, QuotaState } from '../../src/types.js';
import { buildServer } from '../../src/protocol/server.js';
import type { FastifyInstance } from 'fastify';

/**
 * runTurn 挂住不放（模拟上游整轮未完成）；cancel 记录调用次数并放行挂住的
 * 流，让 finally 收尾。只有 cancel 真被调用，runTurn 迭代器才会结束。
 */
class HangingAdapter implements ProviderAdapter {
  readonly id = 'hanging';
  readonly displayName = 'Hanging Adapter';
  readonly sandbox = 'none' as const;

  public cancelCalls = 0;
  private releaseTurn: (() => void) | undefined;

  async probe(): Promise<ProbeResult> {
    const models: ModelInfo[] = [{ id: 'slow-model', provider: this.id }];
    return { availability: 'available', models, auth: 'unknown' };
  }

  async launch(_ctx: LaunchContext): Promise<ProviderSession> {
    const self = this;
    return {
      runTurn(input: TurnInput): AsyncIterable<ChatCompletionChunk> {
        void input;
        return (async function* () {
          yield { delta: 'first-chunk', done: false };
          // 挂住：等 cancel 放行（不 cancel 就永远不到 done）
          await new Promise<void>((resolve) => { self.releaseTurn = resolve; });
          yield { delta: '', done: true };
        })();
      },
      async cancel(): Promise<void> {
        self.cancelCalls += 1;
        self.releaseTurn?.();
      },
    };
  }

  async fetchQuota(): Promise<QuotaState> {
    return 'unknown';
  }

  async dispose(): Promise<void> {
    /* no-op */
  }
}

let app: FastifyInstance | undefined;
let adapter: HangingAdapter | undefined;

beforeEach(() => {
  clearRegistry();
});

afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  clearRegistry();
});

/** 轮询等待条件成立（断开→cancel 是异步链路，给事件循环留时间）。 */
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`等待超时：条件在 ${timeoutMs}ms 内未成立`);
}

describe('客户端中途断开 → cancel（T021 cancel 缺口）', () => {
  it('流式响应中途断开客户端连接 → session.cancel 被调用', async () => {
    adapter = new HangingAdapter();
    registerAdapter(adapter);
    app = buildServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;

    // 真实 HTTP 客户端发流式请求；收到首帧（first-chunk）后立刻掐连接。
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      req.on('response', (res) => {
        res.on('data', (chunk: Buffer) => {
          if (chunk.toString().includes('first-chunk')) {
            req.destroy();
            resolve();
          }
        });
        res.on('error', () => undefined);
      });
      req.on('error', () => undefined);
      req.end(JSON.stringify({
        model: 'hanging:slow-model',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }));
      setTimeout(() => reject(new Error('未收到首帧')), 3000);
    });

    // 上游挂住不结束：cancel 只能来自断开侦测（raw close），不是正常收尾。
    await waitFor(() => (adapter?.cancelCalls ?? 0) > 0);
    expect(adapter.cancelCalls).toBeGreaterThanOrEqual(1);
  });

  it('正常完成的流式请求不走断开分支（aborted 收尾不误报）', async () => {
    // 正常收尾路径：raw close 在 writableEnded 之后触发，不算断开。
    // 用一个正常结束的 runTurn 验证全流程 200 且 cancel（finally 收尾）恰好一次。
    const calls: string[] = [];
    const normal = {
      id: 'normal',
      displayName: 'Normal Adapter',
      sandbox: 'none' as const,
      async probe(): Promise<ProbeResult> {
        return { availability: 'available', models: [{ id: 'm', provider: 'normal' }], auth: 'unknown' };
      },
      async launch(_ctx: LaunchContext): Promise<ProviderSession> {
        return {
          async *runTurn(_input: TurnInput): AsyncIterable<ChatCompletionChunk> {
            calls.push('turn');
            yield { delta: 'ok', done: false };
            yield { delta: '', done: true };
          },
          async cancel(): Promise<void> {
            calls.push('cancel');
          },
        };
      },
      async fetchQuota(): Promise<QuotaState> { return 'unknown'; },
      async dispose(): Promise<void> { /* no-op */ },
    } satisfies ProviderAdapter;
    registerAdapter(normal);
    app = buildServer();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;

    const body = await new Promise<string>((resolve, reject) => {
      const req = httpRequest({
        host: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      }, (res) => {
        let text = '';
        res.on('data', (c: Buffer) => { text += c.toString(); });
        res.on('end', () => resolve(text));
      });
      req.on('error', reject);
      req.end(JSON.stringify({
        model: 'normal:m',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }));
    });
    // 客户端完整读完：正常四帧收尾（role → delta → stop → [DONE]）
    expect(body).toContain('"delta":{"content":"ok"}');
    expect(body).toContain('[DONE]');
    // finally 收尾 cancel 一次；断开分支（writableEnded 后的 close）不再追加
    expect(calls.filter((c) => c === 'cancel')).toHaveLength(1);
  });
});
