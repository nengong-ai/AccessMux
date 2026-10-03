import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from '../../src/protocol/server.js';
import { clearRegistry, registerAdapter } from '../../src/adapters/registry.js';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveOpencodeRuntime } from '../../src/adapters/opencode/runtime.js';
import { resolveQoderRuntime } from '../../src/adapters/qoder/runtime.js';
import { spawnAtRestHelper, createSpawnKeyProvider } from '../../src/adapters/workbuddy/key-provider.js';
import { fetchZcodeBalance } from '../../src/adapters/zcode/quota.js';
import { OpenCodeAdapter } from '../../src/adapters/opencode/index.js';
import { OpenCodeSession } from '../../src/adapters/opencode/session.js';
import { OpenCodeServeClient } from '../../src/adapters/opencode/client.js';
import { QoderAdapter } from '../../src/adapters/qoder/index.js';
import { directTurn } from '../../src/adapters/zcode/direct-client.js';
import { collectQoderMetadata } from '../../src/adapters/qoder/catalog-metadata.js';
import { resolveWorkBuddyClientVersion } from '../../src/adapters/workbuddy/app-version.js';
import { probeWithBudgetDetailed } from '../../src/protocol/control-plane.js';
import { FakeChild, fakeProcess, providerDirectoryFixture } from '../adapters/opencode/fakes.js';

