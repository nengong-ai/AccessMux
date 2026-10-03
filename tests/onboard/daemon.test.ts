// T011 · daemon 起/复用测试（fetch 与 spawn 全注入，离线）。
import { chmodSync, fstatSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { spawn as SpawnT } from 'node:child_process';
import { daemonLogPath, ensureDaemon } from '../../src/onboard/daemon.js';
import { dirname } from 'node:path';

let tmpDir = '';
beforeEach(() => {
  tmpDir = join(tmpdir(), `accessmux-dmn-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  // 假仓库根：确保 dist/cli/index.js 存在（ensureDaemon 的 spawn 前置检查）
  mkdirSync(join(tmpDir, 'dist', 'cli'), { recursive: true });
  writeFileSync(join(tmpDir, 'dist', 'cli', 'index.js'), '#!/usr/bin/env node\n');
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function okHealth(): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ ok: true, service: 'accessmux', adapters: ['fake'] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
}

function deadHealth(): typeof fetch {
  return (async () => {
    throw new Error('connect ECONNREFUSED');
  }) as unknown as typeof fetch;
}

/** 先拒绝 N 次再变好（模拟 spawn 后 daemon 渐渐 ready） */
function flappingHealth(failTimes: number): typeof fetch {
  let calls = 0;
  return (async () => {
    calls++;
    if (calls <= failTimes) throw new Error('connect ECONNREFUSED');
    return new Response(JSON.stringify({ ok: true, service: 'accessmux' }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe('ensureDaemon', () => {
  it('health 通则复用，不 spawn', async () => {
    let spawned = 0;
    const spawnFn = (async () => {
      spawned++;
      return {} as Awaited<ReturnType<typeof SpawnT>>;
    }) as unknown as typeof SpawnT;
    const handle = await ensureDaemon(8080, {
      fetchFn: okHealth(),
      spawnFn,
      repoRoot: tmpDir,
    });
    expect(handle.started).toBe(false);
    expect(handle.baseURL).toBe('http://127.0.0.1:8080');
    expect(spawned).toBe(0);
  });

  it('health 不通则 spawn 并轮询到 ready（spawn 参数走生产入口）', async () => {
    let spawnArgs: { cmd: string; args: string[] } | null = null;
    const spawnFn = ((cmd: string, args: string[]) => {
      spawnArgs = { cmd, args };
      return { unref: () => {} } as unknown as Awaited<ReturnType<typeof SpawnT>>;
    }) as unknown as typeof SpawnT;
    const handle = await ensureDaemon(9099, {
      fetchFn: flappingHealth(2),
      spawnFn,
      repoRoot: tmpDir,
      readyTimeoutMs: 5000,
      configPath: join(tmpDir, 'chosen.yaml'),
    });
    expect(handle.started).toBe(true);
    expect(handle.port).toBe(9099);
    expect(spawnArgs?.args).toEqual([join(tmpDir, 'dist', 'cli', 'index.js'), 'serve', '--port', '9099', '--config', join(tmpDir, 'chosen.yaml')]);
  }, 10000);

  it('daemon 日志先私有原子替换，父进程spawn后关闭fd', async () => {
    const path = daemonLogPath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'old log', { mode: 0o644 });
    chmodSync(path, 0o644);
    chmodSync(dirname(path), 0o755);
    let fd = -1;
    const spawnFn = ((_cmd: string, _args: string[], options: { stdio: unknown[] }) => {
      fd = options.stdio[1] as number;
      expect(fstatSync(fd).mode & 0o777).toBe(0o600);
      return { unref: () => {} };
    }) as unknown as typeof SpawnT;
    await ensureDaemon(9099, { fetchFn: flappingHealth(1), spawnFn, repoRoot: tmpDir });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    expect(() => fstatSync(fd)).toThrow();
  });

  it('一直不 ready 则超时报可读错误', async () => {
    const spawnFn = (() => ({ unref: () => {} })) as unknown as typeof SpawnT;
    await expect(
      ensureDaemon(9098, {
        fetchFn: deadHealth(),
        spawnFn,
        repoRoot: tmpDir,
        readyTimeoutMs: 1200,
      }),
    ).rejects.toThrow(/启动超时/);
  });

  it('仓库根没有 dist 入口时报"先 build"指引', async () => {
    const emptyRoot = join(tmpDir, 'empty');
    mkdirSync(emptyRoot, { recursive: true });
    const spawnFn = (() => ({ unref: () => {} })) as unknown as typeof SpawnT;
    await expect(
      ensureDaemon(9097, { fetchFn: deadHealth(), spawnFn, repoRoot: emptyRoot }),
    ).rejects.toThrow(/npm run build/);
  });
});
