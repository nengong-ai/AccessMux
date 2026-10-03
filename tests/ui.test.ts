// T004 · UI 路由与 config 过滤测试
// - GET /ui 静态资源
// - GET /api/state / /api/bootstrap
// - POST /api/config 保存
// - /v1/models / /v1/chat/completions / /v1/messages 受 config 过滤
// - 首启检测：configPath 不存在时返回 configExists=false

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearRegistry, listAdapters, registerAdapter } from '../src/adapters/registry.js';
import { AdapterNotImplementedError } from '../src/adapters/types.js';
import type {
  LaunchContext,
  ProbeResult,
  ProviderAdapter,
  ProviderSession,
} from '../src/adapters/types.js';
import type { ChatCompletionChunk, ChatMessage, QuotaState } from '../src/types.js';
import { buildServer } from '../src/protocol/server.js';
import { ConfigStore, buildDefaultConfig } from '../src/config/index.js';
import { mountUiRoutes } from '../src/ui/index.js';

// T033 新增本机服务依赖：旧测试仍走实际 UI 服务，只把 HOME/PAT/领取隔离到 fixture。
vi.mock('../src/ui/services.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ui/services.js')>();
  return {
    ...actual,
    createUiServices: (store: ConfigStore, options: Parameters<typeof actual.createUiServices>[1]) => actual.createUiServices(store, {
      homeDir: join(tmpDir, 'home'),
      repoRoot: tmpDir,
      readPat: () => undefined,
      runCheckin: async () => { throw new Error('UI 基线测试禁止真实领取'); },
      ...options,
    }),
  };
});

/** 返回固定模型清单的 fake，便于测试 allowlist */
class FakeAdapter implements ProviderAdapter {
  constructor(
    readonly id: string,
    readonly displayName: string,
    private readonly modelIds: string[],
    private readonly auth: 'logged-in' | 'logged-out' | 'unknown' = 'logged-in',
  ) {}

  async probe(): Promise<ProbeResult> {
    return {
      availability: 'available',
      auth: this.auth,
      models: this.modelIds.map((id) => ({ id, provider: this.id })),
    };
  }

  async launch(_ctx: LaunchContext): Promise<ProviderSession> {
    const self = this;
    return {
      async *runTurn(_input: { model: string; messages: ChatMessage[]; stream: boolean }): AsyncIterable<ChatCompletionChunk> {
        yield { delta: 'hello-from-' + self.id, done: true };
      },
      async cancel(): Promise<void> {},
    };
  }

  async fetchQuota(): Promise<QuotaState> { return 'ok'; }
  async dispose(): Promise<void> {}
}

class ThrowingAdapter implements ProviderAdapter {
  constructor(readonly id: string, readonly displayName = id) {}
  readonly sandbox = 'none' as const;
  async probe(): Promise<ProbeResult> { return { availability: 'unverified', models: [], auth: 'unknown' }; }
  async launch(_ctx: LaunchContext): Promise<never> { throw new AdapterNotImplementedError(this.id, 'T-test'); }
  async fetchQuota(): Promise<QuotaState> { return 'unknown'; }
  async dispose(): Promise<void> {}
}

function makeStore(adapters: ProviderAdapter[]): ConfigStore {
  return new ConfigStore(buildDefaultConfig(adapters));
}

let tmpDir = '';
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'accessmux-ui-'));
  clearRegistry();
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  clearRegistry();
});

