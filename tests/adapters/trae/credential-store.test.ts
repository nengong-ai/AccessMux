// Trae Credential Store 测试：双区域隔离、refresh margin、own path 落盘、单飞。
//
// 关键验收 #2："CN 与 Global 的凭据 store、目录缓存、端口/secret 互不污染；
// 一区域未登录不影响另一区域"。

import { describe, expect, it } from 'vitest';
import { TraeCredentialStore, normalizeTraeCredential, traeAccountId } from '../../../src/adapters/trae/credential-store.js';
import type { TraeCredential } from '../../../src/adapters/trae/credential-store.js';

function buildMemoryFs(initial: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  return {
    files,
    existsSync: (p: string): boolean => files.has(p),
    readFileSync: (p: string): string => {
      const v = files.get(p);
      if (v === undefined) {
        const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return v;
    },
    writeFileSync: (p: string, data: string): void => {
      files.set(p, data);
    },
    mkdirSync: (p: string, _opts: { recursive: boolean }): void => {
      // 内存 FS 不需要建目录
    },
    rmSync: (p: string, _opts: { force: boolean }): void => {
      files.delete(p);
      files.delete(`${p}.lock`);
    },
  };
}

function makeStore(storeDir: string, region: 'cn' | 'ai', refresh: (c: TraeCredential) => Promise<{ accessToken: string; expiresAtMs: number }>, fs: ReturnType<typeof buildMemoryFs>, opts: { edition?: 'cn' | 'sg' | 'auto'; storagePath?: string } = {}) {
  const store = new TraeCredentialStore({
    region,
    edition: opts.edition ?? 'auto',
    ownPath: `${storeDir}/.trae-auth.${region}.json`,
    legacyOwnPath: `${storeDir}/.trae-auth.json`,
    refresh,
    fs: fs as never,
  });
  // 用 storagePath 注入路径；规避 traeStorageCandidates() 默认按当前平台扫真实路径
  if (opts.storagePath !== undefined) {
    store.setSource(opts.storagePath);
  }
  return store;
}

const futureExpiry = Date.now() + 3600_000;
const futureRefreshExpiry = Date.now() + 86400_000;

const cnCredential = {
  token: 'cn-token',
  userId: 'cn-user',
  host: 'https://api.trae.cn',
  userRegion: 'CN',
  expiredAt: futureExpiry,
  refreshToken: 'cn-refresh',
  refreshExpiredAt: futureRefreshExpiry,
  account: { username: 'cn-name' },
};

const aiCredential = {
  token: 'ai-token',
  userId: 'ai-user',
  host: 'https://coresg-normal.trae.ai',
  userRegion: 'SG',
  expiredAt: futureExpiry,
  refreshToken: 'ai-refresh',
  refreshExpiredAt: futureRefreshExpiry,
  account: { username: 'ai-name' },
};

function buildStorageDocument(credential: typeof cnCredential): string {
  const plaintext = JSON.stringify(credential);
  // 我们直接写明文 JSON（不是加密形式）—— store 接受 `parseTraeAuthValue` 看到
  // `{` 开头的明文就直接 JSON.parse。
  return JSON.stringify({ 'iCubeAuthInfo://icube.cloudide': plaintext });
}

describe('TraeCredentialStore 双区域隔离', () => {
  it('CN store 只看 CN account；AI store 只看 AI account', async () => {
    const fs = buildMemoryFs({
      '/store/cn/storage.json': buildStorageDocument(cnCredential),
      '/store/ai/storage.json': buildStorageDocument(aiCredential),
    });
    const cn = makeStore('/store', 'cn', async () => ({ accessToken: '', expiresAtMs: 0 }), fs, { storagePath: '/store/cn/storage.json' });
    const ai = makeStore('/store', 'ai', async () => ({ accessToken: '', expiresAtMs: 0 }), fs, { storagePath: '/store/ai/storage.json' });

    const cnCred = await cn.resolve();
    const aiCred = await ai.resolve();
    expect(cnCred.userId).toBe('cn-user');
    expect(cnCred.host).toBe('https://api.trae.cn');
    expect(aiCred.userId).toBe('ai-user');
    expect(aiCred.host).toBe('https://coresg-normal.trae.ai');
  });

  it('CN store 写 own copy 不污染 AI own path', async () => {
    // 触发 refresh：把 expiresAtMs 设为 1s 后过期
    const expiredFs = buildMemoryFs({
      '/store/cn/storage.json': buildStorageDocument({ ...cnCredential, expiredAt: Date.now() + 1000 }),
    });
    const cn2 = makeStore('/store', 'cn', async () => ({ accessToken: 'cn-fresh', expiresAtMs: futureExpiry }), expiredFs, { storagePath: '/store/cn/storage.json' });
    const cred = await cn2.resolve();
    expect(cred.accessToken).toBe('cn-fresh');
    expect(expiredFs.files.has('/store/.trae-auth.cn.json')).toBe(true);
    expect(expiredFs.files.has('/store/.trae-auth.ai.json')).toBe(false);

    // AI store 独立——它的 own path 不会被 CN store 触动
    // AI store 用 AI storage（独立文件，独立凭据）。
    const aiFs = buildMemoryFs({
      '/store/ai/storage.json': buildStorageDocument(aiCredential),
    });
    const ai = makeStore('/store', 'ai', async () => ({ accessToken: 'ai-fresh', expiresAtMs: futureExpiry }), aiFs, { storagePath: '/store/ai/storage.json' });
    const aiCred = await ai.resolve();
    expect(aiCred.userId).toBe('ai-user');
    // AI store 写 own copy 到 AI path，不碰 CN path
    await ai.logout();
    expect(aiFs.files.has('/store/.trae-auth.ai.json')).toBe(false);
  });
});

describe('TraeCredentialStore 单飞 + refresh 行为', () => {
  it('并发 resolve 只触发一次 refresh（单飞）', async () => {
    const fs = buildMemoryFs({
      '/store/cn/storage.json': buildStorageDocument({ ...cnCredential, expiredAt: Date.now() + 1000 }),
    });
    let calls = 0;
    const cn = makeStore('/store', 'cn', async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      return { accessToken: 'fresh', expiresAtMs: futureExpiry };
    }, fs, { storagePath: '/store/cn/storage.json' });

    const [a, b, c] = await Promise.all([cn.resolve(), cn.resolve(), cn.resolve()]);
    expect(calls).toBe(1);
    expect(a.accessToken).toBe('fresh');
    expect(b.accessToken).toBe('fresh');
    expect(c.accessToken).toBe('fresh');
  });

  it('refresh 失败 + token 仍有 > 30s 余量 → 保留旧 token', async () => {
    const fs = buildMemoryFs({
      '/store/cn/storage.json': buildStorageDocument({ ...cnCredential, expiredAt: Date.now() + 60_000 }),
    });
    const cn = makeStore('/store', 'cn', async () => { throw new Error('refresh failed'); }, fs, { storagePath: '/store/cn/storage.json' });
    const cred = await cn.resolve();
    expect(cred.accessToken).toBe('cn-token');
  });

  it('refresh 失败 + token 真正过期 → 抛错让上层重登', async () => {
    const fs = buildMemoryFs({
      '/store/cn/storage.json': buildStorageDocument({ ...cnCredential, expiredAt: Date.now() + 5_000 }),
    });
    const cn = makeStore('/store', 'cn', async () => { throw new Error('refresh failed'); }, fs, { storagePath: '/store/cn/storage.json' });
    await expect(cn.resolve()).rejects.toThrow(/expired/);
  });

  it('未到期 token 不触发 refresh', async () => {
    const fs = buildMemoryFs({
      '/store/cn/storage.json': buildStorageDocument(cnCredential),
    });
    let calls = 0;
    const cn = makeStore('/store', 'cn', async () => {
      calls++;
      return { accessToken: 'fresh', expiresAtMs: futureExpiry };
    }, fs, { storagePath: '/store/cn/storage.json' });
    const cred = await cn.resolve();
    expect(cred.accessToken).toBe('cn-token');
    expect(calls).toBe(0);
  });
});

