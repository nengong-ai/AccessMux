// WorkBuddy credential store 行为：双 variant 隔离、refresh margin、单飞、
// own copy 落盘、graceful refresh 失败。
//
// key provider 用 fake；desktop file 用内存 FS 注入合成 envelope。

import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkBuddyAdapter } from '../../../src/adapters/workbuddy/index.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  WorkBuddyCredentialStore,
  workBuddyAccountId,
  WORKBUDDY_AUTH_FILE_ENV,
} from '../../../src/adapters/workbuddy/credential-store.js';
import type { WorkBuddyCredential } from '../../../src/adapters/workbuddy/credential-store.js';
import { fakeKeyProvider } from '../../../src/adapters/workbuddy/key-provider.js';
import { workBuddyAuthCandidates } from '../../../src/adapters/workbuddy/paths.js';

const AT_REST_KEY = 'test-at-rest-key';
const FUTURE_EXPIRY = Date.now() + 3600_000;
const FUTURE_REFRESH_EXPIRY = Date.now() + 86400_000;

function buildEncryptedField(atRestKey: string, plaintext: string): unknown {
  const key = createHash('sha256').update(atRestKey, 'utf8').digest();
  const keyId = createHash('sha256').update(key).digest('hex').slice(0, 16);
  const nonce = randomBytes(12);
  const plaintextBuf = Buffer.from(plaintext, 'utf8');
  const aad = Buffer.concat([
    Buffer.from('WB-AAD\0'),
    Buffer.from([0x01]),
    Buffer.from([0x00, 0x00, 0x00, 0x05]),
    Buffer.from('WBEV1'),
    Buffer.from([0x00, 0x00, 0x00, 0x06]),
    Buffer.from('sym-v1'),
    Buffer.from([0x00, 0x00, 0x00, 0x01]),
    Buffer.from([0x00, 0x00, 0x00, 0x10]),
    Buffer.from(keyId, 'utf8'),
    Buffer.from([0x02, 0x00, 0x00]),
  ]);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    $wbEncrypted: 1,
    envelope: Buffer.from(JSON.stringify({
      suite: 1,
      keyId,
      nonce: nonce.toString('base64'),
      authTag: authTag.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    }), 'utf8').toString('base64'),
  };
}

function buildDesktopFile(args: {
  uid: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number | string;
  refreshExpiresAt?: number | string;
}): string {
  return JSON.stringify({
    account: { uid: args.uid },
    auth: {
      accessToken: buildEncryptedField(AT_REST_KEY, args.accessToken),
      ...(args.refreshToken === undefined ? {} : { refreshToken: buildEncryptedField(AT_REST_KEY, args.refreshToken) }),
      expiresAt: args.expiresAt ?? FUTURE_EXPIRY,
      ...(args.refreshExpiresAt === undefined ? {} : { refreshExpiresAt: args.refreshExpiresAt }),
    },
  });
}

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
    mkdirSync: (_p: string, _opts: { recursive: boolean }): void => {
      // 内存 FS 不需要建目录
    },
    rmSync: (p: string, _opts: { force: boolean }): void => {
      files.delete(p);
      files.delete(`${p}.lock`);
    },
  };
}

function makeStore(
  fs: ReturnType<typeof buildMemoryFs>,
  opts: {
    variant?: 'cn' | 'global';
    desktopPath?: string;
    refresh?: (c: WorkBuddyCredential) => Promise<{ accessToken: string; expiresAtMs: number; refreshToken?: string }>;
  } = {},
) {
  return new WorkBuddyCredentialStore({
    variant: opts.variant ?? 'cn',
    keyProvider: fakeKeyProvider(AT_REST_KEY),
    refresh: opts.refresh ?? (async () => ({ accessToken: 'new-token', expiresAtMs: FUTURE_EXPIRY })),
    fs: fs as never,
    ...(opts.desktopPath === undefined ? {} : { desktopPath: opts.desktopPath }),
  });
}

describe('WorkBuddyCredentialStore: account id 派生', () => {
  it('同 variant + 同 userId → 同 account id', () => {
    const a = workBuddyAccountId({ variant: 'cn', userId: 'u1' });
    const b = workBuddyAccountId({ variant: 'cn', userId: 'u1' });
    expect(a).toBe(b);
  });

  it('不同 variant → 不同 account id', () => {
    expect(workBuddyAccountId({ variant: 'cn', userId: 'u1' }))
      .not.toBe(workBuddyAccountId({ variant: 'global', userId: 'u1' }));
  });
});

