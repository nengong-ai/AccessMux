// T011 · 备份测试：内容一致、权限保持、绝不覆盖旧备份。
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupFile } from '../../src/onboard/backup.js';

let tmpDir = '';
beforeEach(() => {
  tmpDir = mkdtemp();
});
afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function mkdtemp(): string {
  const d = join(tmpdir(), `accessmux-bak-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(d, { recursive: true });
  return d;
}

describe('backupFile', () => {
  it('生成带时间戳的备份，内容与权限一致', () => {
    const file = join(tmpDir, 'models.json');
    writeFileSync(file, '[\n  {"id": "keep"}\n]', { mode: 0o600 });
    chmodSync(file, 0o600);
    const fixed = new Date('2026-09-30T12:34:56');
    const bak = backupFile(file, { now: () => fixed });
    expect(bak).toBe(`${file}.bak-pre-onboard-20260930-123456`);
    expect(existsSync(bak ?? '')).toBe(true);
    expect(readFileSync(bak ?? '', 'utf8')).toBe('[\n  {"id": "keep"}\n]');
    expect(statSync(bak ?? '').mode & 0o777).toBe(0o600);
  });

  it('同一秒重复备份不覆盖，追加 -2', () => {
    const file = join(tmpDir, 'x.json');
    writeFileSync(file, 'v1');
    const fixed = new Date('2026-09-30T12:34:56');
    const b1 = backupFile(file, { now: () => fixed });
    writeFileSync(file, 'v2');
    const b2 = backupFile(file, { now: () => fixed });
    expect(b1).not.toBe(b2);
    expect(b2?.endsWith('-2')).toBe(true);
    expect(readFileSync(b2 ?? '', 'utf8')).toBe('v2');
    expect(readFileSync(b1 ?? '', 'utf8')).toBe('v1');
  });

  it('原文件不存在返回 null（新建文件场景）', () => {
    expect(backupFile(join(tmpDir, 'nope.json'))).toBeNull();
  });
});
