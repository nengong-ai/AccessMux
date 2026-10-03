import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { launchdIdentity, launchdPlist, startLaunchdDaemon, stopLaunchdDaemon, type LaunchdOptions } from '../../src/onboard/launchd.js';
import { ensureDaemon } from '../../src/onboard/daemon.js';
import { fixtureUiResponse } from './fixture-ui.js';

let home: string;
let options: LaunchdOptions;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'accessmux-launchd-unit-'));
  const repoRoot = join(home, 'repo & "sample"');
  mkdirSync(join(repoRoot, 'dist/cli'), { recursive: true });
  writeFileSync(join(repoRoot, 'dist/cli/index.js'), '');
  options = { homeDir: home, repoRoot, configPath: join(home, 'config.yaml'), port: 18987, uid: 501, nodePath: '/opt/test-node/bin/node' };
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('macOS 按需独立服务', () => {
  it('只保留明确禁用来源的非秘密开关，不复制会话或任意环境', () => {
    const plist = launchdPlist({ ...options, environment: { ACCESSMUX_DISABLE_ADAPTERS: 'workbuddy,trae-cn,qoder,SYNTHETIC-SECRET' } });
    expect(plist).toContain('<key>ACCESSMUX_DISABLE_ADAPTERS</key><string>workbuddy,trae-cn,qoder</string>');
    expect(plist).not.toContain('SYNTHETIC-SECRET');
  });
  it('私有登记，用程序参数而非shell；不复制Agent环境，也不放开机目录', async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: '' }));
    run.mockResolvedValueOnce({ code: 113, stdout: '' });
    const handle = await startLaunchdDaemon({ ...options, run });
    const id = launchdIdentity(options);
    const plist = readFileSync(id.plist, 'utf8');
    expect(plist).toContain('repo &amp; &quot;sample&quot;');
    expect(plist).toContain('<key>KeepAlive</key><false/>');
    expect(plist).toContain('<key>Umask</key><integer>63</integer>');
    expect(plist).not.toMatch(/NODE_OPTIONS|CODEBUDDY|CLAUDE_SESSION|LaunchAgents|API_KEY/);
    expect(statSync(id.plist).mode & 0o777).toBe(0o600);
    expect(statSync(id.log).mode & 0o777).toBe(0o600);
    expect(handle.registered).toBe(true);
    expect(run.mock.calls[1]?.[0]).toEqual(['bootstrap', 'gui/501', id.plist]);
  });

  it('重复登记只启动已有受管job，不删日志或强杀', async () => {
    const id = launchdIdentity(options);
    const run = vi.fn(async () => ({ code: 0, stdout: `path = ${id.plist}\n` }));
    run.mockResolvedValueOnce({ code: 113, stdout: '' });
    await startLaunchdDaemon({ ...options, run });
    writeFileSync(id.log, 'synthetic evidence');
    const second = await startLaunchdDaemon({ ...options, run });
    expect(second.registered).toBe(false);
    expect(readFileSync(id.log, 'utf8')).toBe('synthetic evidence');
    expect(run.mock.calls.at(-1)?.[0]).toEqual(['kickstart', id.service]);
    expect(run.mock.calls.every(call => !call[0].includes('-k') && !call[0].includes('bootout'))).toBe(true);
  });

  it('系统拒绝bootstrap就非零失败，不回显路径/环境或误报安装成功', async () => {
    const run = vi.fn(async () => ({ code: 5, stdout: 'SECRET-SYNTHETIC /private/sensitive' }));
    run.mockResolvedValueOnce({ code: 113, stdout: '' });
    await expect(startLaunchdDaemon({ ...options, run })).rejects.toThrow(/注册.*launchctl：5.*未完成/);
    expect(existsSync(launchdIdentity(options).plist)).toBe(false);
  });
  it('系统拒绝检查已有job时，不误删登记或宣称已停止', async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: '' }));
    run.mockResolvedValueOnce({ code: 113, stdout: '' });
    await startLaunchdDaemon({ ...options, run });
    const denied = vi.fn(async () => ({ code: 5, stdout: '' }));
    await expect(stopLaunchdDaemon({ ...options, run: denied })).rejects.toThrow(/检查/);
    expect(existsSync(launchdIdentity(options).plist)).toBe(true);
    expect(denied).toHaveBeenCalledTimes(1);
  });

  it('同名其它job不能被bootout/覆盖', async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: 'path = /synthetic/other.plist' }));
    await expect(startLaunchdDaemon({ ...options, run })).rejects.toThrow(/不属于当前安装/);
    expect(run).toHaveBeenCalledTimes(1);
    expect(existsSync(launchdIdentity(options).plist)).toBe(false);
  });

  it('正常stop卸载指定label，删除登记并保留私有证据，不动用户配置', async () => {
    const id = launchdIdentity(options);
    let registered = false;
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === 'print') return { code: registered ? 0 : 113, stdout: registered ? `path = ${id.plist}` : '' };
      registered = args[0] === 'bootstrap';
      return { code: 0, stdout: '' };
    });
    writeFileSync(options.configPath!, 'synthetic original');
    await startLaunchdDaemon({ ...options, run });
    await stopLaunchdDaemon({ ...options, run });
    expect(registered).toBe(false);
    expect(existsSync(id.plist)).toBe(false);
    expect(existsSync(id.log)).toBe(true);
    expect(readFileSync(options.configPath!, 'utf8')).toBe('synthetic original');
    expect(run.mock.calls.some(call => JSON.stringify(call[0]) === JSON.stringify(['bootout', id.service]))).toBe(true);
  });

  it('其它安装登记内容不符，不覆盖、不停止', async () => {
    const run = vi.fn(async () => ({ code: 0, stdout: '' }));
    run.mockResolvedValueOnce({ code: 113, stdout: '' });
    await startLaunchdDaemon({ ...options, run });
    await expect(startLaunchdDaemon({ ...options, repoRoot: '/synthetic/another', run })).rejects.toThrow(/另一个 AccessMux/);
    expect(readFileSync(launchdIdentity(options).plist, 'utf8')).toBe(launchdPlist(options));
  });
});

