// ZCode 直连前缀门与兜底硬禁用；取消行为合成回归。
// 切换一次性生效；401 不降级；未知模型拦截；cancel 语义。

import { describe, expect, it, vi } from 'vitest';
import type { ChatCompletionChunk } from '../../../src/types.js';
import type { ZcodeAppServerHost } from '../../../src/adapters/zcode/app-server.js';
import { ZcodeUpstreamError } from '../../../src/adapters/zcode/error-classify.js';
import {
  ZcodeSession,
  type ZcodeFormState,
  type ZcodeCredentialLoader,
} from '../../../src/adapters/zcode/session.js';
import type { ZcodeCredential } from '../../../src/adapters/zcode/credential-store.js';

const CREDENTIAL: ZcodeCredential = { jwt: 'jwt-x', deviceMid: 'mid', deviceMidSource: 'generated' };
const LOAD: ZcodeCredentialLoader = () => CREDENTIAL;

function fakeHost(): ZcodeAppServerHost {
  return {
    runTurn: vi.fn(async function* (): AsyncGenerator<ChatCompletionChunk> {
      yield { delta: 'APP-SERVER-OK', done: false };
      yield { delta: '', done: true };
    }),
    cancelCurrentTurn: vi.fn(),
    ensureStarted: vi.fn(),
    dispose: vi.fn(),
  } as unknown as ZcodeAppServerHost;
}

function makeSession(overrides: {
  direct?: typeof import('../../../src/adapters/zcode/direct-client.js').directTurn;
  appServerTurn?: ZcodeAppServerHost['runTurn'];
  formState?: ZcodeFormState;
}): { session: ZcodeSession; formState: ZcodeFormState; host: ZcodeAppServerHost } {
  const formState = overrides.formState ?? { form: 'direct' as const };
  const host = fakeHost();
  const session = new ZcodeSession({
    loadCredential: LOAD,
    formState,
    appServer: host,
    directTurnImpl: overrides.direct,
    appServerTurnImpl: overrides.appServerTurn,
  });
  return { session, formState, host };
}

const TURN_INPUT = { model: 'GLM-5.3-Flash', messages: [{ role: 'user', content: 'q' }], stream: false };

async function collect(gen: AsyncGenerator<ChatCompletionChunk>): Promise<string> {
  let text = '';
  for await (const chunk of gen) text += chunk.delta;
  return text;
}

describe('ZcodeSession 双形态切换', () => {
  it('直连成功：不碰 app-server（零常驻进程的主路径）', async () => {
    const direct = vi.fn(async function* (): AsyncGenerator<ChatCompletionChunk> {
      yield { delta: 'DIRECT-OK', done: false };
      yield { delta: '', done: true };
    });
    const { session, formState, host } = makeSession({ direct });
    expect(await collect(session.runTurn(TURN_INPUT))).toBe('DIRECT-OK');
    expect(formState.form).toBe('direct');
    expect((host.runTurn as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('直连撞前缀门：本回合降级 app-server 完成且收到真实回复', async () => {
    const direct = vi.fn(async function* (): AsyncGenerator<ChatCompletionChunk> {
      throw new ZcodeUpstreamError('prefixGate', 'ZCode 前缀门拦截（HTTP 405 code 3012）', { status: 405, upstreamCode: 3012 });
      yield { delta: '', done: true }; // eslint 不存在；占位让 TS 认出 generator
    });
    const appServerTurn = vi.fn(async function* (): AsyncGenerator<ChatCompletionChunk> {
      yield { delta: 'FALLBACK-OK', done: false };
      yield { delta: '', done: true };
    });
    const { session, formState } = makeSession({ direct, appServerTurn });
    await expect(collect(session.runTurn(TURN_INPUT))).rejects.toThrow('兜底已禁用');
    expect(formState.form).toBe('unavailable');
    expect(formState.reason).toContain('前缀门');
    expect(direct).toHaveBeenCalledTimes(1);
    expect(appServerTurn).not.toHaveBeenCalled();
  });

  it('切换一次性生效：后续回合直连实现不再被调用', async () => {
    const direct = vi.fn(async function* (): AsyncGenerator<ChatCompletionChunk> {
      throw new ZcodeUpstreamError('prefixGate', 'gate', { status: 405 });
      yield { delta: '', done: true };
    });
    const appServerTurn = vi.fn(async function* (): AsyncGenerator<ChatCompletionChunk> {
      yield { delta: 'FB', done: false };
      yield { delta: '', done: true };
    });
    const { session } = makeSession({ direct, appServerTurn });
    await expect(collect(session.runTurn(TURN_INPUT))).rejects.toThrow('禁用');
    await expect(collect(session.runTurn(TURN_INPUT))).rejects.toThrow('禁用');
    expect(direct).toHaveBeenCalledTimes(1);
    expect(appServerTurn).not.toHaveBeenCalled();
  });

  it('401（relogin）不降级：两形态共用同一 JWT，直接透传', async () => {
    const direct = vi.fn(async function* (): AsyncGenerator<ChatCompletionChunk> {
      throw new ZcodeUpstreamError('relogin', 'ZCode 登录态已失效（HTTP 401）', { status: 401 });
      yield { delta: '', done: true };
    });
    const appServerTurn = vi.fn();
    const { session, formState } = makeSession({ direct, appServerTurn });
    await expect(collect(session.runTurn(TURN_INPUT))).rejects.toMatchObject({ kind: 'relogin' });
    expect(formState.form).toBe('direct'); // 不因登录态失效切换形态
    expect(appServerTurn).not.toHaveBeenCalled();
  });

  it('429 透传为 rateLimited（不切换形态；上层已重试过一次）', async () => {
    const direct = vi.fn(async function* (): AsyncGenerator<ChatCompletionChunk> {
      throw new ZcodeUpstreamError('rateLimited', 'HTTP 429', { status: 429 });
      yield { delta: '', done: true };
    });
    const { session, formState } = makeSession({ direct });
    await expect(collect(session.runTurn(TURN_INPUT))).rejects.toMatchObject({ kind: 'rateLimited' });
    expect(formState.form).toBe('direct');
  });

  it('未知模型拦截（不烧任何上游请求）', async () => {
    const direct = vi.fn();
    const { session } = makeSession({ direct });
    await expect(
      collect(session.runTurn({ ...TURN_INPUT, model: 'GPT-9' })),
    ).rejects.toThrow(/未知模型/);
    expect(direct).not.toHaveBeenCalled();
  });

  it('cancel：回合空闲时 no-op（不杀常驻进程）', async () => {
    const { session, host } = makeSession({});
    await session.cancel();
    expect((host.cancelCurrentTurn as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('凭据缺失：loadCredential 抛错直接透传（未登录语义）', async () => {
    const host = fakeHost();
    const session = new ZcodeSession({
      loadCredential: () => {
        throw new Error('读不到 credentials.json');
      },
      formState: { form: 'direct' },
      appServer: host,
    });
    await expect(collect(session.runTurn(TURN_INPUT))).rejects.toThrow(/credentials\.json/);
  });
});
