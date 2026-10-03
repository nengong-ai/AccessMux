// T019 前缀常量机制：官方 harness 前缀构建校验（sha256 与 R017 clean-room 实测值比对）。

import { describe, expect, it } from 'vitest';
import {
  EXPECTED_OFFICIAL_PREFIX_SHA256,
  OFFICIAL_HARNESS_PREFIX,
  officialPrefixSha256,
  verifyOfficialPrefix,
} from '../../../src/adapters/zcode/prefix.js';

describe('官方 harness 前缀（D23/R017 合同）', () => {
  it('逐字节重建：1253 字符、sha256 与官方实测值一致', () => {
    expect([...OFFICIAL_HARNESS_PREFIX].length).toBe(1253);
    expect(Buffer.byteLength(OFFICIAL_HARNESS_PREFIX, 'utf8')).toBe(1257); // 两处 em-dash 各 3 字节
    expect(officialPrefixSha256()).toBe(EXPECTED_OFFICIAL_PREFIX_SHA256);
    expect(EXPECTED_OFFICIAL_PREFIX_SHA256).toBe(
      '7e93b98617f4e5eaaf53391445761a5d8624c70064ff3af14cf2b47b0e34737d',
    );
  });

  it('前缀结构：cli_prefix 打头 + identity 段自带起始换行（1253=42+1211）', () => {
    expect(OFFICIAL_HARNESS_PREFIX.startsWith('You are ZCode, an interactive coding agent')).toBe(true);
    // identity 段第一字符是换行（buildIdentityPrompt 的 identityLines 以空串起头）
    expect(OFFICIAL_HARNESS_PREFIX[42]).toBe('\n');
    expect(OFFICIAL_HARNESS_PREFIX).toContain('# Harness');
    expect(OFFICIAL_HARNESS_PREFIX).toContain('IMPORTANT: Assist with authorized security testing');
  });

  it('verifyOfficialPrefix：默认通过；改 1 字符即失配（验收标准 2：不硬闯）', () => {
    expect(verifyOfficialPrefix().ok).toBe(true);
    const tampered = 'X' + OFFICIAL_HARNESS_PREFIX.slice(1);
    const result = verifyOfficialPrefix(tampered);
    expect(result.ok).toBe(false);
    expect(result.sha256).not.toBe(result.expected);
  });

  it('尾部截短 1 字符即失配（R017 §5.1：尾删 1 字符 → 405）', () => {
    expect(verifyOfficialPrefix(OFFICIAL_HARNESS_PREFIX.slice(0, -1)).ok).toBe(false);
  });
});