describe('WorkBuddyCredentialStore: desktop 路径推导（T001R4 根因回归）', () => {
  let fs: ReturnType<typeof buildMemoryFs>;
  beforeEach(() => { fs = buildMemoryFs(); });
  afterEach(() => {
    delete process.env[WORKBUDDY_AUTH_FILE_ENV];
    fs = buildMemoryFs();
  });

  it('不传 desktopPath 时按平台默认推导（之前恒 undefined → desktop: unset 根因）', () => {
    const store = new WorkBuddyCredentialStore({
      variant: 'cn',
      keyProvider: fakeKeyProvider(AT_REST_KEY),
      refresh: async () => ({ accessToken: 'new', expiresAtMs: FUTURE_EXPIRY }),
      fs: fs as never,
    });
    const expected = workBuddyAuthCandidates().find((c) => c.variant === 'cn')!.path;
    expect(store.desktopPath()).toBe(expected);
    expect(store.desktopCandidates()).toEqual([expected]);
  });

  it('默认推导的路径能被 current() 读到（内存 FS 放到推导路径上）', async () => {
    const store = new WorkBuddyCredentialStore({
      variant: 'cn',
      keyProvider: fakeKeyProvider(AT_REST_KEY),
      refresh: async () => ({ accessToken: 'new', expiresAtMs: FUTURE_EXPIRY }),
      fs: fs as never,
    });
    const path = workBuddyAuthCandidates().find((c) => c.variant === 'cn')!.path;
    fs.files.set(path, buildDesktopFile({ uid: 'u-default', accessToken: 'default-path-tok' }));
    const credential = await store.current();
    expect(credential?.accessToken).toBe('default-path-tok');
    expect(credential?.source).toBe('desktop');
  });

  it('WORKBUDDY_AUTH_FILE 环境变量覆盖默认候选', () => {
    process.env[WORKBUDDY_AUTH_FILE_ENV] = '/custom/override/workbuddy-desktop.info';
    const store = new WorkBuddyCredentialStore({
      variant: 'cn',
      keyProvider: fakeKeyProvider(AT_REST_KEY),
      refresh: async () => ({ accessToken: 'new', expiresAtMs: FUTURE_EXPIRY }),
      fs: fs as never,
    });
    expect(store.desktopCandidates()).toEqual(['/custom/override/workbuddy-desktop.info']);
  });

  it('显式 desktopPath 优先于环境变量', () => {
    process.env[WORKBUDDY_AUTH_FILE_ENV] = '/custom/override/workbuddy-desktop.info';
    const store = new WorkBuddyCredentialStore({
      variant: 'cn',
      keyProvider: fakeKeyProvider(AT_REST_KEY),
      refresh: async () => ({ accessToken: 'new', expiresAtMs: FUTURE_EXPIRY }),
      fs: fs as never,
      desktopPath: '/explicit/path',
    });
    expect(store.desktopCandidates()).toEqual(['/explicit/path']);
  });

  it('无凭据时 resolve() 错误信息列出候选路径（不再 desktop: unset）', async () => {
    const store = new WorkBuddyCredentialStore({
      variant: 'cn',
      keyProvider: fakeKeyProvider(AT_REST_KEY),
      refresh: async () => ({ accessToken: 'new', expiresAtMs: FUTURE_EXPIRY }),
      fs: fs as never,
    });
    const expected = workBuddyAuthCandidates().find((c) => c.variant === 'cn')!.path;
    await expect(store.resolve()).rejects.toThrow(new RegExp(expected.replaceAll('/', '\\/')));
  });
});

