// T033 UI 后端：全部 fixture HOME + fake adapter/领取/计时器，不触及本机签到和宿主配置。
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearRegistry, registerAdapter } from '../src/adapters/registry.js';
import type { ProbeResult, ProviderAdapter } from '../src/adapters/types.js';
import { ConfigStore, buildDefaultConfig, loadConfigFromPath, type Config } from '../src/config/index.js';
import type { CheckinOptions } from '../src/checkin/index.js';
import type { CheckinResult } from '../src/checkin/types.js';
import type { HostDef } from '../src/onboard/hosts.js';
import type { ModelInfo, QuotaState } from '../src/types.js';
import { mountUiRoutes } from '../src/ui/index.js';
import {
  createUiServices, publicUiConfig, snapshotAdapterInfo,
  type UiServicesOptions, type UiTimers,
} from '../src/ui/services.js';

class FakeAdapter implements ProviderAdapter {
  readonly displayName: string;
  readonly sandbox = 'none' as const;
  readonly probe = vi.fn(async (): Promise<ProbeResult> => ({
    availability: 'available', auth: 'logged-in', models: this.models,
  }));
  readonly fetchQuota = vi.fn(async (): Promise<QuotaState> => 'ok');
  constructor(readonly id: string, readonly models: ModelInfo[] = [{ id: 'm1', provider: id }]) { this.displayName = id; }
  async launch(): Promise<never> { throw new Error('fixture 不应建立会话'); }
  async dispose(): Promise<void> {}
}

class FakeTimers implements UiTimers {
  private next = 0;
  readonly jobs = new Map<number, { at: number; callback: () => void }>();
  readonly clear = vi.fn();
  time = Date.parse('2026-10-02T04:00:00Z');
  readonly now = () => new Date(this.time);
  setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.next;
    this.jobs.set(id, { at: this.time + delayMs, callback });
    return id;
  }
  clearTimeout(timer: unknown): void { this.clear(timer); this.jobs.delete(timer as number); }
  async advance(ms: number): Promise<void> {
    const until = this.time + ms;
    for (;;) {
      const entry = [...this.jobs].sort((a, b) => a[1].at - b[1].at)[0];
      if (entry === undefined || entry[1].at > until) break;
      this.time = Math.max(this.time, entry[1].at);
      this.jobs.delete(entry[0]);
      entry[1].callback();
      await settle();
    }
    this.time = until;
    await settle();
  }
}

async function settle(): Promise<void> { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function result(source: 'workbuddy' | 'qoder', verdict: CheckinResult['verdict'] = 'claimed', message = '领取成功'): CheckinResult {
  return { source, verdict, message };
}
function checkinOn(store: ConfigStore, sources: { workbuddy?: boolean; qoder?: boolean; zcode?: boolean }) {
  store.set({ ...store.get(), checkin: { ...store.get().checkin, sources: { ...store.get().checkin?.sources, ...sources } } });
}
function fakeHost(id: string, detected: ReturnType<HostDef['detect']>, kind: HostDef['kind'] = 'auto'): HostDef {
  return {
    id, name: id, kind, detect: () => detected,
    guideLines: () => ['本地接入说明'],
    onboard: vi.fn(async () => { throw new Error('禁止接入'); }),
  };
}

let temp = '';
const apps: FastifyInstance[] = [];
const closes: Array<() => void> = [];
beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), 'accessmux-ui-services-'));
  clearRegistry();
});
afterEach(async () => {
  for (const close of closes.splice(0)) close();
  for (const app of apps.splice(0)) await app.close();
  clearRegistry();
  vi.unstubAllEnvs();
  rmSync(temp, { recursive: true, force: true });
});

function harness(config?: Config, options: UiServicesOptions = {}) {
  const adapter = new FakeAdapter('workbuddy');
  registerAdapter(adapter);
  const store = new ConfigStore(config ?? buildDefaultConfig([adapter]));
  const runCheckin = vi.fn(async (opts: CheckinOptions) => [result(opts.sources?.qoder ? 'qoder' : 'workbuddy')]);
  const readPat = vi.fn(() => undefined as string | undefined);
  const timers = new FakeTimers();
  const app = Fastify();
  const configPath = join(temp, 'config.yaml');
  mountUiRoutes(app, {
    store, configPath,
    uiServices: { homeDir: join(temp, 'home'), repoRoot: temp, runCheckin, readPat, timers, now: timers.now, adapterTimeoutMs: 25, ...options },
  });
  apps.push(app);
  return { app, store, runCheckin, readPat, timers, configPath, adapter };
}

function service(store: ConfigStore, options: UiServicesOptions) {
  const services = createUiServices(store, { homeDir: join(temp, 'home'), repoRoot: temp, readPat: () => undefined, ...options });
  closes.push(() => services.close());
  return services;
}

