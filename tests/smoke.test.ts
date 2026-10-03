// 骨架冒烟测试：注册表、路由约定、协议端点、catalog 行为。
// 不含真实业务数据；业务测试由 T001/T002 任务包补充。
//
// 所有 adapter 装配都注入 fakeKeyProvider，确保 npm test 完全离线：
// 不 spawn Electron、不连真上游、纯 in-memory。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearRegistry, listAdapters } from '../src/adapters/registry.js';
import {
  DEFAULT_ADAPTER_IDS,
  DISABLE_ADAPTERS_ENV,
  registerDefaultAdapters,
} from '../src/adapters/index.js';
import { fakeKeyProvider } from '../src/adapters/workbuddy/key-provider.js';
import { WORKBUDDY_AUTH_FILE_ENV } from '../src/adapters/workbuddy/credential-store.js';
import { pickAdapterForModel, NoProviderAvailable } from '../src/router/index.js';
import { buildServer } from '../src/protocol/server.js';
import { CatalogCache, generateLocalSecret } from '../src/catalog/index.js';
import { buildDefaultConfig, ConfigStore } from '../src/config/index.js';

const FAKE_KEY = 'smoke-test-at-rest-key';

/** 离线测试环境禁掉的 adapter（probe 有真机副作用：spawn 子进程/读真凭据） */
const OFFLINE_DISABLED = ['opencode', 'qoder', 'zcode'];

beforeEach(() => {
  // 确定性隔离：credential store 的 desktop 路径推导（T001R4 起）会命中
  // 本机真实凭据文件，把 WORKBUDDY_AUTH_FILE 指到不存在路径保证测试
  // 永不读本机 WorkBuddy 安装（离线 + 无真实数据依赖）。
  process.env[WORKBUDDY_AUTH_FILE_ENV] = '/nonexistent/accessmux-smoke-test';
  // T021：VITEST 门控已解（生产行为=默认全注册），离线改由禁用开关承担：
  // 这三家 probe 会真 spawn opencode serve / qoderclicn / 读 ZCode 凭据。
  process.env[DISABLE_ADAPTERS_ENV] = OFFLINE_DISABLED.join(',');
});

afterEach(() => {
  delete process.env[WORKBUDDY_AUTH_FILE_ENV];
  delete process.env[DISABLE_ADAPTERS_ENV];
  clearRegistry();
});

describe('adapter 注册表', () => {
  it('默认装配 = 动态名单 − 禁用集合（按注册表单一事实源断言）', () => {
    registerDefaultAdapters({ workbuddyKeyProvider: fakeKeyProvider(FAKE_KEY) });
    expect(listAdapters().map((a) => a.id).sort()).toEqual(
      DEFAULT_ADAPTER_IDS.filter((id) => !OFFLINE_DISABLED.includes(id)).sort(),
    );
  });

  it.each(DEFAULT_ADAPTER_IDS)('显式 disable 摘除 %s（包括 WorkBuddy/Trae 双区域）', (id) => {
    registerDefaultAdapters({ workbuddyKeyProvider: fakeKeyProvider(FAKE_KEY), disable: [id] });
    expect(listAdapters().map((a) => a.id).sort()).toEqual(DEFAULT_ADAPTER_IDS.filter((a) => a !== id).sort());
  });

  it.each(DEFAULT_ADAPTER_IDS)('env disable 摘除 %s', (id) => {
    process.env[DISABLE_ADAPTERS_ENV] = id;
    registerDefaultAdapters({ workbuddyKeyProvider: fakeKeyProvider(FAKE_KEY) });
    expect(listAdapters().map((a) => a.id)).not.toContain(id);
  });

  it('全禁用后控制面没有 adapter 可探测', async () => {
    registerDefaultAdapters({ disable: [...DEFAULT_ADAPTER_IDS] });
    expect(listAdapters()).toEqual([]);
    const app = buildServer({ store: new ConfigStore(buildDefaultConfig([])), configPath: '/nonexistent/accessmux-smoke-config.yaml' });
    try {
      const state = await app.inject({ method: 'GET', url: '/api/state' });
      expect(state.statusCode).toBe(200);
      const models = await app.inject({ method: 'GET', url: '/v1/models' });
      expect(models.json().data).toEqual([]);
    } finally { await app.close(); }
  });

  it('禁用开关摘除指定 adapter（构造参数覆盖 env）', () => {
    registerDefaultAdapters({
      workbuddyKeyProvider: fakeKeyProvider(FAKE_KEY),
      disable: [...OFFLINE_DISABLED, 'qoder'],
    });
    const ids = listAdapters().map((a) => a.id);
    expect(ids).not.toContain('qoder');
    expect(ids).toContain('workbuddy');
  });
});

describe('路由约定', () => {
  it('adapterId:model 显式路由', () => {
    registerDefaultAdapters({ workbuddyKeyProvider: fakeKeyProvider(FAKE_KEY) });
    const { adapter, modelId } = pickAdapterForModel('workbuddy:GLM-5.3');
    expect(adapter.id).toBe('workbuddy');
    expect(modelId).toBe('GLM-5.3');
  });

  it('未知来源抛 NoProviderAvailable', () => {
    registerDefaultAdapters({ workbuddyKeyProvider: fakeKeyProvider(FAKE_KEY) });
    expect(() => pickAdapterForModel('nobody:x')).toThrow(NoProviderAvailable);
    expect(() => pickAdapterForModel('GLM-5.3')).toThrow(NoProviderAvailable);
  });
});

describe('协议端点', () => {
  it('/health 与 /v1/models 可用', async () => {
    registerDefaultAdapters({ workbuddyKeyProvider: fakeKeyProvider(FAKE_KEY) });
    const app = buildServer();
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json().adapters).toContain('workbuddy');

    const models = await app.inject({ method: 'GET', url: '/v1/models' });
    expect(models.statusCode).toBe(200);
    expect(models.json().object).toBe('list');
    await app.close();
  });

  it('已实装 adapter 不再返回 501（WorkBuddy + Trae 都已实装）', async () => {
    // 注入 fakeKeyProvider：不会 spawn Electron 也不会读真 desktop file
    registerDefaultAdapters({ workbuddyKeyProvider: fakeKeyProvider(FAKE_KEY) });
    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'workbuddy:GLM-5.3', messages: [{ role: 'user', content: 'hi' }] },
    });
    // adapter 已实装：fakeKeyProvider 让 credentialStore.resolve() 在没有
    // desktop file 时直接抛错；smoke 看到的就是 500（≠ 501 的关键保证）。
    expect(res.statusCode).not.toBe(501);
    await app.close();
  });

  it('非法请求体返回 400', async () => {
    registerDefaultAdapters({ workbuddyKeyProvider: fakeKeyProvider(FAKE_KEY) });
    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'workbuddy:GLM-5.3', messages: [] },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('catalog 骨架', () => {
  it('generateLocalSecret 每次不同', () => {
    expect(generateLocalSecret()).not.toBe(generateLocalSecret());
  });

  it('单飞：并发 get 只 fetch 一次', async () => {
    let calls = 0;
    const cache = new CatalogCache(async () => {
      calls++;
      return { ok: true };
    });
    await Promise.all([cache.get(), cache.get(), cache.get()]);
    expect(calls).toBe(1);
  });

  it('invalidate 后重建快照', async () => {
    let calls = 0;
    const cache = new CatalogCache(async () => ({ n: ++calls }));
    expect((await cache.get()).n).toBe(1);
    expect((await cache.get()).n).toBe(1);
    cache.invalidate();
    expect((await cache.get()).n).toBe(2);
  });
});
