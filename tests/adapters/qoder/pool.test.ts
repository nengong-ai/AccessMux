import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QoderProcessPool } from '../../../src/adapters/qoder/pool.js';
import { FakeQoderChild, fakeExitTarget, scriptedSpawn } from './fakes.js';

describe('Qoder 请求隔离池 B08/R02', () => {
  let root: string;
  const pools: QoderProcessPool[] = [];
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'qoder-isolation-')); });
  afterEach(async () => { await Promise.all(pools.splice(0).map((p) => p.dispose())); await rm(root, { recursive: true, force: true }); });
  function make(children: FakeQoderChild[], resolveRuntime = async () => ({ path: '/fake/qoder', version: 'fake' })) {
    const spawn = scriptedSpawn(children);
    const pool = new QoderProcessPool({ root, spawnImpl: spawn, exitTarget: fakeExitTarget().target, resolveRuntime });
    pools.push(pool);
    return { pool, spawn };
  }
  it('每个同模型请求都 spawn 新 CLI，release 幂等且清临时 workspace', async () => {
    const a = new FakeQoderChild(), b = new FakeQoderChild();
    const { pool, spawn } = make([a, b]);
    const first = await pool.acquire('same');
    first.reportTurn({ ok: true });
    await first.release(); await first.release();
    expect(a.exitCode).toBe(0); expect(pool.liveCount()).toBe(0);
    const second = await pool.acquire('same');
    expect(second.process).not.toBe(first.process); expect(spawn.calls).toBe(2);
    second.reportTurn({ ok: true }); await second.release();
    expect(await readdir(root)).toEqual([]);
  });
  it('排队取消立即拒绝，不 spawn；不能提前解锁仍活跃的前一个请求', async () => {
    const { pool, spawn } = make([new FakeQoderChild(), new FakeQoderChild()]);
    const first = await pool.acquire('same');
    const controller = new AbortController();
    const cancelled = pool.acquire('same', controller.signal);
    const assertion = expect(cancelled).rejects.toThrow('cancelled');
    controller.abort(new Error('cancelled')); await assertion;
    let acquired = false;
    const third = pool.acquire('same').then((lease) => { acquired = true; return lease; });
    await new Promise((r) => setTimeout(r, 10));
    expect(acquired).toBe(false); expect(spawn.calls).toBe(1);
    first.reportTurn({ ok: true }); await first.release();
    await (await third).discard(); expect(spawn.calls).toBe(2);
  });
  it('runtime 定位挂起时取消：延迟完成后也不得 spawn/send', async () => {
    let resolve!: (value: { path: string; version: string }) => void;
    const resolver = vi.fn(() => new Promise<{ path: string; version: string }>((r) => { resolve = r; }));
    const { pool, spawn } = make([], resolver);
    const controller = new AbortController();
    const attempt = pool.acquire('same', controller.signal);
    const assertion = expect(attempt).rejects.toThrow('cancelled');
    await vi.waitFor(() => expect(resolver).toHaveBeenCalled());
    controller.abort(new Error('cancelled')); await assertion;
    resolve({ path: '/fake/qoder', version: 'fake' });
    await Promise.resolve(); expect(spawn.calls).toBe(0);
  });
  it('dispose 拒绝排队/启动并 SIGKILL 所有活动请求；不同模型互不误杀', async () => {
    const a = new FakeQoderChild(), b = new FakeQoderChild();
    const { pool } = make([a, b]);
    const first = await pool.acquire('a'); const second = await pool.acquire('b');
    await first.discard(); expect(a.kills).toContain('SIGKILL'); expect(second.process.alive).toBe(true);
    const waiting = pool.acquire('b'); const assertion = expect(waiting).rejects.toThrow('已 dispose');
    await pool.dispose(); await assertion; await pool.dispose();
    expect(b.kills).toContain('SIGKILL'); expect(pool.liveCount()).toBe(0);
    await expect(pool.acquire('a')).rejects.toThrow('已 dispose');
  });
});
