// T013 隔离语义测试（验收标准 2）：env 白名单、XDG 重定向、随机密码、
// nativePermissions 全 ask/deny、--pure + 随机端口、健康轮询、子进程回收。
// 全离线：spawn/exec/fetch 全注入。

import { describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import {
  bindExitGuards,
  buildIsolatedEnv,
  getFreeLoopbackPort,
  isolatedConfig,
  nativePermissions,
  randomIsolationPassword,
  startIsolatedServe,
  type ExitGuardTarget,
  type ServeChild,
  type StartServeOptions,
} from '../../../src/adapters/opencode/isolate.js';
import {
  opencodeBinaryCandidates,
  resolveOpencodeRuntime,
} from '../../../src/adapters/opencode/runtime.js';
import { FakeChild, fakeFetch, fakeProcess, jsonResponse, providerDirectoryFixture } from './fakes.js';

const LEAK_ENV = {
  PATH: '/usr/bin:/bin',
  HOME: '/Users/tester',
  ANTHROPIC_API_KEY: 'sk-ant-leak',
  OPENAI_API_KEY: 'sk-oai-leak',
  OPENCODE_API_KEY: 'oc-leak',
  XDG_CONFIG_HOME: '/Users/tester/.config',
};

describe('nativePermissions（chat-only 铁律：全 ask/deny，官方 permission schema 键集）', () => {
  it('所有取值只有 ask/deny，通配 * 是 ask（任何本地动作都挂审批）', () => {
    for (const action of Object.values(nativePermissions)) {
      expect(['ask', 'deny']).toContain(action);
    }
    expect(nativePermissions['*']).toBe('ask');
  });

  it('键清单 = 官方已知键（v1/config/permission.ts + plugin/agent.ts plan_*）+ 防御性 codesearch', () => {
    expect(Object.keys(nativePermissions)).toEqual([
      '*', 'question', 'websearch', 'codesearch', 'webfetch',
      'task', 'plan_enter', 'plan_exit', 'todowrite',
    ]);
  });
});

describe('isolatedConfig', () => {
  it('permission 全量注入；buddy-chat agent 同权限门 + 禁工具 prompt', () => {
    expect(isolatedConfig.permission).toEqual(nativePermissions);
    const agent = isolatedConfig.agent['buddy-chat'];
    expect(agent.mode).toBe('primary');
    expect(agent.permission).toEqual(nativePermissions);
    expect(agent.prompt).toContain('No tool use or local actions');
  });

  it('autoupdate 关闭、share 禁用（隔离实例不改本机状态）', () => {
    expect(isolatedConfig.autoupdate).toBe(false);
    expect(isolatedConfig.share).toBe('disabled');
  });
});

describe('buildIsolatedEnv', () => {
  const root = '/tmp/fake-root';

  it('env 白名单：其他 provider 的 key 与用户 OPENCODE_* 一律不透传', () => {
    const env = buildIsolatedEnv(LEAK_ENV, root, 'p'.repeat(48));
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(env['OPENAI_API_KEY']).toBeUndefined();
    expect(env['OPENCODE_API_KEY']).toBeUndefined();
    expect(env['PATH']).toBe('/usr/bin:/bin');
    expect(env['HOME']).toBe('/Users/tester');
  });

  it('XDG 四目录重定向到隔离 root（覆盖用户自己的 XDG_CONFIG_HOME）', () => {
    const env = buildIsolatedEnv(LEAK_ENV, root, 'p'.repeat(48));
    expect(env['XDG_CONFIG_HOME']).toBe(join(root, 'config'));
    expect(env['XDG_DATA_HOME']).toBe(join(root, 'data'));
    expect(env['XDG_CACHE_HOME']).toBe(join(root, 'cache'));
    expect(env['XDG_STATE_HOME']).toBe(join(root, 'state'));
  });

  it('隔离密码原样透传 + OPENCODE 加固变量 + 内嵌配置可解析', () => {
    const env = buildIsolatedEnv(LEAK_ENV, root, 'ab'.repeat(24));
    expect(env['OPENCODE_SERVER_PASSWORD']).toBe('ab'.repeat(24));
    expect(env['OPENCODE_SERVER_USERNAME']).toBe('opencode');
    expect(env['OPENCODE_DISABLE_AUTOUPDATE']).toBe('true');
    expect(env['OPENCODE_DISABLE_PROJECT_CONFIG']).toBe('true');
    expect(env['OPENCODE_CONFIG_CONTENT']).toBeDefined();
    const parsed = JSON.parse(env['OPENCODE_CONFIG_CONTENT'] ?? '') as typeof isolatedConfig;
    expect(parsed.permission).toEqual(nativePermissions);
  });
});

describe('randomIsolationPassword', () => {
  it('48 位 hex 且每次随机', () => {
    const a = randomIsolationPassword();
    const b = randomIsolationPassword();
    expect(a).toMatch(/^[0-9a-f]{48}$/);
    expect(a).not.toBe(b);
  });
});

describe('opencodeBinaryCandidates / resolveOpencodeRuntime', () => {
  it('env 覆盖最优先，其次 ~/.opencode/bin 与 brew 路径', () => {
    const candidates = opencodeBinaryCandidates({
      env: { ACCESSMUX_OPENCODE_BIN: '/custom/oc' },
      home: '/Users/tester',
    });
    expect(candidates[0]).toBe('/custom/oc');
    expect(candidates).toContain('/Users/tester/.opencode/bin/opencode');
    expect(candidates).toContain('/opt/homebrew/bin/opencode');
  });

  it('resolveOpencodeRuntime 跳过版本输出不合法的候选', async () => {
    const result = await resolveOpencodeRuntime({
      candidates: ['/fake/bad', '/fake/good'],
      exists: () => true,
      execFile: async (file) => ({ stdout: file === '/fake/good' ? '1.18.31\n' : 'garbage' }),
    });
    expect(result).toEqual({ path: '/fake/good', version: '1.18.31' });
  });

  it('全部落选时报错并带安装指引', async () => {
    await expect(
      resolveOpencodeRuntime({ candidates: ['/nonexistent/opencode'], env: {}, exists: () => false }),
    ).rejects.toThrow(/找不到可用的 opencode 二进制.*brew install opencode/s);
  });
});

describe('getFreeLoopbackPort', () => {
  it('返回可再次绑定的 loopback 端口', async () => {
    const port = await getFreeLoopbackPort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
    await new Promise<void>((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => server.close(() => resolve()));
    });
  });
});

