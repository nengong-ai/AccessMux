// T031 合成回归：所有 adapter 均为本文件假实现；只允许本轮 loopback 服务。
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/protocol/server.js';
import { clearRegistry, registerAdapter } from '../../src/adapters/registry.js';
import type { ProviderAdapter, ProviderSession, LaunchContext } from '../../src/adapters/types.js';
import { ConfigStore, buildDefaultConfig } from '../../src/config/index.js';

let app: FastifyInstance | undefined;
let dir: string;
beforeEach(() => { clearRegistry(); dir = mkdtempSync(join(tmpdir(), 'accessmux-release-')); });
afterEach(async () => { await app?.close(); app = undefined; clearRegistry(); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

function fake(overrides: Partial<ProviderAdapter> = {}): ProviderAdapter {
  return {
    id: 'fake', displayName: 'Fake', sandbox: 'none',
    async probe() { return { availability: 'available', models: [{ id: 'm', provider: 'fake' }] }; },
    async fetchQuota() { return 'unknown'; }, async dispose() {},
    async launch() { return { async *runTurn() { yield { delta: 'normal text pat=not-a-secret', done: true }; }, async cancel() {} }; },
    ...overrides,
  };
}
const chat = { model: 'fake:m', messages: [{ role: 'user', content: 'synthetic' }] };
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error('合成生命周期未收尾');
}

describe('B01/B02/R05 公开面', () => {
  it('所有配置响应无 PAT，保存保留内部 checkin/PAT，reset 仅清主配置', async () => {
    registerAdapter(fake());
    const pat = 'synthetic-short-pat';
    const configPath = join(dir, 'config.yaml');
    const independent = join(dir, 'qoder.pat');
    writeFileSync(independent, 'synthetic-independent-pat');
    const store = new ConfigStore({ ...buildDefaultConfig(), qoder: { pat }, checkin: { sources: { workbuddy: false, qoder: false } } });
    app = buildServer({ store, configPath });
    for (const url of ['/api/bootstrap', '/api/state']) {
      const res = await app.inject({ url }); expect(res.statusCode).toBe(200); expect(res.body).not.toContain(pat);
    }
    for (const payload of [{ output: { port: 9001 } }, { adapters: { fake: { enabled: true } } }, { models: { allow: { fake: { m: false } } } }]) {
      const res = await app.inject({ method: 'POST', url: '/api/config', payload });
      expect(res.statusCode).toBe(200); expect(res.body).not.toContain(pat);
      expect(store.get().qoder?.pat).toBe(pat); expect(store.get().checkin?.sources?.workbuddy).toBe(false);
      expect(readFileSync(configPath, 'utf8')).toContain(pat);
    }
    const reset = await app.inject({ method: 'POST', url: '/api/config/reset' });
    expect(reset.statusCode).toBe(200); expect(reset.body).not.toContain(pat); expect(store.get().qoder).toBeUndefined();
    expect(readFileSync(independent, 'utf8')).toBe('synthetic-independent-pat');
  });
  it('未知 Host/外站/其它本机端口/null Origin/简单跨站请求均拒绝且磁盘不变', async () => {
    const path = join(dir, 'config.yaml'); writeFileSync(path, 'unchanged');
    app = buildServer({ store: new ConfigStore(buildDefaultConfig()), configPath: path, uiOnly: true });
    for (const headers of [
      { host: 'attacker.invalid:8080' }, { host: '127.1:8080' }, { host: 'localhost:8080', origin: 'https://attacker.invalid' },
      { host: '127.0.0.1:8080', origin: 'http://127.0.0.1:9999' }, { host: 'localhost:8080', origin: 'null' },
      { host: 'localhost:8080', 'content-type': 'text/plain' }, { host: 'localhost:8080', 'sec-fetch-site': 'cross-site' },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/api/config/reset', headers });
      expect(res.statusCode).toBe(403); expect(readFileSync(path, 'utf8')).toBe('unchanged');
    }
    expect((await app.inject({ method: 'POST', url: '/api/config/reset', headers: { host: 'localhost:8080', origin: 'http://localhost:8080' } })).statusCode).toBe(200);
  });
});

describe('B04 HTTP 错误和 R02 释放', () => {
  it.each(['/v1/chat/completions', '/v1/messages', 'sse'])('回合失败 %s 脱敏并恰好 cancel 一次', async (path) => {
    let cancelled = 0;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const secret = 'short-token';
    const pat = 'short-known-pat';
    registerAdapter(fake({ async launch() { return {
      async *runTurn() { yield { delta: 'partial', done: false }; throw new Error(`Authorization: Basic ${secret}; Cloud-IDE-JWT: jwt-short; upstream echo ${pat}`); },
      async cancel() { cancelled++; },
    }; } }));
    const store = new ConfigStore({ ...buildDefaultConfig(), qoder: { pat }, output: { ...buildDefaultConfig().output, exposeAnthropic: true } });
    app = buildServer({ store });
    const res = await app.inject({ method: 'POST', url: path === 'sse' ? '/v1/chat/completions' : path, payload: { ...chat, ...(path === 'sse' ? { stream: true } : {}), max_tokens: 32 } });
    expect(res.body).not.toContain(secret); expect(res.body).not.toContain(pat); expect(res.body).not.toContain('jwt-short');
    expect(JSON.stringify(log.mock.calls)).not.toContain(pat); expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    expect(cancelled).toBe(1);
    if (path === 'sse') { expect(res.body).toContain('partial'); expect(res.body).not.toContain('[DONE]'); }
    else expect(res.statusCode).toBe(500);
  });
  it('launch 失败走安全 Fastify 错误投影；正常模型正文不脱敏', async () => {
    registerAdapter(fake({ async launch() { throw new Error('pat=short-launch-pat'); } }));
    app = buildServer();
    const res = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: chat });
    expect(res.statusCode).toBe(500); expect(res.body).not.toContain('short-launch-pat');
    await app.close(); clearRegistry(); registerAdapter(fake()); app = buildServer();
    const ok = await app.inject({ method: 'POST', url: '/v1/chat/completions', payload: chat });
    expect(ok.json().choices[0].message.content).toBe('normal text pat=not-a-secret');
  });
  it.each([false, true])('launch 未完成断连 stream=%s：signal 已取消，迟到 session 不 send 且释放', async (stream) => {
    let resolveLaunch!: (s: ProviderSession) => void;
    let launched = false; let cancelled = 0; let sent = 0; let signal: AbortSignal | undefined;
    registerAdapter(fake({ launch(ctx: LaunchContext) {
      signal = (ctx as LaunchContext & { signal: AbortSignal }).signal; launched = true;
      return new Promise((resolve) => { resolveLaunch = resolve; });
    } }));
    app = buildServer(); await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as AddressInfo).port;
    const req = request({ host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json' } });
    req.on('error', () => {}); req.end(JSON.stringify({ ...chat, stream }));
    await until(() => launched); req.destroy(); await until(() => signal?.aborted === true);
    resolveLaunch({ async *runTurn() { sent++; yield { delta: 'should-not-send', done: true }; }, async cancel() { cancelled++; } });
    await until(() => cancelled === 1); expect(sent).toBe(0);
  });
  it.each(['/v1/chat/completions', '/v1/messages'])('非流式 %s 断连立即 cancel，无成功续跑', async (path) => {
    let started = false; let cancelled = 0; let release!: () => void;
    registerAdapter(fake({ async launch() { return {
      async *runTurn() { started = true; await new Promise<void>((r) => { release = r; }); yield { delta: '', done: true }; },
      async cancel() { cancelled++; release(); },
    }; } }));
    app = buildServer(); await app.listen({ port: 0, host: '127.0.0.1' });
    const req = request({ host: '127.0.0.1', port: (app.server.address() as AddressInfo).port, path, method: 'POST', headers: { 'content-type': 'application/json' } });
    req.on('error', () => {}); req.end(JSON.stringify({ ...chat, max_tokens: 32 }));
    await until(() => started); req.destroy(); await until(() => cancelled === 1);
  });
});

describe('R09/R10/R11 控制面', () => {
  it.each(['config', 'env'])('关闭源 %s：state/bootstrap/probe/models 零 probe / quota / form 调用', async (mode) => {
    const probe = vi.fn(async () => ({ availability: 'available' as const, models: [] }));
    const quota = vi.fn(async () => 'unknown' as const); const form = vi.fn(() => ({ form: 'direct' }));
    registerAdapter(Object.assign(fake({ probe, fetchQuota: quota }), { formSnapshot: form }));
    const store = new ConfigStore(buildDefaultConfig());
    if (mode === 'config') store.set({ ...store.get(), adapters: { fake: { enabled: false } } });
    else vi.stubEnv('ACCESSMUX_DISABLE_ADAPTERS', 'fake');
    app = buildServer({ store, configPath: join(dir, 'config.yaml') });
    for (const url of ['/api/state', '/api/bootstrap', '/api/probe', '/v1/models']) {
      expect((await app.inject({ url, method: url === '/api/probe' ? 'POST' : 'GET' })).statusCode).toBe(200);
    }
    expect(probe).not.toHaveBeenCalled(); expect(quota).not.toHaveBeenCalled(); expect(form).not.toHaveBeenCalled();
  });
  it('挂起源预算 abort，正常源清单保留，旧调用不响应时刷新不叠加工作', async () => {
    let stopped = false;
    const probe = vi.fn((ctx?: { signal: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      ctx?.signal.addEventListener('abort', () => { stopped = true; reject(new Error('cancelled')); }, { once: true });
    }));
    registerAdapter(fake({ id: 'slow', probe })); registerAdapter(fake());
    app = buildServer({ controlTimeoutMs: 20 });
    const res = await app.inject({ url: '/v1/models' }); expect(res.json().data.map((m: { id: string }) => m.id)).toContain('fake:m'); expect(stopped).toBe(true);
    let calls = 0; registerAdapter(fake({ id: 'stuck', probe() { calls++; return new Promise(() => {}); } }));
    await app.inject({ url: '/v1/models' }); await app.inject({ url: '/v1/models' }); expect(calls).toBe(1);
  });
  it('UI state 的 probe/quota 同时有界并发 abort，正常源仍可见', async () => {
    let stopped = 0;
    const hanging = (ctx?: { signal: AbortSignal }) => new Promise<never>((_resolve, reject) => {
      ctx?.signal.addEventListener('abort', () => { stopped++; reject(new Error('synthetic abort')); }, { once: true });
    });
    registerAdapter(fake({ id: 'slow', probe: hanging, fetchQuota: hanging })); registerAdapter(fake());
    app = buildServer({ store: new ConfigStore(buildDefaultConfig()), configPath: join(dir, 'config.yaml'), controlTimeoutMs: 20 });
    const res = await app.inject({ url: '/api/state' });
    expect(stopped).toBe(2);
    expect(res.json().adapters.find((a: { id: string }) => a.id === 'slow')).toMatchObject({ auth: 'unknown', availability: 'unverified', quota: 'unknown', models: [] });
    expect(res.json().adapters.find((a: { id: string }) => a.id === 'fake').models[0].id).toBe('m');
  });
  it('form 白名单顶层：unavailable/fallback/tools/reason 安全，不透出未知 secret 字段', async () => {
    registerAdapter(Object.assign(fake(), { formSnapshot: () => ({ form: 'unavailable', fallbackAvailable: false, tools: 'disabled', reason: 'Cloud-IDE-JWT: short-form-secret', token: 'synthetic-hidden' }) }));
    app = buildServer({ store: new ConfigStore(buildDefaultConfig()), configPath: join(dir, 'config.yaml') });
    const res = await app.inject({ url: '/api/state' }); const a = res.json().adapters[0];
    expect(a.form).toBe('unavailable'); expect(a.fallbackAvailable).toBe(false); expect(a.tools).toBe('disabled');
    expect(res.body).not.toContain('short-form-secret'); expect(res.body).not.toContain('synthetic-hidden');
  });
});
