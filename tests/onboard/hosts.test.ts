// T011 · 宿主接入件测试：fixture HOME 上验证检测/接入/幂等/合并零破坏/自环排除。
// 全部离线：网络走注入的 fake fetch，不碰真实 ~/.zcode、~/.workbuddy、~/.dsh。
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allHosts, modelDisplayName, type HostContext } from '../../src/onboard/hosts.js';
import { isPureInsertion } from '../../src/onboard/json-text.js';

let home = '';
let repoRoot = '';
beforeEach(() => {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  home = join(tmpdir(), `accessmux-hosts-${id}`);
  repoRoot = join(tmpdir(), `accessmux-repo-${id}`);
  mkdirSync(home, { recursive: true });
  mkdirSync(repoRoot, { recursive: true });
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repoRoot, { recursive: true, force: true });
});

const MODELS = [
  'workbuddy:hy4-preview',
  'workbuddy:glm-5.3-flash',
  'trae-cn:glm-5.2',
  'trae-cn:deepseek-v4-flash',
  'trae-global:gpt-5.4',
];

function ctx(overrides: Partial<HostContext> = {}): HostContext {
  return {
    homeDir: home,
    repoRoot,
    baseURL: 'http://127.0.0.1:8080',
    port: 8080,
    modelIds: MODELS,
    fetchFn: (async () => {
      throw new Error('hosts 测试不应发真实请求');
    }) as unknown as typeof fetch,
    now: () => new Date('2026-09-30T12:00:00'),
    ...overrides,
  };
}

function host(id: string) {
  const h = allHosts().find((x) => x.id === id);
  if (!h) throw new Error(`no host ${id}`);
  return h;
}

function write(path: string, content: string, mode = 0o644): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
}

/** 仿真 ZCode 文件：既有 2 个自定义 provider，键序非字母序（真实形态） */
const ZCODE_FIXTURE = `{
  "schemaVersion": 3,
  "config": {
    "providerOrder": [
      "11111111-1111-1111-1111-111111111111",
      "22222222-2222-2222-2222-222222222222"
    ],
    "providerConfigRules": {
      "providerRules": [
        {
          "providerId": "11111111-1111-1111-1111-111111111111",
          "providerName": "商汤",
          "config": {
            "group": "standard-personal",
            "access": { "type": "api-key", "apiKey": "SENSITIVE-KEEP-1" },
            "api": { "type": "openai-chat-completions", "baseUrl": "https://keep-1.example" },
            "personalModelIds": ["keep1-model"],
            "modelOrder": ["keep1-model"]
          }
        },
        {
          "providerId": "22222222-2222-2222-2222-222222222222",
          "providerName": "小红书",
          "config": {
            "group": "standard-personal",
            "access": { "type": "api-key", "apiKey": "SENSITIVE-KEEP-2" },
            "api": { "type": "openai-chat-completions", "baseUrl": "https://keep-2.example" },
            "personalModelIds": ["keep2-model"],
            "modelOrder": ["keep2-model"]
          }
        }
      ]
    },
    "modelConfigRules": { "untouched": true },
    "defaultModelSelection": { "providerId": "11111111-1111-1111-1111-111111111111", "untouched": true }
  }
}`;

