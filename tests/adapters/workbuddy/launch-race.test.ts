// T010 竞态回归测试：shim 启动竞态（launch 并发撞 "already running"）。
//
// 复现的原始缺陷（ZCode turn_usage 实证）：模型选择器滚动触发的探测/刷新与
// 聊天请求并发到达 daemon → workbuddy adapter 的 launch 守卫抛
// "shim is already running" → 500 → 宿主判非重试失败（ttft 空、零重试）。
//
// 修复语义（ShimSessionPool）：
// - 并发 launch 串行排队，活动 shim 被复用（引用计数），不抛 already-running；
// - 最后一个会话 cancel 才异步关 shim；关期内新 launch 等关完再建；
// - cancel 只断本 session 的连接，不杀并发会话共享的 shim。
//
// 全部离线：fake atRest key + 内存 FS + 假上游 SSE，不 spawn、不联网。

import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkBuddyAdapter } from '../../../src/adapters/workbuddy/index.js';
import { fakeKeyProvider } from '../../../src/adapters/workbuddy/key-provider.js';
import { WorkBuddyCredentialStore } from '../../../src/adapters/workbuddy/credential-store.js';
import type { ChatCompletionChunk } from '../../../src/types.js';

const AT_REST_KEY = 'race-test-at-rest-key';
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

