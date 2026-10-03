// T020 会话单测：stream-json 驱动循环（delta 聚合/错误/中途退出/cancel/模型拦截）。

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QoderProcessPool } from '../../../src/adapters/qoder/pool.js';
import { QoderSession } from '../../../src/adapters/qoder/session.js';
import { FakeQoderChild, drainChunks, fakeExitTarget, scriptedSpawn, wireResponder } from './fakes.js';

describe('QoderSession', () => {
  let root: string;
  let exitTarget: ReturnType<typeof fakeExitTarget>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'accessmux-qoder-sess-'));
    exitTarget = fakeExitTarget();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function makeSession(children: FakeQoderChild[], knownModels?: string[]) {
    const spawn = scriptedSpawn(children);
    const pool = new QoderProcessPool({
      resolveRuntime: async () => ({ path: '/fake/qoderclicn', version: '1.1.61' }),
      root,
      spawnImpl: spawn,
      exitTarget: exitTarget.target,
      idleMs: 60_000,
      log: () => undefined,
    });
    const session = new QoderSession(pool, { knownModels, log: () => undefined });
    return { pool, session, spawn };
  }

  it('B08 A/B 独立会话、第二轮、done-break 都只使用本请求上下文', async () => {
    const children = Array.from({ length: 3 }, () => new FakeQoderChild());
    for (const child of children) {
      let history = '';
      child.onStdinLine = (line) => {
        history += (JSON.parse(line) as { message: { content: Array<{ text: string }> } }).message.content[0]?.text;
        child.emitEvent({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: history }] } });
        child.emitEvent({ type: 'result', is_error: false, result: history, subtype: 'success' });
      };
    }
    const { pool, session, spawn } = makeSession([...children]);
    const other = new QoderSession(pool);
    const input = (text: string) => ({ model: 'qfmodel', messages: [{ role: 'user', content: text }], stream: true });
    const a = drainChunks(session.runTurn(input('PRIVATE_A')));
    const b = drainChunks(other.runTurn(input('PRIVATE_B')));
    expect((await a).map((c) => c.delta).join('')).toBe('PRIVATE_A');
    expect((await b).map((c) => c.delta).join('')).toBe('PRIVATE_B');
    let second = ''; for await (const chunk of session.runTurn(input('SECOND'))) { second += chunk.delta; if (chunk.done) break; }
    expect(second).toBe('SECOND'); expect(spawn.calls).toBe(3); expect(pool.liveCount()).toBe(0);
    expect(children.every((c) => c.stdinWrites.length === 1 && c.exitCode === 0)).toBe(true);
    await pool.dispose();
  });
  it('R02 排队 session cancel 后不 send，也不误杀前一请求', async () => {
    const child = new FakeQoderChild();
    const { pool, session, spawn } = makeSession([child]);
    const first = await pool.acquire('qfmodel');
    const pending = drainChunks(session.runTurn({ model: 'qfmodel', messages: [{ role: 'user', content: 'cancel-me' }], stream: true }));
    const assertion = expect(pending).rejects.toThrow('取消');
    await session.cancel(); await assertion;
    expect(first.process.alive).toBe(true); expect(child.stdinWrites).toHaveLength(0); expect(spawn.calls).toBe(1);
    await first.discard(); await pool.dispose();
  });
  it('R10 无 result deadline 杀底层，队列解锁可重试', async () => {
    const stalled = new FakeQoderChild(), fresh = new FakeQoderChild(); wireResponder(fresh);
    const { pool } = makeSession([stalled, fresh]);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const timeoutSession = new QoderSession(pool, { turnTimeoutMs: 300_000 });
    let sent!: () => void;
    const sending = new Promise<void>((resolve) => { sent = resolve; });
    stalled.onStdinLine = sent;
    const turn = drainChunks(timeoutSession.runTurn({ model: 'qfmodel', messages: [{ role: 'user', content: 'stall' }], stream: true }));
    const assertion = expect(turn).rejects.toThrow('超时');
    try {
      await sending; // filesystem/startup 真正完成后，才推进合成 deadline
      await vi.advanceTimersByTimeAsync(300_000);
      await assertion;
      expect(stalled.kills).toContain('SIGKILL'); expect(pool.liveCount()).toBe(0);
    } finally { vi.useRealTimers(); }
    await drainChunks(new QoderSession(pool).runTurn({ model: 'qfmodel', messages: [{ role: 'user', content: 'retry' }], stream: true }));
    await pool.dispose();
  });
  it('R10 启动挂起 deadline 立即退出，runtime 后来完成也不 spawn', async () => {
    let located!: (value: { path: string; version: string }) => void;
    let locating!: () => void;
    const started = new Promise<void>((r) => { locating = r; });
    const spawn = scriptedSpawn([]);
    const pool = new QoderProcessPool({ root, exitTarget: exitTarget.target, spawnImpl: spawn, resolveRuntime: () => { locating(); return new Promise((r) => { located = r; }); } });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const turn = drainChunks(new QoderSession(pool, { turnTimeoutMs: 100 }).runTurn({ model: 'qfmodel', messages: [{ role: 'user', content: 'stall-start' }], stream: true }));
    const assertion = expect(turn).rejects.toThrow('超时');
    try {
      await started; await vi.advanceTimersByTimeAsync(100); await assertion;
      located({ path: '/fake/qoder', version: 'fake' }); await Promise.resolve();
      expect(spawn.calls).toBe(0); expect(pool.liveCount()).toBe(0);
    } finally { vi.useRealTimers(); await pool.dispose(); }
  });
  it('B04 result 错误回声脱敏，不影响正常模型正文', async () => {
    const child = new FakeQoderChild();
    child.onStdinLine = () => child.emitEvent({ type: 'result', is_error: true, result: 'PAT=tiny Authorization: Cloud-IDE-JWT small', subtype: 'error' });
    const { pool, session } = makeSession([child]);
    const error = await drainChunks(session.runTurn({ model: 'qfmodel', messages: [{ role: 'user', content: 'hi' }], stream: true })).catch((e: Error) => e);
    expect(String(error)).not.toContain('tiny'); expect(String(error)).not.toContain('small');
    await pool.dispose();
  });
  it('happy path：thinking 丢弃、text 作 delta、result 收尾 done', async () => {
    const child = new FakeQoderChild();
    wireResponder(child, 'AMUX_QODER_OK');
    const { pool, session } = makeSession([child]);
    const chunks = await drainChunks(session.runTurn({
      model: 'qfmodel',
      messages: [{ role: 'user', content: 'ping' }],
      stream: true,
    }));
    expect(chunks).toEqual([
      { delta: 'AMUX_QODER_OK', done: false },
      {
        delta: '',
        done: true,
        // T023：上游零计量面 → 本地估算，必须带 estimated 标识
        usage: {
          prompt_tokens: 1,
          completion_tokens: 4,
          total_tokens: 5,
          estimated: true,
        },
      },
    ]);
    // stdin 收到的是合法 user envelope，且单条折叠
    expect(child.stdinWrites).toHaveLength(1);
    const env = JSON.parse(child.stdinWrites[0] as string) as Record<string, unknown>;
    expect(env['type']).toBe('user');
    await pool.dispose();
  });

  it('多轮+system 折叠成单条转录（含 system 段）', async () => {
    const child = new FakeQoderChild();
    wireResponder(child);
    const { pool, session } = makeSession([child]);
    await drainChunks(session.runTurn({
      model: 'qfmodel',
      messages: [
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'A' },
        { role: 'assistant', content: 'B' },
        { role: 'user', content: 'C' },
      ],
      stream: false,
    }));
    const env = JSON.parse(child.stdinWrites[0] as string) as {
      message: { content: Array<{ text: string }> };
    };
    expect(env.message.content[0]?.text).toBe('Be terse.\n\nuser:\nA\n\nassistant:\nB\n\nuser:\nC');
    await pool.dispose();
  });

  it('已知清单非空时未知模型客户端拦截（防落 Auto 烧额度）；qfmodel 放行', async () => {
    const child = new FakeQoderChild();
    wireResponder(child);
    const { pool, session, spawn } = makeSession([child], ['Qwen3.8-Flash']);
    await expect(
      drainChunks(session.runTurn({
        model: 'No-Such-Model',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      })),
    ).rejects.toThrow('未知模型');
    expect(spawn.calls).toBe(0); // 拦截在 spawn 前
    // 清单内模型 + qfmodel 都放行
    await drainChunks(session.runTurn({
      model: 'Qwen3.8-Flash',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    }));
    await pool.dispose();
  });

  it('is_error 的 result 抛错（上游错误原文透出）', async () => {
    const child = new FakeQoderChild();
    child.onStdinLine = () => {
      child.emitEvent({
        type: 'result',
        subtype: 'error',
        is_error: true,
        result: 'Not logged in · Please run /login',
      });
    };
    const { pool, session } = makeSession([child]);
    await expect(
      drainChunks(session.runTurn({
        model: 'qfmodel',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      })),
    ).rejects.toThrow('Not logged in');
    await pool.dispose();
  });

  it('进程回合中途退出 → 抛"中途退出"错误，进程池下轮重连', async () => {
    const dead = new FakeQoderChild();
    const fresh = new FakeQoderChild();
    wireResponder(fresh, 'AFTER_RECONNECT');
    const { pool, session, spawn } = makeSession([dead, fresh]);
    const attempt = drainChunks(session.runTurn({
      model: 'qfmodel',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    }));
    await vi.waitFor(() => expect(dead.stdinWrites.length).toBeGreaterThan(0));
    dead.exit(1);
    await expect(attempt).rejects.toThrow('中途退出');
    // 下轮自动重起新进程并成功
    const chunks = await drainChunks(session.runTurn({
      model: 'qfmodel',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    }));
    expect(spawn.calls).toBe(2);
    expect(chunks.some((c) => c.delta === 'AFTER_RECONNECT')).toBe(true);
    await pool.dispose();
  });

  it('cancel：回合中杀进程；回合结束后的 cancel 是 no-op', async () => {
    const child = new FakeQoderChild(); // 不回包：回合挂起
    const { pool, session } = makeSession([child]);
    const turn = drainChunks(session.runTurn({
      model: 'qfmodel',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    }));
    await vi.waitFor(() => expect(child.stdinWrites).toHaveLength(1));
    await session.cancel();
    await expect(turn).rejects.toThrow('中途退出');
    // 生成期间 SIGTERM 被忽略（真机实测）→ cancel 走 SIGKILL 丢弃
    expect(child.kills).toContain('SIGKILL');
    // 正常结束后 cancel 不再杀（保住常驻进程）
    const child2 = new FakeQoderChild();
    wireResponder(child2);
    const spawn2 = scriptedSpawn([child2]);
    const pool2 = new QoderProcessPool({
      resolveRuntime: async () => ({ path: '/fake/qoderclicn', version: '1.1.61' }),
      root,
      spawnImpl: spawn2,
      exitTarget: exitTarget.target,
      idleMs: 60_000,
    });
    const session2 = new QoderSession(pool2, { log: () => undefined });
    await drainChunks(session2.runTurn({
      model: 'qfmodel',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    }));
    await session2.cancel(); // no-op：不应有 kill
    expect(child2.kills.filter((k) => k === 'SIGTERM')).toHaveLength(0);
    await pool.dispose();
    await pool2.dispose();
  });
});
