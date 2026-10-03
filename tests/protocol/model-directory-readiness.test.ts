import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/protocol/server.js';
import { clearRegistry, registerAdapter } from '../../src/adapters/registry.js';
import type { ProbeResult, ProviderAdapter } from '../../src/adapters/types.js';
import { ConfigStore, buildDefaultConfig } from '../../src/config/index.js';
import { snapshotAdapterInfo } from '../../src/ui/services.js';

let app: FastifyInstance | undefined;
beforeEach(() => clearRegistry());
afterEach(async () => { await app?.close(); app = undefined; clearRegistry(); vi.unstubAllEnvs(); });
const model = { id: 'candidate', provider: 'synthetic' };
function fake(id: string, probe: ProviderAdapter['probe']): ProviderAdapter {
  return { id, displayName: id, sandbox: 'none', probe, fetchQuota: async () => 'unknown', dispose: async () => {}, launch: async () => { throw new Error('推理禁止'); } };
}
async function ids(): Promise<string[]> {
  const response = await app!.inject({ url: '/v1/models' });
  expect(response.statusCode).toBe(200);
  return response.json().data.map((entry: { id: string }) => entry.id);
}

describe('/v1/models 只发布可接入的当前目录', () => {
  it.each<[string, ProbeResult]>([
    ['WorkBuddy 登出静态候选', { availability: 'unavailable', auth: 'logged-out', catalogSource: 'fallback', models: [model] }],
    ['本地读取/helper 失败', { availability: 'unverified', auth: 'unknown', reasonCode: 'credential-unavailable', models: [model] }],
    ['ZCode 已登录但只有候选', { availability: 'unverified', auth: 'logged-in', catalogSource: 'fallback', models: [model] }],
    ['available 不能绕过明确登出', { availability: 'available', auth: 'logged-out', catalogSource: 'current', models: [model] }],
    ['available 不能绕过 fallback', { availability: 'available', auth: 'logged-in', catalogSource: 'fallback', models: [model] }],
    ['available 不能绕过目录失败缓存', { availability: 'available', auth: 'logged-in', catalogSource: 'cache', reasonCode: 'catalog-unavailable', models: [model] }],
    ['未验证旧缓存', { availability: 'unverified', auth: 'logged-in', catalogSource: 'cache', models: [model] }],
  ])('%s 不成为当前可接入模型', async (_name, result) => {
    registerAdapter(fake('synthetic', async () => result));
    app = buildServer();
    expect(await ids()).toEqual([]);
  });

  it('匿名 OpenCode、未知登录但实时可用的 Qoder 与旧 available 桩仍返回 canonical ID', async () => {
    registerAdapter(fake('opencode', async () => ({ availability: 'available', catalogSource: 'current', models: [model] })));
    registerAdapter(fake('qoder', async () => ({ availability: 'available', auth: 'unknown', catalogSource: 'current', models: [{ ...model, id: 'private-provider/custom-model', tags: ['custom-provider'] }] })));
    registerAdapter(fake('legacy-fixture', async () => ({ availability: 'available', models: [model] })));
    app = buildServer();
    expect(await ids()).toEqual(['opencode:candidate', 'qoder:private-provider/custom-model', 'legacy-fixture:candidate']);
  });

  it.each(['config', 'environment'])('%s 禁用源不读取登录态或目录', async (kind) => {
    const probe = vi.fn(async (): Promise<ProbeResult> => { throw new Error('禁用源不应被读取'); });
    const adapter = fake('qoder', probe);
    registerAdapter(adapter);
    const config = buildDefaultConfig([adapter]);
    if (kind === 'config') config.adapters.qoder = { enabled: false };
    else vi.stubEnv('ACCESSMUX_DISABLE_ADAPTERS', 'qoder');
    app = buildServer({ store: new ConfigStore(config) });
    expect(await ids()).toEqual([]);
    expect(probe).not.toHaveBeenCalled();
  });

  it('目录 A 成功后更新失败只留历史；恢复后 API 只接新目录 B', async () => {
    let result: ProbeResult = { availability: 'available', auth: 'logged-in', catalogSource: 'current', models: [{ ...model, id: 'model-a' }] };
    const adapter = fake('synthetic', async () => result);
    registerAdapter(adapter);
    const config = buildDefaultConfig([adapter]);
    app = buildServer({ store: new ConfigStore(config) });
    expect(await ids()).toEqual(['synthetic:model-a']);
    await snapshotAdapterInfo([adapter], config, 100, { env: {} });
    result = { ...result, availability: 'unverified', catalogSource: 'cache', reasonCode: 'catalog-unavailable' };
    expect(await ids()).toEqual([]);
    const failed = (await snapshotAdapterInfo([adapter], config, 100, { env: {} }))[0]!;
    expect(failed.directoryReady).toBe(false);
    expect(failed.models).toEqual([]);
    expect(Reflect.get(failed, 'historyModels')).toMatchObject([{ id: 'model-a' }]);
    result = { availability: 'available', auth: 'unknown', catalogSource: 'current', models: [{ ...model, id: 'model-b' }] };
    expect(await ids()).toEqual(['synthetic:model-b']);
  });
});