describe('模型元数据和每源额度隔离', () => {
  it('公开元数据完整透传，嵌套/私有字段不透传；不编余量或缺失徽标', async () => {
    const adapter = new FakeAdapter('a', [{
      id: 'm', provider: 'a', tags: ['chat'], minCtx: 128_000,
      name: '上游展示名', priceMultiplier: 0, free: true, priceScope: 'entitlement',
      freeSource: { kind: 'platform', reference: 'qoder:test', field: 'fee', updated_at: '2026-10-02T04:00:00Z' },
      activityLabels: ['夜间免费'], description: '上游原始描述',
      reasoning: { supported: true, supportedEfforts: ['low', 'high'], canDisableThinking: false, token: 'PRIVATE-NESTED' },
      inputModalities: ['text', 'image'], iconUrl: 'https://example.test/model.png',
      accessToken: 'PRIVATE-MODEL',
    } as ModelInfo]);
    const other = new FakeAdapter('b');
    const config = buildDefaultConfig([adapter, other]);
    const snapshot = await snapshotAdapterInfo([adapter, other], config, 25);
    expect(snapshot[0]?.models[0]).toEqual({
      id: 'm', provider: 'a', tags: ['chat'], minCtx: 128_000,
      name: '上游展示名', priceMultiplier: 0, free: true, freeSource: { kind: 'platform', reference: 'qoder:test', field: 'fee', updated_at: '2026-10-02T04:00:00Z' }, priceScope: 'entitlement',
      feeFreshness: 'fresh', feeCheckedAt: expect.any(String),
      activityLabels: ['夜间免费'], description: '上游原始描述',
      reasoning: { supported: true, supportedEfforts: ['low', 'high'], canDisableThinking: false },
      inputModalities: ['text', 'image'], iconUrl: 'https://example.test/model.png', bridgeInputModalities: ['text'],
    });
    expect(snapshot[1]?.models[0]).toEqual({ id: 'm1', provider: 'b', feeFreshness: 'unknown', bridgeInputModalities: ['text'] });
    expect(snapshot[0]?.quota).toBe('ok');
    expect(snapshot[0]?.quotaMessage).toContain('未提供具体余量');
    expect(JSON.stringify(snapshot)).not.toContain('PRIVATE');
    expect(snapshot[0]).not.toHaveProperty('remaining');
    expect(adapter.fetchQuota).toHaveBeenCalledTimes(1);
  });

  it('单源 quota 抛错/超时不影响模型与其它源；probe 失败仍能返回 quota', async () => {
    const quotaError = new FakeAdapter('quota-error');
    quotaError.fetchQuota.mockRejectedValue(new Error('SECRET quota trace'));
    const hanging = new FakeAdapter('hang');
    hanging.probe.mockImplementation(() => new Promise(() => {}));
    hanging.fetchQuota.mockImplementation(() => new Promise(() => {}));
    const probeError = new FakeAdapter('probe-error');
    probeError.probe.mockRejectedValue(new Error('SECRET probe trace'));
    probeError.fetchQuota.mockResolvedValue('exhausted');
    const good = new FakeAdapter('good');
    const adapters = [quotaError, hanging, probeError, good];
    const config = buildDefaultConfig(adapters);
    const snapshot = await snapshotAdapterInfo(adapters, config, 10);
    expect(snapshot.map((source) => source.quota)).toEqual(['unknown', 'unknown', 'exhausted', 'ok']);
    expect(snapshot.map((source) => source.models.length)).toEqual([1, 0, 0, 1]);
    expect(JSON.stringify(snapshot)).not.toContain('SECRET');
    await snapshotAdapterInfo([hanging], config, 10);
    expect(hanging.probe).toHaveBeenCalledTimes(1);
    expect(hanging.fetchQuota).toHaveBeenCalledTimes(1);
  });

  it('保持 T031 禁用源不探测、不查 quota、不取 form，状态灯 reason 仍脱敏', async () => {
    const adapter = new FakeAdapter('disabled');
    const form = vi.fn(() => ({ form: 'direct', reason: 'Authorization: Bearer SYNTHETIC-PAT' }));
    Object.assign(adapter, { formSnapshot: form });
    const config = buildDefaultConfig([adapter]);
    config.adapters.disabled = { enabled: false };
    config.qoder = { pat: 'SYNTHETIC-PAT' };
    const disabled = await snapshotAdapterInfo([adapter], config, 25);
    expect(disabled[0]).toMatchObject({ enabled: false, availability: 'disabled', models: [], quota: 'unknown' });
    expect(adapter.probe).not.toHaveBeenCalled();
    expect(adapter.fetchQuota).not.toHaveBeenCalled();
    expect(form).not.toHaveBeenCalled();
    config.adapters.disabled = { enabled: true };
    const enabled = await snapshotAdapterInfo([adapter], config, 25);
    expect(enabled[0]?.form).toBe('direct');
    expect(JSON.stringify(enabled)).not.toContain('SYNTHETIC-PAT');
    Object.assign(adapter, { formSnapshot: () => ({ form: 'unavailable', fallbackAvailable: false, tools: 'disabled', token: 'PRIVATE-FORM' }) });
    const unavailable = await snapshotAdapterInfo([adapter], config, 25);
    expect(unavailable[0]).toMatchObject({ form: 'unavailable', fallbackAvailable: false, tools: 'disabled' });
    expect(JSON.stringify(unavailable)).not.toContain('PRIVATE-FORM');
    vi.stubEnv('ACCESSMUX_DISABLE_ADAPTERS', 'disabled');
    await snapshotAdapterInfo([adapter], config, 25);
    expect(adapter.probe).toHaveBeenCalledTimes(2);
    expect(form).toHaveBeenCalledTimes(1);
  });
});