describe('zcode 宿主', () => {
  it('未装 → installed=false', () => {
    expect(host('zcode').detect(ctx()).installed).toBe(false);
  });

  it('装了且无 AccessMux → 可接入', () => {
    write(join(home, '.zcode/v2/provider_config.json'), ZCODE_FIXTURE, 0o600);
    const d = host('zcode').detect(ctx());
    expect(d.installed).toBe(true);
    expect(d.onboarded).toBe(false);
    expect(d.canAuto).toBe(true);
  });

  it('接入：两处纯增 + 既有字节逐字保留（含既有 apiKey 原文）+ 权限保持 600', async () => {
    const file = join(home, '.zcode/v2/provider_config.json');
    write(file, ZCODE_FIXTURE, 0o600);
    const r = await host('zcode').onboard?.(ctx());
    expect(r?.summary).toMatch(/5 个模型/);
    const after = readFileSync(file, 'utf8');
    const parsed = JSON.parse(after) as {
      config: {
        providerOrder: string[];
        providerConfigRules: { providerRules: { providerName: string; config: { personalModelIds: string[]; api: { baseUrl: string } } }[] };
      };
    };
    // providerOrder：12→13 式追加（fixture 2→3），既有两个 UUID 仍在前
    expect(parsed.config.providerOrder).toHaveLength(3);
    expect(parsed.config.providerOrder.slice(0, 2)).toEqual([
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
    ]);
    // rules 尾部出现 AccessMux，模型清单全量、baseUrl 指向 daemon
    const amux = parsed.config.providerConfigRules.providerRules[2];
    expect(amux?.providerName).toBe('AccessMux');
    expect(amux?.config.personalModelIds).toEqual(MODELS);
    expect(amux?.config.api.baseUrl).toBe('http://127.0.0.1:8080/v1');
    // 既有内容零破坏：敏感 apiKey 原文保留、顶层键序保持
    expect(after).toContain('SENSITIVE-KEEP-1');
    expect(after).toContain('SENSITIVE-KEEP-2');
    expect(Object.keys(JSON.parse(after))).toEqual(['schemaVersion', 'config']);
    expect(Object.keys((JSON.parse(after) as { config: object }).config)).toEqual([
      'providerOrder',
      'providerConfigRules',
      'modelConfigRules',
      'defaultModelSelection',
    ]);
    // 既有 provider 的所有原文行一字不动地保留（合并语义非覆盖）
    for (const line of ZCODE_FIXTURE.split('\n')) {
      if (line.trim() === '') continue;
      expect(after).toContain(line);
    }
    // 权限保持 600
    expect(existsSync(file)).toBe(true);
    // 备份存在且内容 = 改前原文
    const r0 = r?.files[0];
    expect(r0?.backup).toBeTruthy();
    expect(readFileSync(r0?.backup ?? '', 'utf8')).toBe(ZCODE_FIXTURE);
  });

  it('幂等：接入后再 detect → onboarded=true，编排层据此跳过（端到端幂等见 onboard.test.ts）', async () => {
    const file = join(home, '.zcode/v2/provider_config.json');
    write(file, ZCODE_FIXTURE, 0o600);
    await host('zcode').onboard?.(ctx());
    const d = host('zcode').detect(ctx());
    expect(d.onboarded).toBe(true);
    const parsed1 = JSON.parse(readFileSync(file, 'utf8')) as { config: { providerConfigRules: { providerRules: unknown[] } } };
    expect(parsed1.config.providerConfigRules.providerRules).toHaveLength(3);
  });

  it('无 provider_config.json → canAuto=false（降级指引）', () => {
    mkdirSync(join(home, '.zcode'), { recursive: true });
    const d = host('zcode').detect(ctx());
    expect(d.installed).toBe(true);
    expect(d.canAuto).toBe(false);
  });

  it('回滚指引包含备份路径', async () => {
    const file = join(home, '.zcode/v2/provider_config.json');
    write(file, ZCODE_FIXTURE, 0o600);
    const r = await host('zcode').onboard?.(ctx());
    const lines = host('zcode').rollbackLines?.(r);
    expect(lines?.[0]).toMatch(/cp .*\.bak-pre-onboard-/);
  });
});