describe('WorkBuddyCredentialStore: 错误透出（T001R4 #2）', () => {
  let fs: ReturnType<typeof buildMemoryFs>;
  beforeEach(() => { fs = buildMemoryFs(); });
  afterEach(() => { fs = buildMemoryFs(); });

  it('desktop 文件存在但 JSON 坏 → resolve() 抛出 parse 错误（含 cause 描述）', async () => {
    const store = makeStore(fs, { desktopPath: '/auth/info' });
    fs.files.set('/auth/info', 'not-json-at-all');
    await expect(store.resolve()).rejects.toThrow(/not valid JSON/);
  });

  it('desktop 文件存在但 key 不匹配 → resolve() 抛出 keyId mismatch 错误', async () => {
    const store = makeStore(fs, { desktopPath: '/auth/info' });
    // 用别的 key 加密 → fakeKeyProvider 的 key 解不开
    fs.files.set('/auth/info', JSON.stringify({
      account: { uid: 'u' },
      auth: { accessToken: buildEncryptedField('another-key', 'tok'), expiresAt: FUTURE_EXPIRY },
    }));
    await expect(store.resolve()).rejects.toThrow(/keyId does not match|auth failed/);
  });

  it('status() 读取/解密失败为 unknown，不能要求用户重新登录', async () => {
    const store = makeStore(fs, { desktopPath: '/auth/info' });
    fs.files.set('/auth/info', 'not-json-at-all');
    const status = await store.status();
    expect(status.state).toBe('unknown');
    expect(status.reason).toMatch(/could not be read or decrypted/);
  });

  it('readFileSync 非 ENOENT IO 错误抛出（带路径与 cause）', async () => {
    const failingFs = {
      ...buildMemoryFs(),
      existsSync: (): boolean => true,
      readFileSync: (): string => {
        const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      },
    };
    const store = new WorkBuddyCredentialStore({
      variant: 'cn',
      keyProvider: fakeKeyProvider(AT_REST_KEY),
      refresh: async () => ({ accessToken: 'new', expiresAtMs: FUTURE_EXPIRY }),
      fs: failingFs as never,
      desktopPath: '/auth/info',
    });
    await expect(store.resolve()).rejects.toThrow(/read failed at \/auth\/info.*EACCES/);
  });

  it('ENOENT（existsSync 后竞态删除）→ 落到 own copy 而非抛错', async () => {
    const store = makeStore(fs, { desktopPath: '/auth/info' });
    // existsSync true 但读时 ENOENT：内存 FS 模拟——existsSync 用自己的 map，read 拿不到
    const racetimeFs = {
      files: fs.files,
      existsSync: (): boolean => true,
      readFileSync: fs.readFileSync,
      writeFileSync: fs.writeFileSync,
      mkdirSync: fs.mkdirSync,
      rmSync: fs.rmSync,
    };
    const store2 = new WorkBuddyCredentialStore({
      variant: 'cn',
      keyProvider: fakeKeyProvider(AT_REST_KEY),
      refresh: async () => ({ accessToken: 'new', expiresAtMs: FUTURE_EXPIRY }),
      fs: racetimeFs as never,
      desktopPath: '/auth/info',
    });
    fs.files.set(store2.ownAuthPath(), JSON.stringify({
      version: 1,
      credential: { accessToken: 'own-tok', userId: 'u', expiresAtMs: FUTURE_EXPIRY, variant: 'cn', source: 'accessmux' },
    }));
    const credential = await store2.current();
    expect(credential?.accessToken).toBe('own-tok');
    void store;
  });
});

