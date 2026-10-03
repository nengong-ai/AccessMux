// T019 adapter 层：probe 三态、fetchQuota、form env、双形态 session 装配、dispose。

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZcodeAdapter } from '../../../src/adapters/zcode/index.js';
import { createZcodeCredentialCipher } from '../../../src/adapters/zcode/decrypt.js';
import { registerDefaultAdapters } from '../../../src/adapters/index.js';
import { clearRegistry, listAdapters } from '../../../src/adapters/registry.js';

const FAKE_JWT = `${'a'.repeat(36)}.${'b'.repeat(120)}.${'c'.repeat(43)}`;

const tmpHomes: string[] = [];
function makeLoggedInHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'zcode-adapter-'));
  tmpHomes.push(home);
  mkdirSync(join(home, '.zcode', 'v2'), { recursive: true });
  const cipher = createZcodeCredentialCipher({ env: {}, home, username: 'tester' });
  writeFileSync(
    join(home, '.zcode', 'v2', 'credentials.json'),
    JSON.stringify({ zcodejwttoken: cipher.encrypt(FAKE_JWT) }),
  );
  return home;
}

afterEach(() => {
  tmpHomes.splice(0);
});

function okBalance(capabilities?: string[]): Response {
  const entry: Record<string, unknown> = { remaining_units: 12345 };
  if (capabilities !== undefined) entry['capabilities'] = capabilities;
  return new Response(
    JSON.stringify({ code: 0, data: { balances: [entry] } }),
    { status: 200 },
  );
}

function makeAdapter(overrides: Partial<ConstructorParameters<typeof ZcodeAdapter>[0]> = {}) {
  return new ZcodeAdapter({ home: makeLoggedInHome(), env: {}, username: 'tester', ...overrides });
}

describe('ZcodeAdapter probe/fetchQuota', () => {
  it('权益过滤（用户裁决）：balance capabilities 只放行 flash → 只列 GLM-5.3-Flash', async () => {
    const adapter = makeAdapter({ fetchImpl: vi.fn(async () => okBalance(['model:glm-5.3-flash'])) });
    const probe = await adapter.probe();
    expect(probe.availability).toBe('available');
    expect(probe.auth).toBe('logged-in');
    expect(probe.models.map((m) => m.id)).toEqual(['GLM-5.3-Flash']);
    expect(await adapter.fetchQuota()).toBe('ok');
  });

  it('balance 正常但无可识别 capability → 固定候选保持未确认，不算就绪目录', async () => {
    const adapter = makeAdapter({ fetchImpl: vi.fn(async () => okBalance()) });
    const probe = await adapter.probe();
    expect(probe.availability).toBe('unverified');
    expect(probe.models.map((m) => m.id)).toEqual(['GLM-5.3-Flash', 'GLM-5.2', 'GLM-5-Turbo']);
  });

  it('多模型 capability 全放行 → 清单全列', async () => {
    const adapter = makeAdapter({
      fetchImpl: vi.fn(async () =>
        okBalance(['model:glm-5.3-flash', 'model:glm-5.2', 'model:glm-5-turbo']),
      ),
    });
    expect((await adapter.probe()).models.map((m) => m.id)).toEqual([
      'GLM-5.3-Flash',
      'GLM-5.2',
      'GLM-5-Turbo',
    ]);
  });

  it('未登录（无凭据文件）→ unavailable + logged-out', async () => {
    const emptyHome = mkdtempSync(join(tmpdir(), 'zcode-none-'));
    tmpHomes.push(emptyHome);
    const adapter = new ZcodeAdapter({ home: emptyHome, env: {} });
    const probe = await adapter.probe();
    expect(probe).toEqual({ availability: 'unavailable', models: [], auth: 'logged-out' });
    expect(await adapter.fetchQuota()).toBe('unknown');
  });

  it('balance 401 → unavailable + logged-out（JWT 失效，无 refresh）', async () => {
    const adapter = makeAdapter({ fetchImpl: vi.fn(async () => new Response('', { status: 401 })) });
    const probe = await adapter.probe();
    expect(probe.availability).toBe('unavailable');
    expect(probe.auth).toBe('logged-out');
  });

  it('balance 形状异常 → unverified + 退回固定三模型（不虚标也不误杀）', async () => {
    const adapter = makeAdapter({
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 })),
    });
    const probe = await adapter.probe();
    expect(probe.availability).toBe('unverified');
    expect(probe.auth).toBe('logged-in');
    expect(probe.models).toHaveLength(3);
  });
});

