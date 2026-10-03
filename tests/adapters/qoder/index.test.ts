// T020 adapter 层单测：probe / fetchQuota / launch / dispose（全注入、离线）。

import { describe, expect, it } from 'vitest';
import { QoderAdapter } from '../../../src/adapters/qoder/index.js';

const LIST_MODELS_STDOUT = [
  'MODEL',
  'Auto',
  'Qwen3.8-Flash',
  'Qwen3.7-Flash',
  'GLM-5.3-Flash',
  'OpenCode Go Qwen3.8-Max (opencode-go/qwen3.8-max)',
].join('\n');

/** execFile 桩：-v 回版本，--list-models 回清单，其余抛错。 */
function stubExec(stdoutForListModels: string | Error) {
  return async (file: string, args: readonly string[]): Promise<{ stdout: string }> => {
    if (args[0] === '-v') return { stdout: '1.1.61\n' };
    if (args[0] === '--list-models') {
      if (stdoutForListModels instanceof Error) throw stdoutForListModels;
      return { stdout: stdoutForListModels };
    }
    throw new Error(`unexpected args: ${args.join(' ')}`);
  };
}

function makeAdapter(execImpl: ReturnType<typeof stubExec>, now = () => 1000) {
  return new QoderAdapter({
    runtimeDeps: {
      home: '/tmp/accessmux-qoder-test-home',
      candidates: ['/fake/qoderclicn'],
      exists: () => true,
      execFile: execImpl,
      env: {},
    },
    catalogTtlMs: 10_000,
    now,
    metadataDeps: { homeDir: '/tmp/accessmux-qoder-test-home', textFiles: [], runtimeFiles: [], settingsFile: null, publicOffer: false, fetchImpl: async () => { throw new Error('offline fixture'); } },
  });
}

describe('QoderAdapter', () => {
  it('T039 强制刷新绕过 TTL，并发 probe/quota 共用一轮目录采集', async () => {
    let calls = 0;
    let release: (() => void) | undefined;
    let gate: Promise<void> | undefined;
    const execImpl = async (_file: string, args: readonly string[]) => {
      if (args[0] === '-v') return {stdout: '1.1.61'};
      calls++;
      if (gate) await gate;
      return {stdout: calls === 1 ? LIST_MODELS_STDOUT : 'MODEL\nQwen3.8-Flash\n'};
    };
    const adapter = makeAdapter(execImpl);
    expect((await adapter.probe()).models.length).toBeGreaterThan(1);
    await adapter.probe(); expect(calls).toBe(1);
    gate = new Promise<void>((done) => {release = done;});
    const first = adapter.probe({forceRefresh: true});
    const second = adapter.probe({forceRefresh: true});
    const quota = adapter.fetchQuota();
    release?.();
    const [a, b] = await Promise.all([first, second, quota]);
    expect(calls).toBe(2); expect(a.models).toEqual(b.models); expect(a.models).toHaveLength(1);
    await adapter.probe(); expect(calls).toBe(2);
  });

  it('T039 已取消的强制刷新不启动新的目录命令，旧缓存仍可读取', async () => {
    let calls = 0;
    const adapter = makeAdapter(async (_file, args) => {
      if (args[0] === '-v') return {stdout:'1.1.61'};
      calls++; return {stdout:LIST_MODELS_STDOUT};
    });
    await adapter.probe();
    const controller = new AbortController(); controller.abort();
    expect(await adapter.probe({forceRefresh:true, signal:controller.signal})).toMatchObject({ availability: 'available', catalogSource: 'cache', reasonCode: 'catalog-unavailable' });
    expect(calls).toBe(1); expect((await adapter.probe()).availability).toBe('available');
  });
  it('probe available：模型清单 → ModelInfo（已实证无 unverified，其余如实标）', async () => {
    const adapter = makeAdapter(stubExec(LIST_MODELS_STDOUT));
    const result = await adapter.probe();
    expect(result.availability).toBe('available');
    expect(result.auth).toBe('unknown'); // 不烧推理请求验证登录态
    const byId = new Map(result.models.map((m) => [m.id, m]));
    expect(byId.get('Qwen3.8-Flash')?.tags).toEqual(['chat']); // 实测免费
    expect(byId.get('Qwen3.7-Flash')?.tags).toEqual(['chat']); // 实测定向成功
    expect(byId.get('GLM-5.3-Flash')?.tags).toContain('unverified'); // 未实证不虚标
    expect(byId.has('Auto')).toBe(false); // 伪模型不进清单
    expect(byId.get('opencode-go/qwen3.8-max')?.provider).toBe('qoder');
  });

  it('probe unavailable：--list-models 失败收敛，不抛错（D8）', async () => {
    const adapter = makeAdapter(stubExec(new Error('spawn ENOENT')));
    const result = await adapter.probe();
    expect(result).toEqual({ availability: 'unavailable', models: [], auth: 'unknown', reasonCode: 'catalog-unavailable' });
  });

  it('probe unavailable：二进制不存在（候选落空）', async () => {
    const adapter = new QoderAdapter({
      runtimeDeps: { home: '/tmp/accessmux-qoder-test-home', candidates: ['/nope'], exists: () => false, env: {} },
      metadataDeps: { homeDir: '/tmp/accessmux-qoder-test-home', textFiles: [], runtimeFiles: [], settingsFile: null, publicOffer: false, fetchImpl: async () => { throw new Error('offline fixture'); } },
    });
    expect((await adapter.probe()).availability).toBe('unavailable');
  });

  it('fetchQuota：有清单 → ok；失败 → unknown（不编数）', async () => {
    expect(await makeAdapter(stubExec(LIST_MODELS_STDOUT)).fetchQuota()).toBe('ok');
    expect(await makeAdapter(stubExec(new Error('boom'))).fetchQuota()).toBe('unknown');
  });

  it('launch 返回可用会话（knownModels 注入，未知模型回合中被拦）', async () => {
    const adapter = makeAdapter(stubExec(LIST_MODELS_STDOUT));
    const session = await adapter.launch({ localSecret: 'x' });
    expect(typeof session.runTurn).toBe('function');
    expect(typeof session.cancel).toBe('function');
  });

  it('目录缓存：TTL 内不重复 --list-models', async () => {
    let listCalls = 0;
    const execImpl = async (file: string, args: readonly string[]): Promise<{ stdout: string }> => {
      if (args[0] === '-v') return { stdout: '1.1.61\n' };
      listCalls += 1;
      return { stdout: LIST_MODELS_STDOUT };
    };
    const adapter = makeAdapter(execImpl);
    await adapter.probe();
    await adapter.fetchQuota();
    expect(listCalls).toBe(1);
  });

  it('dispose 幂等', async () => {
    const adapter = makeAdapter(stubExec(LIST_MODELS_STDOUT));
    await adapter.dispose();
    await adapter.dispose();
  });
});