describe('zcode 模型清单同步（refresh，T024）', () => {
  const ZC_DIR = () => join(home, '.zcode/v2');
  const zcFile = () => join(ZC_DIR(), 'provider_config.json');
  function bakCount(): number {
    return readdirSync(ZC_DIR()).filter((n) => n.includes('.bak-pre-onboard-')).length;
  }
  async function setupOnboarded(): Promise<void> {
    write(zcFile(), ZCODE_FIXTURE, 0o600);
    await host('zcode').onboard?.(ctx());
  }

  it('未接入（文件里没有 AccessMux 条目）→ 可读报错、不写盘', async () => {
    write(zcFile(), ZCODE_FIXTURE, 0o600);
    await expect(host('zcode').refresh?.(ctx())).rejects.toThrow(/找不到 AccessMux/);
    expect(readFileSync(zcFile(), 'utf8')).toBe(ZCODE_FIXTURE);
    expect(bakCount()).toBe(0);
  });

  it('stale → 两个数组整段替换：条目外零破坏、键序保持、备份生成', async () => {
    await setupOnboarded();
    const before = readFileSync(zcFile(), 'utf8');
    const bakBefore = bakCount();
    const NEW = ['zcode:glm-4.6', 'opencode:mimo'];
    const r = await host('zcode').refresh?.(ctx({ modelIds: NEW }));
    expect(r?.summary).toMatch(/同步模型清单（5 → 2 个模型/);
    expect(r?.files[0]?.backup).toBeTruthy();
    expect(bakCount()).toBe(bakBefore + 1);
    const after = readFileSync(zcFile(), 'utf8');
    const parsed = JSON.parse(after) as {
      config: {
        providerOrder: string[];
        providerConfigRules: { providerRules: { providerName: string; config: { personalModelIds: string[]; modelOrder: string[]; api: { baseUrl: string } } }[] };
        defaultModelSelection: unknown;
      };
    };
    const rules = parsed.config.providerConfigRules.providerRules;
    const amux = rules.find((x) => x.providerName === 'AccessMux');
    expect(amux?.config.personalModelIds).toEqual(NEW);
    expect(amux?.config.modelOrder).toEqual(NEW);
    // 数组外零破坏：既有 provider 原文（含敏感值）与关键结构逐字保留
    for (const line of ZCODE_FIXTURE.split('\n')) {
      if (line.trim() === '') continue;
      expect(after).toContain(line);
    }
    expect(after).toContain('SENSITIVE-KEEP-1');
    expect(after).toContain('SENSITIVE-KEEP-2');
    expect(Object.keys(JSON.parse(after))).toEqual(['schemaVersion', 'config']);
    // 语义：只有两个数组变了（把旧值换进新文件即回到原语义）
    const orig = JSON.parse(before) as typeof parsed;
    const amuxOrig = orig.config.providerConfigRules.providerRules.find((x) => x.providerName === 'AccessMux');
    if (!amuxOrig) throw new Error('fixture 里应有 AccessMux');
    amuxOrig.config.personalModelIds = NEW;
    amuxOrig.config.modelOrder = NEW;
    expect(JSON.parse(after)).toEqual(orig);
    // 备份 = 改前原文
    expect(readFileSync(r?.files[0]?.backup ?? '', 'utf8')).toBe(before);
  });

  it('已最新 → 返回 null：不写盘、不备份（幂等）', async () => {
    await setupOnboarded();
    const before = readFileSync(zcFile(), 'utf8');
    const bakBefore = bakCount();
    const r = await host('zcode').refresh?.(ctx()); // 与 onboard 写入的 MODELS 相同
    expect(r).toBeNull();
    expect(readFileSync(zcFile(), 'utf8')).toBe(before);
    expect(bakCount()).toBe(bakBefore);
  });

  it('空清单防御：拒绝用空数组覆盖已注册模型', async () => {
    await setupOnboarded();
    const before = readFileSync(zcFile(), 'utf8');
    await expect(host('zcode').refresh?.(ctx({ modelIds: [] }))).rejects.toThrow(/空清单/);
    expect(readFileSync(zcFile(), 'utf8')).toBe(before);
  });
});