describe('WorkBuddyCredentialStore: read + refresh', () => {
  let fs: ReturnType<typeof buildMemoryFs>;
  beforeEach(() => { fs = buildMemoryFs(); });
  afterEach(() => { fs = buildMemoryFs(); });

  it('desktop 存在时解出 token + variant', async () => {
    const store = makeStore(fs, {
      desktopPath: '/auth/workbuddy-desktop.info',
    });
    fs.files.set('/auth/workbuddy-desktop.info', buildDesktopFile({
      uid: 'u1',
      accessToken: 'jwt.access',
      refreshToken: 'jwt.refresh',
    }));
    const credential = await store.resolve();
    expect(credential.accessToken).toBe('jwt.access');
    expect(credential.refreshToken).toBe('jwt.refresh');
    expect(credential.variant).toBe('cn');
    expect(credential.source).toBe('desktop');
  });

  it('desktop 缺失 → no signed-in 错误', async () => {
    const store = makeStore(fs, { desktopPath: '/missing' });
    await expect(store.resolve()).rejects.toThrow(/no signed-in account/);
  });

  it('access token 未到期直接返回，不调 refresh', async () => {
    const refreshCalls: WorkBuddyCredential[] = [];
    const store = makeStore(fs, {
      desktopPath: '/auth/info',
      refresh: async (c) => {
        refreshCalls.push(c);
        return { accessToken: 'new', expiresAtMs: FUTURE_EXPIRY };
      },
    });
    fs.files.set('/auth/info', buildDesktopFile({ uid: 'u', accessToken: 'tok', expiresAt: FUTURE_EXPIRY }));
    const cred = await store.resolve();
    expect(cred.accessToken).toBe('tok');
    expect(refreshCalls).toHaveLength(0);
  });

  it('access token 临近到期触发 refresh，并写 own copy', async () => {
    const expiredAt = Date.now() + 60_000; // 1 分钟后到期 < 默认 refreshMargin 5 分钟
    const store = makeStore(fs, {
      desktopPath: '/auth/info',
      refresh: async (c) => ({ accessToken: `new-${c.userId}`, expiresAtMs: FUTURE_EXPIRY }),
    });
    fs.files.set('/auth/info', buildDesktopFile({
      uid: 'u1', accessToken: 'old', refreshToken: 'rt', expiresAt: expiredAt, refreshExpiresAt: FUTURE_REFRESH_EXPIRY,
    }));
    const cred = await store.resolve();
    expect(cred.accessToken).toBe('new-u1');
    expect(cred.source).toBe('accessmux');
    // own copy 应落盘
    expect(fs.files.has(store.ownAuthPath())).toBe(true);
    const own = JSON.parse(fs.files.get(store.ownAuthPath())!) as { credential: WorkBuddyCredential };
    expect(own.credential.accessToken).toBe('new-u1');
  });

  it('refresh 失败 + access 还有 > 30s 余量 → graceful 用当前 token', async () => {
    const stillValid = Date.now() + 120_000; // 2 分钟后到期
    const store = makeStore(fs, {
      desktopPath: '/auth/info',
      refresh: async () => { throw new Error('refresh network failure'); },
    });
    fs.files.set('/auth/info', buildDesktopFile({
      uid: 'u', accessToken: 'current-tok', refreshToken: 'rt',
      expiresAt: stillValid, refreshExpiresAt: FUTURE_REFRESH_EXPIRY,
    }));
    // 把 margin 调到 5 分钟让 access 视为"接近过期"
    store.refreshMarginMs = 5 * 60_000;
    // 5min margin + now = 5min from now, access 还有 2min —— 不算余量 > 30s
    // 用更小 margin 测：margin = 3min, access 还有 2min → 仍会 refresh；refresh 失败但 access 还有 120s > 30s → 用当前 token
    store.refreshMarginMs = 3 * 60_000;
    const cred = await store.resolve();
    expect(cred.accessToken).toBe('current-tok');
    expect(cred.source).toBe('desktop');
  });

  it('refresh 失败 + access < 30s 余量 → 抛错', async () => {
    const expired = Date.now() + 10_000; // 10s
    const store = makeStore(fs, {
      desktopPath: '/auth/info',
      refresh: async () => { throw new Error('refresh failed'); },
    });
    fs.files.set('/auth/info', buildDesktopFile({
      uid: 'u', accessToken: 'expired', refreshToken: 'rt',
      expiresAt: expired, refreshExpiresAt: FUTURE_REFRESH_EXPIRY,
    }));
    store.refreshMarginMs = 60_000;
    await expect(store.resolve()).rejects.toThrow(/token refresh failed/);
  });

  it('并发 resolve 共享 inflight 单飞', async () => {
    let calls = 0;
    const store = makeStore(fs, {
      desktopPath: '/auth/info',
      refresh: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 5));
        return { accessToken: 'new', expiresAtMs: FUTURE_EXPIRY };
      },
    });
    fs.files.set('/auth/info', buildDesktopFile({
      uid: 'u', accessToken: 'old', refreshToken: 'rt',
      expiresAt: Date.now() + 60_000, refreshExpiresAt: FUTURE_REFRESH_EXPIRY,
    }));
    store.refreshMarginMs = 5 * 60_000;
    await Promise.all([store.resolve(), store.resolve(), store.resolve()]);
    expect(calls).toBe(1);
  });

  it('status: signed-out 当 desktop 缺失', async () => {
    const store = makeStore(fs, { desktopPath: '/missing' });
    expect(await store.status()).toEqual({ state: 'signed-out', variant: 'cn' });
  });

  it('status: signed-in 当 desktop 存在', async () => {
    const store = makeStore(fs, { desktopPath: '/auth/info' });
    fs.files.set('/auth/info', buildDesktopFile({ uid: 'u', accessToken: 'tok' }));
    const status = await store.status();
    expect(status.state).toBe('signed-in');
    expect(status.source).toBe('desktop');
  });

  it('own copy 在 desktop 缺失时顶替；desktop 在时以 desktop 为准（Trae 同构）', async () => {
    const store = makeStore(fs, { desktopPath: '/auth/info' });
    fs.files.set('/auth/info', buildDesktopFile({ uid: 'u', accessToken: 'desktop-tok' }));
    // 写 own copy（accessmux 之前 refresh 出来的）
    const ownPath = store.ownAuthPath();
    fs.files.set(ownPath, JSON.stringify({
      version: 1,
      credential: {
        accessToken: 'own-tok',
        userId: 'u',
        expiresAtMs: FUTURE_EXPIRY,
        variant: 'cn',
        source: 'accessmux',
      },
    }));
    // desktop 存在 → 以 desktop 为准（最权威）
    const cred = await store.resolve();
    expect(cred.accessToken).toBe('desktop-tok');
    expect(cred.source).toBe('desktop');
  });

  it('desktop 缺失时 own copy 顶替（带回退路径）', async () => {
    const store = makeStore(fs, { desktopPath: '/missing' });
    const ownPath = store.ownAuthPath();
    fs.files.set(ownPath, JSON.stringify({
      version: 1,
      credential: {
        accessToken: 'own-tok',
        userId: 'u',
        expiresAtMs: FUTURE_EXPIRY,
        variant: 'cn',
        source: 'accessmux',
      },
    }));
    const cred = await store.resolve();
    expect(cred.accessToken).toBe('own-tok');
    expect(cred.source).toBe('accessmux');
  });

  it('logout 清 own copy 不动 desktop', async () => {
    const store = makeStore(fs, { desktopPath: '/auth/info' });
    fs.files.set('/auth/info', buildDesktopFile({ uid: 'u', accessToken: 'tok' }));
    const ownPath = store.ownAuthPath();
    fs.files.set(ownPath, JSON.stringify({ version: 1, credential: { accessToken: 'own', userId: 'own-u', expiresAtMs: 0, variant: 'cn', source: 'accessmux' } }));
    await store.logout();
    expect(fs.files.has(ownPath)).toBe(false);
    expect(fs.files.has('/auth/info')).toBe(true);
  });
});

