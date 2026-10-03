// 配置面新增字段回归（T027）：checkin.sources 开关 + qoder.pat。
// 放在 tests/checkin/ 内（本任务可写范围），验证：
// - 老配置（无 checkin/qoder 键）仍然通过校验（向后兼容）；
// - 新字段形状正确时通过；错形状被拒；
// - YAML roundtrip 保留新字段。

import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { writeQoderPat } from '../../src/checkin/pat-store.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configSchema, loadConfigFromPath, saveConfigToPath } from '../../src/config/index.js';

let tmpDir = '';
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'accessmux-checkin-cfg-')); });
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

const BASE = {
  version: 1,
  output: { port: 8080, host: '127.0.0.1', protocol: 'openai', exposeAnthropic: false },
  adapters: {},
  models: { allow: {} },
};

describe('checkin 配置字段', () => {
  it('PAT 刷新安全原子替换，收紧存量目录/文件权限', () => {
    const path = join(tmpDir, 'qoder.pat');
    writeQoderPat('old-synthetic', path);
    chmodSync(path, 0o644);
    chmodSync(tmpDir, 0o755);
    const inode = statSync(path).ino;
    writeQoderPat('new-synthetic', path);
    expect(readFileSync(path, 'utf8')).toBe('new-synthetic\n');
    expect(statSync(path).ino).not.toBe(inode);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(tmpDir).mode & 0o777).toBe(0o700);
    expect(readdirSync(tmpDir)).toEqual(['qoder.pat']);
  });

  it('PAT 链接目标拒写，原值不变', () => {
    const target = join(tmpDir, 'original');
    const link = join(tmpDir, 'qoder.pat');
    writeFileSync(target, 'keep');
    symlinkSync(target, link);
    expect(() => writeQoderPat('synthetic-secret', link)).toThrow(/symbolic link/);
    expect(readFileSync(target, 'utf8')).toBe('keep');
  });
  it('老配置（无 checkin/qoder 键）依然通过（向后兼容）', () => {
    expect(configSchema.safeParse(BASE).success).toBe(true);
  });

  it('checkin.sources 三源布尔开关通过', () => {
    const r = configSchema.safeParse({
      ...BASE,
      checkin: { sources: { workbuddy: false, qoder: true, zcode: false } },
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.checkin?.sources?.workbuddy).toBe(false);
  });

  it('qoder.pat 字符串字段通过（手写配置兜底入口）', () => {
    const r = configSchema.safeParse({ ...BASE, qoder: { pat: 'pat-value' } });
    expect(r.success).toBe(true);
  });

  it('错形状被拒：sources 不是布尔、pat 不是字符串', () => {
    expect(configSchema.safeParse({ ...BASE, checkin: { sources: { workbuddy: 'yes' } } }).success).toBe(false);
    expect(configSchema.safeParse({ ...BASE, qoder: { pat: 123 } }).success).toBe(false);
    expect(configSchema.safeParse({ ...BASE, checkin: { sources: { unknownSource: true } } }).success).toBe(false);
  });

  it('YAML roundtrip：checkin 开关与 qoder.pat 原样保留', () => {
    const path = join(tmpDir, 'config.yaml');
    const cfg = {
      ...BASE,
      output: { ...BASE.output, port: 8080 as const, host: '127.0.0.1' as const, protocol: 'openai' as const },
      adapters: {},
      models: { allow: {} },
      checkin: { sources: { zcode: false } },
      qoder: { pat: 'roundtrip-pat' },
    };
    saveConfigToPath(path, cfg as never);
    const loaded = loadConfigFromPath(path);
    expect(loaded.checkin?.sources?.zcode).toBe(false);
    expect(loaded.qoder?.pat).toBe('roundtrip-pat');
  });
});