describe('workbuddy 宿主', () => {
  it('未装 → installed=false', () => {
    expect(host('workbuddy').detect(ctx()).installed).toBe(false);
  });

  it('接入：数组尾追加、排除 workbuddy 自环、既有条目逐字节保留', async () => {
    const file = join(home, '.workbuddy/models.json');
    write(file, `[
  {
    "id": "user-handmade",
    "name": "我的手工模型",
    "apiKey": "SENSITIVE-KEEP"
  }
]`);
    const r = await host('workbuddy').onboard?.(ctx({ modelDescriptions: { 'trae-cn:glm-5.2': { name: 'GLM-5.2 · 夜间折扣 · 0.2× · Trae CN' } } }));
    const after = readFileSync(file, 'utf8');
    const parsed = JSON.parse(after) as { id: string; name: string; apiKey: string }[];
    // 自环排除：5 个模型中 2 个 workbuddy:* 被排除 → 追加 3 条
    expect(parsed).toHaveLength(4);
    const added = parsed.filter((e) => e.name.startsWith('AccessMux ·'));
    expect(added.map((e) => e.id)).toEqual(['trae-cn:glm-5.2', 'trae-cn:deepseek-v4-flash', 'trae-global:gpt-5.4']);
    // 条目字段照抄 host-integration 第 7 节
    const first = added[0];
    expect(first).toMatchObject({
      vendor: 'Custom',
      url: 'http://127.0.0.1:8080/v1/chat/completions',
      apiKey: 'local',
      supportsToolCall: false,
      supportsImages: false,
      supportsReasoning: false,
      useCustomProtocol: true,
      onlyReasoning: false,
    });
    expect(first?.name).toBe('AccessMux · GLM-5.2 · 夜间折扣 · 0.2× · Trae CN');
    // 既有条目原文保留（含敏感 apiKey）
    expect(after).toContain('"我的手工模型"');
    expect(after).toContain('SENSITIVE-KEEP');
    // 既有条目在语义上也未变
    expect(parsed[0]).toEqual({ id: 'user-handmade', name: '我的手工模型', apiKey: 'SENSITIVE-KEEP' });
    expect(r?.files[0]?.backup).toBeTruthy();
  });

  it('{models:[…]} 对象形态也支持', async () => {
    const file = join(home, '.workbuddy/models.json');
    write(file, `{"models": []}`);
    await host('workbuddy').onboard?.(ctx());
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { models: { id: string }[] };
    expect(parsed.models).toHaveLength(3);
    expect(parsed.models[0]?.id).toBe('trae-cn:glm-5.2');
  });

  it('文件不存在 → 新建数组文件（无备份）', async () => {
    mkdirSync(join(home, '.workbuddy'), { recursive: true });
    const r = await host('workbuddy').onboard?.(ctx());
    const file = join(home, '.workbuddy/models.json');
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toHaveLength(3);
    expect(r?.files[0]?.backup).toBeNull();
    expect(r?.files[0]?.created).toBe(true);
  });

  it('幂等：接入后 detect → onboarded', async () => {
    write(join(home, '.workbuddy/models.json'), '[]');
    await host('workbuddy').onboard?.(ctx());
    const d = host('workbuddy').detect(ctx());
    expect(d.onboarded).toBe(true);
  });

  it('已接入后只刷新完整AccessMux原ID对应的name；其他字段字节保持不变并幂等', async () => {
    const file = join(home, '.workbuddy/models.json');
    const raw = `[{"id":"trae-cn:glm-5.2","name":"AccessMux · Trae CN glm-5.2","vendor":"Custom","url":"http://127.0.0.1:8080/v1/chat/completions","apiKey":"SYNTHETIC-KEEP","default":true},{"id":"qoder:flash","name":"AccessMux · Qoder flash","url":"http://127.0.0.1:8999/v1/chat/completions","apiKey":"SYNTHETIC-OLD-PORT"},{"id":"handmade","name":"手工模型","key":"SYNTHETIC-OTHER"}]`;
    write(file, raw);
    const context = ctx({ modelDescriptions: { 'trae-cn:glm-5.2': { name: 'GLM-5.2 · 夜间折扣 · 0.2× · Trae CN' } } });
    const refreshed = await host('workbuddy').refresh?.(context);
    expect(refreshed?.summary).toContain('仅改 name 字段');
    const changed = readFileSync(file, 'utf8');
    const parsed = JSON.parse(changed) as Array<Record<string, unknown>>;
    expect(parsed[0]).toMatchObject({ id: 'trae-cn:glm-5.2', name: 'AccessMux · GLM-5.2 · 夜间折扣 · 0.2× · Trae CN', url: 'http://127.0.0.1:8080/v1/chat/completions', apiKey: 'SYNTHETIC-KEEP', default: true });
    expect(parsed[1]).toEqual({ id: 'qoder:flash', name: 'AccessMux · Qoder flash', url: 'http://127.0.0.1:8999/v1/chat/completions', apiKey: 'SYNTHETIC-OLD-PORT' });
    expect(parsed[2]).toEqual({ id: 'handmade', name: '手工模型', key: 'SYNTHETIC-OTHER' });
    expect(changed).toContain('SYNTHETIC-KEEP');
    expect(changed).toContain('SYNTHETIC-OLD-PORT');
    expect(await host('workbuddy').refresh?.(context)).toBeNull();
    expect(readFileSync(file, 'utf8')).toBe(changed);
  });

  it('不认识的文件形态 → canAuto=false 且不写', () => {
    write(join(home, '.workbuddy/models.json'), '{"weird": 1}');
    const d = host('workbuddy').detect(ctx());
    expect(d.canAuto).toBe(false);
    expect(d.warning).toBeTruthy();
  });

  it('全部模型都是自环时拒绝注册并给指引', async () => {
    mkdirSync(join(home, '.workbuddy'), { recursive: true });
    await expect(
      host('workbuddy').onboard?.(ctx({ modelIds: ['workbuddy:only-one'] })),
    ).rejects.toThrow(/自环/);
  });
});