describe('完整控制台就绪', () => {
  it.each(['/ui/', '/ui/app.js', '/ui/style.css'])('health200但%s坏，避开非受管旧服务复用下一健康端口', async (broken) => {
    const spawnFn = vi.fn(); const launchctlRun = vi.fn();
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (new URL(String(input)).port === String(options.port) && path === broken) return new Response('{"error":{"message":"connect failed"}}', { status: 500 });
      return fixtureUiResponse(input) ?? new Response('{"ok":true,"service":"accessmux"}');
    });
    const result = await ensureDaemon(options.port, { fetchFn: fetchFn as typeof fetch, spawnFn, launchctlRun, repoRoot: options.repoRoot, homeDir: home });
    expect(result).toEqual({ baseURL: `http://127.0.0.1:${options.port + 1}`, port: options.port + 1, started: false, recoveredFrom: options.port });
    expect(spawnFn).not.toHaveBeenCalled(); expect(launchctlRun).not.toHaveBeenCalled();
  });

  it('失效job严格属于本安装时，正常卸载并在原端口重建', async () => {
    const initial = { ...options, nodePath: process.execPath, uid: process.getuid?.() };
    const id = launchdIdentity(initial); let registered = false; let starts = 0;
    const run = vi.fn(async (args: string[]) => {
      if (args[0] === 'print') return { code: registered ? 0 : 113, stdout: registered ? `path = ${id.plist}` : '' };
      if (args[0] === 'bootstrap') { registered = true; starts++; }
      if (args[0] === 'bootout') registered = false;
      return { code: 0, stdout: '' };
    });
    await startLaunchdDaemon({ ...initial, run });
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/health')) return new Response('{"ok":true,"service":"accessmux"}');
      return starts > 1 ? fixtureUiResponse(input)! : new Response('broken', { status: 500 });
    });
    const result = await ensureDaemon(options.port, { platform: 'darwin', repoRoot: options.repoRoot, homeDir: home, configPath: options.configPath, fetchFn: fetchFn as typeof fetch, launchctlRun: run, portAvailable: async () => true });
    expect(result.port).toBe(options.port); expect(result.recoveredFrom).toBe(options.port); expect(result.launcher).toBe('launchd');
    expect(starts).toBe(2); expect(run.mock.calls.filter(call => call[0][0] === 'bootout')).toHaveLength(1);
  });

  it('非mac会话代理环境准确说明限制，不擅自关闭安全机制或启动', async () => {
    const spawnFn = vi.fn();
    await expect(ensureDaemon(options.port, { platform: 'linux', repoRoot: options.repoRoot, fetchFn: async () => { throw new Error('offline'); }, spawnFn, environment: { CODEBUDDY_BROKERED_FS_HOOK_ENABLED: '1' } })).rejects.toThrow(/此系统尚不能自动创建独立后台服务/);
    expect(spawnFn).not.toHaveBeenCalled();
  });
});