describe('T031 B03/B04/B05/R04 WorkBuddy real filesystem regression', () => {
  function fixture() {
    const base = mkdtempSync(join(realpathSync(tmpdir()), 'accessmux-wb-fixes-'));
    const desktop = join(base, 'desktop.info'); const own = join(base, 'private', 'auth');
    mkdirSync(join(base, 'private'), { mode: 0o755 });
    writeFileSync(desktop, buildDesktopFile({ uid: 'user-a', accessToken: 'old-short-token', refreshToken: 'old-short-refresh', expiresAt: Date.now() - 1 }));
    let resets = 0; let refreshes = 0;
    const provider = { resolveAtRestSecretKey: async () => ({ version: 1, atRestSecretKey: AT_REST_KEY }), resetCache: () => { resets++; } };
    const store = new WorkBuddyCredentialStore({ desktopPath: desktop, ownPath: own, keyProvider: provider, refresh: async (c) => {
      refreshes++; expect(c.refreshToken).toBe(refreshes === 1 ? 'old-short-refresh' : 'rotated-refresh');
      return { accessToken: `fresh-${refreshes}`, refreshToken: 'rotated-refresh', expiresAtMs: FUTURE_EXPIRY };
    } });
    return { base, desktop, own, store, resets: () => resets, refreshes: () => refreshes };
  }
  it('unchanged expired desktop reuses fresh same-account own copy, rotated refresh and private modes', async () => {
    const f = fixture();
    try {
      writeFileSync(f.own, 'stale', { mode: 0o644 }); chmodSync(join(f.base, 'private'), 0o755);
      await Promise.all([f.store.resolve(), f.store.resolve()]);
      expect((await f.store.resolve()).accessToken).toBe('fresh-1'); expect(f.refreshes()).toBe(1);
      expect(statSync(f.own).mode & 0o777).toBe(0o600); expect(statSync(join(f.base, 'private')).mode & 0o777).toBe(0o700);
      const own = JSON.parse(readFileSync(f.own, 'utf8')); own.credential.expiresAtMs = Date.now() - 1; writeFileSync(f.own, JSON.stringify(own));
      expect((await f.store.resolve()).accessToken).toBe('fresh-2');
      writeFileSync(f.desktop, buildDesktopFile({ uid: 'user-b', accessToken: 'other-account', expiresAt: FUTURE_EXPIRY + 1000 }));
      expect((await f.store.resolve()).userId).toBe('user-b');
      f.store.selectAccount(workBuddyAccountId({ variant: 'cn', userId: 'user-a' })); rmSync(f.own);
      expect(await f.store.current()).toBeUndefined();
      await f.store.logout(); expect(f.resets()).toBe(1);
    } finally { f.store.dispose(); rmSync(f.base, { recursive: true, force: true }); }
  });
  it('shared active shim reads refreshed tokens and rejects different account, dispose clears key cache', async () => {
    const f = fixture(); const seen: string[] = [];
    const adapter = new WorkBuddyAdapter({ credentialStore: f.store, resolveClientVersion: async () => '9.9.9', fetchImpl: (async (_url, init) => {
      const headers = init!.headers as Record<string, string>; seen.push(headers['Authorization'] ?? headers['authorization'] ?? headers['X-Access-Token'] ?? '');
      return new Response('data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n');
    }) as typeof fetch });
    const session = await adapter.launch({ localSecret: 'unused' });
    const input = { model: 'm', messages: [{ role: 'user' as const, content: 'hello' }], stream: true };
    try {
      for await (const c of session.runTurn(input)) { if (c.done) break; }
      const own = JSON.parse(readFileSync(f.own, 'utf8')); own.credential.expiresAtMs = Date.now() - 1; writeFileSync(f.own, JSON.stringify(own));
      for await (const c of session.runTurn(input)) { if (c.done) break; }
      expect(seen.join(' ')).toContain('fresh-1'); expect(seen.join(' ')).toContain('fresh-2');
      writeFileSync(f.desktop, buildDesktopFile({ uid: 'user-b', accessToken: 'different-account', expiresAt: FUTURE_EXPIRY + 1000 }));
      await expect((async () => { for await (const _c of session.runTurn(input)) {} })()).rejects.toThrow();
      expect(seen).toHaveLength(2);
    } finally { await session.cancel(); await adapter.dispose(); expect(f.resets()).toBe(1); rmSync(f.base, { recursive: true, force: true }); }
  });
  it.each(['http', 'transport'])('%s errors redact short exact current token and refresh', async (failure) => {
    const f = fixture();
    const adapter = new WorkBuddyAdapter({ credentialStore: f.store, resolveClientVersion: async () => '9.9.9', fetchImpl: (async () => {
      if (failure === 'transport') throw new Error('fresh-1 rotated-refresh');
      return new Response('fresh-1 rotated-refresh', { status: 401 });
    }) as typeof fetch });
    const session = await adapter.launch({ localSecret: 'unused' });
    let error = '';
    try { for await (const _c of session.runTurn({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true })) {} } catch (e) { error = String(e); }
    finally { await session.cancel(); await adapter.dispose(); rmSync(f.base, { recursive: true, force: true }); }
    expect(error).not.toBe(''); expect(error).not.toContain('fresh-1'); expect(error).not.toContain('rotated-refresh');
  });
});


