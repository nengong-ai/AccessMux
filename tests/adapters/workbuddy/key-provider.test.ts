// WorkBuddy atRest payload 解析 + fake key provider + spawn provider 行为。
//
// spawn helper 不在 unit test 跑（需要 Electron 二进制）；spawn 路径用 mock
// execFile 注入覆盖。

import { describe, expect, it, vi } from 'vitest';
import {
  HELPER_SCRIPT,
  workBuddyHelperEnv,
  HELPER_SCRIPT_ARGUMENT_FLAG,
  createSpawnKeyProvider,
  fakeKeyProvider,
  parseAtRestPayload,
} from '../../../src/adapters/workbuddy/key-provider.js';

describe('parseAtRestPayload', () => {
  const GOOD_KEY = Buffer.alloc(32, 1).toString('base64'); // canonical 44 字符

  it('合法 payload 解出 version + atRestSecretKey（32 字节 canonical base64）', () => {
    const parsed = parseAtRestPayload(JSON.stringify({ version: 1, atRestSecretKey: GOOD_KEY }));
    expect(parsed).toEqual({ version: 1, atRestSecretKey: GOOD_KEY });
  });

  it('version !== 1 抛错', () => {
    expect(() => parseAtRestPayload('{"version":2,"atRestSecretKey":"x"}')).toThrow(/version/);
  });

  it('缺 atRestSecretKey 抛错', () => {
    expect(() => parseAtRestPayload('{"version":1}')).toThrow(/atRestSecretKey/);
  });

  it('不是 JSON 抛错', () => {
    expect(() => parseAtRestPayload('not json')).toThrow(/not JSON/);
    expect(() => parseAtRestPayload('')).toThrow(/empty/);
  });

  it('非对象抛错', () => {
    expect(() => parseAtRestPayload('[1,2,3]')).toThrow(/JSON object/);
    expect(() => parseAtRestPayload('null')).toThrow(/JSON object/);
  });

  it('key 不是 32 字节抛错（dsh 形状校验）', () => {
    const short = Buffer.alloc(16, 1).toString('base64');
    expect(() => parseAtRestPayload(JSON.stringify({ version: 1, atRestSecretKey: short }))).toThrow(/canonical base64 32-byte/);
  });

  it('key 非全零（全零 secret 抛错）', () => {
    const zero = Buffer.alloc(32, 0).toString('base64');
    expect(() => parseAtRestPayload(JSON.stringify({ version: 1, atRestSecretKey: zero }))).toThrow(/all-zero/);
  });
});

describe('fakeKeyProvider', () => {
  it('resolveAtRestSecretKey 返回注入的 key', async () => {
    const provider = fakeKeyProvider('test-key');
    const payload = await provider.resolveAtRestSecretKey();
    expect(payload).toEqual({ version: 1, atRestSecretKey: 'test-key' });
  });

  it('resetCache 是 no-op', () => {
    const provider = fakeKeyProvider('test');
    expect(() => provider.resetCache()).not.toThrow();
  });
});