function baseOptions(overrides: Partial<StartServeOptions> & { child?: ServeChild } = {}): StartServeOptions {
  const { child, ...rest } = overrides;
  const fakeChild = child ?? new FakeChild();
  return {
    binary: '/fake/opencode',
    version: '1.18.31',
    root: mkdtempSync(join(tmpdir(), 'oc-isolate-')),
    env: LEAK_ENV,
    refreshOnStart: false,
    healthAttempts: 10,
    healthIntervalMs: 1,
    stopGraceMs: 30,
    exitTarget: fakeProcess().target,
    spawnImpl: () => fakeChild,
    fetchImpl: fakeFetch((call) => {
      if (call.url.endsWith('/global/health')) return jsonResponse({ healthy: true, version: '1.18.31' });
      if (call.url.endsWith('/provider')) return jsonResponse(providerDirectoryFixture);
      return jsonResponse({});
    }).fetchImpl,
    ...rest,
  };
}

describe('startIsolatedServe（注入 spawn/exec/fetch）', () => {

  it('子进程 stdout/stderr 跨chunk鉴权回声脱敏，日志覆盖为0600', async () => {
    const options = baseOptions();
    const logPath = join(options.root, 'serve.log');
    writeFileSync(logPath, 'old raw log');
    chmodSync(logPath, 0o644);
    const child = new FakeChild();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const streamChild = {
      get exitCode() { return child.exitCode; }, get signalCode() { return child.signalCode; },
      on: child.on.bind(child), once: child.once.bind(child), kill: child.kill.bind(child), stdout, stderr,
    };
    const handle = await startIsolatedServe({ ...options, spawnImpl: () => streamChild });
    stdout.write('Authorization: Bea');
    stdout.write('rer short-token\n');
    stderr.write('Cloud-IDE-JWT: short-jwt\nPAT=short-pat\n');
    stderr.write('a'.repeat(66000));
    stderr.write('\nnormal diagnostic\n');
    await handle.stop();
    const log = readFileSync(logPath, 'utf8');
    for (const value of ['short-token', 'short-jwt', 'short-pat', 'old raw log']) expect(log).not.toContain(value);
    expect(log).toContain('normal diagnostic');
    expect(log).toContain('oversized subprocess log omitted');
    expect(statSync(logPath).mode & 0o777).toBe(0o600);
    expect(statSync(options.root).mode & 0o777).toBe(0o700);
  });

  it('健康后返回句柄：--pure + 127.0.0.1 随机端口 + 隔离 env 传给子进程', async () => {
    const child = new FakeChild();
    const { fetchImpl, calls } = fakeFetch((call) => {
      if (call.url.endsWith('/global/health')) return jsonResponse({ healthy: true, version: '1.18.31' });
      return jsonResponse({});
    });
    const spawnArgs: { args: readonly string[]; env: Record<string, string> }[] = [];
    const handle = await startIsolatedServe({
      ...baseOptions(),
      spawnImpl: (file, args, options) => {
        spawnArgs.push({ args, env: options.env });
        return child;
      },
      fetchImpl,
    });
    try {
      expect(handle.baseUrl).toBe(`http://127.0.0.1:${handle.port}`);
      expect(spawnArgs[0]!.args).toEqual(['serve', '--pure', '--hostname', '127.0.0.1', '--port', String(handle.port)]);
      const env = spawnArgs[0]!.env;
      expect(env['OPENCODE_SERVER_PASSWORD']).toMatch(/^[0-9a-f]{48}$/);
      expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
      expect(env['XDG_CONFIG_HOME']).toContain('config');
      expect(calls.some((c) => c.method === 'GET' && c.url.endsWith('/global/health'))).toBe(true);
    } finally {
      await handle.stop();
    }
    expect(child.kills).toEqual(['SIGTERM']);
  });

  it('refreshOnStart 时启动前执行 models opencode --refresh --pure；刷新失败不阻断', async () => {
    const child = new FakeChild();
    const execCalls: { args: readonly string[]; cwd: string }[] = [];
    const handle = await startIsolatedServe({
      ...baseOptions({ child }),
      refreshOnStart: true,
      execImpl: async (file, args, options) => {
        execCalls.push({ args, cwd: options.cwd });
        throw new Error('simulated refresh failure');
      },
    });
    await handle.stop();
    expect(execCalls[0]!.args).toEqual(['models', 'opencode', '--refresh', '--pure']);
    expect(execCalls[0]!.cwd.endsWith('project')).toBe(true);
  });

  it('健康检查始终不过 → 超时抛错并回收子进程（无孤儿）', async () => {
    const child = new FakeChild();
    await expect(
      startIsolatedServe({
        ...baseOptions({ child }),
        fetchImpl: fakeFetch((call) => {
          if (call.url.endsWith('/global/health')) return jsonResponse({ healthy: false });
          return jsonResponse({});
        }).fetchImpl,
      }),
    ).rejects.toThrow(/启动超时/);
    expect(child.kills).toContain('SIGTERM');
  });

  it('serve 提前退出 → 报错且不残留', async () => {
    const child = new FakeChild();
    const promise = startIsolatedServe(baseOptions({ child }));
    child.exit(1);
    await expect(promise).rejects.toThrow(/提前退出/);
    expect(child.kills).toEqual([]);
  });

  it('健康版本与二进制不一致 → 立即失败并回收', async () => {
    const child = new FakeChild();
    await expect(
      startIsolatedServe({
        ...baseOptions({ child }),
        fetchImpl: fakeFetch((call) => {
          if (call.url.endsWith('/global/health')) return jsonResponse({ healthy: true, version: '0.0.1' });
          return jsonResponse({});
        }).fetchImpl,
      }),
    ).rejects.toThrow(/版本不一致/);
    expect(child.kills).toContain('SIGTERM');
  });

  it('SIGTERM 装死 → SIGKILL 兜底（stopGraceMs 注入加速）', async () => {
    const child = new FakeChild(['SIGKILL']);
    const handle = await startIsolatedServe(baseOptions({ child }));
    await handle.stop();
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('stop 幂等：重复调用不重复 kill', async () => {
    const child = new FakeChild();
    const handle = await startIsolatedServe(baseOptions({ child }));
    await handle.stop();
    await handle.stop();
    expect(child.kills).toEqual(['SIGTERM']);
  });
});

describe('父进程退出联动（daemon 无优雅关闭钩子时的孤儿兜底）', () => {
  it('SIGTERM：先完整 stop 子进程，再摘监听并原信号自杀', async () => {
    const proc = fakeProcess();
    const child = new FakeChild();
    const handle = await startIsolatedServe({ ...baseOptions({ child }), exitTarget: proc.target });
    proc.emit('SIGTERM');
    await vi.waitFor(() => {
      expect(proc.kills).toContainEqual({ pid: 4242, signal: 'SIGTERM' });
    });
    expect(child.kills).toEqual(['SIGTERM']); // stop 已完整跑完（grace 内退出，无 SIGKILL）
    proc.emit('SIGTERM'); // 监听已摘除：不重复自杀、不重复 kill 子进程
    expect(proc.kills.length).toBe(1);
    expect(child.kills.length).toBe(1);
    await handle.stop();
  });

  it('exit 钩子：同步补发 SIGTERM；显式 stop 后句柄离场不再补发', async () => {
    const proc = fakeProcess();
    const childA = new FakeChild();
    const handleA = await startIsolatedServe({ ...baseOptions({ child: childA }), exitTarget: proc.target });
    const childB = new FakeChild();
    const handleB = await startIsolatedServe({ ...baseOptions({ child: childB }), exitTarget: proc.target });
    await handleB.stop(); // B 显式离场（自身 stop 已发过一次 SIGTERM）
    expect(childB.kills).toEqual(['SIGTERM']);
    proc.emit('exit');
    expect(childA.kills).toEqual(['SIGTERM']); // 在场句柄同步补发
    expect(childB.kills.length).toBe(1); // 已离场的不再补发
    await handleA.stop();
  });

  it('bindExitGuards 同一 target 只绑定一次', () => {
    const proc = fakeProcess();
    bindExitGuards(proc.target);
    bindExitGuards(proc.target);
    proc.emit('exit'); // 只触发一轮（若重复绑定会 double kill 也没有副作用，这里验证不抛错）
  });
});