describe('TraeCredentialStore 选中账号消失绝不静默 fallback', () => {
  it('accountId 选了某个账号 → 该账号的 own copy 没了 → 返回 undefined', async () => {
    const fs = buildMemoryFs({}); // 没有任何 candidate
    const cn = makeStore('/store', 'cn', async () => ({ accessToken: '', expiresAtMs: 0 }), fs, { storagePath: '/store/none/storage.json' });
    cn.selectAccount(traeAccountId({ edition: 'cn', userId: 'gone' }));
    const cred = await cn.current();
    expect(cred).toBeUndefined();
  });

  it('未选账号时 → 返回第一个（preferred = first）', async () => {
    const fs = buildMemoryFs({
      '/store/cn/storage.json': buildStorageDocument(cnCredential),
    });
    const cn = makeStore('/store', 'cn', async () => ({ accessToken: '', expiresAtMs: 0 }), fs, { storagePath: '/store/cn/storage.json' });
    const cred = await cn.current();
    expect(cred?.userId).toBe('cn-user');
  });
});

describe('TraeCredentialStore logout', () => {
  it('清掉 own copy + legacy own copy', async () => {
    const fs = buildMemoryFs({
      '/store/.trae-auth.cn.json': JSON.stringify({ version: 1, credential: { accessToken: 'x' } }),
      '/store/.trae-auth.ai.json': JSON.stringify({ version: 1, credential: { accessToken: 'y' } }),
      '/store/.trae-auth.json': JSON.stringify({ version: 1, credential: { accessToken: 'z' } }),
    });
    const cn = makeStore('/store', 'cn', async () => ({ accessToken: '', expiresAtMs: 0 }), fs);
    await cn.logout();
    expect(fs.files.has('/store/.trae-auth.cn.json')).toBe(false);
    expect(fs.files.has('/store/.trae-auth.json')).toBe(false);
    expect(fs.files.has('/store/.trae-auth.ai.json')).toBe(true); // logout 只清自己 region
  });
});