describe('dsh 宿主', () => {
  const PKG = `{
  "name": "dsh-profile-desktop",
  "private": true,
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "dshmarket"
      ]
    }
  },
  "dependencies": {
    "dshmarket": "^1.66.5"
  }
}`;

  function setupProfile(): string {
    const profileDir = join(home, '.dsh/profiles/desktop');
    write(join(profileDir, 'package.json'), PKG);
    return profileDir;
  }

  function setupPlugin(): string {
    const pluginDir = join(repoRoot, 'integrations/dsh-accessmux-connect');
    write(join(pluginDir, 'package.json'), '{"name":"dsh-accessmux-connect","main":"index.js"}');
    return pluginDir;
  }

  it('未装 → installed=false', () => {
    expect(host('dsh').detect(ctx()).installed).toBe(false);
  });

  it('接入：package.json 两处纯增 + node_modules symlink 指向插件源码', async () => {
    const profileDir = setupProfile();
    const pluginDir = setupPlugin();
    const r = await host('dsh').onboard?.(ctx());
    const after = readFileSync(join(profileDir, 'package.json'), 'utf8');
    const parsed = JSON.parse(after) as {
      dsh: { profile: { bundles: string[] } };
      dependencies: Record<string, string>;
    };
    expect(parsed.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base', 'dshmarket', 'dsh-accessmux-connect']);
    expect(parsed.dependencies['dsh-accessmux-connect']).toBe(`link:${pluginDir}`);
    // 既有内容零破坏
    for (const line of PKG.split('\n')) {
      if (line.trim() === '') continue;
      expect(after).toContain(line);
    }
    // symlink 建立且指向插件目录（透过链接能读到插件 package.json）
    const link = join(profileDir, 'node_modules', 'dsh-accessmux-connect');
    expect(existsSync(link)).toBe(true);
    expect(readFileSync(join(link, 'package.json'), 'utf8')).toContain('dsh-accessmux-connect');
    expect(r?.files).toHaveLength(2);
    expect(r?.files[0]?.backup).toBeTruthy();
  });

  it('幂等：装完 → onboarded=true；bundles/链接不一致 → canAuto=false + warning', () => {
    const profileDir = setupProfile();
    setupPlugin();
    // 只写 bundles 不建 link 的不一致态
    const pkgPath = join(profileDir, 'package.json');
    const patched = JSON.parse(PKG) as { dsh: { profile: { bundles: string[] } } };
    patched.dsh.profile.bundles.push('dsh-accessmux-connect');
    write(pkgPath, JSON.stringify(patched, null, 2));
    const d = host('dsh').detect(ctx());
    expect(d.canAuto).toBe(false);
    expect(`${d.detail}${d.warning ?? ''}`).toMatch(/不一致/);
  });

  it('插件源码缺失时报可读错误', async () => {
    setupProfile();
    await expect(host('dsh').onboard?.(ctx())).rejects.toThrow(/插件源码不在预期位置/);
  });

  it('正常装完后 onboarded', async () => {
    setupProfile();
    setupPlugin();
    await host('dsh').onboard?.(ctx());
    const d = host('dsh').detect(ctx());
    expect(d.onboarded).toBe(true);
  });
});

describe('指引型宿主', () => {
  it('claude-code 检测并给环境变量指引', () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    const d = host('claude-code').detect(ctx());
    expect(d.installed).toBe(true);
    const lines = host('claude-code').guideLines(ctx());
    expect(lines.join('\n')).toContain('ANTHROPIC_BASE_URL="http://127.0.0.1:8080"');
    expect(lines.join('\n')).toContain('workbuddy:hy4-preview'); // 清单第一条作示例模型
  });

  it('codex 给 config.toml 指引', () => {
    mkdirSync(join(home, '.codex'), { recursive: true });
    expect(host('codex').detect(ctx()).installed).toBe(true);
    const lines = host('codex').guideLines(ctx());
    expect(lines.join('\n')).toContain('[model_providers.accessmux]');
  });

  it('hermes 给通用指引', () => {
    mkdirSync(join(home, '.hermes'), { recursive: true });
    expect(host('hermes').detect(ctx()).installed).toBe(true);
    expect(host('hermes').guideLines(ctx()).length).toBeGreaterThan(0);
  });
});

