import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runOnboard } from '../../src/onboard/onboard.js';
import { openUi } from '../../src/onboard/open-ui.js';
import { ensureDaemon } from '../../src/onboard/daemon.js';
import { allHosts } from '../../src/onboard/hosts.js';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(models = ['trae-cn:synthetic']) {
  const home = mkdtempSync(join(tmpdir(), 'accessmux-t039-')); dirs.push(home);
  mkdirSync(join(home, '.workbuddy')); writeFileSync(join(home, '.workbuddy/models.json'), '[{"id":"keep","url":"unchanged"}]');
  mkdirSync(join(home, '.zcode/v2'), { recursive: true }); writeFileSync(join(home, '.zcode/v2/provider_config.json'), '{"keep":true}');
  const requests: string[] = []; const opened: string[] = [];
  const pathname = (input: RequestInfo | URL) => { try { return new URL(String(input)).pathname; } catch { return String(input).split('?')[0]; } };
  const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input); requests.push(url);
    if (pathname(input).endsWith('/health')) return new Response(JSON.stringify({ok: true, service: 'accessmux'}));
    if (pathname(input).endsWith('/ui')) return new Response('<html>synthetic UI</html>', {headers: {'content-type': 'text/html'}});
    if (pathname(input).endsWith('/v1/models')) return new Response(JSON.stringify({data: models.map(id => ({id}))}));
    throw new Error('推理/签到/其它网络操作不允许');
  });
  const logs: string[] = [];
  const deps = {homeDir: home, fetchFn: fetchFn as typeof fetch, isTTY: false, openUi: async (url: string) => {opened.push(url); return true;}, log: (line = '') => logs.push(line)};
  return {home, requests, opened, logs, deps};
}