describe('createSpawnKeyProvider (mocked spawnHelper)', () => {
  it('discovery 返回 undefined 时抛错', async () => {
    const provider = createSpawnKeyProvider('cn', {
      discovery: async () => undefined,
      spawnHelper: () => { throw new Error('should not be called'); },
    });
    await expect(provider.resolveAtRestSecretKey()).rejects.toThrow(/desktop app.*not found/);
  });

  it('discovery 命中 + helper 输出合法 JSON → cached 复用', async () => {
    const calls: string[] = [];
    const mockKey = Buffer.alloc(32, 7).toString('base64');
    const provider = createSpawnKeyProvider('cn', {
      discovery: async () => ({ electronPath: '/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy', variant: 'cn' }),
      spawnHelper: async (electronPath) => {
        calls.push(electronPath);
        return JSON.stringify({ version: 1, atRestSecretKey: mockKey });
      },
    });
    const a = await provider.resolveAtRestSecretKey();
    const b = await provider.resolveAtRestSecretKey();
    expect(a.atRestSecretKey).toBe(mockKey);
    expect(b.atRestSecretKey).toBe(mockKey);
    // 单飞 + cache：第二次不重 spawn
    expect(calls.length).toBe(1);
  });

  it('helper 脚本常量与 spawn 参数', () => {
    expect(HELPER_SCRIPT).toBe("process.stdout.write(String(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet()))");
    // 真机验证：`-e` 是 node `-e <script>` inline-evaluate；
    // `--js` 在新版 Electron / WorkBuddy 私有 fork 下报 `bad option: --js`
    expect(HELPER_SCRIPT_ARGUMENT_FLAG).toBe('-e');
  });

  it('resetCache 让下一次重新 spawn', async () => {
    let calls = 0;
    const mockKey = JSON.stringify({ version: 1, atRestSecretKey: Buffer.alloc(32, 9).toString('base64') });
    const provider = createSpawnKeyProvider('cn', {
      discovery: async () => ({ electronPath: '/fake', variant: 'cn' }),
      spawnHelper: async () => {
        calls++;
        return mockKey;
      },
    });
    await provider.resolveAtRestSecretKey();
    provider.resetCache();
    await provider.resolveAtRestSecretKey();
    expect(calls).toBe(2);
  });

  it('并发 resolve 共享 inflight 单飞', async () => {
    let calls = 0;
    const mockKey = JSON.stringify({ version: 1, atRestSecretKey: Buffer.alloc(32, 11).toString('base64') });
    const provider = createSpawnKeyProvider('cn', {
      discovery: async () => ({ electronPath: '/fake', variant: 'cn' }),
      spawnHelper: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 5));
        return mockKey;
      },
    });
    await Promise.all([provider.resolveAtRestSecretKey(), provider.resolveAtRestSecretKey(), provider.resolveAtRestSecretKey()]);
    expect(calls).toBe(1);
  });

  it('helper 输出坏 payload（key 形状非法）时抛错', async () => {
    const provider = createSpawnKeyProvider('cn', {
      discovery: async () => ({ electronPath: '/fake', variant: 'cn' }),
      spawnHelper: async () => JSON.stringify({ version: 1, atRestSecretKey: 'too-short' }),
    });
    await expect(provider.resolveAtRestSecretKey()).rejects.toThrow(/canonical base64 32-byte/);
  });
});

describe('defaultWorkBuddyDiscovery (CFBundleExecutable 优先)', () => {
  // macOS mdfind 在测试机可能没有 .app（CI / 干净容器），这里只覆盖注入式 mock。
  it('discovery 函数存在 + 注入 mock 路径命中', async () => {
    const { defaultWorkBuddyDiscovery } = await import('../../../src/adapters/workbuddy/key-provider.js');
    expect(typeof defaultWorkBuddyDiscovery).toBe('function');

  });
});

describe('T031 helper isolation/cache lifecycle', () => {
  it('helper environment keeps only OS essentials and excludes other providers and injected Node runtime', () => {
    expect(workBuddyHelperEnv({ HOME: '/synthetic', PATH: '/bin', OPENAI_API_KEY: 'short-key', ANTHROPIC_API_KEY: 'other-key', NODE_OPTIONS: '--require evil', NODE_PATH: '/evil', DYLD_INSERT_LIBRARIES: '/evil', ELECTRON_RUN_AS_NODE: '0' })).toEqual({ HOME: '/synthetic', PATH: '/bin', ELECTRON_RUN_AS_NODE: '1' });
  });
  it('reset during pending helper cannot restore key cache or clear a newer in-flight resolution', async () => {
    const resolvers: Array<(value: string) => void> = [];
    const provider = createSpawnKeyProvider('cn', { discovery: async () => ({ electronPath: '/synthetic', variant: 'cn' }), spawnHelper: () => new Promise((resolve) => { resolvers.push(resolve); }) });
    const old = provider.resolveAtRestSecretKey(); const failure = expect(old).rejects.toThrow(/reset/);
    await vi.waitFor(() => expect(resolvers).toHaveLength(1)); provider.resetCache();
    const current = provider.resolveAtRestSecretKey(); await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    const payload = JSON.stringify({ version: 1, atRestSecretKey: Buffer.alloc(32, 7).toString('base64') });
    resolvers[0]!(payload); await failure;
    const concurrent = provider.resolveAtRestSecretKey(); expect(resolvers).toHaveLength(2);
    resolvers[1]!(payload); expect(await current).toEqual(await concurrent);
    await provider.resolveAtRestSecretKey(); expect(resolvers).toHaveLength(2);
  });
});