describe('宿主检测/引导只读与状态诚实', () => {
  it('刷新状态同步跨源WorkBuddy条目名称；仅匹配当前端点，重复刷新不写盘', async () => {
    const home = join(temp, 'promotion-home');
    mkdirSync(join(home, '.workbuddy'), { recursive: true });
    const modelsPath = join(home, '.workbuddy/models.json');
    writeFileSync(modelsPath, JSON.stringify([
      { id: 'trae-cn:glm-5.2', name: 'AccessMux · Trae CN glm-5.2', url: 'http://127.0.0.1:8080/v1/chat/completions', apiKey: 'SYNTHETIC-KEEP', default: true },
      { id: 'qoder:flash', name: 'AccessMux · qoder old', url: 'http://127.0.0.1:8999/v1/chat/completions', apiKey: 'SYNTHETIC-OLD-PORT' },
      { id: 'handmade', name: '手工模型', apiKey: 'SYNTHETIC-OTHER' },
    ]));
    const { app } = harness(undefined, { homeDir: home });
    const priceSource = { kind: 'platform' as const, reference: 'workbuddy:test', field: 'models.credits', updated_at: '2026-10-03T04:00:00.000Z' };
    const trae = new FakeAdapter('trae-cn', [{
      id: 'glm-5.2', provider: 'trae-cn', name: 'GLM-5.2', free: false,
      priceMultiplier: { value: 0.2, current: true, updated_at: priceSource.updated_at, source: priceSource },
      freeSource: priceSource, feeFreshness: 'fresh', activityLabels: ['夜间折扣'],
      activities: [{ label: '夜间折扣', kind: 'discount', scheduleMeaning: 'label', timezone: 'Asia/Shanghai', daily: [{ start: '23:00', end: '23:59' }, { start: '00:00', end: '08:00' }] }],
    }]);
    registerAdapter(trae);
    const first = await app.inject({ method: 'POST', url: '/api/probe', payload: {} });
    expect(first.statusCode).toBe(200);
    expect(first.json().metadataSync).toBe('updated');
    const updated = readFileSync(modelsPath, 'utf8');
    const parsed = JSON.parse(updated) as Array<Record<string, unknown>>;
    expect(parsed[0]?.name).toContain('夜间折扣');
    expect(parsed[0]).toMatchObject({ id: 'trae-cn:glm-5.2', url: 'http://127.0.0.1:8080/v1/chat/completions', apiKey: 'SYNTHETIC-KEEP', default: true });
    expect(parsed[1]).toEqual({ id: 'qoder:flash', name: 'AccessMux · qoder old', url: 'http://127.0.0.1:8999/v1/chat/completions', apiKey: 'SYNTHETIC-OLD-PORT' });
    expect(parsed[2]).toEqual({ id: 'handmade', name: '手工模型', apiKey: 'SYNTHETIC-OTHER' });
    const second = await app.inject({ method: 'POST', url: '/api/probe', payload: {} });
    expect(second.json().metadataSync).toBe('current');
    expect(readFileSync(modelsPath, 'utf8')).toBe(updated);
  });

  it('真实 allHosts.detect 仅检测 fixture 已安装宿主，guide 永远未确认，不读/写真实用户文件', async () => {
    const { app, runCheckin, readPat } = harness();
    const home = join(temp, 'home');
    mkdirSync(join(home, '.zcode/v2'), { recursive: true });
    const zcode = join(home, '.zcode/v2/provider_config.json');
    const fixture = JSON.stringify({ config: { providerConfigRules: { providerRules: [{ providerName: 'AccessMux', apiKey: 'PRIVATE-HOST' }] } } });
    writeFileSync(zcode, fixture);
    mkdirSync(join(home, '.workbuddy'), { recursive: true });
    mkdirSync(join(home, '.codex'), { recursive: true });
    const hosts = (await app.inject({ method: 'GET', url: '/api/hosts' })).json().hosts;
    expect(hosts).toEqual([
      { id: 'zcode', name: 'ZCode', kind: 'auto', status: 'onboarded', statusLabel: '已接入' },
      { id: 'workbuddy', name: 'WorkBuddy', kind: 'auto', status: 'not-onboarded', statusLabel: '未接入' },
      expect.objectContaining({ id: 'codex', status: 'unknown', statusLabel: '未确认' }),
    ]);
    const guide = await app.inject({ method: 'GET', url: '/api/onboard?host=codex' });
    expect(guide.statusCode).toBe(200);
    expect(guide.json().commands).toEqual(['accessmux onboard']);
    expect(guide.json().guideLines.join('\n')).toContain('base_url = "http://127.0.0.1:8080/v1"');
    expect(guide.json().guideLines.join('\n')).toContain('workbuddy:m1');
    expect(readFileSync(zcode, 'utf8')).toBe(fixture);
    expect(guide.body + JSON.stringify(hosts)).not.toContain('PRIVATE-HOST');
    expect(runCheckin).not.toHaveBeenCalled();
    expect(readPat).not.toHaveBeenCalled();
    expect((await app.inject({ method: 'POST', url: '/api/onboard', payload: { host: 'codex' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/onboard?host=not-a-host' })).statusCode).toBe(404);
  });

  it('单个宿主 detect 异常隔离，只给通用提示，不把未证实安装或 guide 判已接入', async () => {
    const broken = fakeHost('broken', { installed: true, onboarded: true, detail: 'PRIVATE-HOST' });
    const guide = fakeHost('guide', { installed: true, onboarded: true, detail: 'PRIVATE-HOST' }, 'guide');
    const absent = fakeHost('absent', { installed: false, detail: '' });
    const { app } = harness(undefined, { allHosts: () => [broken, guide, absent] });
    expect((await app.inject('/api/hosts')).json().hosts[0].status).toBe('onboarded');
    broken.detect = () => { throw new Error('PRIVATE-HOST credentials payload trace'); };
    const response = await app.inject('/api/hosts');
    expect(response.json().hosts).toHaveLength(2);
    expect(response.json().hosts.every((host: { status: string }) => host.status === 'unknown')).toBe(true);
    expect(response.json().message).toContain('检测未完成');
    expect(response.body).not.toContain('PRIVATE');
    guide.guideLines = () => { throw new Error('PRIVATE-HOST guide trace'); };
    const error = await app.inject('/api/onboard?host=guide');
    expect(error.statusCode).toBe(400);
    expect(error.body).not.toContain('PRIVATE');
  });

  it('bootstrap/state 统一携带 hosts 和初始未查询 checkin，GET 状态不发领取', async () => {
    const { app, runCheckin, readPat } = harness();
    for (const url of ['/api/bootstrap', '/api/state']) {
      const res = await app.inject(url);
      expect(res.json().hosts).toEqual([]);
      expect(res.json().checkin.sources[0]).toMatchObject({ supported: true, enabled: false, status: 'unqueried', message: '尚未查询领取状态' });
    }
    const state = (await app.inject('/api/checkin')).json();
    expect(state.sources.find((source: { source: string }) => source.source === 'trae-cn')).toMatchObject({
      supported: false, enabled: false, message: '不支持：需设备身份校验，本项目不提供',
    });
    expect(state.sources.find((source: { source: string }) => source.source === 'zcode')).toMatchObject({
      supported: false, enabled: false, message: '免费额度每日自动发放，无需签到',
    });
    expect(runCheckin).not.toHaveBeenCalled();
    expect(readPat).not.toHaveBeenCalled();
  });
});

describe('配置严格公开投影/保存/重置选择', () => {
  it('嵌套白名单不泄漏未来私有字段', () => {
    const config = buildDefaultConfig();
    const corrupted = {
      ...config, private: 'PRIVATE', qoder: { pat: 'PRIVATE' },
      output: { ...config.output, token: 'PRIVATE' },
      adapters: { source: { enabled: true, token: 'PRIVATE' } },
      models: { allow: { source: { m: false } }, token: 'PRIVATE' },
      checkin: { sources: { workbuddy: true, token: 'PRIVATE' }, token: 'PRIVATE' },
    } as Config;
    expect(publicUiConfig(corrupted)).toEqual({
      ...config, adapters: { source: { enabled: true } }, models: { allow: { source: { m: false } } }, checkin: { sources: { workbuddy: true } },
    });
  });

  it('保存 checkin.sources 和原 PAT；所有 config 响应脱敏；新重置选择保留 output/领取偏好/PAT', async () => {
    const { app, store, configPath, timers } = harness();
    store.set({ ...store.get(), qoder: { pat: 'SYNTHETIC-PRIVATE-PAT' }, checkin: { sources: { workbuddy: false, qoder: true, zcode: false } } });
    const saved = await app.inject({ method: 'POST', url: '/api/config', payload: {
      output: { port: 9002 }, adapters: { workbuddy: { enabled: false } },
      models: { allow: { workbuddy: { m1: false } } }, checkin: { sources: { workbuddy: true } },
    } });
    expect(saved.statusCode).toBe(200);
    expect(store.get().qoder?.pat).toBe('SYNTHETIC-PRIVATE-PAT');
    expect(store.get().checkin?.sources).toEqual({ workbuddy: true, qoder: true, zcode: false });
    expect(loadConfigFromPath(configPath).qoder?.pat).toBe('SYNTHETIC-PRIVATE-PAT');
    const reset = await app.inject({ method: 'POST', url: '/api/config/reset-selection' });
    expect(reset.statusCode).toBe(200);
    expect(store.get().output.port).toBe(9002);
    expect(store.get().adapters.workbuddy?.enabled).toBe(true);
    expect(store.get().models.allow.workbuddy).toEqual({});
    expect(store.get().checkin?.sources).toEqual({ workbuddy: true, qoder: true, zcode: false });
    expect(store.get().qoder?.pat).toBe('SYNTHETIC-PRIVATE-PAT');
    expect(loadConfigFromPath(configPath).checkin).toEqual(store.get().checkin);
    for (const response of [saved, reset, await app.inject('/api/bootstrap'), await app.inject('/api/state')]) {
      expect(response.body).not.toContain('SYNTHETIC-PRIVATE-PAT');
      expect(response.json().config).not.toHaveProperty('qoder');
    }
    expect(timers.jobs.size).toBe(1);
    // 既有 T031 完整重置仍保持原语义；前端用 reset-selection，不能混淆二者。
    const fullReset = await app.inject({ method: 'POST', url: '/api/config/reset' });
    expect(fullReset.statusCode).toBe(200);
    expect(fullReset.body).not.toContain('SYNTHETIC-PRIVATE-PAT');
    expect(store.get().qoder).toBeUndefined();
  });

  it.each([
    { checkin: { sources: { 'trae-cn': true } } },
    { checkin: { sources: { 'trae-cn': false } } },
    { checkin: { sources: { opencode: true } } },
    { qoder: { pat: 'SYNTHETIC-NEW-PAT' } },
    { pat: 'SYNTHETIC-NEW-PAT' },
    { checkin: { pat: 'SYNTHETIC-NEW-PAT' } },
    { output: { host: '0.0.0.0' } },
    { adapters: { workbuddy: { enabled: true, token: 'SYNTHETIC-NEW-PAT' } } },
  ])('拒绝私有字段/非签到源，不反射异常字段 $checkin', async (payload) => {
    const { app, store } = harness();
    const before = store.get();
    const response = await app.inject({ method: 'POST', url: '/api/config', payload });
    expect(response.statusCode).toBe(400);
    expect(store.get()).toBe(before);
    expect(response.body).not.toContain('SYNTHETIC');
    expect(response.json().error).not.toHaveProperty('details');
  });

  it('写盘失败不给浏览器异常原文/路径/PAT，内存不变', async () => {
    const { app, store, configPath } = harness();
    mkdirSync(configPath); // 目标是目录：生产 saveConfigToPath 报错，但不触及用户文件。
    store.set({ ...store.get(), qoder: { pat: 'PRIVATE-PAT' } });
    const before = store.get();
    for (const url of ['/api/config', '/api/config/reset', '/api/config/reset-selection']) {
      const res = await app.inject({ method: 'POST', url, payload: {} });
      expect(res.statusCode).toBe(400);
      expect(res.body).not.toContain('PRIVATE-PAT');
      expect(res.body).not.toContain(temp);
      expect(res.body).not.toMatch(/EISDIR|Error|stack|writeFile/);
      expect(store.get()).toBe(before);
    }
  });
});

describe('手动签到安全映射/单飞', () => {
  it('必须显式启用选定源；仅调用一个源，PAT 文件优先，ZCode 不探测', async () => {
    const runCheckin = vi.fn(async (_options: CheckinOptions) => [result('qoder', 'claimed', '领取成功（+20 Credits）')]);
    const readPat = vi.fn(() => 'SYNTHETIC-FILE-PAT');
    const { app, store } = harness(undefined, { runCheckin, readPat });
    expect((await app.inject({ method: 'POST', url: '/api/checkin', payload: { source: 'qoder' } })).statusCode).toBe(409);
    store.set({ ...store.get(), qoder: { pat: 'SYNTHETIC-CONFIG-PAT' } });
    checkinOn(store, { qoder: true, zcode: true });
    const response = await app.inject({ method: 'POST', url: '/api/checkin', payload: { source: 'qoder' } });
    expect(response.statusCode).toBe(200);
    expect(response.json().result).toMatchObject({ source: 'qoder', verdict: 'claimed', message: '领取成功（+20 Credits）' });
    expect(runCheckin).toHaveBeenCalledTimes(1);
    expect(runCheckin.mock.calls[0]?.[0]).toMatchObject({
      sources: { qoder: true, workbuddy: false, zcode: false }, qoderPat: 'SYNTHETIC-FILE-PAT',
    });
    expect(response.body).not.toContain('SYNTHETIC');
    expect(readPat).toHaveBeenCalledTimes(1);
  });

  it('Qoder PAT 缺文件时用 config fallback，WorkBuddy 不读 PAT', async () => {
    const { app, store, runCheckin, readPat } = harness();
    store.set({ ...store.get(), qoder: { pat: 'SYNTHETIC-CONFIG-PAT' } });
    checkinOn(store, { qoder: true, workbuddy: true });
    await app.inject({ method: 'POST', url: '/api/checkin', payload: { source: 'qoder' } });
    expect(runCheckin.mock.calls[0]?.[0].qoderPat).toBe('SYNTHETIC-CONFIG-PAT');
    await app.inject({ method: 'POST', url: '/api/checkin', payload: { source: 'workbuddy' } });
    expect(readPat).toHaveBeenCalledTimes(1);
    expect(runCheckin.mock.calls[1]?.[0]).toMatchObject({ sources: { workbuddy: true, qoder: false, zcode: false } });
    expect(runCheckin.mock.calls[1]?.[0]).not.toHaveProperty('qoderPat');
  });

  it.each([
    ['claimed', '领取成功（+25 credits，连签 2 天）', 'claimed', '领取成功（+25 credits，连签 2 天）'],
    ['already', '今日已领（+10 Credits，服务端幂等回执）', 'already', '今日已领（+10 Credits，服务端幂等回执）'],
    ['inactive', 'PRIVATE-UPSTREAM', 'inactive', '活动未开放或未下发'],
    ['skipped', 'PRIVATE-PAT trace /Users/secret', 'skipped', '未能领取，请检查该源登录状态或本地领取配置'],
    ['error', 'PRIVATE-TOKEN Bearer trace', 'error', '领取失败，请稍后重试'],
    ['hint', 'PRIVATE-HINT', 'error', '领取失败，请稍后重试'],
    ['claimed', '领取成功（+10 Credits）\nPRIVATE-PAT', 'claimed', '领取成功'],
    ['already', '今日已领 PRIVATE-TOKEN', 'already', '今日已领'],
  ])('安全映射 %s 不泄漏上游文本', async (verdict, rawMessage, safeVerdict, safeMessage) => {
    const runCheckin = vi.fn(async () => [result('workbuddy', verdict as CheckinResult['verdict'], rawMessage)]);
    const { app, store } = harness(undefined, { runCheckin });
    checkinOn(store, { workbuddy: true });
    const response = await app.inject({ method: 'POST', url: '/api/checkin', payload: { source: 'workbuddy' } });
    expect(response.json().result).toMatchObject({ verdict: safeVerdict, message: safeMessage });
    expect(response.body).not.toContain('PRIVATE');
    const state = (await app.inject('/api/checkin')).json().sources[0];
    expect(state.status).toBe(safeVerdict);
    expect(state.message).toBe(safeMessage);
  });

  it('runCheckin 或 PAT reader 异常统一安全 error，不暴露异常原文', async () => {
    const { app, store } = harness(undefined, {
      runCheckin: async () => { throw new Error('PRIVATE-RUN-TOKEN stack'); },
      readPat: () => { throw new Error('PRIVATE-PAT-FILE stack'); },
    });
    checkinOn(store, { workbuddy: true, qoder: true });
    for (const source of ['workbuddy', 'qoder']) {
      const response = await app.inject({ method: 'POST', url: '/api/checkin', payload: { source } });
      expect(response.json().result).toMatchObject({ verdict: 'error', message: '领取失败，请稍后重试' });
      expect(response.body).not.toContain('PRIVATE');
    }
  });

  it('同源手动与自动 single-flight，第二个请求 409，不重复领取', async () => {
    let finish!: (value: CheckinResult[]) => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((done) => { signalStarted = done; });
    const runCheckin = vi.fn(() => new Promise<CheckinResult[]>((done) => { finish = done; signalStarted(); }));
    const { app, store, timers } = harness(undefined, { runCheckin });
    checkinOn(store, { workbuddy: true });
    await app.ready();
    const first = app.inject({ method: 'POST', url: '/api/checkin', payload: { source: 'workbuddy' } }).then((response) => response);
    await started;
    expect(runCheckin).toHaveBeenCalledTimes(1);
    expect((await app.inject('/api/checkin')).json().sources[0].status).toBe('running');
    const second = await app.inject({ method: 'POST', url: '/api/checkin', payload: { source: 'workbuddy' } });
    expect(second.statusCode).toBe(409);
    await timers.advance(1_000);
    expect(runCheckin).toHaveBeenCalledTimes(1);
    finish([result('workbuddy')]);
    expect((await first).statusCode).toBe(200);
    expect((await app.inject('/api/checkin')).json().sources[0].status).toBe('claimed');
  });

  it.each(['trae-cn', 'zcode', 'opencode', 'bad'])('拒绝不支持的源 %s 不调用 production', async (source) => {
    const { app, store, runCheckin, readPat } = harness();
    checkinOn(store, { zcode: true });
    const response = await app.inject({ method: 'POST', url: '/api/checkin', payload: { source } });
    expect(response.statusCode).toBe(400);
    if (source === 'trae-cn') expect(response.json().error.message).toBe('不支持：需设备身份校验，本项目不提供');
    if (source === 'zcode') expect(response.json().error.message).toBe('免费额度每日自动发放，无需签到');
    expect(runCheckin).not.toHaveBeenCalled();
    expect(readPat).not.toHaveBeenCalled();
  });
});

describe('自动签到只在服务生命周期内、显式开关、有界重试', () => {
  it('老配置缺省/全关/ZCode true 均不开 timer、不读 PAT、不领取', async () => {
    const { app, store, timers, runCheckin, readPat } = harness();
    await app.ready();
    expect(timers.jobs.size).toBe(0);
    await timers.advance(24 * 60 * 60_000);
    checkinOn(store, { zcode: true, workbuddy: false, qoder: false });
    await timers.advance(24 * 60 * 60_000);
    expect(timers.jobs.size).toBe(0);
    expect(runCheckin).not.toHaveBeenCalled();
    expect(readPat).not.toHaveBeenCalled();
  });

  it.each(['claimed', 'already', 'inactive'] as const)('%s 每源每天只运行一次，跨日状态回未查询、下一日可领取', async (verdict) => {
    const timers = new FakeTimers();
    const runCheckin = vi.fn(async () => [result('workbuddy', verdict)]);
    const store = new ConfigStore({ ...buildDefaultConfig(), checkin: { sources: { workbuddy: true } } });
    const services = service(store, { timers, now: timers.now, runCheckin });
    services.start();
    await timers.advance(1_000);
    expect(runCheckin).toHaveBeenCalledTimes(1);
    await timers.advance(60 * 60_000);
    expect(runCheckin).toHaveBeenCalledTimes(1);
    timers.time = Date.parse('2026-10-03T04:00:00Z');
    expect(services.checkin().sources[0]?.status).toBe('unqueried');
    await timers.advance(1_000);
    expect(runCheckin).toHaveBeenCalledTimes(2);
  });

  it('error 延后有限重试（5分钟/15分钟，日内最多3次），不无限重领', async () => {
    const timers = new FakeTimers();
    const runCheckin = vi.fn(async () => [result('workbuddy', 'error', 'PRIVATE trace')]);
    const store = new ConfigStore({ ...buildDefaultConfig(), checkin: { sources: { workbuddy: true } } });
    const services = service(store, { timers, now: timers.now, runCheckin });
    services.start();
    await timers.advance(1_000);
    expect(runCheckin).toHaveBeenCalledTimes(1);
    await timers.advance(4 * 60_000);
    expect(runCheckin).toHaveBeenCalledTimes(1);
    await timers.advance(60_000);
    expect(runCheckin).toHaveBeenCalledTimes(2);
    await timers.advance(15 * 60_000);
    expect(runCheckin).toHaveBeenCalledTimes(3);
    await timers.advance(2 * 60 * 60_000);
    expect(runCheckin).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(services.checkin())).not.toContain('PRIVATE');
  });

  it('关闭后不再运行，onClose 清timer且解除配置listener，服务不新增常驻进程/历史文件', async () => {
    const { app, store, timers, runCheckin } = harness();
    checkinOn(store, { workbuddy: true });
    await app.ready();
    expect(timers.jobs.size).toBe(1);
    checkinOn(store, { workbuddy: false });
    expect(timers.jobs.size).toBe(0);
    await timers.advance(10 * 60_000);
    expect(runCheckin).not.toHaveBeenCalled();
    checkinOn(store, { workbuddy: true });
    await timers.advance(1_000);
    expect(runCheckin).toHaveBeenCalledTimes(1);
    await app.close();
    expect(timers.jobs.size).toBe(0);
    expect(timers.clear).toHaveBeenCalled();
    checkinOn(store, { qoder: true });
    await timers.advance(24 * 60 * 60_000);
    expect(runCheckin).toHaveBeenCalledTimes(1);
    expect(timers.jobs.size).toBe(0);
  });

  it('关闭/取消勾选发生在实际启动前时不调用领取；正在领取期间关闭不排新任务', async () => {
    const timers = new FakeTimers();
    let finish!: (value: CheckinResult[]) => void;
    const runCheckin = vi.fn(() => new Promise<CheckinResult[]>((done) => { finish = done; }));
    const store = new ConfigStore({ ...buildDefaultConfig(), checkin: { sources: { workbuddy: true } } });
    const services = service(store, { timers, now: timers.now, runCheckin });
    const canceled = services.claim('workbuddy');
    checkinOn(store, { workbuddy: false });
    expect((await canceled).verdict).toBe('skipped');
    expect(runCheckin).not.toHaveBeenCalled();
    checkinOn(store, { workbuddy: true });
    services.start();
    const running = services.claim('workbuddy');
    await settle();
    expect(runCheckin).toHaveBeenCalledTimes(1);
    services.close();
    await timers.advance(24 * 60 * 60_000);
    expect(timers.jobs.size).toBe(0);
    expect(runCheckin).toHaveBeenCalledTimes(1);
    finish([result('workbuddy')]);
    await running;
    await expect(services.claim('workbuddy')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('配置热更新只运行当时明确打开的源，不误用 runCheckinAll 缺省全开', async () => {
    const { app, store, timers, runCheckin } = harness();
    checkinOn(store, { qoder: true, workbuddy: false, zcode: true });
    await app.ready();
    await timers.advance(1_000);
    expect(runCheckin).toHaveBeenCalledTimes(1);
    expect(runCheckin.mock.calls[0]?.[0].sources).toEqual({ workbuddy: false, qoder: true, zcode: false });
    checkinOn(store, { workbuddy: true, qoder: false });
    await timers.advance(60_000);
    expect(runCheckin).toHaveBeenCalledTimes(2);
    expect(runCheckin.mock.calls[1]?.[0].sources).toEqual({ workbuddy: true, qoder: false, zcode: false });
  });
});

describe('本机写 API 防跨站请求', () => {
  it.each([
    { host: 'evil.example' },
    { host: '127.0.0.1:8080', origin: 'https://evil.example' },
    { host: '127.0.0.1:8080', origin: 'http://127.0.0.1:8081' },
    { host: '127.0.0.1:8080', origin: 'http://localhost:8080' },
    { host: '127.0.0.1:8080', origin: 'null' },
    { host: '127.0.0.1:8080', 'sec-fetch-site': 'cross-site' },
    { host: '127.0.0.1:8080', origin: 'http://127.0.0.1:8080/path' },
  ])('拒绝 cross-site/DNS rebinding $host $origin', async (headers) => {
    const { app, store, runCheckin, adapter } = harness();
    checkinOn(store, { workbuddy: true });
    for (const url of ['/api/config', '/api/config/reset', '/api/config/reset-selection', '/api/checkin', '/api/probe']) {
      const response = await app.inject({ method: 'POST', url, headers, payload: url === '/api/checkin' ? { source: 'workbuddy' } : {} });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.message).toBe('只允许本机同源请求');
    }
    expect(runCheckin).not.toHaveBeenCalled();
    expect(adapter.probe).not.toHaveBeenCalled();
  });

  it('同源 loopback 浏览器/CLI 可用，远端socket拒绝', async () => {
    const { app, store, runCheckin } = harness();
    const sameOrigin = await app.inject({
      method: 'POST', url: '/api/config', headers: { host: '127.0.0.1:8080', origin: 'http://127.0.0.1:8080' }, payload: { output: { port: 9090 } },
    });
    expect(sameOrigin.statusCode).toBe(200);
    const cli = await app.inject({ method: 'POST', url: '/api/config', payload: {} });
    expect(cli.statusCode).toBe(200);
    checkinOn(store, { workbuddy: true });
    const remote = await app.inject({
      method: 'POST', url: '/api/checkin', remoteAddress: '203.0.113.1', headers: { host: '127.0.0.1:8080' }, payload: { source: 'workbuddy' },
    });
    expect(remote.statusCode).toBe(403);
    expect(runCheckin).not.toHaveBeenCalled();
  });
});