it('T031 logout while refresh is pending cannot recreate own-copy', async () => {
  const fs = buildMemoryFs(); let finish!: (value: { accessToken: string; expiresAtMs: number }) => void;
  let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; });
  const store = makeStore(fs, { desktopPath: '/synthetic/info', refresh: async () => { started(); return new Promise((resolve) => { finish = resolve; }); } });
  fs.files.set('/synthetic/info', buildDesktopFile({ uid: 'u', accessToken: 'old', refreshToken: 'rt', expiresAt: Date.now() - 1 }));
  const pending = store.resolve(); const failed = expect(pending).rejects.toThrow(/reset/);
  await ready; await store.logout(); finish({ accessToken: 'new-synthetic', expiresAtMs: FUTURE_EXPIRY }); await failed;
  expect(fs.files.has(store.ownAuthPath())).toBe(false);
});

it('T031 catalog transport/errors do not expose short exact current secrets', async () => {
  const fs = buildMemoryFs(); fs.files.set('/synthetic/info', buildDesktopFile({ uid: 'u', accessToken: 'short-access', refreshToken: 'short-refresh' }));
  const adapter = new WorkBuddyAdapter({ credentialStore: makeStore(fs, { desktopPath: '/synthetic/info' }), fetchImpl: (async () => new Response('short-access short-refresh', { status: 500 })) as typeof fetch });
  const error = await adapter.refreshCatalog().catch(String); expect(error).not.toContain('short-access'); expect(error).not.toContain('short-refresh');
  await adapter.dispose();
});
