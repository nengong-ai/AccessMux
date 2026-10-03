import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TraeCredentialStore, traeAccountId, type TraeCredential } from '../../../src/adapters/trae/credential-store.js';
import { TraeAdapter } from '../../../src/adapters/trae/index.js';
import { readTraeCliIdentity, readTraeIdentity, resolveTraeIdentity } from '../../../src/adapters/trae/identity.js';
import { buildTraeHeaders } from '../../../src/adapters/trae/headers.js';
import { refreshTraeCredential } from '../../../src/adapters/trae/refresh.js';

const roots: string[] = [];
function root(): string { const p = mkdtempSync(join(realpathSync(tmpdir()), 'accessmux-trae-fixes-')); roots.push(p); return p; }
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });
function fixture() {
  const base = root(); const desktop = join(base, 'desktop', 'storage.json'); const own = join(base, 'private', 'auth');
  mkdirSync(join(base, 'desktop')); mkdirSync(join(base, 'private'), { mode: 0o755 });
  let refreshes = 0;
  const credential: TraeCredential = { accessToken: 'old-short-token', refreshToken: 'old-short-refresh', userId: 'user-a', host: 'https://synthetic.invalid', edition: 'cn', source: 'desktop', userRegion: 'CN', expiresAtMs: Date.now() - 1000 };
  const setDesktop = (c: TraeCredential) => writeFileSync(desktop, JSON.stringify({ 'iCubeAuthInfo://icube.cloudide': JSON.stringify({ token: c.accessToken, refreshToken: c.refreshToken, userId: c.userId, host: c.host, userRegion: c.userRegion, expiredAt: c.expiresAtMs }), 'telemetry.machineId': 'official-machine', 'telemetry.devDeviceId': 'official-device' }));
  setDesktop(credential);
  const store = new TraeCredentialStore({ region: 'cn', edition: 'cn', ownPath: own, legacyOwnPath: join(base, 'absent-legacy'), refresh: async (c) => { refreshes++; expect(c.refreshToken).toBe(refreshes === 1 ? 'old-short-refresh' : 'rotated-refresh'); return { accessToken: `fresh-${refreshes}`, refreshToken: 'rotated-refresh', expiresAtMs: Date.now() + 3600_000 }; } });
  store.setSource(desktop, 'cn');
  return { base, desktop, own, credential, setDesktop, store, refreshes: () => refreshes };
}

describe('B05/R04 Trae real-FS credential refresh', () => {
  it('reuses rotated same-account own copy despite unchanged expired desktop, tightens existing modes', async () => {
    const f = fixture(); writeFileSync(f.own, 'stale', { mode: 0o644 }); chmodSync(join(f.base, 'private'), 0o755);
    const [a, b] = await Promise.all([f.store.resolve(), f.store.resolve()]);
    expect(a.accessToken).toBe('fresh-1'); expect(b.accessToken).toBe('fresh-1');
    expect((await f.store.resolve()).refreshToken).toBe('rotated-refresh'); expect(f.refreshes()).toBe(1);
    expect(statSync(f.own).mode & 0o777).toBe(0o600); expect(statSync(join(f.base, 'private')).mode & 0o777).toBe(0o700);
    const own = JSON.parse(readFileSync(f.own, 'utf8')); own.credential.expiresAtMs = Date.now() - 1; writeFileSync(f.own, JSON.stringify(own));
    expect((await f.store.resolve()).accessToken).toBe('fresh-2'); expect(f.refreshes()).toBe(2);
  });
  it('desktop switches account: do not prefer fresher arbitrary own copy or fallback if selected account disappears', async () => {
    const f = fixture(); await f.store.resolve();
    f.setDesktop({ ...f.credential, userId: 'user-b', accessToken: 'other-account', expiresAtMs: Date.now() + 7200_000 });
    expect((await f.store.resolve()).userId).toBe('user-b');
    f.store.selectAccount(traeAccountId(f.credential)); rmSync(f.own);
    expect(await f.store.current()).toBeUndefined();
  });
  it('activity on shared shim resolves newly refreshed token, rejects account switch', async () => {
    const f = fixture(); const seen: string[] = [];
    const adapter = new TraeAdapter('cn', { credentialStore: f.store, identityResolver: async () => ({ edition: 'cn', machineId: 'official-machine', deviceId: 'official-device', platform: 'darwin' }), fetchImpl: (async (_url, init) => {
      seen.push((init!.headers as Record<string, string>)['X-Ide-Token']!);
      return new Response('event: output\ndata: {"response":"OK"}\n\nevent: done\ndata: {}\n\n');
    }) as typeof fetch });
    const session = await adapter.launch({ localSecret: 'unused' });
    const input = { model: 'm', messages: [{ role: 'user' as const, content: 'hello' }], stream: true };
    try {
      for await (const c of session.runTurn(input)) { if (c.done) break; }
      const own = JSON.parse(readFileSync(f.own, 'utf8')); own.credential.expiresAtMs = Date.now() - 1; writeFileSync(f.own, JSON.stringify(own));
      for await (const c of session.runTurn(input)) { if (c.done) break; }
      expect(seen).toEqual(['fresh-1', 'fresh-2']);
      f.setDesktop({ ...f.credential, userId: 'user-b', expiresAtMs: Date.now() + 7200_000 });
      await expect((async () => { for await (const _c of session.runTurn(input)) {} })()).rejects.toThrow();
      expect(seen).toHaveLength(2);
    } finally { await session.cancel(); await adapter.dispose(); }
  });
});

