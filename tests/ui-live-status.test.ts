import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProbeContext, ProbeResult, ProviderAdapter } from '../src/adapters/types.js';
import { clearRegistry, registerAdapter } from '../src/adapters/registry.js';
import { buildDefaultConfig, ConfigStore } from '../src/config/index.js';
import type { ModelInfo, QuotaState } from '../src/types.js';
import { mountUiRoutes } from '../src/ui/index.js';
import { mergeCatalogFees, snapshotAdapterInfo } from '../src/ui/services.js';

const source = (at: string) => ({ kind: 'platform' as const, reference: 'qoder:test-fee', field: 'fee', updated_at: at, region: 'cn' });
const model = (values: Partial<ModelInfo>): ModelInfo => ({ id: 'm', provider: 'qoder', ...values });

describe('费用证据合并与公开投影', () => {
  it('较旧的新目录证据不会把上次免费和新倍率拼到一起', () => {
    const previous = model({ free: true, freeSource: source('2026-10-03T10:00:00Z'), priceMultiplier: { value: 0, current: true, updated_at: '2026-10-03T10:00:00Z', source: source('2026-10-03T10:00:00Z') } });
    const older = model({ free: false, freeSource: source('2026-10-02T10:00:00Z'), priceMultiplier: { value: 2, current: true, updated_at: '2026-10-02T10:00:00Z', source: source('2026-10-02T10:00:00Z') } });
    const [merged] = mergeCatalogFees([previous], [older], '2026-10-03T11:00:00Z');
    expect(merged).toMatchObject({ free: true, feeFreshness: 'stale' });
    expect(merged?.priceMultiplier).toMatchObject({ value: 0 });
  });

  it('明确反向证据缺倍率时会清理相反方向的旧倍率', () => {
    const priorFree = model({ free: true, freeSource: source('2026-10-02T10:00:00Z'), priceMultiplier: { value: 0, current: true, updated_at: '2026-10-02T10:00:00Z', source: source('2026-10-02T10:00:00Z') } });
    const paidWithoutRate = model({ free: false, freeSource: source('2026-10-03T10:00:00Z') });
    expect(mergeCatalogFees([priorFree], [paidWithoutRate])[0]).toMatchObject({ free: false });
    expect(mergeCatalogFees([priorFree], [paidWithoutRate])[0]).not.toHaveProperty('priceMultiplier');
    const priorPaid = model({ free: false, freeSource: source('2026-10-02T10:00:00Z'), priceMultiplier: { value: 2, current: true, updated_at: '2026-10-02T10:00:00Z', source: source('2026-10-02T10:00:00Z') } });
    const freeWithoutRate = model({ free: true, freeSource: source('2026-10-03T10:00:00Z') });
    expect(mergeCatalogFees([priorPaid], [freeWithoutRate])[0]).toMatchObject({ free: true });
    expect(mergeCatalogFees([priorPaid], [freeWithoutRate])[0]).not.toHaveProperty('priceMultiplier');
  });

  it('过期免费活动是 stale，不能覆盖刚确认的 2× 收费证据', () => {
    const currentPaid = model({ free: false, freeSource: source('2026-10-03T10:30:00Z'), priceMultiplier: { value: 2, current: true, updated_at: '2026-10-03T10:30:00Z', source: source('2026-10-03T10:30:00Z') }, feeFreshness: 'fresh' });
    const oldOffer = model({ free: true, freeSource: source('2026-10-03T10:31:00Z'), priceMultiplier: { value: 0, current: false, updated_at: '2026-10-03T10:31:00Z', source: source('2026-10-03T10:31:00Z') }, feeFreshness: 'stale' });
    expect(mergeCatalogFees([currentPaid], [oldOffer])[0]).toMatchObject({ free: false, feeFreshness: 'stale', priceMultiplier: { value: 2 } });
  });

  it('目录失败后历史模型走公开白名单投影，不输出 adapter 私有字段', async () => {
    const privateModel = { ...model({ free: true, freeSource: source('2026-10-03T10:00:00Z') }), accessToken: 'PRIVATE-TOKEN', cookie: 'PRIVATE-COOKIE' } as ModelInfo;
    let fail = false;
    const adapter = testAdapter('qoder', async () => {
      if (fail) throw new Error('PRIVATE-TOKEN');
      return { availability: 'available', auth: 'unknown', catalogSource: 'current', models: [privateModel] };
    });
    const config = buildDefaultConfig([adapter]); config.adapters.qoder = { enabled: true };
    await snapshotAdapterInfo([adapter], config, 100);
    fail = true;
    const [result] = await snapshotAdapterInfo([adapter], config, 100);
    expect(result?.sourceState).toBe('failed');
    expect(result?.historyModels?.[0]).toMatchObject({ id: 'm', provider: 'qoder', feeFreshness: 'failed' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('真正的环境禁用状态不探测；未注册环境禁用源也给出状态卡数据', async () => {
    const adapter = testAdapter('qoder', async () => ({ availability: 'available', models: [] }));
    const config = buildDefaultConfig([adapter]);
    const [disabled] = await snapshotAdapterInfo([adapter], config, 100, { env: { ACCESSMUX_DISABLE_ADAPTERS: 'qoder' } });
    expect(disabled?.sourceState).toBe('environment-disabled');
    expect(adapter.probe).not.toHaveBeenCalled();
    const absent = await snapshotAdapterInfo([], config, 100, { env: { ACCESSMUX_DISABLE_ADAPTERS: 'trae-cn' } });
    expect(absent[0]).toMatchObject({ id: 'trae-cn', sourceState: 'environment-disabled', nextAction: expect.stringContaining('重启') });
  });
});

describe('生产 UI 刷新和宿主地址', () => {
  const apps: Array<{ close(): Promise<unknown> }> = [];
  const temps: string[] = [];
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    for (const path of temps.splice(0)) rmSync(path, { recursive: true, force: true });
    clearRegistry();
  });

  it('forceRefresh 从生产按钮路由原样到达 adapter，重定向不保留旧宿主参数', async () => {
    const temp = mkdtempSync(join(tmpdir(), 'accessmux-ui-refresh-')); temps.push(temp);
    const adapter = testAdapter('qoder', async (ctx) => ({ availability: 'available', auth: 'unknown', catalogSource: 'current', reasonCode: ctx?.forceRefresh ? 'directory-ready' : 'login-unverified', models: [{ id: 'm', provider: 'qoder' }] }));
    registerAdapter(adapter);
    const app = Fastify();
    const config = buildDefaultConfig([adapter]); config.adapters.qoder = { enabled: true };
    mountUiRoutes(app, { store: new ConfigStore(config), configPath: join(temp, 'config.yaml'), uiServices: { homeDir: temp, repoRoot: temp, readPat: () => undefined, runCheckin: async () => [], autoIntervalMs: 0 } });
    apps.push(app);
    const redirect = await app.inject({ method: 'GET', url: '/ui?host=claude-code' });
    expect(redirect.statusCode).toBe(301);
    expect(redirect.headers.location).toBe('/ui/');
    expect((await app.inject({ method: 'GET', url: '/ui?host=trae-cn' })).headers.location).toBe('/ui/');
    const refreshed = await app.inject({ method: 'POST', url: '/api/probe', payload: {} });
    expect(refreshed.statusCode).toBe(200);
    expect(adapter.probe).toHaveBeenCalledWith(expect.objectContaining({ forceRefresh: true }));
  });
});

function testAdapter(id: string, probe: (context?: ProbeContext) => Promise<ProbeResult>): ProviderAdapter & { probe: ReturnType<typeof vi.fn> } {
  return {
    id, displayName: id, sandbox: 'none', probe: vi.fn(probe),
    async launch() { throw new Error('fixture does not launch'); }, async fetchQuota(): Promise<QuotaState> { return 'unknown'; }, async dispose() {},
  };
}