describe('UI 静态资源', () => {
  it('GET /ui 重定向到 /ui/，再返回 index.html', async () => {
    registerAdapter(new FakeAdapter('a1', 'A1', ['m1']));
    const store = makeStore(listAdapters());
    const app = buildServer({ store, configPath: join(tmpDir, 'nope.yaml') });
    const r1 = await app.inject({ method: 'GET', url: '/ui' });
    expect(r1.statusCode).toBe(301);
    expect(r1.headers.location).toBe('/ui/');
    const r2 = await app.inject({ method: 'GET', url: '/ui/' });
    expect(r2.statusCode).toBe(200);
    expect(r2.headers['content-type']).toContain('text/html');
    expect(r2.body).toContain('AccessMux');
    await app.close();
  });

  it('GET /ui/style.css 返回 CSS', async () => {
    registerAdapter(new FakeAdapter('a1', 'A1', ['m1']));
    const store = makeStore(listAdapters());
    const app = buildServer({ store, configPath: join(tmpDir, 'nope.yaml') });
    const res = await app.inject({ method: 'GET', url: '/ui/style.css' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/css');
    await app.close();
  });

  it('GET /ui/app.js 返回编译后的 JS', async () => {
    registerAdapter(new FakeAdapter('a1', 'A1', ['m1']));
    const store = makeStore(listAdapters());
    const app = buildServer({ store, configPath: join(tmpDir, 'nope.yaml') });
    const res = await app.inject({ method: 'GET', url: '/ui/app.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/javascript');
    await app.close();
  });

  it('GET /ui/toggle.js 返回转译后的开关模块', async () => {
    registerAdapter(new FakeAdapter('a1', 'A1', ['m1']));
    const app = buildServer({ store: makeStore(listAdapters()), configPath: join(tmpDir, 'nope.yaml') });
    const res = await app.inject({ method: 'GET', url: '/ui/toggle.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('application/javascript');
    expect(res.body).toContain('bindSwitch');
    await app.close();
  });

  it('WorkBuddy 图标路由只提供固定 PNG，缺失时不泄露路径', async () => {
    registerAdapter(new FakeAdapter('a1', 'A1', ['m1']));
    const store = makeStore(listAdapters());
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    const app = Fastify();
    mountUiRoutes(app, { store, configPath: join(tmpDir, 'nope.yaml'), workBuddyIconLoader: () => png });
    const image = await app.inject({ method: 'GET', url: '/ui/app-icons/workbuddy.png' });
    expect(image.statusCode).toBe(200);
    expect(image.headers['content-type']).toContain('image/png');
    expect(image.headers['x-content-type-options']).toBe('nosniff');
    expect(image.rawPayload.subarray(0, 8)).toEqual(png);
    await app.close();

    const failed = Fastify();
    mountUiRoutes(failed, { store, configPath: join(tmpDir, 'nope.yaml'), workBuddyIconLoader: () => { throw new Error(join(tmpDir, 'private-path')); } });
    const unavailable = await failed.inject({ method: 'GET', url: '/ui/app-icons/workbuddy.png' });
    expect(unavailable.statusCode).toBe(404);
    expect(unavailable.body).not.toContain(tmpDir);
    await failed.close();

    const absent = Fastify();
    mountUiRoutes(absent, { store, configPath: join(tmpDir, 'nope.yaml'), workBuddyIconLoader: () => undefined });
    const missing = await absent.inject({ method: 'GET', url: '/ui/app-icons/workbuddy.png' });
    expect(missing.statusCode).toBe(404);
    expect(missing.body).not.toContain(tmpDir);
    expect((await absent.inject({ method: 'GET', url: '/ui/app-icons/workbuddy.png/../../package.json' })).statusCode).not.toBe(200);
    await absent.close();
  });

  it('目录穿越被拒绝', async () => {
    registerAdapter(new FakeAdapter('a1', 'A1', ['m1']));
    const store = makeStore(listAdapters());
    const app = buildServer({ store, configPath: join(tmpDir, 'nope.yaml') });
    const r1 = await app.inject({ method: 'GET', url: '/ui/../package.json' });
    expect(r1.statusCode === 400 || r1.statusCode === 404).toBe(true);
    const r2 = await app.inject({ method: 'GET', url: '/ui/%2e%2e/package.json' });
    expect(r2.statusCode === 400 || r2.statusCode === 404).toBe(true);
    await app.close();
  });
});

describe('UI API', () => {
  it('GET /api/bootstrap 返回 configExists=false 当配置缺失', async () => {
    registerAdapter(new FakeAdapter('a1', 'A1', ['m1']));
    const path = join(tmpDir, 'absent.yaml');
    expect(existsSync(path)).toBe(false);
    const store = makeStore(listAdapters());
    const app = buildServer({ store, configPath: path });
    const res = await app.inject({ method: 'GET', url: '/api/bootstrap' });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.configExists).toBe(false);
    expect(data.configPath).toBe(path);
    await app.close();
  });

  it('POST /api/config 保存并即时更新 store', async () => {
    registerAdapter(new FakeAdapter('a1', 'A1', ['m1', 'm2']));
    const store = makeStore(listAdapters());
    const app = buildServer({ store, configPath: join(tmpDir, 'nope.yaml') });
    const r = await app.inject({
      method: 'POST',
      url: '/api/config',
      payload: {
        output: { port: 9000, exposeAnthropic: false },
        adapters: { a1: { enabled: false } },
        models: { allow: { a1: { m1: true, m2: false } } },
      },
    });
    expect(r.statusCode).toBe(200);
    expect(store.get().output.port).toBe(9000);
    expect(store.get().adapters['a1']?.enabled).toBe(false);
    expect(store.get().models.allow['a1']?.['m2']).toBe(false);
    await app.close();
  });

  it('POST /api/config 校验失败返回 400', async () => {
    registerAdapter(new FakeAdapter('a1', 'A1', ['m1']));
    const store = makeStore(listAdapters());
    const app = buildServer({ store, configPath: join(tmpDir, 'nope.yaml') });
    const r = await app.inject({
      method: 'POST',
      url: '/api/config',
      payload: { output: { port: 'NaN' } },
    });
    expect(r.statusCode).toBe(400);
    await app.close();
  });

  it('POST /api/config/reset 把配置重置为默认', async () => {
    registerAdapter(new FakeAdapter('a1', 'A1', ['m1']));
    const store = makeStore(listAdapters());
    store.set({ ...store.get(), output: { ...store.get().output, port: 9999 } });
    const app = buildServer({ store, configPath: join(tmpDir, 'nope.yaml') });
    const r = await app.inject({ method: 'POST', url: '/api/config/reset' });
    expect(r.statusCode).toBe(200);
    expect(store.get().output.port).toBe(8080);
    await app.close();
  });
});

describe('config 过滤：/v1/models', () => {
  it('adapter.enabled=false 时该源模型不出现', async () => {
    registerAdapter(new FakeAdapter('a1', 'A1', ['m1', 'm2']));
    const store = makeStore(listAdapters());
    store.set({
      ...store.get(),
      adapters: { a1: { enabled: false } },
    });
    const app = buildServer({ store, configPath: join(tmpDir, 'nope.yaml') });
    const r = await app.inject({ method: 'GET', url: '/v1/models' });
    expect(r.statusCode).toBe(200);
    expect(r.json().data).toEqual([]);
    await app.close();
  });

  it('allowlist=false 时该模型不出现', async () => {
    registerAdapter(new FakeAdapter('a1', 'A1', ['m1', 'm2']));
    const store = makeStore(listAdapters());
    store.set({
      ...store.get(),
      models: { allow: { a1: { m1: true, m2: false } } },
    });
    const app = buildServer({ store, configPath: join(tmpDir, 'nope.yaml') });
    const r = await app.inject({ method: 'GET', url: '/v1/models' });
    expect(r.statusCode).toBe(200);
    const ids = (r.json().data as Array<{ id: string }>).map((m) => m.id);
    expect(ids).toContain('a1:m1');
    expect(ids).not.toContain('a1:m2');
    await app.close();
  });

  it('allowlist 未列出时默认放行（空字典语义）', async () => {
    registerAdapter(new FakeAdapter('a1', 'A1', ['m1']));
    const store = makeStore(listAdapters());
    store.set({
      ...store.get(),
      models: { allow: { a1: {} } },
    });
    const app = buildServer({ store, configPath: join(tmpDir, 'nope.yaml') });
    const r = await app.inject({ method: 'GET', url: '/v1/models' });
    const ids = (r.json().data as Array<{ id: string }>).map((m) => m.id);
    expect(ids).toContain('a1:m1');
    await app.close();
  });
});

describe('config 过滤：/v1/chat/completions', () => {
  it('allowlist 拒绝时返回 404', async () => {
    registerAdapter(new FakeAdapter('a1', 'A1', ['m1']));
    const store = makeStore(listAdapters());
    store.set({
      ...store.get(),
      models: { allow: { a1: { m1: false } } },
    });
    const app = buildServer({ store, configPath: join(tmpDir, 'nope.yaml') });
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'a1:m1', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.message).toMatch(/allowlist/);
    await app.close();
  });

  it('adapter disabled 时返回 404', async () => {
    registerAdapter(new FakeAdapter('a1', 'A1', ['m1']));
    const store = makeStore(listAdapters());
    store.set({
      ...store.get(),
      adapters: { a1: { enabled: false } },
    });
    const app = buildServer({ store, configPath: join(tmpDir, 'nope.yaml') });
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'a1:m1', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r.statusCode).toBe(404);
    await app.close();
  });

  it('allowlist 通过时仍按原路径返回 chat.completion', async () => {
    registerAdapter(new FakeAdapter('a1', 'A1', ['m1']));
    const store = makeStore(listAdapters());
    const app = buildServer({ store, configPath: join(tmpDir, 'nope.yaml') });
    const r = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'a1:m1', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().choices[0].message.content).toBe('hello-from-a1');
    await app.close();
  });
});

describe('config 过滤：/v1/messages', () => {
  function storeWithAnthropic(adapters: ProviderAdapter[], expose: boolean): ConfigStore {
    const store = makeStore(adapters);
    store.set({ ...store.get(), output: { ...store.get().output, exposeAnthropic: expose } });
    return store;
  }

  it('exposeAnthropic 未勾选时端点摘挂（T021 清偿 T004 挂账）', async () => {
    registerAdapter(new FakeAdapter('a1', 'A1', ['m1']));
    const store = storeWithAnthropic(listAdapters(), false);
    const app = buildServer({ store, configPath: join(tmpDir, 'nope.yaml') });
    const r = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: { model: 'a1:m1', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.type).toBe('not_found_error');
    // 勾选后即时生效（配置热应用，无需重启）
    store.set({ ...store.get(), output: { ...store.get().output, exposeAnthropic: true } });
    const r2 = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: { model: 'a1:m1', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().content[0].text).toBe('hello-from-a1');
    await app.close();
  });

  it('allowlist 拒绝时返回 Anthropic 风格 404 错误', async () => {
    registerAdapter(new FakeAdapter('a1', 'A1', ['m1']));
    const store = storeWithAnthropic(listAdapters(), true);
    store.set({
      ...store.get(),
      models: { allow: { a1: { m1: false } } },
    });
    const app = buildServer({ store, configPath: join(tmpDir, 'nope.yaml') });
    const r = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: { model: 'a1:m1', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.type).toBe('not_found_error');
    await app.close();
  });

  it('allowlist 通过时仍返回 Anthropic 风格响应', async () => {
    registerAdapter(new FakeAdapter('a1', 'A1', ['m1']));
    const store = storeWithAnthropic(listAdapters(), true);
    const app = buildServer({ store, configPath: join(tmpDir, 'nope.yaml') });
    const r = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: { model: 'a1:m1', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().type).toBe('message');
    expect(r.json().content[0].text).toBe('hello-from-a1');
    await app.close();
  });
});

describe('adapter 启停联动 setEnabled（T021 region 原语接线）', () => {
  it('POST /api/config 停用 adapter → setEnabled(false)；启动初始同步 setEnabled(true)', async () => {
    const calls: boolean[] = [];
    class RegionFake extends FakeAdapter {
      setEnabled(b: boolean): void { calls.push(b); }
    }
    registerAdapter(new RegionFake('r1', 'R1', ['m1']));
    const store = makeStore(listAdapters());
    const app = buildServer({ store, configPath: join(tmpDir, 'nope.yaml') });
    // mountUiRoutes 已做启动初始同步（默认 enabled=true）
    expect(calls.at(-1)).toBe(true);
    const r = await app.inject({
      method: 'POST',
      url: '/api/config',
      payload: { adapters: { r1: { enabled: false } } },
    });
    expect(r.statusCode).toBe(200);
    expect(calls.at(-1)).toBe(false);
    // 重新启用 → 恢复
    const r2 = await app.inject({
      method: 'POST',
      url: '/api/config',
      payload: { adapters: { r1: { enabled: true } } },
    });
    expect(r2.statusCode).toBe(200);
    expect(calls.at(-1)).toBe(true);
    await app.close();
  });
});

describe('buildServer 不带 store 时回退到原行为', () => {
  it('无 store 时仍可用 /health、/v1/models、/v1/chat/completions', async () => {
    registerAdapter(new ThrowingAdapter('a1'));
    const app = buildServer();
    const h = await app.inject({ method: 'GET', url: '/health' });
    expect(h.statusCode).toBe(200);
    const m = await app.inject({ method: 'GET', url: '/v1/models' });
    expect(m.statusCode).toBe(200);
    await app.close();
  });

  it('无 store 时仍不挂 UI 路由', async () => {
    const app = buildServer();
    const r = await app.inject({ method: 'GET', url: '/ui' });
    expect(r.statusCode).toBe(404);
    await app.close();
  });
});

describe('uiOnly 模式', () => {
  it('跳过 LLM 端点挂载', async () => {
    registerAdapter(new ThrowingAdapter('a1'));
    const store = makeStore(listAdapters());
    const app = buildServer({ store, configPath: join(tmpDir, 'nope.yaml'), uiOnly: true });
    const chat = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'a1:m1', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(chat.statusCode).toBe(404);
    const uiRes = await app.inject({ method: 'GET', url: '/ui/' });
    expect(uiRes.statusCode).toBe(200);
    await app.close();
  });
});