function buildDesktopFile(uid: string, accessToken: string): string {
  return JSON.stringify({
    account: { uid },
    auth: {
      accessToken: buildEncryptedField(AT_REST_KEY, accessToken),
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

/** 假上游 catalog（/v3/config 形状，对齐 parse-catalog 的 envelope）。 */
function catalogResponse(): Response {
  return new Response(JSON.stringify({
    code: 0,
    msg: '',
    data: {
      models: [{ id: 'hy4-preview', name: 'HY4', maxInputTokens: 128000, maxOutputTokens: 8192 }],
      agents: [{ name: 'cli', models: ['hy4-preview'] }],
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/** 假上游 chat SSE：吐 OpenAI 形状的 chunk（shim 透传给 adapter 的就是上游 body）。 */
function sseResponse(chunks: string[], delayMs = 0): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const c of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: 'chatcmpl-fake', choices: [{ index: 0, delta: { content: c } }] })}\n\n`));
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

interface FakeUpstreamOptions {
  /** 每个请求吐的 delta 内容（默认 ['A']） */
  chunks?: string[];
  /** 每帧之间的延迟，模拟真实回合时长 */
  delayMs?: number;
}

function makeAdapter(fs: ReturnType<typeof buildMemoryFs>, opts: FakeUpstreamOptions = {}) {
  const chunks = opts.chunks ?? ['A'];
  const delayMs = opts.delayMs ?? 0;
  let chatCalls = 0;
  const fetchMock = (async (input: unknown, _init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/v3/config')) return catalogResponse();
    if (url.includes('/v2/chat/completions')) {
      chatCalls += 1;
      return sseResponse(chunks, delayMs);
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  const adapter = new WorkBuddyAdapter({
    keyProvider: fakeKeyProvider(AT_REST_KEY),
    fetchImpl: fetchMock,
    resolveClientVersion: async () => '9.9.9',
    credentialStore: new WorkBuddyCredentialStore({
      variant: 'cn',
      keyProvider: fakeKeyProvider(AT_REST_KEY),
      desktopPath: '/auth/info',
      refresh: async () => ({ accessToken: 'new', expiresAtMs: FUTURE_EXPIRY }),
      fs: fs as never,
    }),
  });
  return { adapter, chatCalls: () => chatCalls };
}

async function runTurnCollect(session: { runTurn(i: unknown): AsyncIterable<ChatCompletionChunk> }): Promise<string> {
  let out = '';
  for await (const chunk of session.runTurn({ model: 'hy4-preview', messages: [{ role: 'user', content: 'hi' }], stream: true })) {
    out += chunk.delta;
    if (chunk.done) break;
  }
  return out;
}

function leaseShimUrl(session: unknown): string {
  return (session as unknown as { lease: { shim: { baseUrl(): string } } }).lease.shim.baseUrl();
}

const adapters: WorkBuddyAdapter[] = [];
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((a) => a.dispose().catch(() => undefined)));
});

describe('T010 竞态：并发 launch 不再抛 already-running', () => {
  it('6 个并发 launch 全部成功且共享同一 shim（旧码此处 5 个会抛 already running）', async () => {
    const fs = buildMemoryFs({ '/auth/info': buildDesktopFile('u', 'tok') });
    const { adapter } = makeAdapter(fs);
    adapters.push(adapter);
    const sessions = await Promise.all(
      Array.from({ length: 6 }, () => adapter.launch({ localSecret: 'x' })),
    );
    const urls = new Set(sessions.map((s) => leaseShimUrl(s)));
    expect(urls.size).toBe(1);
    for (const s of sessions) await s.cancel();
    // 全部归还后池子回到干净态，可无缝再 launch
    const again = await adapter.launch({ localSecret: 'x' });
    await again.cancel();
  });

  it('两个并发会话各跑完整 turn，内容互不串扰，串行完成', async () => {
    const fs = buildMemoryFs({ '/auth/info': buildDesktopFile('u', 'tok') });
    const { adapter, chatCalls } = makeAdapter(fs, { chunks: ['你', '好'], delayMs: 5 });
    adapters.push(adapter);
    const [s1, s2] = await Promise.all([adapter.launch({ localSecret: 'x' }), adapter.launch({ localSecret: 'x' })]);
    const sharedUrl = leaseShimUrl(s1); // 提前取：cancel 后旧 shim 关闭，baseUrl 会抛
    const [t1, t2] = await Promise.all([runTurnCollect(s1), runTurnCollect(s2)]);
    expect(t1).toBe('你好');
    expect(t2).toBe('你好');
    expect(chatCalls()).toBe(2);
    await s1.cancel();
    await s2.cancel();
    // 共享 shim 在最后一个 cancel 后关闭；下一次 launch 拿到新 shim
    const s3 = await adapter.launch({ localSecret: 'x' });
    expect(leaseShimUrl(s3)).not.toBe(sharedUrl);
    const t3 = await runTurnCollect(s3);
    expect(t3).toBe('你好');
    await s3.cancel();
  });

  it('cancel 与下一次 launch 撞关闭窗口：不抛错、不拿到死 shim', async () => {
    const fs = buildMemoryFs({ '/auth/info': buildDesktopFile('u', 'tok') });
    const { adapter } = makeAdapter(fs);
    adapters.push(adapter);
    for (let i = 0; i < 8; i += 1) {
      const s = await adapter.launch({ localSecret: 'x' });
      const turn = runTurnCollect(s);
      const cancelPromise = s.cancel(); // 不 await：与下一次 launch 制造并发窗口
      const s2 = await adapter.launch({ localSecret: 'x' }); // 旧码在此抛 already running
      expect(leaseShimUrl(s2)).toBeDefined();
      await turn.catch(() => ''); // 中途 cancel 的 turn 允许失败/截断
      await s2.cancel();
      await cancelPromise;
    }
  });

  it('模型选择器场景：turn 进行中并发 probe/refreshCatalog/launch 不抛错', async () => {
    const fs = buildMemoryFs({ '/auth/info': buildDesktopFile('u', 'tok') });
    const { adapter } = makeAdapter(fs, { chunks: ['x', 'y'], delayMs: 10 });
    adapters.push(adapter);
    const main = await adapter.launch({ localSecret: 'x' });
    const mainTurn = runTurnCollect(main);
    // 模拟宿主翻模型选择器：探测 + 目录刷新并发砸过来
    const noise = await Promise.all([
      adapter.probe(),
      adapter.refreshCatalog(),
      adapter.probe(),
      adapter.launch({ localSecret: 'x' }).then(async (s) => {
        const text = await runTurnCollect(s);
        await s.cancel();
        return text;
      }),
      adapter.refreshCatalog(),
    ]);
    expect(noise[0].auth).toBe('logged-in');
    expect(await mainTurn).toBe('xy');
    await main.cancel();
    // 风暴过后再来一个正常回合
    const s = await adapter.launch({ localSecret: 'x' });
    expect(await runTurnCollect(s)).toBe('xy');
    await s.cancel();
  });

  it('中途 cancel：上游 fetch 被 abort，shim 不被整个杀掉（并发会话不受影响）', async () => {
    const fs = buildMemoryFs({ '/auth/info': buildDesktopFile('u', 'tok') });
    const { adapter } = makeAdapter(fs, { chunks: ['1', '2', '3', '4', '5', '6'], delayMs: 30 });
    adapters.push(adapter);
    const [sa, sb] = await Promise.all([adapter.launch({ localSecret: 'x' }), adapter.launch({ localSecret: 'x' })]);
    const turnA = runTurnCollect(sa);
    await new Promise((r) => setTimeout(r, 45)); // A 拿到第一帧后
    await sa.cancel();
    const a = await turnA.catch(() => '<aborted>');
    expect(a === '<aborted>' || a.length < 6).toBe(true); // A 被截断
    const b = await runTurnCollect(sb); // B 走同一 shim，不受影响
    expect(b).toBe('123456');
    await sb.cancel();
  });
});
