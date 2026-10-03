// T044: synthetic-only regressions for misleading first-install login states.
import { describe, expect, it, vi } from 'vitest';
import { WorkBuddyCredentialStore } from '../src/adapters/workbuddy/credential-store.js';
import { WorkBuddyAdapter } from '../src/adapters/workbuddy/index.js';
import { TraeCredentialStore } from '../src/adapters/trae/credential-store.js';
import { TraeAdapter } from '../src/adapters/trae/index.js';
import { ZcodeAdapter } from '../src/adapters/zcode/index.js';
import { ZcodeCredentialError } from '../src/adapters/zcode/credential-store.js';
import { buildDefaultConfig } from '../src/config/index.js';
import { snapshotAdapterInfo } from '../src/ui/services.js';
import type { ProviderAdapter } from '../src/adapters/types.js';

const noRefresh = async (): Promise<never> => { throw new Error('synthetic refresh disabled'); };
const noFetch = async (): Promise<never> => { throw new Error('synthetic network refused'); };
function memoryFs(files: Record<string, string> = {}, unreadable = false) {
  return {
    existsSync: (path: string) => path in files,
    readFileSync: (path: string) => {
      if (unreadable) throw Object.assign(new Error('synthetic denied'), { code: 'EACCES' });
      if (!(path in files)) throw Object.assign(new Error('synthetic missing'), { code: 'ENOENT' });
      return files[path]!;
    },
    writeFileSync() { throw new Error('writes forbidden'); }, mkdirSync() {}, rmSync() {},
  };
}
function workBuddy(files: Record<string, string> = {}, unreadable = false) {
  const store = new WorkBuddyCredentialStore({
    fs: memoryFs(files, unreadable), desktopPath: '/synthetic/wb', ownPath: '/synthetic/own',
    keyProvider: { resolveAtRestSecretKey: noRefresh, resetCache() {} }, refresh: noRefresh,
  });
  const adapter = new WorkBuddyAdapter({
    credentialStore: store, fetchImpl: noFetch, metadataCachePath: null, resolveClientVersion: async () => 'synthetic',
  });
  return { store, adapter };
}
function trae(files: Record<string, string> = {}, unreadable = false) {
  const store = new TraeCredentialStore({
    fs: memoryFs(files, unreadable), ownPath: '/synthetic/own', legacyOwnPath: '/synthetic/legacy', refresh: noRefresh,
  });
  store.setSource('/synthetic/trae');
  return { store, adapter: new TraeAdapter('cn', { credentialStore: store, fetchImpl: noFetch }) };
}
function zcode(load: () => unknown, fetchImpl: typeof fetch = noFetch) {
  const adapter = new ZcodeAdapter({ env: {}, fetchImpl, log() {} });
  vi.spyOn(adapter as unknown as { loadCredential: () => unknown }, 'loadCredential').mockImplementation(load);
  return adapter;
}
const fakeCredential = () => ({ jwt: 'synthetic.synthetic.synthetic', deviceMid: 'synthetic', deviceMidSource: 'generated' });
async function ui(adapter: ProviderAdapter) {
  return (await snapshotAdapterInfo([adapter], buildDefaultConfig([adapter]), 50, { env: {} }))[0]!;
}

describe('first-install source login classification', () => {
  it.each(['malformed', 'helper', 'permission'])('WorkBuddy %s failure is unknown and gives a safe recovery instruction', async (failure) => {
    const data = failure === 'malformed' ? 'not-json' : JSON.stringify({ account: { uid: 'synthetic' }, auth: { accessToken: 'synthetic' } });
    const { adapter } = workBuddy({ '/synthetic/wb': data }, failure === 'permission');
    const snapshot = await ui(adapter);
    expect(snapshot).toMatchObject({ auth: 'unknown', sourceState: 'failed', reasonCode: 'credential-unavailable', sourceMessage: '登录信息暂无法读取', models: [] });
    expect(snapshot.nextAction).not.toContain('重新登录');
    expect(snapshot.nextAction).toContain('无需提供密钥');
  });
  it('a damaged WorkBuddy own copy is unknown, while no record is logged-out', async () => {
    expect((await ui(workBuddy({ '/synthetic/own': 'damaged' }).adapter)).auth).toBe('unknown');
    expect((await ui(workBuddy().adapter)).auth).toBe('logged-out');
  });
  it.each([false, true])('Trae existing invalid/unreadable record is unknown (unreadable=%s)', async (unreadable) => {
    const snapshot = await ui(trae({ '/synthetic/trae': 'damaged' }, unreadable).adapter);
    expect(snapshot).toMatchObject({ auth: 'unknown', sourceState: 'failed', reasonCode: 'credential-unavailable' });
    expect(snapshot.nextAction).not.toContain('重新登录');
  });
  it('Trae with no records remains logged-out', async () => {
    expect((await ui(trae().adapter)).auth).toBe('logged-out');
  });
  it('ZCode local decryption/IPC failures are unknown; confirmed missing record remains logged-out', async () => {
    const unreadable = zcode(() => { throw new ZcodeCredentialError('synthetic decryption failure'); });
    expect(await ui(unreadable)).toMatchObject({ auth: 'unknown', sourceState: 'failed', reasonCode: 'credential-unavailable' });
    const missing = zcode(() => { throw new ZcodeCredentialError('synthetic ENOENT', 'missing'); });
    expect((await ui(missing)).auth).toBe('logged-out');
  });
  it('ZCode refused connection retains known login state; a real 401 is logged-out', async () => {
    const network = await ui(zcode(fakeCredential));
    expect(network.auth).toBe('logged-in');
    expect(network.sourceMessage).toBe('当前只有候选目录，尚未取得实时目录');
    expect(network.nextAction).toBe('检查网络和来源服务后刷新');
    expect((await ui(zcode(fakeCredential, async () => new Response('{}', { status: 401 })))).auth).toBe('logged-out');
  });
  it('cancellation never becomes a signed-out result', async () => {
    const controller = new AbortController(); controller.abort(new Error('synthetic cancel'));
    await expect(workBuddy().store.status(controller.signal)).rejects.toThrow('synthetic cancel');
    await expect(trae().adapter.probe({ signal: controller.signal })).rejects.toThrow('synthetic cancel');
    await expect(zcode(fakeCredential).probe({ signal: controller.signal })).rejects.toThrow('synthetic cancel');
  });
  it('a slow cold start remains failed/unknown rather than logged-out', async () => {
    const adapter = {
      id: 'synthetic-slow', displayName: 'Synthetic slow', sandbox: 'none',
      fetchQuota: async () => 'unknown', dispose: async () => {}, launch: noRefresh,
      probe: async ({ signal }: { signal?: AbortSignal }) => new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true })),
    } as ProviderAdapter;
    expect(await ui(adapter)).toMatchObject({ auth: 'unknown', sourceState: 'failed' });
  });
});