describe('ZcodeAdapter 形态与环境', () => {
  it('R11 405 后 formSnapshot 安全 unavailable，probe 不继续触碰上游，重建恢复 direct', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ code: 3012, msg: 'Authorization: Bearer secret-echo' }), { status: 405 }));
    const spawnImpl = vi.fn();
    const adapter = makeAdapter({ fetchImpl, spawnImpl });
    const session = await adapter.launch({ localSecret: 'synthetic' });
    await expect(async () => { for await (const _ of session.runTurn({ model: 'GLM-5.3-Flash', messages: [{ role: 'user', content: 'hello' }], stream: false })) void _; }).rejects.toThrow('禁用');
    const snapshot = adapter.formSnapshot();
    expect(snapshot).toMatchObject({ form: 'unavailable', fallbackAvailable: false, tools: 'disabled' });
    expect(JSON.stringify(snapshot)).not.toContain('secret-echo'); expect(JSON.stringify(snapshot)).not.toContain(FAKE_JWT);
    expect((await adapter.probe()).availability).toBe('unavailable'); expect(fetchImpl).toHaveBeenCalledTimes(1); expect(spawnImpl).not.toHaveBeenCalled();
    expect(makeAdapter().formSnapshot()).toMatchObject({ form: 'direct', fallbackAvailable: false, tools: 'disabled' });
  });
  it('ACCESSMUX_ZCODE_FORM=app-server 强制兜底形态（D23 被否决时的停用开关）', () => {
    const adapter = new ZcodeAdapter({ env: { ACCESSMUX_ZCODE_FORM: 'app-server' } });
    expect(adapter.formSnapshot().form).toBe('unavailable');
    expect(new ZcodeAdapter({ env: {} }).formSnapshot().form).toBe('direct');
    expect(new ZcodeAdapter({ env: { ACCESSMUX_ZCODE_FORM: 'garbage' } }).formSnapshot().form).toBe('direct');
  });

  it('未注入 env 时读 process.env（生产 daemon 的 env 指定路径，R021 微修）', () => {
    process.env['ACCESSMUX_ZCODE_FORM'] = 'app-server';
    try {
      expect(new ZcodeAdapter().formSnapshot().form).toBe('unavailable');
    } finally {
      delete process.env['ACCESSMUX_ZCODE_FORM'];
    }
    // 注入 env 仍优先：注入空对象时不受宿主 process.env 污染（隔离语义不变）
    expect(new ZcodeAdapter({ env: {} }).formSnapshot().form).toBe('direct');
  });

  it('launch 出双形态会话；formSnapshot 反映切换', async () => {
    const adapter = makeAdapter({ fetchImpl: vi.fn(async () => okBalance()) });
    const session = await adapter.launch({ localSecret: 's' });
    expect(typeof session.runTurn).toBe('function');
    expect(typeof session.cancel).toBe('function');
    expect(adapter.formSnapshot().form).toBe('direct');
    expect(adapter.formSnapshot().reason).toBeUndefined();
  });

  it('dispose 幂等（未起 app-server 时也安全）', async () => {
    const adapter = makeAdapter();
    await adapter.dispose();
    await adapter.dispose();
  });
});

describe('默认注册（禁用开关语义，T021 解 VITEST 门控后）', () => {
  beforeEach(() => {
    clearRegistry();
  });
  afterEach(() => {
    clearRegistry();
  });

  it('registerDefaultAdapters 默认含 zcode（构造离线；probe 才有真机副作用）', () => {
    registerDefaultAdapters();
    expect(listAdapters().map((a) => a.id)).toContain('zcode');
  });

  it('disable 开关摘除 zcode（离线测试环境的替代机制）', () => {
    registerDefaultAdapters({ disable: ['opencode', 'qoder', 'zcode'] });
    expect(listAdapters().map((a) => a.id)).not.toContain('zcode');
  });
});
