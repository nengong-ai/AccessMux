// ShimSessionPool 单测（T010 #2 的基础设施）。
// 用可控 fake shim（可控关闭耗时）精确验证：
// - 并发 acquire 串行创建（绝不双开）；
// - 关闭窗口内 acquire 等待，不撞"正在关闭"的 shim；
// - release 幂等；dispose 强制清场。

import { describe, expect, it } from 'vitest';
import { ShimSessionPool } from '../../src/protocol/shim-session-pool.js';
import type { LoopbackShim } from '../../src/protocol/shim.js';

interface FakeShim extends LoopbackShim {
  readonly id: number;
  readonly closeStarted: Promise<void>;
  closeCalls: number;
}

function makeFakeShim(id: number, closeDelayMs = 0): FakeShim {
  let closeStartedResolve!: () => void;
  const closeStarted = new Promise<void>((r) => { closeStartedResolve = r; });
  const shim = {
    id,
    closeCalls: 0,
    closeStarted,
    ready: Promise.resolve(),
    baseUrl: () => `http://127.0.0.1:1/fake-${id}`,
    token: () => `token-${id}`,
    close(): Promise<void> {
      this.closeCalls += 1;
      closeStartedResolve();
      return new Promise((r) => setTimeout(r, closeDelayMs));
    },
  };
  return shim;
}

describe('ShimSessionPool', () => {
  it('并发 acquire 全部复用同一 shim，createShim 只被调一次', async () => {
    const pool = new ShimSessionPool();
    const created: FakeShim[] = [];
    const leases = await Promise.all(
      Array.from({ length: 10 }, async () =>
        pool.acquire(async () => {
          const shim = makeFakeShim(created.length + 1);
          created.push(shim);
          return shim;
        })),
    );
    expect(created).toHaveLength(1);
    expect(new Set(leases.map((l) => l.shim)).size).toBe(1);
    expect(pool.stats()).toEqual({ sessions: 10, hasShim: true, closing: false });
    for (const l of leases) l.release();
    // 全部 release 后 shim 异步关闭
    await pool.dispose();
    expect(created[0]?.closeCalls).toBe(1);
  });

  it('release 归 0 后下一次 acquire 拿到新 shim；重复 release 无副作用', async () => {
    const pool = new ShimSessionPool();
    const shims: FakeShim[] = [];
    const create = async (): Promise<FakeShim> => {
      const shim = makeFakeShim(shims.length + 1);
      shims.push(shim);
      return shim;
    };
    const l1 = await pool.acquire(create);
    l1.release();
    l1.release(); // 幂等：第二次不算数
    l1.release();
    const l2 = await pool.acquire(create);
    expect(l2.shim).not.toBe(l1.shim);
    expect(shims).toHaveLength(2);
    l2.release();
    await pool.dispose();
  });

  it('关闭窗口内并发 acquire：等旧 shim 关完才建新 shim（T010 竞态窗口）', async () => {
    const pool = new ShimSessionPool();
    const shims: FakeShim[] = [];
    const create = async (): Promise<FakeShim> => {
      const shim = makeFakeShim(shims.length + 1, 40); // 关闭耗时 40ms
      shims.push(shim);
      return shim;
    };
    const l1 = await pool.acquire(create);
    const shim1 = l1.shim as FakeShim;
    l1.release();
    // 不等待关闭完成，立刻并发 acquire（旧实现此处撞 already-running）
    const [l2, l3] = await Promise.all([pool.acquire(create), pool.acquire(create)]);
    // 旧 shim 确实被等完了（close 已发生），新 shim 是同一个实例
    expect(shim1.closeCalls).toBe(1);
    expect(l2.shim).toBe(l3.shim);
    expect(l2.shim).not.toBe(shim1);
    expect(shims).toHaveLength(2);
    l2.release();
    l3.release();
    await pool.dispose();
  });

  it('createShim 抛错：acquire 原样上抛，池状态干净可重试', async () => {
    const pool = new ShimSessionPool();
    let attempts = 0;
    await expect(
      pool.acquire(async () => {
        attempts += 1;
        throw new Error('credential boom');
      }),
    ).rejects.toThrow('credential boom');
    expect(attempts).toBe(1);
    expect(pool.stats()).toEqual({ sessions: 0, hasShim: false, closing: false });
    // 失败后重试成功
    const shim = makeFakeShim(99);
    const lease = await pool.acquire(async () => shim);
    expect(lease.shim).toBe(shim);
    lease.release();
    await pool.dispose();
  });

  it('dispose 无视引用计数强制清场，之后 acquire 可重建', async () => {
    const pool = new ShimSessionPool();
    const shims: FakeShim[] = [];
    const create = async (): Promise<FakeShim> => {
      const shim = makeFakeShim(shims.length + 1);
      shims.push(shim);
      return shim;
    };
    const l1 = await pool.acquire(create);
    await pool.acquire(create); // 不 release，直接 dispose
    await pool.dispose();
    expect(shims[0]?.closeCalls).toBe(1);
    l1.release(); // dispose 之后的迟到 release 不能复活旧 shim
    expect(pool.stats()).toEqual({ sessions: 0, hasShim: false, closing: false });
    const l2 = await pool.acquire(create);
    expect(l2.shim).not.toBe(shims[0]);
    l2.release();
    await pool.dispose();
  });
});
