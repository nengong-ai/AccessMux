// T011 · `accessmux onboard` 端到端测试：fixture HOME + 注入 fake daemon + 注入交互，
// 全程离线。覆盖：检测→询问→接入→冒烟→完成清单、幂等重跑、dry-run 不写盘、
// 非 TTY 无 --yes 报错、部分宿主失败不影响其余。
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { spawn as SpawnT } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runOnboard } from '../../src/onboard/onboard.js';
import { fixtureUiResponse } from './fixture-ui.js';

let home = '';
let repoRoot = '';
let logs: string[];
let asked: string[];

beforeEach(() => {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  home = join(tmpdir(), `accessmux-e2e-${id}`);
  repoRoot = join(tmpdir(), `accessmux-e2e-repo-${id}`);
  mkdirSync(home, { recursive: true });
  mkdirSync(join(repoRoot, 'dist', 'cli'), { recursive: true });
  logs = [];
  asked = [];
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repoRoot, { recursive: true, force: true });
});

const MODELS = ['workbuddy:hy4-preview', 'trae-cn:glm-5.2', 'trae-global:gpt-5.4'];

function fakeDaemon(models: string[] = MODELS): { fetchFn: typeof fetch; chatCalls: () => string[] } {
  const chats: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const ui = fixtureUiResponse(input); if (ui) return ui;
    if (url.endsWith('/health')) {
      return new Response(JSON.stringify({ ok: true, service: 'accessmux', adapters: ['workbuddy', 'trae-cn'] }), {
        status: 200,
      });
    }
    if (url.endsWith('/v1/models')) {
      return new Response(
        JSON.stringify({ object: 'list', data: models.map((id) => ({ id })) }),
        { status: 200 },
      );
    }
    if (url.endsWith('/v1/chat/completions')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
      chats.push(body.model ?? '?');
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'pong' } }] }),
        { status: 200 },
      );
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchFn, chatCalls: () => chats };
}

function deps(overrides: Record<string, unknown> = {}, models: string[] = MODELS) {
  const { fetchFn } = fakeDaemon(models);
  return {
    openUi: async () => true,
    homeDir: home,
    repoRoot,
    port: 8080,
    fetchFn,
    spawnFn: (() => ({ unref: () => {} })) as unknown as typeof SpawnT,
    now: () => new Date('2026-09-30T12:00:00'),
    ask: async (q: string) => {
      asked.push(q);
      return true;
    },
    closeAsk: () => {},
    log: (line?: string) => {
      logs.push(line ?? '');
    },
    sleep: async () => {},
    isTTY: true,
    ...overrides,
  };
}

function setupAllHostsFresh(): void {
  mkdirSync(join(home, '.zcode/v2'), { recursive: true });
  writeFileSync(join(home, '.zcode/v2/provider_config.json'), zcodeFixture(), { mode: 0o600 });
  chmodSync(join(home, '.zcode/v2/provider_config.json'), 0o600);
  mkdirSync(join(home, '.workbuddy'), { recursive: true });
  writeFileSync(join(home, '.workbuddy/models.json'), '[]');
  mkdirSync(join(home, '.dsh/profiles/desktop'), { recursive: true });
  writeFileSync(
    join(home, '.dsh/profiles/desktop/package.json'),
    `{"name":"dsh-profile-desktop","dsh":{"profile":{"bundles":["dshmarket"]}},"dependencies":{"dshmarket":"^1"}}`,
  );
  const pluginDir = join(repoRoot, 'integrations/dsh-accessmux-connect');
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'package.json'), '{"name":"dsh-accessmux-connect"}');
  // 指引型宿主
  mkdirSync(join(home, '.claude'), { recursive: true });
  mkdirSync(join(home, '.codex'), { recursive: true });
}

function zcodeFixture(): string {
  return `{
  "schemaVersion": 3,
  "config": {
    "providerOrder": ["keep-1"],
    "providerConfigRules": {
      "providerRules": [
        { "providerId": "keep-1", "providerName": "既有", "config": { "group": "x" } }
      ]
    },
    "defaultModelSelection": { "untouched": true }
  }
}`;
}