describe('B06 no synthetic Trae identity', () => {
  it('empty CLI home with USER/HOSTNAME, even persisted crash reporter, remains unavailable', async () => {
    const home = root(); const options = { home, platform: 'linux' as const, env: { USER: 'synthetic-user', HOSTNAME: 'synthetic-host' } };
    await expect(readTraeCliIdentity('cn', options)).rejects.toThrow(/identity unavailable/);
    mkdirSync(join(home, '.trae-cn')); writeFileSync(join(home, '.trae-cn', 'argv.json'), '{"crash-reporter-id":"official-crash-id"}');
    await expect(resolveTraeIdentity([], 'cn', options)).rejects.toThrow(/identity unavailable/);
  });
  it('machineId without official deviceId cannot produce headers; complete fields retain existing replay', async () => {
    const home = root(); const path = join(home, 'storage.json'); const candidate = { edition: 'cn' as const, source: 'desktop' as const, path };
    writeFileSync(path, '{"telemetry.machineId":"official-machine"}');
    await expect(readTraeIdentity(candidate, { home, platform: 'linux' })).rejects.toThrow(/identity unavailable/);
    writeFileSync(path, '{"telemetry.machineId":"official-machine","telemetry.devDeviceId":"official-device"}');
    const identity = await readTraeIdentity(candidate, { home, platform: 'linux' });
    expect(buildTraeHeaders({ accessToken: 'synthetic', userId: 'u' }, identity)).toMatchObject({ 'x-machine-id': 'official-machine', 'x-device-id': 'official-device' });
    expect(() => buildTraeHeaders({ accessToken: 'synthetic', userId: 'u' }, { ...identity, deviceId: '' })).toThrow(/identity unavailable/);
  });
  it('probe missing official identity returns unavailable without upstream requests', async () => {
    const f = fixture(); let calls = 0;
    const adapter = new TraeAdapter('cn', { credentialStore: f.store, identityResolver: async () => { throw new Error('Trae official device identity unavailable'); }, fetchImpl: (async () => { calls++; throw new Error('must not fetch'); }) as typeof fetch });
    expect((await adapter.probe()).availability).toBe('unavailable'); expect(calls).toBe(0); await adapter.dispose();
  });
});