const dirs: string[] = [];
afterEach(() => { clearRegistry(); vi.unstubAllEnvs(); vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, {recursive:true,force:true}); });
function home() { const dir = mkdtempSync(join(tmpdir(), 'accessmux-cancel-')); dirs.push(dir); return dir; }
function hanging(signal?: AbortSignal | null, onAbort = () => {}): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) throw new Error('missing cancellation signal');
    const stop = () => { onAbort(); reject(signal.reason); };
    signal.addEventListener('abort', stop, {once:true});
    if (signal.aborted) stop();
  });
}
async function gone(pid: number) {
  await vi.waitFor(() => { expect(() => process.kill(pid, 0)).toThrow(); }, {timeout:3000,interval:10});
}
function fakeBinary(dir: string) {
  const marker = join(dir, 'pid'); const file = join(dir, 'synthetic-cli');
  writeFileSync(file, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));setInterval(()=>{},1000);\n`); chmodSync(file,0o755);
  return {file,marker};
}

describe('R10 underlying cancellation evidence', () => {
  it.each(['opencode','qoder','helper'])('%s owned synthetic process actually exits on parent abort', async kind => {
    const {file,marker} = fakeBinary(home()); const controller = new AbortController();
    const pending = kind==='helper' ? spawnAtRestHelper(file,10000,controller.signal)
      : kind==='qoder' ? resolveQoderRuntime({candidates:[file],signal:controller.signal})
      : resolveOpencodeRuntime({candidates:[file],signal:controller.signal});
    const failed = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(existsSync(marker)).toBe(true), {timeout:3000});
    const pid = Number(readFileSync(marker,'utf8')); controller.abort(); await failed; await gone(pid);
  });
  it('one helper caller abort does not kill another caller; cancelled last waiter permits fresh resolution', async () => {
    let owned!: AbortSignal;
    const provider = createSpawnKeyProvider('cn', {discovery:async()=>({electronPath:'/synthetic',variant:'cn'}), spawnHelper:(_path,signal)=> {owned=signal!;return hanging(signal);} });
    const a=new AbortController(), b=new AbortController();
    const one=provider.resolveAtRestSecretKey(a.signal), two=provider.resolveAtRestSecretKey(b.signal);
    const oneFailed=expect(one).rejects.toThrow(); const twoFailed=expect(two).rejects.toThrow();
    await vi.waitFor(()=>expect(owned).toBeDefined()); a.abort(); await oneFailed; expect(owned.aborted).toBe(false);
    b.abort(); await twoFailed; expect(owned.aborted).toBe(true);
  });
  it('parent abort stops OpenCode startup refresh without spawning serve; next probe succeeds', async () => {
    let refreshEntered=false;let aborted=false; const spawn=vi.fn(()=>new FakeChild()); let hang=true;
    const adapter=new OpenCodeAdapter({xdgRoot:home(),resolveRuntime:async()=>({path:'/synthetic',version:'1.0.0'}),spawnImpl:spawn,exitTarget:fakeProcess().target,
      execImpl:async(_file,_args,options)=> {if(hang) {refreshEntered=true;return hanging(options.signal,()=>{aborted=true;});}return {stdout:''};},
      fetchImpl:async input=>Response.json(String(input).endsWith('/global/health')?{healthy:true,version:'1.0.0'}:providerDirectoryFixture),stopGraceMs:0});
    const controller=new AbortController();
    const starting=adapter.probe({signal:controller.signal});
    // Wait until the owned refresh operation is actually running before exercising cancellation.
    await vi.waitFor(()=>expect(refreshEntered).toBe(true));
    controller.abort();await starting;
    await vi.waitFor(()=>expect(aborted).toBe(true));expect(spawn).not.toHaveBeenCalled();
    hang=false; await vi.waitFor(async()=>expect((await probeWithBudgetDetailed(adapter,300)).result?.availability).toBe('available'));
    expect(spawn).toHaveBeenCalledTimes(1);await adapter.dispose();
  });
  it('one OpenCode startup caller cancels while another keeps the shared process alive', async () => {
    let finish!:()=>void;const waiting=new Promise<void>(r=>{finish=r;});let owned!:AbortSignal;
    const child=new FakeChild();const adapter=new OpenCodeAdapter({xdgRoot:home(),resolveRuntime:async()=>({path:'/synthetic',version:'1.0.0'}),
      execImpl:async(_f,_a,options)=>{owned=options.signal!;await waiting;return {stdout:''};},spawnImpl:()=>child,exitTarget:fakeProcess().target,stopGraceMs:0,
      fetchImpl:async input=>Response.json(String(input).endsWith('/global/health')?{healthy:true,version:'1.0.0'}:providerDirectoryFixture)});
    const a=new AbortController();const one=adapter.probe({signal:a.signal});const two=adapter.launch({localSecret:'synthetic'});
    await vi.waitFor(()=>expect(owned).toBeDefined());a.abort();await one;expect(owned.aborted).toBe(false);finish();await two;
    expect(child.kills).toEqual([]);await adapter.dispose();
  });
  it('Qoder catalog version abort reaches injected process before list/metadata; later catalog recovers', async () => {
    let aborted=false;let hang=true;const calls:string[][]=[];
    const adapter=new QoderAdapter({runtimeDeps:{candidates:['/synthetic'],exists:()=>true,execFile:async(_f,args,options)=>{
      calls.push([...args]);if(hang)return hanging(options?.signal,()=>{aborted=true;});return {stdout:args[0]==='-v'?'1.0.0':'Qwen3.8-Flash'};
    }},metadataDeps:{textFiles:[],runtimeFiles:[],settingsFile:null,publicOffer:false}});
    const controller=new AbortController();const pending=adapter.probe({signal:controller.signal});
    await vi.waitFor(()=>expect(calls).toHaveLength(1));controller.abort();await pending;expect(aborted).toBe(true);expect(calls).toEqual([['-v']]);
    hang=false;await adapter.probe();expect(calls.some(args=>args[0]==='--list-models')).toBe(true);await adapter.dispose();
  });
  it('ZCode quota body cancellation settles and a pre-aborted request never starts fetch', async () => {
    let aborted=false;const controller=new AbortController();const fetch=vi.fn(async(_i,_o)=>({status:200,text:()=>hanging(_o?.signal,()=>{aborted=true;})} as Response));
    const pending=fetchZcodeBalance({jwt:'synthetic-jwt',deviceMid:'synthetic-device'}, {fetchImpl:fetch as typeof globalThis.fetch,signal:controller.signal});
    await vi.waitFor(()=>expect(fetch).toHaveBeenCalledTimes(1));controller.abort();expect((await pending).state).toBe('unknown');expect(aborted).toBe(true);
    await fetchZcodeBalance({jwt:'synthetic-jwt',deviceMid:'synthetic-device'}, {fetchImpl:fetch as typeof globalThis.fetch,signal:controller.signal});expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('OpenCode cancel during session creation prevents message', async () => {
    let abort=false;const routes:string[]=[];
    const client=new OpenCodeServeClient('http://127.0.0.1:1','synthetic',async(input,options)=>{const path=new URL(String(input)).pathname;routes.push(path);if(path==='/session')return hanging(options?.signal,()=>{abort=true;});return Response.json([]);});
    const session=new OpenCodeSession(client);const pending=session.runTurn({model:'m',messages:[{role:'user',content:'hi'}],stream:false})[Symbol.asyncIterator]().next();
    const failed=expect(pending).rejects.toThrow();await vi.waitFor(()=>expect(routes).toContain('/session'));await session.cancel();await failed;expect(abort).toBe(true);expect(routes).toEqual(['/session']);
  });
  it('OpenCode late created ID is aborted and deleted without sending a message', async () => {
    let finish!: (value: Response) => void; const routes: string[] = [];
    const client = new OpenCodeServeClient('http://127.0.0.1:1', 'synthetic', async input => {
      const path = new URL(String(input)).pathname; routes.push(path);
      if (path === '/session') return new Promise<Response>(resolve => { finish = resolve; });
      return Response.json({});
    });
    const session = new OpenCodeSession(client);
    const pending = session.runTurn({model:'m',messages:[{role:'user',content:'hi'}],stream:false})[Symbol.asyncIterator]().next();
    const failed = expect(pending).rejects.toThrow(); await vi.waitFor(()=>expect(finish).toBeDefined());
    await session.cancel(); await failed; finish(Response.json({id:'late-synthetic'}));
    await vi.waitFor(()=>expect(routes).toEqual(['/session','/session/late-synthetic/abort','/session/late-synthetic']));
  });
  it('ZCode 429 retry sleep cancels without a second network request', async () => {
    const controller = new AbortController(); const fetch = vi.fn(async () => new Response('',{status:429}));
    const pending = directTurn({jwt:'synthetic-jwt',model:'GLM-5.3-Flash',messages:[{role:'user',content:'hi'}],stream:false}, {fetchImpl:fetch,signal:controller.signal,retryDelayMs:500})[Symbol.asyncIterator]().next();
    const failed=expect(pending).rejects.toThrow(); await vi.waitFor(()=>expect(fetch).toHaveBeenCalledTimes(1)); controller.abort(); await failed;
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('metadata rejects already aborted calls before feed, token read or campaign', async () => {
    const controller=new AbortController();controller.abort(); const fetch=vi.fn();const token=vi.fn();
    await expect(collectQoderMetadata({textFiles:[],runtimeFiles:[],settingsFile:null,fetchImpl:fetch,campaignToken:token,signal:controller.signal})).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();expect(token).not.toHaveBeenCalled();
  });
  it('metadata body and injected version-reader cancellation settle without proceeding', async () => {
    const controller=new AbortController();let stopped=false;
    const pending=collectQoderMetadata({textFiles:[],runtimeFiles:[],settingsFile:null,signal:controller.signal,fetchImpl:async(_input,options)=>({ok:true,text:()=>hanging(options?.signal,()=>{stopped=true;})} as Response)});
    const failed=expect(pending).rejects.toThrow(); await new Promise(resolve=>setTimeout(resolve,20)); controller.abort();await failed;expect(stopped).toBe(true);
    const version=new AbortController();const versionWork=resolveWorkBuddyClientVersion('cn',{signal:version.signal,bundleVersionReader:signal=>hanging(signal)});
    const versionFailed=expect(versionWork).rejects.toThrow();version.abort();await versionFailed;
  });
  it('control budget signals hanging underlying probe and subsequent source remains usable', async () => {
    let stopped=false;const adapter={id:'synthetic',displayName:'Synthetic',sandbox:'none' as const,
      probe:async(ctx?:{signal?:AbortSignal})=>{await hanging(ctx?.signal,()=>{stopped=true;});return {availability:'available' as const,models:[]};},
      launch:vi.fn(),fetchQuota:async()=> 'unknown' as const,dispose:async()=>{}};
    expect((await probeWithBudgetDetailed(adapter,10)).status).not.toBe('ready'); await vi.waitFor(()=>expect(stopped).toBe(true));
    adapter.probe=async()=>({availability:'available',models:[]}); expect((await probeWithBudgetDetailed(adapter,100)).status).toBe('ready');
  });

  it('server idle timeout sends an error after partial SSE and next request succeeds', async () => {
    vi.stubEnv('ACCESSMUX_IDLE_TIMEOUT_MS', '20'); vi.stubEnv('ACCESSMUX_TURN_TIMEOUT_MS', '1000');
    let first = true; let cancelled = 0; let release: (()=>void) | undefined;
    registerAdapter({id:'synthetic',displayName:'Synthetic',sandbox:'none',probe:async()=>({availability:'available',models:[{id:'m',provider:'synthetic'}]}),fetchQuota:async()=> 'ok',dispose:async()=>{},
      launch:async()=>({runTurn:async function*(){yield {delta:'partial',done:false};if(first){first=false;await new Promise<void>(r=>{release=r;});}yield {delta:'',done:true};},cancel:async()=>{cancelled++;release?.();release=undefined;}})});
    const app=buildServer();
    try {
      const response=await app.inject({method:'POST',url:'/v1/chat/completions',payload:{model:'synthetic:m',messages:[{role:'user',content:'hi'}],stream:true}});
      expect(response.body).toContain('partial');expect(response.body).toContain('"error"');expect(response.body).not.toContain('[DONE]');expect(cancelled).toBe(1);
      const next=await app.inject({method:'POST',url:'/v1/chat/completions',payload:{model:'synthetic:m',messages:[{role:'user',content:'again'}],stream:true}});
      expect(next.body).toContain('[DONE]');expect(next.body).not.toContain('"error"');
    } finally {await app.close();}
  });

});