describe('runOnboard 端到端', () => {
  it('全流程：检测→询问→接入→冒烟→完成清单，退出码 0', async () => {
    setupAllHostsFresh();
    const d = deps();
    const code = await runOnboard({ allHosts: true, smokeAll: true }, d);
    expect(code).toBe(0);
    const out = logs.join('\n');
    // 检测清单包含全部宿主
    expect(out).toContain('ZCode');
    expect(out).toContain('WorkBuddy');
    expect(out).toContain('DeepSeek Harness');
    expect(out).toContain('Claude Code');
    // 询问发生在三个 auto 宿主上
    expect(asked.filter((q) => q.includes('接入')).length).toBe(3);
    // 三宿主接入成功 + 冒烟（走 fake daemon 的非流式 chat）
    expect(out).toMatch(/✓ ZCode：注册供应商「AccessMux」/);
    expect(out).toMatch(/✓ WorkBuddy：注册 2 个模型/); // 排除 workbuddy:* 自环后 3-1=2
    expect(out).toMatch(/✓ DeepSeek Harness（DSH）：安装插件/);
    // 完成清单含回滚命令
    expect(out).toMatch(/回滚：cp .*bak-pre-onboard/);
    // 指引型宿主给了接法
    expect(out).toContain('ANTHROPIC_BASE_URL');
    // 文件层验证
    const zc = JSON.parse(readFileSync(join(home, '.zcode/v2/provider_config.json'), 'utf8')) as {
      config: { providerOrder: string[]; providerConfigRules: { providerRules: { providerName: string }[] } };
    };
    expect(zc.config.providerOrder).toEqual(['keep-1', expect.any(String)]);
    expect(zc.config.providerConfigRules.providerRules[1]?.providerName).toBe('AccessMux');
    const wb = JSON.parse(readFileSync(join(home, '.workbuddy/models.json'), 'utf8')) as unknown[];
    expect(wb).toHaveLength(2);
    expect(existsSync(join(home, '.dsh/profiles/desktop/node_modules/dsh-accessmux-connect'))).toBe(true);
  });

  it('幂等：重跑后全部"已接入"、不产生新备份、文件内容不变', async () => {
    setupAllHostsFresh();
    await runOnboard({ allHosts: true, yes: true }, deps());
    const zcPath = join(home, '.zcode/v2/provider_config.json');
    const wbPath = join(home, '.workbuddy/models.json');
    const zc1 = readFileSync(zcPath, 'utf8');
    const wb1 = readFileSync(wbPath, 'utf8');
    const baks1 = bakCount();
    // 重跑
    logs = [];
    asked = [];
    const code = await runOnboard({ allHosts: true, yes: true }, deps());
    expect(code).toBe(0);
    const out = logs.join('\n');
    expect(out).toContain('已接入（本次未重复注册）');
    expect(asked).toHaveLength(0); // 已接入的不再询问
    expect(readFileSync(zcPath, 'utf8')).toBe(zc1); // 逐字节不变
    expect(readFileSync(wbPath, 'utf8')).toBe(wb1);
    expect(bakCount()).toBe(baks1); // 没有新备份
  });

  it('dry-run：不写任何文件、不询问、打印预览', async () => {
    setupAllHostsFresh();
    const zcPath = join(home, '.zcode/v2/provider_config.json');
    const before = readFileSync(zcPath, 'utf8');
    const code = await runOnboard({ dryRun: true }, deps());
    expect(code).toBe(0);
    expect(readFileSync(zcPath, 'utf8')).toBe(before);
    expect(readFileSync(join(home, '.workbuddy/models.json'), 'utf8')).toBe('[]');
    expect(asked).toHaveLength(0);
    expect(logs.join('\n')).toContain('[预览] ZCode');
    expect(bakCount()).toBe(0);
  });

  it.each(['fresh', 'onboarded', 'missing-login'] as const)('dry-run %s：无网络、spawn、日志或状态目录写入（含 --smoke）', async (state) => {
    setupAllHostsFresh();
    if (state === 'onboarded') await runOnboard({ allHosts: true, yes: true }, deps());
    if (state === 'missing-login') rmSync(join(home, '.zcode/v2/provider_config.json'));
    const snapshot = (): string => {
      const walk = (dir: string): unknown => readdirSync(dir, { withFileTypes: true }).map((f) => {
        const p = join(dir, f.name);
        return [f.name, f.isDirectory() ? walk(p) : f.isSymbolicLink() ? 'symlink' : readFileSync(p, 'hex')];
      });
      return JSON.stringify(walk(home));
    };
    const before = snapshot();
    logs = [];
    const forbidden = () => { throw new Error('dry-run side effect'); };
    const code = await runOnboard({ dryRun: true, smokeAll: true }, deps({
      fetchFn: forbidden, spawnFn: forbidden, ask: forbidden,
    }));
    expect(code).toBe(0);
    expect(snapshot()).toBe(before);
    expect(logs.join('\n')).toContain('模型数量未知');
    expect(logs.join('\n')).not.toContain('╔═ 接入完成');
  });

  it.each([false, true])('冒烟失败：退出非零、配置及回滚保留（already=%s）', async (already) => {
    setupAllHostsFresh();
    if (already) await runOnboard({ allHosts: true, yes: true }, deps());
    logs = [];
    const normal = fakeDaemon().fetchFn;
    const failed = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/v1/chat/completions')) return new Response('failure', { status: 500 });
      return normal(input, init);
    }) as typeof fetch;
    const code = await runOnboard({ allHosts: true, yes: true, smokeAll: true }, deps({ fetchFn: failed }));
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('部分完成');
    expect(logs.join('\n')).toContain('已接入但自检失败');
    expect(logs.join('\n')).not.toContain('╔═ 接入完成');
    expect(readFileSync(join(home, '.workbuddy/models.json'), 'utf8')).toContain('AccessMux');
    if (!already) expect(logs.join('\n')).toContain('回滚：');
  });

  it('非 TTY 且无 --yes：报错而不是挂死或误接入', async () => {
    setupAllHostsFresh();
    const d = deps({ isTTY: false });
    await expect(runOnboard({ allHosts: true }, d)).rejects.toThrow(/--yes/);
    // 没写任何文件
    expect(readFileSync(join(home, '.workbuddy/models.json'), 'utf8')).toBe('[]');
  });

  it('用户全选 n：不接入、退出 0、给指引', async () => {
    setupAllHostsFresh();
    const d = deps({ ask: async () => false });
    const code = await runOnboard({ allHosts: true }, d);
    expect(code).toBe(0);
    expect(readFileSync(join(home, '.workbuddy/models.json'), 'utf8')).toBe('[]');
    expect(logs.join('\n')).toContain('本次没有选择接入任何宿主');
  });

  it('单宿主失败不影响其余（DSH 插件源码缺失时 ZCode/WorkBuddy 照常接入）', async () => {
    setupAllHostsFresh();
    // detect 能过（profile 合法），onboard 时才发现插件源码不在 → 运行期失败
    rmSync(join(repoRoot, 'integrations'), { recursive: true, force: true });
    const code = await runOnboard({ allHosts: true, yes: true }, deps());
    expect(code).toBe(1); // 有失败项
    const out = logs.join('\n');
    expect(out).toContain('✓ ZCode：注册供应商「AccessMux」');
    expect(out).toContain('✓ WorkBuddy：注册 2 个模型');
    expect(out).toContain('插件源码不在预期位置');
    expect(out).toMatch(/✗ DeepSeek Harness（DSH）：失败/);
    // 失败宿主给了手动接法降级
    expect(out).toContain('手动接法');
  });

  it('一个宿主都没装：打印通用接法、退出 0', async () => {
    const code = await runOnboard({ allHosts: true, yes: true }, deps());
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('没有检测到支持的宿主');
  });

  it('smokeAll 对已接入宿主也重新冒烟', async () => {
    setupAllHostsFresh();
    await runOnboard({ allHosts: true, yes: true }, deps());
    logs = [];
    const d = deps();
    await runOnboard({ allHosts: true, yes: true, smokeAll: true }, d);
    const out = logs.join('\n');
    expect(out).toContain('自检');
    expect(out.match(/✓ ZCode：收到回复/g)?.length).toBe(1);
  });

  it('已接入宿主清单同步：桥接源新增模型 → 刷新写盘+备份；再跑已最新幂等（T024 束 1）', async () => {
    setupAllHostsFresh();
    await runOnboard({ allHosts: true, yes: true }, deps());
    const zcPath = join(home, '.zcode/v2/provider_config.json');
    const bak1 = bakCount();
    // 桥接源清单变化：4 个模型（原注册 3 + 1）
    const NEW = [...MODELS, 'opencode:mimo-v2.6-flash-free'];
    logs = [];
    const code = await runOnboard({ allHosts: true, yes: true }, deps({}, NEW));
    expect(code).toBe(0);
    const out = logs.join('\n');
    expect(out).toMatch(/↻ ZCode：同步模型清单（3 → 4 个模型/);
    const zc = JSON.parse(readFileSync(zcPath, 'utf8')) as {
      config: {
        providerConfigRules: {
          providerRules: { providerName: string; config: { personalModelIds: string[]; modelOrder: string[] } }[];
        };
      };
    };
    const amux = zc.config.providerConfigRules.providerRules.find((r) => r.providerName === 'AccessMux');
    expect(amux?.config.personalModelIds).toEqual(NEW);
    expect(amux?.config.modelOrder).toEqual(NEW);
    expect(bakCount()).toBe(bak1 + 1);
    const afterSync = readFileSync(zcPath, 'utf8');
    // 再跑同一清单：已最新 → 不写盘、不备份、无新备份文件
    logs = [];
    const code2 = await runOnboard({ allHosts: true, yes: true }, deps({}, NEW));
    expect(code2).toBe(0);
    expect(logs.join('\n')).toContain('模型清单已是最新');
    expect(readFileSync(zcPath, 'utf8')).toBe(afterSync);
    expect(bakCount()).toBe(bak1 + 1);
  });

  it('已接入但桥接源离线：跳过清单同步、绝不用空清单覆盖、退出 0（T024 束 1）', async () => {
    setupAllHostsFresh();
    await runOnboard({ allHosts: true, yes: true }, deps());
    const zcPath = join(home, '.zcode/v2/provider_config.json');
    const before = readFileSync(zcPath, 'utf8');
    const bak1 = bakCount();
    logs = [];
    const offline = deps({
      fetchFn: (async (input: RequestInfo | URL) => {
        const url = String(input);
        const ui = fixtureUiResponse(input); if (ui) return ui;
    if (url.endsWith('/health')) {
          return new Response(JSON.stringify({ ok: true, service: 'accessmux' }), { status: 200 });
        }
        if (url.endsWith('/v1/models')) {
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }
        return new Response('not found', { status: 404 });
      }) as unknown as typeof fetch,
    });
    const code = await runOnboard({ allHosts: true, yes: true }, offline);
    expect(code).toBe(0);
    expect(logs.join('\n')).toContain('跳过模型清单同步');
    expect(readFileSync(zcPath, 'utf8')).toBe(before);
    expect(bakCount()).toBe(bak1);
  });

  it('探针未就绪：指引示例名等约 1s 后显示 [探测中]，不打裸占位（T024 束 2）', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true }); // 仅指引型宿主 → 走"无可接入"分支
    let attempts = 0;
    const d = deps({
      fetchFn: (async (input: RequestInfo | URL) => {
        attempts++;
        if (String(input).endsWith('/health')) return new Response(JSON.stringify({ok: true, service: 'accessmux'}));
        const ui = fixtureUiResponse(input); if (ui) return ui;
        return new Response('probe not ready', { status: 500 });
      }) as unknown as typeof fetch,
    });
    const code = await runOnboard({ allHosts: true }, d);
    expect(code).toBe(0);
    const out = logs.join('\n');
    expect(out).toContain('[探测中]');
    expect(out).not.toContain('<adapterId>:<modelId>');
    expect(attempts).toBe(6); // health + HTML/JS/CSS + 开页前HTML + 一次目录采集
  });

  it('探针秒回：指引示例名用真实模型 id（T024 束 2）', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    const code = await runOnboard({ allHosts: true }, deps());
    expect(code).toBe(0);
    const out = logs.join('\n');
    expect(out).toContain('ANTHROPIC_MODEL="workbuddy:hy4-preview"');
    expect(out).not.toContain('[探测中]');
  });

  function bakCount(): number {
    let n = 0;
    const walk = (dir: string): void => {
      if (!existsSync(dir)) return;
      for (const f of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, f.name);
        if (f.isDirectory()) walk(p);
        else if (f.name.includes('.bak-pre-onboard-')) n++;
      }
    };
    walk(home);
    return n;
  }
});
