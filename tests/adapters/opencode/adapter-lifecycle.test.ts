// T013 adapter 生命周期测试（验收标准 2/3/4）：懒启动单飞、隔离参数落到真实
// spawn 调用、probe 失败收敛为 unavailable（D8）、dispose 无孤儿、dispose 后可重启。
// 走生产 OpenCodeAdapter + isolate + client + catalog + session 全栈，只注入
// spawn/exec/fetch/二进制定位（lessons #2：测试 import 生产模块）。

import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenCodeAdapter, type OpenCodeAdapterOptions } from '../../../src/adapters/opencode/index.js';
import type { ServeChild } from '../../../src/adapters/opencode/isolate.js';
import {
  FakeChild,
  fakeFetch,
  fakeProcess,
  jsonResponse,
  messageResponseFixture,
  pathOf,
  providerDirectoryFixture,
  type RecordedCall,
} from './fakes.js';

interface Harness {
  adapter: OpenCodeAdapter;
  root: string;
  children: FakeChild[];
  execCalls: { args: readonly string[]; cwd: string }[];
  spawnCalls: Array<{ env: Record<string, string>; args: readonly string[] }>;
  calls: RecordedCall[];
}

function makeAdapter(
  overrides: Partial<OpenCodeAdapterOptions> & { health?: () => unknown; directory?: unknown } = {},
): Harness {
  const { health, directory = providerDirectoryFixture, ...rest } = overrides;
  const children: FakeChild[] = [];
  const execCalls: { args: readonly string[]; cwd: string }[] = [];
  const spawnCalls: Array<{ env: Record<string, string>; args: readonly string[] }> = [];
  const { fetchImpl, calls } = fakeFetch((call) => {
    const path = pathOf(call.url);
    if (path === '/global/health') return jsonResponse(health?.() ?? { healthy: true, version: '1.18.31' });
    if (path === '/provider') return jsonResponse(directory);
    if (path === '/session' && call.method === 'POST') return jsonResponse({ id: 'ses_1' });
    if (path === '/permission' && call.method === 'GET') return jsonResponse([]);
    if (path === '/session/ses_1/message' && call.method === 'POST') return jsonResponse(messageResponseFixture);
    if (path === '/session/ses_1/abort' && call.method === 'POST') return jsonResponse({});
    if (path === '/session/ses_1' && call.method === 'DELETE') return jsonResponse({});
    throw new Error(`unexpected request: ${call.method} ${path}`);
  });
  const spawnImpl = (file: string, args: readonly string[], options: { cwd: string; env: Record<string, string> }): ServeChild => {
    spawnCalls.push({ env: options.env, args });
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  const root = mkdtempSync(join(tmpdir(), 'oc-adapter-'));
  const adapter = new OpenCodeAdapter({
    xdgRoot: root,
    env: { PATH: '/usr/bin:/bin', ANTHROPIC_API_KEY: 'sk-leak', OPENAI_API_KEY: 'sk-leak' },
    resolveRuntime: async () => ({ path: '/fake/opencode', version: '1.18.31' }),
    spawnImpl,
    execImpl: async (_file, args, options) => {
      execCalls.push({ args, cwd: options.cwd });
      return { stdout: '' };
    },
    fetchImpl,
    healthAttempts: 20,
    healthIntervalMs: 1,
    stopGraceMs: 30,
    exitTarget: fakeProcess().target,
    ...rest,
  });
  return { adapter, root, children, execCalls, spawnCalls, calls };
}

describe('OpenCodeAdapter 生命周期（全栈注入）', () => {
  it('probe：available + 免费清单（cost 全 0 过滤 + 元数据）', async () => {
    const h = makeAdapter();
    const probe = await h.adapter.probe();
    expect(probe.availability).toBe('available');
    expect(probe.models.map((m) => m.id)).toEqual(['mimo-v2.6-flash-free', 'space-bunny-free']);
    const mimo = probe.models[0]!;
    expect(mimo.provider).toBe('opencode');
    expect(mimo.minCtx).toBe(200000);
    expect(mimo.tags).toEqual(['chat', 'toolcall', 'image', 'reasoning']);
    await h.adapter.dispose();
  });

  it('懒启动单飞：probe×2 + fetchQuota + launch 只 spawn 一次；启动前刷新目录', async () => {
    const h = makeAdapter();
    await h.adapter.probe();
    await h.adapter.probe();
    await h.adapter.fetchQuota();
    await h.adapter.launch({ localSecret: 'x' });
    expect(h.children.length).toBe(1);
    expect(h.execCalls[0]?.args).toEqual(['models', 'opencode', '--refresh', '--pure']);
    await h.adapter.dispose();
  });

  it('隔离参数落到 spawn：白名单 env + XDG 重定向 + 48 位 hex 隔离密码', async () => {
    const h = makeAdapter();
    await h.adapter.probe();
    const spawn = h.spawnCalls[0]!;
    expect(spawn.args).toEqual(expect.arrayContaining(['serve', '--pure', '--hostname', '127.0.0.1', '--port']));
    expect(spawn.env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(spawn.env['OPENAI_API_KEY']).toBeUndefined();
    expect(spawn.env['XDG_CONFIG_HOME']).toBe(join(h.root, 'config'));
    expect(spawn.env['XDG_STATE_HOME']).toBe(join(h.root, 'state'));
    expect(spawn.env['OPENCODE_SERVER_PASSWORD']).toMatch(/^[0-9a-f]{48}$/);
    await h.adapter.dispose();
  });

  it('launch → runTurn 出真实文本（消息 payload 剥前缀、DELETE 收尾）', async () => {
    const h = makeAdapter();
    const session = await h.adapter.launch({ localSecret: 's' });
    let text = '';
    for await (const chunk of session.runTurn({
      model: 'opencode/mimo-v2.6-flash-free',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    })) {
      text += chunk.delta;
    }
    await session.cancel();
    expect(text).toBe('OCFREE_OK');
    const message = h.calls.find((c) => pathOf(c.url) === '/session/ses_1/message');
    expect((message?.body as { model: { modelID: string } }).model.modelID).toBe('mimo-v2.6-flash-free');
    await h.adapter.dispose();
  });

  it('dispose：SIGTERM 回收、幂等；dispose 后 probe 重新拉起', async () => {
    const h = makeAdapter();
    await h.adapter.probe();
    await h.adapter.dispose();
    expect(h.children[0]!.kills).toEqual(['SIGTERM']);
    await h.adapter.dispose(); // 幂等
    const probe2 = await h.adapter.probe();
    expect(probe2.availability).toBe('available');
    expect(h.children.length).toBe(2); // 重启
    await h.adapter.dispose();
  });

  it('无二进制：probe 收敛 unavailable / fetchQuota unknown，不抛错不 spawn（D8）', async () => {
    const h = makeAdapter({
      resolveRuntime: async () => {
        throw new Error('找不到可用的 opencode 二进制');
      },
    });
    const probe = await h.adapter.probe();
    expect(probe).toEqual({ availability: 'unavailable', models: [] });
    expect(await h.adapter.fetchQuota()).toBe('unknown');
    expect(h.children.length).toBe(0);
  });

  it('目录缺 opencode provider：probe unavailable（adapter 级失败收敛）', async () => {
    const h = makeAdapter({ directory: { all: [{ id: 'deepinfra', models: {} }] } });
    const probe = await h.adapter.probe();
    expect(probe.availability).toBe('unavailable');
    await h.adapter.dispose();
  });

  it('启动中途 dispose：启动落定后必停，无孤儿', async () => {
    const h = makeAdapter({ health: () => ({ healthy: false }) });
    const probePromise = h.adapter.probe();
    await vi.waitFor(() => {
      expect(h.children.length).toBe(1);
    });
    await h.adapter.dispose();
    const probe = await probePromise;
    expect(probe.availability).toBe('unavailable');
    await vi.waitFor(() => {
      expect(h.children[0]!.kills.length).toBeGreaterThanOrEqual(1);
    });
  });
});