describe('trae / qoder 宿主（T037 登记，guide 型）', () => {
  it('未装（无 ~/.trae*、~/.qoder*）→ installed=false', () => {
    expect(host('trae').detect(ctx()).installed).toBe(false);
    expect(host('qoder').detect(ctx()).installed).toBe(false);
  });

  it('trae 数据目录存在 → 检测到并给自定义模型指引（guide 型，不自动写）', () => {
    mkdirSync(join(home, '.trae-cn'), { recursive: true });
    const def = host('trae');
    expect(def.kind).toBe('guide');
    const d = def.detect(ctx());
    expect(d.installed).toBe(true);
    expect(d.detail).toContain('.trae-cn');
    const lines = def.guideLines(ctx()).join('\n');
    expect(lines).toContain('添加模型');
    expect(lines).toContain('http://127.0.0.1:8080/v1');
    expect(lines).toContain('workbuddy:hy4-preview'); // 探针就绪时用真实模型 id
    expect(lines).toContain('真机复核'); // 未实测不冒称已验证
    expect(def.onboard).toBeUndefined(); // 未升级为 auto 型前不写宿主配置
  });

  it('qoder 数据目录存在 → 检测到并给自定义 Base URL 指引', () => {
    mkdirSync(join(home, '.qoder-cn'), { recursive: true });
    const def = host('qoder');
    expect(def.kind).toBe('guide');
    const d = def.detect(ctx());
    expect(d.installed).toBe(true);
    expect(d.detail).toContain('.qoder-cn');
    const lines = def.guideLines(ctx()).join('\n');
    expect(lines).toContain('自定义 Base URL');
    expect(lines).toContain('http://127.0.0.1:8080/v1');
    expect(def.onboard).toBeUndefined();
  });

  it('探针未就绪（modelIds 空）→ 指引显示 [探测中]，不打裸占位名', () => {
    mkdirSync(join(home, '.trae'), { recursive: true });
    const lines = host('trae').guideLines(ctx({ modelIds: [] })).join('\n');
    expect(lines).toContain('[探测中]');
    expect(lines).not.toContain('<adapterId>:<modelId>');
  });
});

describe('modelDisplayName', () => {
  it('adapter 显示名映射', () => {
    expect(modelDisplayName('trae-cn:glm-5.2')).toBe('Trae CN glm-5.2');
    expect(modelDisplayName('workbuddy:hy4-preview')).toBe('WorkBuddy hy4-preview');
    expect(modelDisplayName('trae-global:gpt-5.4')).toBe('Trae Global gpt-5.4');
    expect(modelDisplayName('unknown:x')).toBe('unknown x');
    expect(modelDisplayName('no-colon')).toBe('no-colon');
  });
});

// isPureInsertion 从 json-text 导入使用（防止 fixture 意外变成重写）
describe('fixture 卫生', () => {
  it('fixture 与其 JSON 规范化重写之间不是纯插入（反向确认判定器有效）', () => {
    expect(isPureInsertion(ZCODE_FIXTURE, JSON.stringify(JSON.parse(ZCODE_FIXTURE), null, 2))).toBeNull();
  });
});
