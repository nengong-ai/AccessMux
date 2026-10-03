// T004 · Config schema 与 store 测试
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildDefaultConfig,
  configSchema,
  formatZodError,
  loadConfigFromPath,
  saveConfigToPath,
  reconcileWithRegistry,
  ConfigStore,
} from '../src/config/index.js';

let tmpDir = '';
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'accessmux-cfg-')); });
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

describe('configSchema', () => {
  it('合法最小配置通过校验', () => {
    const result = configSchema.safeParse({
      version: 1,
      output: { port: 8080, host: '127.0.0.1', protocol: 'openai', exposeAnthropic: false },
      adapters: {},
      models: { allow: {} },
    });
    expect(result.success).toBe(true);
  });

  it('非法 port 报错', () => {
    const result = configSchema.safeParse({
      version: 1,
      output: { port: 99999 },
      adapters: {},
      models: { allow: {} },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = formatZodError(result.error);
      expect(msg).toMatch(/port/);
    }
  });

  it('bind 地址只接受 127.0.0.1（D4 硬约束）', () => {
    const r = configSchema.safeParse({
      version: 1,
      output: { port: 8080, host: '0.0.0.0' },
      adapters: {},
      models: { allow: {} },
    });
    expect(r.success).toBe(false);
  });

  it('拒绝未知字段', () => {
    const r = configSchema.safeParse({
      version: 1,
      output: { port: 8080 },
      adapters: {},
      models: { allow: {} },
      debug: true,
    });
    expect(r.success).toBe(false);
  });
});

describe('buildDefaultConfig', () => {
  it('基于注册表生成默认启用 + 空 allowlist', () => {
    const def = buildDefaultConfig([
      { id: 'a1', displayName: 'A1', sandbox: 'none' } as never,
      { id: 'a2', displayName: 'A2', sandbox: 'none' } as never,
    ]);
    expect(def.version).toBe(1);
    expect(def.output.host).toBe('127.0.0.1');
    expect(def.output.protocol).toBe('openai');
    expect(def.adapters['a1']?.enabled).toBe(true);
    expect(def.adapters['a2']?.enabled).toBe(true);
    expect(def.models.allow['a1']).toEqual({});
  });
});

describe('reconcileWithRegistry', () => {
  it('为新注册的 adapter 补默认项', () => {
    const cfg = buildDefaultConfig([
      { id: 'a1', displayName: 'A1', sandbox: 'none' } as never,
    ]);
    const next = reconcileWithRegistry(cfg, [
      { id: 'a1', displayName: 'A1', sandbox: 'none' } as never,
      { id: 'a2', displayName: 'A2', sandbox: 'none' } as never,
    ]);
    expect(next.adapters['a2']?.enabled).toBe(true);
    expect(next.models.allow['a2']).toEqual({});
  });
});

describe('YAML save / load roundtrip', () => {
  it('写入后再读出来结构一致', () => {
    const path = join(tmpDir, 'config.yaml');
    const cfg = buildDefaultConfig([
      { id: 'workbuddy', displayName: 'WorkBuddy', sandbox: 'behavioural' } as never,
      { id: 'trae-cn', displayName: 'Trae CN', sandbox: 'behavioural' } as never,
    ]);
    cfg.adapters['workbuddy'] = { enabled: false };
    cfg.models.allow['workbuddy'] = { 'GLM-5.3': true };
    saveConfigToPath(path, cfg);

    const loaded = loadConfigFromPath(path);
    expect(loaded.adapters['workbuddy']?.enabled).toBe(false);
    expect(loaded.models.allow['workbuddy']?.['GLM-5.3']).toBe(true);
    expect(loaded.adapters['trae-cn']?.enabled).toBe(true);
  });

  it('敏感配置新建/覆盖均为 0600、父目录 0700，原子替换不留临时文件', () => {
    const path = join(tmpDir, 'config.yaml');
    const cfg = { ...buildDefaultConfig([]), qoder: { pat: 'synthetic-short-pat' } };
    saveConfigToPath(path, cfg);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    chmodSync(path, 0o644);
    chmodSync(tmpDir, 0o755);
    const inode = statSync(path).ino;
    saveConfigToPath(path, cfg);
    expect(statSync(path).ino).not.toBe(inode);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(tmpDir).mode & 0o777).toBe(0o700);
    expect(readdirSync(tmpDir)).toEqual(['config.yaml']);
  });

  it('拒绝链接覆盖：旧内容保持、错误无敏感内容', () => {
    const original = join(tmpDir, 'original.yaml');
    const link = join(tmpDir, 'config.yaml');
    writeFileSync(original, 'keep-original');
    symlinkSync(original, link);
    expect(() => saveConfigToPath(link, { ...buildDefaultConfig([]), qoder: { pat: 'secret' } })).toThrow(/symbolic link/);
    expect(readFileSync(original, 'utf8')).toBe('keep-original');
    expect(readdirSync(tmpDir).sort()).toEqual(['config.yaml', 'original.yaml']);
  });

  it('YAML 解析错误不带原始敏感行', () => {
    const path = join(tmpDir, 'bad.yaml');
    writeFileSync(path, 'qoder: {pat: synthetic-short-pat, broken: [}');
    try { loadConfigFromPath(path); throw new Error('expected parse error'); } catch (error) {
      expect(String(error)).not.toContain('synthetic-short-pat');
    }
  });

  it('非法 YAML 抛 ConfigError', () => {
    const path = join(tmpDir, 'bad.yaml');
    writeFileSync(path, 'output: : :\n', 'utf8');
    expect(() => loadConfigFromPath(path)).toThrow(/合法 YAML/);
  });

  it('合法 YAML 但字段非法抛 ConfigError', () => {
    const path = join(tmpDir, 'bad-fields.yaml');
    writeFileSync(path, 'version: 1\noutput: { port: "abc" }\n', 'utf8');
    expect(() => loadConfigFromPath(path)).toThrow(/校验失败/);
  });

  it('saveConfigToPath 也校验写入对象', () => {
    const path = join(tmpDir, 'x.yaml');
    const bad = { version: 1, output: { port: 70000 }, adapters: {}, models: { allow: {} } };
    expect(() => saveConfigToPath(path, bad as never)).toThrow(/要保存的配置不合法/);
  });
});

describe('ConfigStore', () => {
  it('set 触发 onChange 回调', () => {
    const store = new ConfigStore(buildDefaultConfig([]));
    const events: number[] = [];
    store.onChange((cfg) => events.push(cfg.output.port));
    store.set({ ...store.get(), output: { ...store.get().output, port: 9000 } });
    expect(events).toEqual([9000]);
  });

  it('off 取消订阅', () => {
    const store = new ConfigStore(buildDefaultConfig([]));
    let count = 0;
    const off = store.onChange(() => { count++; });
    store.set({ ...store.get(), output: { ...store.get().output, port: 9000 } });
    off();
    store.set({ ...store.get(), output: { ...store.get().output, port: 9001 } });
    expect(count).toBe(1);
  });
});