describe('TraeCredentialStore status / desktopFilePresent', () => {
  it('status: 没有 candidate → signed-out', async () => {
    const fs = buildMemoryFs({});
    const cn = makeStore('/store', 'cn', async () => ({ accessToken: '', expiresAtMs: 0 }), fs, { storagePath: '/store/none/storage.json' });
    expect(await cn.status()).toEqual({ state: 'signed-out' });
  });

  it('status: 有 candidate → signed-in', async () => {
    const fs = buildMemoryFs({ '/store/cn/storage.json': buildStorageDocument(cnCredential) });
    const cn = makeStore('/store', 'cn', async () => ({ accessToken: '', expiresAtMs: 0 }), fs, { storagePath: '/store/cn/storage.json' });
    const s = await cn.status();
    expect(s.state).toBe('signed-in');
    expect(s.edition).toBe('cn');
  });

  it('desktopFilePresent: 任意 candidate 存在 → true', async () => {
    const fs = buildMemoryFs({ '/store/cn/storage.json': buildStorageDocument(cnCredential) });
    const cn = makeStore('/store', 'cn', async () => ({ accessToken: '', expiresAtMs: 0 }), fs, { storagePath: '/store/cn/storage.json' });
    expect(await cn.desktopFilePresent()).toBe(true);
  });

  it('desktopFilePresent: 无任何 candidate → false', async () => {
    const fs = buildMemoryFs({});
    const cn = makeStore('/store', 'cn', async () => ({ accessToken: '', expiresAtMs: 0 }), fs, { storagePath: '/store/none/storage.json' });
    expect(await cn.desktopFilePresent()).toBe(false);
  });
});

describe('normalizeTraeCredential', () => {
  it('缺 accessToken → undefined', () => {
    expect(normalizeTraeCredential({}, 'cn', 'desktop')).toBeUndefined();
  });

  it('accessToken string OK', () => {
    expect(normalizeTraeCredential({ token: 't', userId: 'u' }, 'cn', 'desktop')?.accessToken).toBe('t');
  });

  it('expiredAt 数字秒 → 毫秒', () => {
    const out = normalizeTraeCredential({ token: 't', userId: 'u', expiredAt: 1_700_000_000 }, 'cn', 'desktop');
    expect(out?.expiresAtMs).toBe(1_700_000_000 * 1000);
  });

  it('expiredAt 数字毫秒保留', () => {
    const out = normalizeTraeCredential({ token: 't', userId: 'u', expiredAt: 1_700_000_000_000 }, 'cn', 'desktop');
    expect(out?.expiresAtMs).toBe(1_700_000_000_000);
  });

  it('userRegion string 透传', () => {
    const out = normalizeTraeCredential({ token: 't', userId: 'u', userRegion: 'CN' }, 'cn', 'desktop');
    expect(out?.userRegion).toBe('CN');
  });

  it('userRegion object 提取 .region', () => {
    const out = normalizeTraeCredential({ token: 't', userId: 'u', userRegion: { region: 'CN' } }, 'cn', 'desktop');
    expect(out?.userRegion).toBe('CN');
  });
});

describe('traeAccountId', () => {
  it('同 edition + 同 userId → 同 id', () => {
    const id1 = traeAccountId({ edition: 'cn', userId: 'u1' });
    const id2 = traeAccountId({ edition: 'cn', userId: 'u1' });
    expect(id1).toBe(id2);
  });
  it('不同 userId → 不同 id', () => {
    expect(traeAccountId({ edition: 'cn', userId: 'u1' })).not.toBe(traeAccountId({ edition: 'cn', userId: 'u2' }));
  });
  it('24 字符十六进制', () => {
    expect(traeAccountId({ edition: 'cn', userId: 'u1' })).toMatch(/^[a-f0-9]{24}$/);
  });
});