describe('B04 Trae short secret errors', () => {
  it.each(['http', 'transport'])('%s failure removes exact access/refresh values', async (failure) => {
    const f = fixture(); const secrets = ['fresh-1', 'rotated-refresh'];
    const adapter = new TraeAdapter('cn', { credentialStore: f.store, identityResolver: async () => ({ edition: 'cn', machineId: 'official-machine', deviceId: 'official-device', platform: 'darwin' }), fetchImpl: (async () => {
      const text = secrets.join(' '); if (failure === 'transport') throw new Error(text);
      return new Response(text, { status: 401 });
    }) as typeof fetch });
    const session = await adapter.launch({ localSecret: 'unused' });
    let error = '';
    try { for await (const _c of session.runTurn({ model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true })) {} } catch (e) { error = String(e); }
    finally { await session.cancel(); await adapter.dispose(); }
    expect(error).not.toBe(''); for (const secret of secrets) expect(error).not.toContain(secret);
  });
  it('direct refresh JSON/transport errors do not echo current credentials', async () => {
    const f = fixture();
    await expect(refreshTraeCredential(f.credential, (async () => { throw new Error(`${f.credential.accessToken} ${f.credential.refreshToken}`); }) as typeof fetch)).rejects.toThrow('<redacted>');
  });
});


it('R04/B03 logout while refresh is pending cannot recreate removed own-copy', async () => {
  const f = fixture();
  let finish!: (value: { accessToken: string; expiresAtMs: number }) => void;
  let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; });
  const store = new TraeCredentialStore({ region: 'cn', edition: 'cn', ownPath: f.own, refresh: async () => { started(); return new Promise((resolve) => { finish = resolve; }); } });
  store.setSource(f.desktop, 'cn');
  const pending = store.resolve(); const failed = expect(pending).rejects.toThrow(/reset/);
  await ready; await store.logout(); finish({ accessToken: 'pending-secret', expiresAtMs: Date.now() + 3600_000 });
  await failed; expect(() => statSync(f.own)).toThrow();
});

it('B04 current access/refresh redacted from response reader errors and remote directory errors', async () => {
  const f = fixture(); const credential = await f.store.resolve();
  const { TraeRemoteCatalogClient } = await import('../../../src/adapters/trae/remote-catalog.js');
  const client = new TraeRemoteCatalogClient({ credential: async () => credential, fetchImpl: (async () => { throw new Error('fresh-1 rotated-refresh'); }) as typeof fetch });
  const error = await client.fetchModels().catch(String); expect(error).not.toContain('fresh-1'); expect(error).not.toContain('rotated-refresh');
});


it('T031 Trae catalog deadline aborts both actual directory sources', async () => {
  const f = fixture(); let aborted = 0; let starts = 0;
  const adapter = new TraeAdapter('cn', { credentialStore: f.store, catalogTimeoutMs: 15, identityResolver: async () => ({ edition: 'cn', machineId: 'official-machine', deviceId: 'official-device', platform: 'darwin' }), fetchImpl: (async (_url, init) => new Promise<Response>((_resolve, reject) => {
    starts++; const signal = init!.signal!;
    const abort = () => { aborted++; reject(new Error('synthetic aborted')); };
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  })) as typeof fetch });
  const keepAlive = setTimeout(() => {}, 1000);
  try { await expect(adapter.refreshCatalog({ force: true })).rejects.toThrow(); expect(starts).toBeGreaterThanOrEqual(2); expect(aborted).toBe(starts); }
  finally { clearTimeout(keepAlive); await adapter.dispose(); }
});

it('T031 Trae caller abort reaches underlying refresh fetch and cannot write own copy', async () => {
  const f = fixture(); let started!: () => void; const ready = new Promise<void>((resolve) => { started = resolve; }); let aborted = false;
  const store = new TraeCredentialStore({ region: 'cn', edition: 'cn', ownPath: f.own, refresh: (credential, signal) => refreshTraeCredential(credential, (async (_url, init) => new Promise<Response>((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => { aborted = true; reject(new Error('synthetic aborted')); }, { once: true }); started();
  })) as typeof fetch, signal) }); store.setSource(f.desktop, 'cn');
  const controller = new AbortController(); const pending = store.resolve(controller.signal); const failed = expect(pending).rejects.toThrow(/cancelled/);
  await ready; controller.abort(); await failed; expect(aborted).toBe(true); expect(() => statSync(f.own)).toThrow();
});