describe('T039 当前宿主与开页', () => {
  it('延迟注册期间不打开首屏，写盘完成后只打开一次且首屏读到接入', async () => {
    const f = fixture(); const host = allHosts().find(h => h.id === 'workbuddy')!;
    const original = host.onboard!;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(host, 'onboard').mockImplementation(async ctx => { entered(); await gate; return original(ctx); });
    const observed: string[] = [];
    const running = runOnboard({host: 'workbuddy', yes: true}, {...f.deps, openUi: async url => {
      observed.push(readFileSync(join(f.home, '.workbuddy/models.json'), 'utf8'));
      f.opened.push(url); return true;
    }});
    await started;
    expect(f.opened).toEqual([]);
    expect(f.logs.some(line => line.includes('ACCESSMUX_UI_URL='))).toBe(false);
    release();
    expect(await running).toBe(0);
    expect(f.opened).toHaveLength(1);
    expect(observed[0]).toContain('trae-cn:synthetic');
  });
  it('注册失败仍打开一次诊断 UI，返回失败且保留原配置', async () => {
    const f = fixture(); const path = join(f.home, '.workbuddy/models.json');
    const before = readFileSync(path, 'utf8');
    const host = allHosts().find(h => h.id === 'workbuddy')!;
    vi.spyOn(host, 'onboard').mockRejectedValue(new Error('synthetic write failure'));
    expect(await runOnboard({host: 'workbuddy', yes: true}, f.deps)).toBe(1);
    expect(f.opened).toHaveLength(1);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
  it('首次只写当前 WorkBuddy；重复不备份、不发推理，每次都确认并打开 UI', async () => {
    const f = fixture(); const zcode = readFileSync(join(f.home, '.zcode/v2/provider_config.json'), 'utf8');
    expect(await runOnboard({host: 'workbuddy', yes: true}, f.deps)).toBe(0);
    const path = join(f.home, '.workbuddy/models.json'); const first = readFileSync(path, 'utf8');
    const files = readdirSync(join(f.home, '.workbuddy'));
    expect(await runOnboard({host: 'workbuddy', yes: true}, f.deps)).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe(first); expect(readdirSync(join(f.home, '.workbuddy'))).toEqual(files);
    expect(readFileSync(join(f.home, '.zcode/v2/provider_config.json'), 'utf8')).toBe(zcode);
    expect(f.opened).toEqual(['http://127.0.0.1:8080/ui', 'http://127.0.0.1:8080/ui']);
    expect(f.requests.every(url => /\/(health|ui|v1\/models)$/.test(new URL(url).pathname))).toBe(true);
  });
  it('无模型仍开页、非零退出、不写空配置', async () => {
    const f = fixture([]); const before = readFileSync(join(f.home, '.workbuddy/models.json'), 'utf8');
    expect(await runOnboard({host: 'workbuddy', yes: true}, f.deps)).toBe(1);
    expect(f.opened).toHaveLength(1); expect(readFileSync(join(f.home, '.workbuddy/models.json'), 'utf8')).toBe(before);
  });
  it('指定宿主未安装仍开 UI，诚实返回未完成', async () => {
    const f = fixture(); rmSync(join(f.home, '.workbuddy'), {recursive: true});
    expect(await runOnboard({host: 'workbuddy', yes: true}, f.deps)).toBe(1); expect(f.opened).toHaveLength(1);
  });
  it('非交互缺宿主不猜、无网络无配置写入', async () => {
    const f = fixture(); await expect(runOnboard({yes: true}, f.deps)).rejects.toThrow('--host'); expect(f.requests).toEqual([]);
  });
  it('交互只选择一次当前宿主', async () => {
    const f = fixture(); const choose = vi.fn(async () => 'workbuddy');
    expect(await runOnboard({yes: true}, {...f.deps, isTTY: true, choose})).toBe(0); expect(choose).toHaveBeenCalledTimes(1);
  });
  it('Agent 内置浏览器模式只打印地址，系统浏览器不打开', async () => {
    const f = fixture(); expect(await runOnboard({host: 'workbuddy', yes: true, openUi: false}, f.deps)).toBe(0);
    expect(f.opened).toEqual([]); expect(f.logs.join('\n')).toContain('ACCESSMUX_UI_URL=http://127.0.0.1:8080/ui');
  });
  it('系统浏览器失败给可点击地址，不误报已打开', async () => {
    const f = fixture(); expect(await runOnboard({host: 'workbuddy', yes: true}, {...f.deps, openUi: async () => false})).toBe(0);
    expect(f.logs.join('\n')).toContain('浏览器未能自动打开，请点击：http://127.0.0.1:8080/ui');
  });
  it('无图形环境不执行程序，浏览器参数不经过 shell', async () => {
    const run = vi.fn(async () => {});
    expect(await openUi('http://127.0.0.1:8888/ui', {platform:'linux', env:{}, run})).toBe(false); expect(run).not.toHaveBeenCalled();
    expect(await openUi('http://127.0.0.1:8888/ui', {platform:'darwin', env:{}, run})).toBe(true);
    expect(run).toHaveBeenCalledWith('open', ['http://127.0.0.1:8888/ui']);
  });
  it('其它服务即使 health ok 也不复用；下一端口已有 AccessMux 时复用，不重复起', async () => {
    const spawnFn = vi.fn(); const fetchFn = vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(String(input).includes(':18081/') ? {ok:true, service:'accessmux'} : {ok:true, service:'other'})));
    const result = await ensureDaemon(18080, {fetchFn:fetchFn as typeof fetch, spawnFn:spawnFn as never, portAvailable: async () => false});
    expect(result).toEqual({baseURL:'http://127.0.0.1:18081', port:18081, started:false}); expect(spawnFn).not.toHaveBeenCalled();
  });
  it('旧版 health + 正确 UI 标题可复用，无重复 daemon', async () => {
    const spawnFn = vi.fn();
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/ui') ? new Response('<title>AccessMux 本地配置</title>') : new Response(JSON.stringify({ok:true, adapters:['qoder']})));
    expect((await ensureDaemon(18080, {fetchFn:fetchFn as typeof fetch, spawnFn:spawnFn as never})).started).toBe(false);
    expect(spawnFn).not.toHaveBeenCalled();
  });
});
