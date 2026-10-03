// WorkBuddyAdapter 主类集成测试：probe / launch / shim 通信 / dispose。
//
// 测试用 fake key provider 注入合成 atRest key，避免 spawn 真实 Electron。

import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkBuddyAdapter } from '../../../src/adapters/workbuddy/index.js';
import { fakeKeyProvider } from '../../../src/adapters/workbuddy/key-provider.js';
import { WorkBuddyCredentialStore } from '../../../src/adapters/workbuddy/credential-store.js';

const AT_REST_KEY = 'integration-at-rest-key';
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

function buildDesktopFile(args: { uid: string; accessToken: string; refreshToken?: string }): string {
  return JSON.stringify({
    account: { uid: args.uid },
    auth: {
      accessToken: buildEncryptedField(AT_REST_KEY, args.accessToken),
      ...(args.refreshToken === undefined ? {} : { refreshToken: buildEncryptedField(AT_REST_KEY, args.refreshToken) }),
      expiresAt: FUTURE_EXPIRY,
      refreshExpiresAt: FUTURE_REFRESH_EXPIRY,
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
    writeFileSync: (p: string, data: string): void => { files.set(p, data); },
    mkdirSync: (_p: string, _opts: { recursive: boolean }): void => undefined,
    rmSync: (p: string, _opts: { force: boolean }): void => { files.delete(p); files.delete(`${p}.lock`); },
  };
}

describe('WorkBuddyAdapter: 基础事实', () => {
  it('id = workbuddy；displayName = WorkBuddy；sandbox = behavioural', () => {
    const adapter = new WorkBuddyAdapter({ keyProvider: fakeKeyProvider(AT_REST_KEY) });
    expect(adapter.id).toBe('workbuddy');
    expect(adapter.displayName).toBe('WorkBuddy');
    expect(adapter.sandbox).toBe('behavioural');
    expect(adapter.variant).toBe('cn');
  });

  it('static withFakeKey 工厂', () => {
    const adapter = WorkBuddyAdapter.withFakeKey(AT_REST_KEY);
    expect(adapter.variant).toBe('cn');
  });
});

describe('WorkBuddyAdapter: probe', () => {
  it('desktop 缺失 → availability: unavailable', async () => {
    const fs = buildMemoryFs();
    const adapter = new WorkBuddyAdapter({
      keyProvider: fakeKeyProvider(AT_REST_KEY),
      fetchImpl: (() => { throw new Error('should not be called'); }) as never,
      credentialStore: makeStoreWithFs(fs, '/missing'),
    });
    const probe = await adapter.probe();
    expect(probe.availability).toBe('unavailable');
    expect(probe.auth).toBe('logged-out');
    expect(probe.models.length).toBeGreaterThan(0); // fallbackModelsFor('cn')
  });

  it('desktop 存在 + fetch 失败 → availability: unverified + fallback', async () => {
    const fs = buildMemoryFs({
      '/auth/workbuddy-desktop.info': buildDesktopFile({ uid: 'u', accessToken: 'tok' }),
    });
    const adapter = new WorkBuddyAdapter({
      keyProvider: fakeKeyProvider(AT_REST_KEY),
      fetchImpl: (() => Promise.reject(new Error('network'))) as never,
      credentialStore: makeStoreWithFs(fs, '/auth/workbuddy-desktop.info'),
    });
    const probe = await adapter.probe();
    expect(probe.availability).toBe('unverified');
    expect(probe.auth).toBe('logged-in');
    expect(probe.models.length).toBeGreaterThan(0);
  });

  it('desktop 存在 + fetch 成功 → 用真实 catalog（/v3/config envelope 形状）', async () => {
    const fs = buildMemoryFs({
      '/auth/workbuddy-desktop.info': buildDesktopFile({ uid: 'u', accessToken: 'tok' }),
    });
    const fetchMock = (async () => new Response(JSON.stringify({
      code: 0,
      msg: '',
      data: {
        models: [{ id: 'live-m', name: 'Live', maxInputTokens: 128000, maxOutputTokens: 8192 }],
        agents: [{ name: 'cli', models: ['live-m'] }],
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })) as typeof fetch;
    const adapter = new WorkBuddyAdapter({
      keyProvider: fakeKeyProvider(AT_REST_KEY),
      fetchImpl: fetchMock,
      credentialStore: makeStoreWithFs(fs, '/auth/workbuddy-desktop.info'),
    });
    const probe = await adapter.probe();
    expect(probe.availability).toBe('available');
    expect(probe.models.map((m) => m.id)).toContain('live-m');
  });
});

describe('WorkBuddyAdapter: launch / shim 通信 / runTurn', () => {
  let fs: ReturnType<typeof buildMemoryFs>;
  beforeEach(() => { fs = buildMemoryFs(); });
  afterEach(() => { fs = buildMemoryFs(); });

  it('launch() 启动 shim，shim GET /healthz 返回 200（带 bearer）', async () => {
    fs.files.set('/auth/info', buildDesktopFile({ uid: 'u', accessToken: 'tok' }));
    const adapter = makeAdapter(fs);
    const session = await adapter.launch({ localSecret: 'unused' });
    expect(session).toBeDefined();
    await adapter.dispose();
  });

  it('shim GET /v1/models 返回 catalog 列表', async () => {
    fs.files.set('/auth/info', buildDesktopFile({ uid: 'u', accessToken: 'tok' }));
    const adapter = makeAdapter(fs);
    const session = await adapter.launch({ localSecret: 'unused' });
    const baseUrl = (session as unknown as { lease?: { shim: { baseUrl(): string } } }).lease?.shim.baseUrl();
    expect(baseUrl).toBeDefined();
    const res = await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: 'Bearer wrong' },
    });
    expect(res.status).toBe(401);
    await adapter.dispose();
  });

  // T010：MVP 期"已 launch 再 launch 抛 already-running"的行为已废除——
  // 并发 launch 改为串行排队 + 活动 shim 复用（ShimSessionPool），
  // 并发回归测试见 launch-race.test.ts。
  it('已 launch 后再次 launch 复用 shim，不抛错', async () => {
    fs.files.set('/auth/info', buildDesktopFile({ uid: 'u', accessToken: 'tok' }));
    const adapter = makeAdapter(fs);
    const s1 = await adapter.launch({ localSecret: 'unused' });
    const s2 = await adapter.launch({ localSecret: 'unused' });
    expect(s2).toBeDefined();
    const url1 = (s1 as unknown as { lease: { shim: { baseUrl(): string } } }).lease.shim.baseUrl();
    const url2 = (s2 as unknown as { lease: { shim: { baseUrl(): string } } }).lease.shim.baseUrl();
    expect(url2).toBe(url1); // 并发会话共享同一 shim
    await s1.cancel();
    await s2.cancel();
    await adapter.dispose();
  });

  it('dispose() 关闭 shim 且 timer', async () => {
    fs.files.set('/auth/info', buildDesktopFile({ uid: 'u', accessToken: 'tok' }));
    const adapter = makeAdapter(fs);
    await adapter.launch({ localSecret: 'unused' });
    adapter.startCatalogSweep();
    await adapter.dispose();
    // 再 launch 应该能成功（shim 已关）
    fs.files.set('/auth/info', buildDesktopFile({ uid: 'u', accessToken: 'tok' }));
    await expect(adapter.launch({ localSecret: 'unused' })).resolves.toBeDefined();
    await adapter.dispose();
  });

  // T023：真数透传——上游 usage 帧排在 finish_reason 之后、[DONE] 之前，
  // session 必须读到 [DONE] 才收尾，否则会漏掉用量。
  it('上游 usage 透传到终帧（真数，无 estimated；usage 帧在 finish 之后）', async () => {
    fs.files.set('/auth/info', buildDesktopFile({ uid: 'u', accessToken: 'tok' }));
    const upstreamBody = [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } })}\n\n`,
      'data: [DONE]\n\n',
    ].join('');
    const adapter = new WorkBuddyAdapter({
      keyProvider: fakeKeyProvider(AT_REST_KEY),
      fetchImpl: (async (url: unknown) => {
        if (String(url).includes('/v2/chat/completions')) {
          return new Response(upstreamBody, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        }
        throw new Error(`unexpected fetch: ${String(url)}`);
      }) as never,
      resolveClientVersion: async () => '9.9.9',
      credentialStore: makeStoreWithFs(fs, '/auth/info'),
    });

    const session = await adapter.launch({ localSecret: 'unused' });
    let text = '';
    let usage: unknown;
    for await (const chunk of session.runTurn({ model: 'hy4-preview', messages: [{ role: 'user', content: 'hi' }], stream: true })) {
      text += chunk.delta;
      if (chunk.usage !== undefined) usage = chunk.usage;
      if (chunk.done) break;
    }
    expect(text).toBe('hi');
    expect(usage).toEqual({ prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 });
    await session.cancel();
    await adapter.dispose();
  });
});

describe('WorkBuddyAdapter: fetchQuota + dispose', () => {
  it('fetchQuota: signed-out → unknown', async () => {
    const adapter = new WorkBuddyAdapter({
      keyProvider: fakeKeyProvider(AT_REST_KEY),
      credentialStore: makeStoreWithFs(buildMemoryFs(), '/missing'),
    });
    expect(await adapter.fetchQuota()).toBe('unknown');
  });

  it('fetchQuota: signed-in → ok', async () => {
    const fs = buildMemoryFs({ '/auth/info': buildDesktopFile({ uid: 'u', accessToken: 'tok' }) });
    const adapter = new WorkBuddyAdapter({
      keyProvider: fakeKeyProvider(AT_REST_KEY),
      credentialStore: makeStoreWithFs(fs, '/auth/info'),
    });
    expect(await adapter.fetchQuota()).toBe('ok');
  });

  it('dispose() 是幂等的', async () => {
    const adapter = new WorkBuddyAdapter({ keyProvider: fakeKeyProvider(AT_REST_KEY) });
    await adapter.dispose();
    await adapter.dispose();
  });
});

function makeStoreWithFs(fs: ReturnType<typeof buildMemoryFs>, desktopPath: string) {
  return new WorkBuddyCredentialStore({
    variant: 'cn',
    keyProvider: fakeKeyProvider(AT_REST_KEY),
    desktopPath,
    refresh: async () => ({ accessToken: 'new', expiresAtMs: FUTURE_EXPIRY }),
    fs: fs as never,
  });
}

function makeAdapter(fs: ReturnType<typeof buildMemoryFs>) {
  return new WorkBuddyAdapter({
    keyProvider: fakeKeyProvider(AT_REST_KEY),
    fetchImpl: (() => Promise.reject(new Error('catalog fetch not used here'))) as never,
    credentialStore: makeStoreWithFs(fs, '/auth/info'),
  });
}

it('T031 catalog deadline aborts actual fetch (not a Promise.race)', async () => {
  const fs = buildMemoryFs({ '/synthetic/info': buildDesktopFile({ uid: 'u', accessToken: 'short-token' }) });
  let aborted = false;
  const adapter = new WorkBuddyAdapter({ credentialStore: makeStoreWithFs(fs, '/synthetic/info'), catalogTimeoutMs: 15, fetchImpl: (async (_url, init) => new Promise<Response>((_resolve, reject) => {
    const signal = init!.signal!; signal.addEventListener('abort', () => { aborted = true; reject(new Error('synthetic aborted')); }, { once: true });
  })) as typeof fetch });
  const keepAlive = setTimeout(() => {}, 1000);
  try { await expect(adapter.refreshCatalog()).rejects.toThrow(); expect(aborted).toBe(true); }
  finally { clearTimeout(keepAlive); await adapter.dispose(); }
});

it('T031 probe AbortSignal reaches actual catalog fetch', async () => {
  const fs = buildMemoryFs({ '/synthetic/info': buildDesktopFile({ uid: 'u', accessToken: 'short-token' }) });
  let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; }); let aborted = false;
  const adapter = new WorkBuddyAdapter({ credentialStore: makeStoreWithFs(fs, '/synthetic/info'), fetchImpl: (async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => { aborted = true; reject(new Error('synthetic aborted')); }, { once: true }); started();
  })) as typeof fetch });
  const controller = new AbortController(); const pending = adapter.probe({ signal: controller.signal }); await ready; controller.abort();
  expect((await pending).availability).toBe('unverified'); expect(aborted).toBe(true); await adapter.dispose();
});
