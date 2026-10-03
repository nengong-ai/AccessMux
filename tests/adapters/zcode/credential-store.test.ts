// T019 凭据读取：credentials.json 定位 zcodejwttoken + telemetry deviceMid。

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertJwtShape,
  loadZcodeCredential,
  ZcodeCredentialError,
} from '../../../src/adapters/zcode/credential-store.js';
import { createZcodeCredentialCipher } from '../../../src/adapters/zcode/decrypt.js';

// 三段伪 JWT（形状合法即可，内容无意义）
const FAKE_JWT = `${'a'.repeat(36)}.${'b'.repeat(120)}.${'c'.repeat(43)}`;

const tmpDirs: string[] = [];
function makeHome(withTelemetry = true): string {
  const home = mkdtempSync(join(tmpdir(), 'zcode-cred-'));
  tmpDirs.push(home);
  mkdirSync(join(home, '.zcode', 'v2'), { recursive: true });
  const cipher = createZcodeCredentialCipher({ env: {}, home, username: 'tester' });
  const credentials: Record<string, string> = {
    'oauth:bigmodel:access_token': cipher.encrypt('oauth-at'),
    zcodejwttoken: cipher.encrypt(FAKE_JWT),
  };
  writeFileSync(
    join(home, '.zcode', 'v2', 'credentials.json'),
    JSON.stringify(credentials, null, 1),
  );
  if (withTelemetry) {
    writeFileSync(
      join(home, '.zcode', 'v2', 'telemetry-state.json'),
      JSON.stringify({ deviceMid: '11111111-2222-3333-4444-555555555555' }),
    );
  }
  return home;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    // mkdtemp 目录在系统临时区，测试进程退出即由 OS 清理策略处理；此处不阻塞
    void dir;
  }
});

describe('ZcodeCredentialStore', () => {
  it('解密 zcodejwttoken + 读 telemetry deviceMid', () => {
    const credential = loadZcodeCredential({ home: makeHome(), env: {}, username: 'tester' });
    expect(credential.jwt).toBe(FAKE_JWT);
    expect(credential.deviceMid).toBe('11111111-2222-3333-4444-555555555555');
    expect(credential.deviceMidSource).toBe('telemetry-state');
  });

  it('telemetry 缺失时自生成 deviceMid（服务端只校验存在性，R014）', () => {
    const credential = loadZcodeCredential({ home: makeHome(false), env: {}, username: 'tester' });
    expect(credential.deviceMid).not.toBe('');
    expect(credential.deviceMidSource).toBe('generated');
  });

  it('credentials.json 缺失 → 可读错误', () => {
    const home = mkdtempSync(join(tmpdir(), 'zcode-empty-'));
    tmpDirs.push(home);
    expect(() => loadZcodeCredential({ home, env: {} })).toThrow(ZcodeCredentialError);
    expect(() => loadZcodeCredential({ home, env: {} })).toThrow(/读不到/);
  });

  it('没有 zcodejwttoken 键 → 未登录语义', () => {
    const home = mkdtempSync(join(tmpdir(), 'zcode-nokey-'));
    tmpDirs.push(home);
    mkdirSync(join(home, '.zcode', 'v2'), { recursive: true });
    writeFileSync(join(home, '.zcode', 'v2', 'credentials.json'), JSON.stringify({ other: 'x' }));
    expect(() => loadZcodeCredential({ home, env: {} })).toThrow(/zcodejwttoken/);
  });

  it('解密出的值形状不对（非 3 段 JWT）→ 拒绝使用', () => {
    const home = mkdtempSync(join(tmpdir(), 'zcode-badshape-'));
    tmpDirs.push(home);
    mkdirSync(join(home, '.zcode', 'v2'), { recursive: true });
    const cipher = createZcodeCredentialCipher({ env: {}, home, username: 'tester' });
    writeFileSync(
      join(home, '.zcode', 'v2', 'credentials.json'),
      JSON.stringify({ zcodejwttoken: cipher.encrypt('not-a-jwt') }),
    );
    expect(() => loadZcodeCredential({ home, env: {}, username: 'tester' })).toThrow(/形状不合法/);
  });

  it('assertJwtShape：3 段通过，其余拒绝', () => {
    expect(() => assertJwtShape('a.b.c')).not.toThrow();
    expect(() => assertJwtShape('ab.c')).toThrow();
    expect(() => assertJwtShape('a..c')).toThrow();
  });
});
